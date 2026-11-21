/**
 * telemetry-result-hooks.js —— 结果页事件的通用运行时（v1，2026-11-19）
 *
 * 为什么需要这个文件（而不是改 9 个站各自的业务代码）：
 *   ① `subject_ref` 需要前端带上 `sid`（localStorage 随机 UUID），但 9 个站的埋点各写各的，
 *      逐个改 buildPayload 等于 9 次回归风险；
 *   ② `export` / `result_rerun` / `result_copied` 在多数站根本没埋（实测：export 全站 0 注册）；
 *   ③ 结果页事件（viewed/dwell）依赖各站自己的 DOM 结构，写死选择器必然随改版失效。
 *
 * 做法：**在传输层做旁路**，不碰业务代码
 *   · 拦 fetch / sendBeacon 的 /track 请求，识别出站内已有的 `tool_completed` / `check_completed`
 *     等"结果已产生"信号 → 从那一刻起开始计时；
 *   · 顺带把 `sid` 注入该批次的顶层（服务端据此算 subject_ref，前端无法伪造 subject_ref）；
 *   · 由本文件自己补发 `result_viewed` / `result_dwell` / `result_rerun` / `result_copied` / `export`。
 *
 * 边界（必须遵守，否则等于绕过同意）：
 *   · 只在识别到 `consent === true` 的批次后才做任何事；`consent === false` 一律不发；
 *   · 不采集任何新字段（无 IP/UA/Canvas/指纹），只发上面 5 个已注册事件；
 *   · 不改业务请求（只对 URL 以 `/track` 结尾的请求生效）；
 *   · 任何异常静默吞掉，绝不影响页面功能。
 *
 * 接入（每个站一行，放在自己的埋点脚本**之后**）：
 *   <script src="/js/telemetry-result-hooks.js" defer></script>
 *
 * 服务端权威：事件名/字段必须在 config/sites/{site}/site.json 注册，
 * 字段必须在 config/semantic_map/{site}.json 有分级，否则被 EventSchema 丢弃（B25 的反面）。
 */
(function (global) {
  'use strict';

  if (global.__VR_RESULT_HOOKS__) { return; }
  global.__VR_RESULT_HOOKS__ = true;

  // 视为"结果已产生"的事件名（各站命名不同，同一含义只列一次）
  var RESULT_TRIGGERS = {
    tool_completed: 1, check_completed: 1, generate_completed: 1,
    audit_completed: 1, extract_success: 1, generate_success: 1,
    result_ready: 1, analysis_completed: 1, report_ready: 1
  };
  // 各站自己已经发过的结果事件：识别到就不再代发（避免重复计数）
  var SELF_EMITTED = {
    result_viewed: 1, result_dwell: 1, result_rerun: 1, result_copied: 1, export: 1
  };

  var state = {
    siteId: '', endpoint: '', consent: false, sessRef: '',
    sid: null, sidTried: false,
    resultAt: 0, rerunSeq: 1, maxDepth: 0, viewedSent: false,
    dwellSent: false, pending: [], learned: false
  };

  function now() { return Date.now(); }
  function warn(msg) {
    try { if (global.console && /[?&]debug/.test(global.location.search || '')) { console.warn('[vr-hooks] ' + msg); } } catch (e) { }
  }

  function uuid32() {
    var hex = '0123456789abcdef', out = '', buf = new Uint8Array(16), i;
    if (global.crypto && global.crypto.getRandomValues) { global.crypto.getRandomValues(buf); }
    else { for (i = 0; i < 16; i++) { buf[i] = Math.floor(Math.random() * 256); } }
    for (i = 0; i < 16; i++) { out += hex[buf[i] >> 4] + hex[buf[i] & 15]; }
    out = out.substring(0, 12) + '4' + out.substring(13, 16) + hex[(parseInt(out[16], 16) & 3) | 8] + out.substring(17);
    return out;
  }

  /**
   * sid：跨会话假名主体（签核单 §1）。**只在 consent=true 时生成/持久化**——
   * 未同意就写 localStorage 等于"先把人认下来再问"，是明确的越界。
   */
  function subjectSid() {
    if (state.sid !== null) { return state.sid; }
    if (state.sidTried) { return null; }
    state.sidTried = true;
    var key = 'vr_sid_' + (state.siteId || 'site');
    try {
      var v = global.localStorage.getItem(key);
      if (v && /^[0-9a-f-]{8,64}$/.test(v)) { state.sid = v; return v; }
      var sid = uuid32();
      global.localStorage.setItem(key, sid);
      state.sid = sid;
      return sid;
    } catch (e) {
      state.sid = null;
      return null;   // 存储不可用 → 不写 subject_ref（如实"缺"，不伪造）
    }
  }

  function pagePath() {
    var p = String((global.location && global.location.pathname) || '/').split('?')[0].split('#')[0];
    if (p.charAt(0) !== '/') { p = '/' + p; }
    p = p.toLowerCase();
    if (p.length > 1) { p = p.replace(/\/+$/, '') || '/'; }
    return p.substring(0, 512);
  }

  function referrerHost() {
    try {
      if (!global.document.referrer) { return 'direct'; }
      var h = new URL(global.document.referrer).hostname.toLowerCase();
      if (h.indexOf('www.') === 0) { h = h.substring(4); }
      return h || 'direct';
    } catch (e) { return 'direct'; }
  }

  function deviceType() {
    var ua = (global.navigator && global.navigator.userAgent) || '';
    if (/iPad|Tablet|PlayBook|Silk/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) { return 'tablet'; }
    if (/Mobi|iPhone|iPod|Android.*Mobile|Windows Phone/i.test(ua)) { return 'mobile'; }
    return 'desktop';
  }

  function scrollDepth() {
    try {
      var h = global.document.documentElement;
      var total = Math.max(h.scrollHeight, global.document.body ? global.document.body.scrollHeight : 0);
      if (total <= 0) { return 100; }
      var seen = (global.pageYOffset || h.scrollTop || 0) + (global.innerHeight || 0);
      var pct = Math.min(100, Math.round((seen / total) * 100));
      if (pct >= 90) { return 100; }
      if (pct >= 60) { return 75; }
      if (pct >= 30) { return 50; }
      return 25;
    } catch (e) { return 25; }
  }

  /** 直接向 /track 发一批（不带业务字段，只有本文件代发的事件） */
  function send(events) {
    if (!state.consent || !events.length || !state.siteId || !state.endpoint) { return; }
    var payload = {
      site_id: state.siteId,
      consent: true,
      sess_ref: state.sessRef || (state.siteId + ':' + uuid32()),
      page_path: pagePath(),
      device_type: deviceType(),
      referrer_host: referrerHost(),
      events: events
    };
    var sid = subjectSid();
    if (sid) { payload.sid = sid; }
    var body = JSON.stringify(payload);
    try {
      if (events.length === 1 && global.navigator && global.navigator.sendBeacon) {
        var ok = global.navigator.sendBeacon(state.endpoint, new Blob([body], { type: 'application/json' }));
        if (ok) { return; }
      }
    } catch (e) { /* 落 fetch */ }
    try {
      global.fetch(state.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        keepalive: true,
        credentials: 'omit'
      }).catch(function () { });
    } catch (e) { /* 静默 */ }
  }

  function emit(name, fields) {
    var ev = { event: name };
    Object.keys(fields || {}).forEach(function (k) { ev[k] = fields[k]; });
    send([ev]);
  }

  /** 从一批出站事件里学习站点/端点，并识别"结果已产生" */
  function observe(payload, url) {
    if (!payload || typeof payload !== 'object') { return; }
    if (payload.site_id && !state.siteId) { state.siteId = String(payload.site_id); }
    if (url && !state.endpoint) { state.endpoint = String(url).split('?')[0]; }
    if (!state.learned) {
      // 端点里通常带 site id：/{site}/track
      var m = /\/([a-z0-9-]+)\/track\/?$/.exec(state.endpoint || '');
      if (!state.siteId && m) { state.siteId = m[1]; }
      if (state.siteId && state.endpoint) { state.learned = true; }
    }
    var consent = payload.consent === true;
    state.consent = consent;
    if (!consent) { return; }          // 拒绝/未决策：本文件什么也不发
    if (payload.sess_ref && typeof payload.sess_ref === 'string') { state.sessRef = payload.sess_ref; }
    subjectSid();                      // 同意已确认，此时才允许落 sid

    var events = Array.isArray(payload.events) ? payload.events : [];
    var sawTrigger = false, sawViewed = false, sawDwell = false;
    for (var i = 0; i < events.length; i++) {
      var name = events[i] && (events[i].event || events[i].type);
      if (!name) { continue; }
      if (RESULT_TRIGGERS[name]) { sawTrigger = true; }
      if (name === 'result_viewed') { sawViewed = true; state.viewedSent = true; }
      if (name === 'result_dwell') { sawDwell = true; state.dwellSent = true; }
    }
    if (!sawTrigger) { return; }

    var t = now();
    if (state.resultAt > 0) {
      // 同一页面会话内第二次出结果 = 复跑（改了参数再跑，Q6 的核心信号）
      state.rerunSeq++;
      emit('result_rerun', {
        rerun_seq: state.rerunSeq,
        interval_seconds: Math.max(0, Math.round((t - state.resultAt) / 1000))
      });
    }
    state.resultAt = t;
    state.dwellSent = false;
    state.maxDepth = 0;
    if (!sawViewed && !state.viewedSent) {
      state.viewedSent = true;
      emit('result_viewed', {});
      if (sawDwell) { state.dwellSent = true; }
    }
  }

  function flushDwell(useBeacon) {
    if (state.resultAt <= 0 || state.dwellSent || !state.consent) { return; }
    var secs = Math.max(0, Math.round((now() - state.resultAt) / 1000));
    if (secs < 1) { return; }          // 秒级跳出不算停留（避免污染中位数）
    state.dwellSent = true;
    var depth = Math.max(state.maxDepth, scrollDepth());
    var ev = { event: 'result_dwell', dwell_seconds: secs, scrolled_depth: depth };
    if (useBeacon) {
      send([ev]);
    } else {
      emit('result_dwell', { dwell_seconds: secs, scrolled_depth: depth });
    }
  }

  // ---------------------------------------------------------------- 传输层旁路
  function patchFetch() {
    if (!global.fetch || global.fetch.__vrPatched) { return; }
    var orig = global.fetch;
    var patched = function (input, init) {
      try {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        if (/\/track(\?|$)/.test(url) && init && typeof init.body === 'string') {
          var body = init.body;
          var j = null;
          try { j = JSON.parse(body); } catch (e) { j = null; }
          if (j && j.site_id) {
            var before = j.consent;
            observe(j, url);
            if (j.consent === true) {
              var sid = subjectSid();
              if (sid && !j.sid) {
                j.sid = sid;
                init = Object.assign({}, init, { body: JSON.stringify(j) });
              }
            } else if (before !== j.consent) {
              init = Object.assign({}, init, { body: JSON.stringify(j) });
            }
          }
        }
      } catch (e) { /* 一律不影响原请求 */ }
      return orig.call(this, input, init);
    };
    patched.__vrPatched = true;
    global.fetch = patched;
  }

  function patchBeacon() {
    if (!global.navigator || !global.navigator.sendBeacon || global.navigator.sendBeacon.__vrPatched) { return; }
    var orig = global.navigator.sendBeacon.bind(global.navigator);
    var patched = function (url, data) {
      try {
        if (/\/([a-z0-9-]+)\/track(\?|$)/.test(String(url)) && data) {
          // Blob 需异步读出；同步路径放弃注入（下一批 fetch 会补上），不阻塞卸载
          if (typeof data === 'string') {
            var j = JSON.parse(data);
            observe(j, url);
            if (j.consent === true) {
              var sid = subjectSid();
              if (sid && !j.sid) { data = new Blob([JSON.stringify(Object.assign({}, j, { sid: sid }))], { type: 'application/json' }); }
            }
          }
        }
      } catch (e) { /* 静默 */ }
      return orig(url, data);
    };
    patched.__vrPatched = true;
    global.navigator.sendBeacon = patched;
  }

  // ---------------------------------------------------------------- 结果页行为
  function bindCopy() {
    if (!global.document) { return; }
    global.document.addEventListener('copy', function () {
      if (state.resultAt <= 0) { return; }     // 只有"看到过结果"才算复制结果
      emit('result_copied', { copy_format: 'text_summary' });
    }, true);
  }

  var EXPORT_RE = /(export|download|导出|下载|保存)/i;
  function guessFormat(el) {
    var hint = '';
    try {
      hint = (el.getAttribute && (el.getAttribute('download') || el.getAttribute('data-export') || el.getAttribute('href') || '') || '')
        + ' ' + (el.textContent || '');
    } catch (e) { }
    hint = hint.toLowerCase();
    if (/\.json|json/.test(hint)) { return 'json'; }
    if (/\.csv|csv/.test(hint)) { return 'csv'; }
    if (/\.pdf|pdf/.test(hint)) { return 'pdf'; }
    if (/\.png|\.jpg|\.jpeg|\.svg|png|图片/.test(hint)) { return 'png'; }
    if (/\.txt|text|txt/.test(hint)) { return 'text'; }
    return 'other';
  }

  function bindExport() {
    if (!global.document) { return; }
    global.document.addEventListener('click', function (ev) {
      if (state.resultAt <= 0) { return; }
      var el = ev.target;
      var hit = null;
      while (el && el !== global.document) {
        var tag = (el.tagName || '').toLowerCase();
        var dl = el.hasAttribute && (el.hasAttribute('download') || el.hasAttribute('data-export'));
        var blob = el.getAttribute && /^blob:/.test(el.getAttribute('href') || '');
        if (dl || blob || ((tag === 'a' || tag === 'button') && EXPORT_RE.test(el.textContent || ''))) { hit = el; break; }
        el = el.parentNode;
      }
      if (hit) { emit('export', { export_format: guessFormat(hit) }); }
    }, true);
  }

  function bindDwell() {
    if (!global.document) { return; }
    global.document.addEventListener('scroll', function () {
      if (state.resultAt <= 0) { return; }
      var d = scrollDepth();
      if (d > state.maxDepth) { state.maxDepth = d; }
    }, { passive: true });

    global.document.addEventListener('visibilitychange', function () {
      if (global.document.visibilityState === 'hidden') { flushDwell(true); }
    });
    global.addEventListener('pagehide', function () { flushDwell(true); });
  }

  function boot() {
    bindCopy();
    bindExport();
    bindDwell();
    // 预置配置（可选）：window.__VR_TELEMETRY__ = { siteId, endpoint }
    var cfg = global.__VR_TELEMETRY__;
    if (cfg) {
      if (cfg.siteId) { state.siteId = String(cfg.siteId); }
      if (cfg.endpoint) { state.endpoint = String(cfg.endpoint); }
      if (cfg.consent === true) { state.consent = true; }
      state.learned = !!(state.siteId && state.endpoint);
    }
    if (global.__SITE_CONFIG__ && global.__SITE_CONFIG__.SITE_ID) { state.siteId = state.siteId || global.__SITE_CONFIG__.SITE_ID; }
    if (global.__TP_ENV__ && global.__TP_ENV__.SITE_ID) { state.siteId = state.siteId || global.__TP_ENV__.SITE_ID; }
  }

  // 传输层旁路必须**同步立即生效**：page_view 往往在其他脚本解析时就发出去了，
  // 放到 DOMContentLoaded 会漏掉第一屏（而 uv 的全部样本都来自 page_view）。
  patchFetch();
  patchBeacon();

  if (global.document && global.document.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  global.__VR_RESULT_HOOKS_DIAG__ = function () { return state; };
})(window);
