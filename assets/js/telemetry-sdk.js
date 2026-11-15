(function (global) {
  'use strict';

  var MAX_BATCH_EVENTS = 50;
  var MAX_BATCH_BYTES = 32 * 1024;
  var MAX_SINGLE_EVENT_BYTES = 32 * 1024;
  var MAX_QUEUE = 200;
  var MAX_RETRIES = 3;

  var DECISION_EVENTS = { consent_changed: 1, consent_updated: 1, consent_responded: 1, consent_withdrawn: 1 };

  var state = {
    siteId: '',
    endpoint: '',
    manifest: null,
    consent: false,
    consentMode: 'unset',
    queue: [],
    sending: false,
    droppedCount: 0,
    oversizeCount: 0,
    retryCount: 0,
    lastPagePath: null,
    inited: false
  };

  function isDebug() {
    try {
      var host = global.location ? global.location.hostname : '';
      if (host === 'localhost' || host === '127.0.0.1' || /[?&]debug/.test(global.location.search)) {
        return true;
      }
    } catch (e) { /* noop */ }
    return false;
  }

  function uuid32() {
    var hex = '0123456789abcdef';
    var out = '';
    var buf = new Uint8Array(16);
    (global.crypto || {}).getRandomValues ? global.crypto.getRandomValues(buf)
      : (function () { for (var i = 0; i < 16; i++) { buf[i] = Math.floor(Math.random() * 256); } })();
    for (var i = 0; i < 16; i++) {
      out += hex[buf[i] >> 4] + hex[buf[i] & 15];
    }

    out = out.substring(0, 12) + '4' + out.substring(13, 16) + hex[(parseInt(out[16], 16) & 3) | 8] + out.substring(17);
    return out;
  }

  function normalizePagePath(path) {
    if (!path) { return '/'; }
    var p = String(path).split('?')[0].split('#')[0];
    if (p.charAt(0) !== '/') { p = '/' + p; }
    p = p.toLowerCase();
    if (p.length > 1) {
      p = p.replace(/\/+$/, '');
      if (p === '') { p = '/'; }
    }
    return p.substring(0, 512);
  }

  function normalizeReferrerHost(ref) {
    if (!ref) { return 'direct'; }
    var a = document.createElement('a');
    a.href = ref;
    var host = (a.hostname || '').toLowerCase();
    if (!host) { return 'direct'; }
    if (host.indexOf('www.') === 0) { host = host.substring(4); }
    return host.substring(0, 128) || 'direct';
  }

  function detectDeviceType(ua) {
    ua = ua || '';
    if (/iPad|Tablet|PlayBook|Silk/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) {
      return 'tablet';
    }
    if (/Mobi|iPhone|iPod|Android.*Mobile|Windows Phone/i.test(ua)) {
      return 'mobile';
    }
    return 'desktop';
  }

  function getSessRef(siteId) {
    var key = 'vidrank_sess_ref';
    try {
      var v = global.sessionStorage ? global.sessionStorage.getItem(key) : null;
      if (v && v.indexOf(siteId + ':') === 0) { return v; }
      var fresh = siteId + ':' + uuid32();
      if (global.sessionStorage) { global.sessionStorage.setItem(key, fresh); }
      return fresh;
    } catch (e) {
      return siteId + ':' + uuid32();
    }
  }

  var BUFFER_KEY = 'vidrank_tm_buffer';

  function persistBuffer() {
    if (state.consentMode !== 'unset') { return; }
    try { if (global.sessionStorage) { global.sessionStorage.setItem(BUFFER_KEY, JSON.stringify(state.queue)); } } catch (e) { /* noop */ }
  }

  function restoreBuffer() {
    if (state.consentMode !== 'unset') { return; }
    try {
      var raw = global.sessionStorage ? global.sessionStorage.getItem(BUFFER_KEY) : null;
      if (raw) { state.queue = JSON.parse(raw) || []; }
    } catch (e) { /* noop */ }
  }

  function clearBuffer() {
    try { if (global.sessionStorage) { global.sessionStorage.removeItem(BUFFER_KEY); } } catch (e) { /* noop */ }
  }

  function autoFields() {
    var path = global.location ? global.location.pathname : '/';
    return {
      page_path: normalizePagePath(path),
      referrer_host: normalizeReferrerHost(document.referrer),
      device_type: detectDeviceType(navigator.userAgent)
    };
  }

  function applyAutoFields(event) {
    var auto = autoFields();
    for (var k in auto) {
      if (auto.hasOwnProperty(k) && event[k] === undefined) {
        event[k] = auto[k];
      }
    }
    if (event.sess_ref === undefined) {
      event.sess_ref = getSessRef(state.siteId);
    }

    if (event.event_id === undefined) {
      event.event_id = newEventId();
    }
    return event;
  }

  function newEventId() {
    try {
      var buf = new Uint8Array(8);
      (global.crypto || global.msCrypto).getRandomValues(buf);
      var hex = '';
      for (var i = 0; i < buf.length; i++) { hex += ('0' + buf[i].toString(16)).slice(-2); }
      return hex;
    } catch (e) {
      var s = '';
      for (var j = 0; j < 16; j++) { s += '0123456789abcdef'.charAt(Math.floor(Math.random() * 16)); }
      return s;
    }
  }

  function loadManifest(url) {
    if (!url) { return; }
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) { return; }
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            state.manifest = JSON.parse(xhr.responseText);
          } catch (e) {
            if (isDebug()) { console.warn('[telemetry] manifest JSON parse failed, continuing without manifest', e); }
          }
        } else {
          if (isDebug()) { console.warn('[telemetry] manifest load failed (telemetry not blocked; backend is the authoritative sanitizer)', xhr.status); }
        }
      };
      xhr.send(null);
    } catch (e) {
      if (isDebug()) { console.warn('[telemetry] manifest load error (telemetry not blocked)', e); }
    }
  }

  function eventBytes(e) {
    try { return JSON.stringify(e).length; } catch (err) { return MAX_SINGLE_EVENT_BYTES + 1; }
  }

  function enqueue(event) {
    var size = eventBytes(event);
    if (size > MAX_SINGLE_EVENT_BYTES) {

      if (isDebug()) { console.warn('[telemetry] event exceeds 32KB, sending it alone', event.event, size); }
      sendBatch([event], 0);
      return;
    }
    state.queue.push(event);
    while (state.queue.length > MAX_QUEUE) {
      state.queue.shift();
      state.droppedCount++;
      if (isDebug()) { console.warn('[telemetry] queue exceeds 200, dropping oldest events (total ' + state.droppedCount + ')'); }
    }
    persistBuffer();
    scheduleFlush();
  }

  var flushScheduled = false;

  function scheduleFlush() {
    if (flushScheduled) { return; }
    flushScheduled = true;
    setTimeout(function () {
      flushScheduled = false;
      flush();
    }, 0);
  }

  function splitBatches() {
    var batches = [];
    var cur = [];
    var curBytes = 0;
    for (var i = 0; i < state.queue.length; i++) {
      var e = state.queue[i];
      var b = eventBytes(e);
      if (cur.length > 0 && (cur.length + 1 > MAX_BATCH_EVENTS || curBytes + b > MAX_BATCH_BYTES)) {
        batches.push(cur);
        cur = [];
        curBytes = 0;
      }
      cur.push(e);
      curBytes += b;
    }
    if (cur.length > 0) { batches.push(cur); }
    state.queue = [];
    return batches;
  }

  function flush() {
    if (state.consentMode !== 'granted') { return; }
    if (state.sending || state.queue.length === 0) { return; }
    var batches = splitBatches();
    clearBuffer();
    for (var i = 0; i < batches.length; i++) {
      sendBatch(batches[i], 0);
    }
  }

  function sendDecision(name) {
    var isGranted = state.consent === true;
    sendBatch([{ event: name, consent: isGranted }], 0);
  }

  function payloadFor(batch) {
    return JSON.stringify({
      site_id: state.siteId,
      consent: state.consent === true,
      events: batch
    });
  }

  function sendBatch(batch, attempt) {

    var prodHost = false;
    try { prodHost = /(^|\.)solarpmlab\.com$/i.test(global.location.hostname); } catch (e) { }
    if (!prodHost) {
      if (isDebug()) { console.debug('[telemetry] non-production domain, telemetry isolated, skipping send (' + (global.location && global.location.hostname) + ')'); }
      return;
    }
    var body = payloadFor(batch);
    var sent = false;
    try {
      if (navigator.sendBeacon) {

        sent = navigator.sendBeacon(state.endpoint, new Blob([body], { type: 'text/plain;charset=UTF-8' }));
      }
    } catch (e) { sent = false; }
    if (sent) { return; }

    var doFetch = function () {
      fetch(state.endpoint, {
        method: 'POST',
        body: body,
        keepalive: true,
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' }
      }).then(function () {              })
        .catch(function () { retryOrDrop(batch, attempt); });
    };
    try { doFetch(); } catch (e) { retryOrDrop(batch, attempt); }
  }

  function retryOrDrop(batch, attempt) {
    if (attempt < MAX_RETRIES) {
      var delay = Math.round(100 * Math.pow(4, attempt)); // 100ms/400ms/1600ms
      setTimeout(function () { sendBatch(batch, attempt + 1); }, delay);
      state.retryCount++;
    } else {
      state.oversizeCount++;
      if (isDebug()) { console.warn('[telemetry] send failed, retry limit exceeded, dropping (total ' + state.oversizeCount + ')'); }
    }
  }

  function sendPageView() {
    var path = normalizePagePath(global.location ? global.location.pathname : '/');
    if (path === state.lastPagePath) { return; }
    state.lastPagePath = path;
    Telemetry.track('page_view', {});
  }

  function setupAutoPageView() {

    if (document.readyState === 'complete') {
      setTimeout(sendPageView, 0);
    } else {
      global.addEventListener('load', sendPageView);
    }

    var wrap = function (name) {
      var orig = history[name];
      if (typeof orig !== 'function') { return; }
      history[name] = function () {
        var ret = orig.apply(this, arguments);
        try { sendPageView(); } catch (e) {              }
        return ret;
      };
    };
    try {
      wrap('pushState');
      wrap('replaceState');
      global.addEventListener('popstate', sendPageView);
    } catch (e) {                             }
  }

  var Telemetry = {

    init: function (opts) {
      opts = opts || {};
      if (!opts.siteId || !opts.endpoint) {
        if (isDebug()) { console.assert(false, '[telemetry] init missing siteId/endpoint'); }
        return;
      }
      state.siteId = String(opts.siteId);
      state.endpoint = String(opts.endpoint);
      state.consent = opts.consent === true;
      state.consentMode = opts.consentMode === 'granted' || opts.consentMode === 'denied'
        ? opts.consentMode
        : (opts.consent === true ? 'granted' : 'unset');
      if (state.consentMode === 'unset') { restoreBuffer(); }
      state.inited = true;
      if (opts.manifestUrl) { loadManifest(String(opts.manifestUrl)); }
      setupAutoPageView();
      if (isDebug()) { console.info('[telemetry] init ok', state.siteId); }
    },

    track: function (event, payload) {
      if (!state.inited || !event || typeof event !== 'string') { return; }

      if (DECISION_EVENTS[event]) {
        sendDecision(event);
        return;
      }

      if (state.consentMode === 'denied') {
        state.droppedCount++;
        return;
      }
      var e = { event: event };
      payload = payload || {};
      for (var k in payload) {
        if (payload.hasOwnProperty(k)) { e[k] = payload[k]; }
      }
      applyAutoFields(e);

      if (isDebug() && state.manifest && state.manifest.events) {

        var def = state.manifest.events[event];
        console.assert(!!def, '[telemetry] event not registered in manifest: ' + event);
        if (def && def.required_fields) {
          for (var i = 0; i < def.required_fields.length; i++) {
            var f = def.required_fields[i];
            var isAuto = def.auto_fields && def.auto_fields.indexOf(f) !== -1;
            console.assert(isAuto || e[f] !== undefined, '[telemetry] event ' + event + ' missing required field: ' + f);
          }
        }
      }
      enqueue(e);
    },

    setConsent: function (value) {
      var granted = value === true;
      state.consent = granted;
      state.consentMode = granted ? 'granted' : 'denied';
      if (granted) {
        if (state.inited) { flush(); }
      } else {
        state.droppedCount += state.queue.length;
        state.queue = [];
        clearBuffer();
      }
    },

    pageView: function () {
      state.lastPagePath = null;
      sendPageView();
    },

    _diag: function () {
      return {
        siteId: state.siteId,
        sessRef: state.siteId ? getSessRef(state.siteId) : '',
        queue: state.queue.length,
        droppedCount: state.droppedCount,
        oversizeCount: state.oversizeCount,
        retryCount: state.retryCount,
        manifestLoaded: !!state.manifest,
        consent: state.consent,
        consentMode: state.consentMode
      };
    }
  };

  global.Telemetry = Telemetry;
})(typeof window !== 'undefined' ? window : this);
