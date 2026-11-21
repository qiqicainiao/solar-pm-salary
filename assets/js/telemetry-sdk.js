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
    subjectSid: null,
    subjectSidTried: false,
    inited: false,
    utmSent: false,
    vitalsBound: false,
    errorsReported: 0
  };

  /**
   * UTM 白名单（P0-3）：只认这五个键，各截 40 字符。
   * 为什么必须白名单而不是"收集所有 query"：query 里有搜索词、邮箱、token、
   * 用户从别的系统带过来的任何东西。只认这五个键 + 过滤到安全字符 = 渠道归因
   * 够用，同时不会把用户输入写进数据仓库。
   */
  var UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];

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
    var payload = {
      site_id: state.siteId,
      consent: state.consent === true,
      events: batch
    };
    // subject_ref 的前端半边（签核单 §1）：只在**已同意**时生成/上报 sid。
    // 服务端用不轮换 pepper 算 subject_ref；flag 未开时服务端直接忽略该键。
    // 未同意不写 localStorage —— "先把人认下来再问"是明确越界。
    var sid = state.consent === true ? subjectSid() : null;
    if (sid) { payload.sid = sid; }
    return JSON.stringify(payload);
  }

  /**
   * sid = localStorage 里的随机 UUID（不是指纹：清了就换主体，这是假名化的固有限制）。
   * 存储不可用 → null（如实"缺"，不用内存值伪造跨会话稳定性）。
   */
  function subjectSid() {
    if (state.subjectSid !== null) { return state.subjectSid; }
    if (state.subjectSidTried) { return null; }
    state.subjectSidTried = true;
    var key = 'vr_sid_' + (state.siteId || 'site');
    try {
      var v = global.localStorage.getItem(key);
      if (v && /^[0-9a-f-]{8,64}$/.test(v)) { state.subjectSid = v; return v; }
      var sid = uuid32();
      global.localStorage.setItem(key, sid);
      state.subjectSid = sid;
      return sid;
    } catch (e) {
      state.subjectSid = null;
      return null;
    }
  }

  function sendBatch(batch, attempt) {

    // 只在"明确不是真实部署"的地址上隔离上报（本地 / *.pages.dev / *.workers.dev 预览）。
    // 这里原本是白名单 /(^|\.)(lasazhaopin|guomeijiayu)\.com$/：每接一个新站就得记得
    // 回来加域名，忘了就整站静默丢事件（dqfsuite.com 就这样从上线起 0 落库，
    // 页面 200、控制台无错、后端 0 条，任何 HTTP 层监控都看不出来，2026-11-20 实证）。
    // 反过来判定：默认发，只拦非生产主机 —— 新站上线不再需要改 SDK。
    var host = '';
    var proto = '';
    try {
      host = String(global.location.hostname || '');
      proto = String(global.location.protocol || '');
    } catch (e) { }
    var nonProd = proto === 'file:' || !host
      || host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1'
      || /\.local$/i.test(host)
      || /\.(pages|workers)\.dev$/i.test(host);
    if (nonProd) {
      if (isDebug()) { console.debug('[telemetry] non-production domain, telemetry isolated, skipping send (' + host + ')'); }
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
    // 落地页先结掉上一页的 vitals（SPA 路由切页：LCP/CLS 是文档级累积值，
    // 不切分就会把两页的数字混成一条，倒过来污染性能判断）
    flushVitals(path);
    var extra = {};
    // 渠道只在**第一次** page_view 记：后续路由切换 location.search 通常不变，
    // 每页都带一遍只会把同一来源重复计入。
    if (!state.utmSent) {
      extra = readUtm();
      state.utmSent = true;
    }
    Telemetry.track('page_view', extra);
  }

  /** 只从当前 URL 的 query 里取 UTM 白名单键（P0-3）。未同意时不读——由 track 门控兜底。 */
  function readUtm() {
    var out = {};
    var q = '';
    try { q = String((global.location && global.location.search) || ''); } catch (e) { return out; }
    if (!q) { return out; }
    if (q.charAt(0) === '?') { q = q.substring(1); }
    var parts = q.split('&');
    for (var i = 0; i < parts.length; i++) {
      var eq = parts[i].indexOf('=');
      if (eq <= 0) { continue; }
      var k = '';
      var v = '';
      try {
        k = decodeURIComponent(parts[i].substring(0, eq)).toLowerCase();
        v = decodeURIComponent(parts[i].substring(eq + 1).replace(/\+/g, ' '));
      } catch (e) { continue; }
      if (UTM_KEYS.indexOf(k) === -1) { continue; }
      // 含 @ 的整条丢弃：utm_source=某个邮箱 是最常见的 PII 泄漏路径，
      // 过滤成 zhang-x-com 依然可识别，只能整条不记。
      if (v.indexOf('@') !== -1) { continue; }
      v = v.replace(/[^A-Za-z0-9._~\-]/g, '-').replace(/-{2,}/g, '-').substring(0, 40);
      if (v) { out[k] = v; }
    }
    return out;
  }

  // ---------------- P0-1 真实用户 Core Web Vitals ----------------

  var vitals = { path: null, fcp: null, lcp: null, cls: 0, inp: null, ttfb: null, nav: null };
  var vitalsSent = {};

  function perfObserver(type, cb) {
    try {
      if (!global.PerformanceObserver) { return; }
      var po = new global.PerformanceObserver(function (list) { cb(list.getEntries()); });
      po.observe({ type: type, buffered: true });
    } catch (e) { /* 老浏览器不支持该 entry 类型：跳过，不报错 */ }
  }

  function detectNavType() {
    try {
      var navs = global.performance.getEntriesByType('navigation');
      if (navs && navs[0]) {
        vitals.ttfb = Math.round(navs[0].responseStart || 0) || null;
        return navs[0].type || 'navigate';
      }
      var t = global.performance.navigation;
      if (t) {
        return t.type === 1 ? 'reload' : (t.type === 2 ? 'back_forward' : 'navigate');
      }
    } catch (e) { /* noop */ }
    return 'navigate';
  }

  function setupVitals() {
    if (state.vitalsBound) { return; }
    state.vitalsBound = true;
    vitals.path = normalizePagePath(global.location ? global.location.pathname : '/');
    vitals.nav = detectNavType();

    perfObserver('paint', function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].name === 'first-contentful-paint') {
          vitals.fcp = Math.round(entries[i].startTime);
        }
      }
    });
    perfObserver('largest-contentful-paint', function (entries) {
      if (entries.length) { vitals.lcp = Math.round(entries[entries.length - 1].startTime); }
    });
    perfObserver('layout-shift', function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (!entries[i].hadRecentInput) { vitals.cls += entries[i].value; }
      }
    });
    perfObserver('event', function (entries) {
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        if (e.interactionId && e.duration) {
          vitals.inp = Math.max(vitals.inp || 0, Math.round(e.duration));
        }
      }
    });
    // INP 的老实现路径：部分浏览器只给 first-input，至少把首个交互耗时留下
    perfObserver('first-input', function (entries) {
      if (entries.length && !vitals.inp) { vitals.inp = Math.round(entries[0].duration || 0) || null; }
    });

    var onHide = function () { flushVitals(null); };
    try {
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') { onHide(); }
      });
      global.addEventListener('pagehide', onHide);
    } catch (e) { /* noop */ }
  }

  /**
   * 上报当前文档的 vitals。path 参数非空时表示"路由已经切走，结旧页的账"。
   * 同一 path 每文档只发一次（避免 hidden/pagehide 双触发重复计数）。
   * CLS 用 ×1000 的整数：浮点跨语言序列化会有尾差，宁可存整数在读侧除。
   */
  function flushVitals(nextPath) {
    var path = vitals.path;
    if (!path || vitalsSent[path]) { return; }
    var hasAny = vitals.fcp !== null || vitals.lcp !== null || vitals.inp !== null
      || vitals.cls > 0 || vitals.ttfb !== null;
    if (!hasAny) { return; }
    vitalsSent[path] = true;
    var payload = { page_path: path, nav_type: vitals.nav || 'navigate' };
    if (vitals.fcp !== null) { payload.fcp_ms = vitals.fcp; }
    if (vitals.lcp !== null) { payload.lcp_ms = vitals.lcp; }
    if (vitals.cls > 0) { payload.cls_x1000 = Math.round(vitals.cls * 1000); }
    if (vitals.inp !== null) { payload.inp_ms = vitals.inp; }
    if (vitals.ttfb !== null) { payload.ttfb_ms = vitals.ttfb; }
    Telemetry.track('page_vitals', payload);

    // 切页：把累积量归零，新页重新开始记（LCP 会在新页重新触发）
    if (nextPath) {
      vitals.path = nextPath;
      vitals.fcp = null; vitals.lcp = null; vitals.cls = 0; vitals.inp = null;
    }
  }

  // ---------------- P0-2 运行时脚本错误 ----------------

  /** URL → 文件名。**绝不能**把完整 URL 发出去：里面可能有 token/查询串。 */
  function scriptBasename(src) {
    var s = String(src || '');
    if (!s) { return 'unknown'; }
    s = s.split('#')[0].split('?')[0];
    var slash = s.lastIndexOf('/');
    if (slash >= 0) { s = s.substring(slash + 1); }
    // 同源 Astro/Vite 产物形如 BaseLayout.astro_astro_type_script_index_0_lang.DbHLoLfT.js，
    // 保留原名才能定位到具体 chunk；只做长度与字符收敛。
    s = s.replace(/[^A-Za-z0-9._\-]/g, '_').substring(0, 80);
    return s || 'unknown';
  }

  /**
   * 报一次脚本错误。**只报类型/文件名/行列**。
   * 绝不报 message、绝不报 stack 文本：那里会带出用户输入（如解析失败时的原文）、
   * 内部路径、以及第三方 SDK 的调试信息。定位"哪个脚本哪一行挂了"不需要这些。
   */
  function reportJsError(type, script, line, col) {
    if (state.errorsReported >= 20) { return; } // 错误风暴保护：单文档最多 20 条
    var key = type + '|' + script + '|' + line;
    if (state._errKeys === undefined) { state._errKeys = {}; }
    state._errKeys[key] = (state._errKeys[key] || 0) + 1;
    if (state._errKeys[key] > 3) { return; }     // 同一位置循环报错只留前 3 条
    state.errorsReported++;
    Telemetry.track('js_error', {
      error_type: type,
      script: script,
      line: line | 0,
      col: col | 0
    });
  }

  function setupErrorHooks() {
    try {
      // capture=true：资源加载失败不会冒泡，必须在捕获阶段才拿得到
      global.addEventListener('error', function (ev) {
        var t = ev && ev.target;
        if (t && t !== global && t.tagName) {
          // 只报 <script> 资源错误。图片/字体/广告位失败量极大且与产品质量无关。
          if (String(t.tagName).toLowerCase() !== 'script') { return; }
          reportJsError('error', scriptBasename(t.src || ''), 0, 0);
          return;
        }
        reportJsError('error', scriptBasename(ev.filename || ''), ev.lineno, ev.colno);
      }, true);

      global.addEventListener('unhandledrejection', function (ev) {
        // 只从 stack 里抠出文件名，绝不读 reason.message / reason 本身
        var script = 'unknown';
        try {
          var stack = (ev && ev.reason && ev.reason.stack) || '';
          var m = /(?:^|\s|\()((?:https?:\/\/|\/)[^\s):]+?\.js)(?::\d+)*/.exec(String(stack));
          if (m) { script = scriptBasename(m[1]); }
        } catch (e) { /* noop */ }
        reportJsError('unhandledrejection', script, 0, 0);
      });
    } catch (e) { /* noop */ }
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
      // 采集器要在 setupAutoPageView 之前挂好：sendPageView 会先 flushVitals，
      // 那时 vitals.path 必须是当前页，否则第一条 page_vitals 会带空路径。
      // 两者都只挂监听、不发请求，未同意时事件进队列由 track 门控兜底。
      setupVitals();
      setupErrorHooks();
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
