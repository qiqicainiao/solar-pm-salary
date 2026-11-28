/**
 * Solar PM Salary — account + free quota UI（阶段二 P2 的前端接入，2026-11-24）
 *
 * 这一层只做三件事，每件都对应一个"不接就会撒的谎"：
 *
 *   ① 会话：没接账号时，服务端把每次 check 都算成一个匿名设备。
 *      接了之后 `account_id` 才会进信封 —— 订阅、额度、历史才挂得住人。
 *   ② 额度：`check` 的响应里带 `quota_info`（used / remaining / resets_at）。
 *      不显示它就等于让用户在第 4 次点击时突然撞上 403，而前 3 次毫无预警。
 *   ③ 付费墙：只在 `pricing.sellable === true` 的时候给购买按钮。
 *      渠道没开户时 checkout 只会 503，摆一个点了没用的按钮比不做付费墙更伤。
 *
 * 三条硬约束：
 *   · **金额不参与**：价格从 `billing/status` 读（服务端 PlanCatalog 定价），
 *     前端只负责显示；`checkout` 也只传 plan_code，绝不传金额。
 *   · **cookie 靠同源代理**：`/bff/` 是 Pages Function 反代，会话 cookie 由它转发，
 *     所以这里一律 `credentials: 'same-origin'`，不跨域。
 */
(function () {
  /* 站点身份只从「加载本文件的那个 script 标签」读（`data-account-site`）。
   *
   * 九站各有一份 `_site_config.js`，但里面挂的对象名各不相同（`SITE_CONFIG` /
   * `__SITE_CONFIG__` / 各自自定义），从配置对象取站点名会有一半站打空 —— 而打空的
   * 表现是所有 `/bff//account/me` 变成 404、页头永远显示 "Sign in"，看起来像"没登录"。
   * script 标签自己一定在（否则这份代码不会执行），所以它是最可靠的来源。
   *
   * 回退顺序：本标签 → 遥测 SDK 标签的 data-vr-site → window.VR_SITE_ID。
   */
  function resolveSiteId() {
    try {
      var own = document.currentScript || document.querySelector('script[data-account-site]');
      if (own && own.getAttribute) {
        var v = own.getAttribute('data-account-site');
        if (v) return v;
      }
      var vr = document.querySelector('script[data-vr-site]');
      if (vr && vr.getAttribute('data-vr-site')) return vr.getAttribute('data-vr-site');
      if (window.VR_SITE_ID) return String(window.VR_SITE_ID);
    } catch (e) { /* 老浏览器：走下面的告警分支 */ }
    return '';
  }

  var SITE_ID = resolveSiteId();

  /** 同源 /bff/ 路径：唯一来源是站点名，不允许各页面自己拼 */
  function api(action) {
    return '/bff/' + SITE_ID + '/' + action;
  }

  /**
   * 可覆盖文案。默认英文（与 solarpmlab 的成品一致），中文站/双语站在自己的页面里
   * 先设 `window.VR_ACCOUNT_TEXT = { sign_in: '登录', ... }` 再加载本文件即可，
   * 不需要把这份实现复制成九份各自翻译的副本（九份必然漂移）。
   */
  var TEXT = Object.assign({
    sign_in: 'Sign in',
    sign_out: 'Sign out',
    account_title: 'Your account',
    your_account: 'Your account',
    member_since: 'member since',
    guest_title: 'Sign in to see your account',
    guest_body: 'Plan status, renewal date and API keys belong to the account you are signed in with — there is nothing to show until you sign in.',
    create_account: 'Create account',
    free_plan: 'Free plan',
    pro_badge: 'Pro',
    free_badge: 'Free',
    upgrade: 'Upgrade to Pro',
    plan_unavailable: 'Plan unavailable',
    plan_unread: 'We could not read your subscription just now. Reload this page.',
    pro_until: 'Active until',
    pro_line: 'Everything in Free, with no daily limit.',
    free_includes: 'Includes %d free checks per day, no card needed.',
    free_unlimited: 'Early access — every tool is free, no daily limit.',
    not_on_sale: 'Pro is not on sale yet — checkout opens soon.',
    pricing_updating: 'Pricing is being updated — purchases are temporarily closed.',
    test_mode: 'Test mode — no real charge.',
    paid_active_note: 'Your Pro features are on.',
    loading: 'Loading your account…',
    email_label: 'Email',
    password_label: 'Password',
    auth_sub_login: 'Your checks and Pro plan are tied to this account.',
    auth_sub_register: 'One account for your checks and your Pro plan.',
    auth_switch_to_register: 'New here? Create an account',
    auth_switch_to_login: 'Already have an account? Sign in',
    signed_in: 'Signed in.',
    account_created: 'Account created.',
    signed_out: 'Signed out.',

    /* F5：按钮与提示一律由 `entitlement.next_action` 决定，前端不再自己判 isPro() 推文案。
     * 七枚举：none / signup / buy_once / buy_credits / subscribe / unlock_feature / wait。 */
    ent_signup: 'Create a free account',
    ent_buy_once: 'Buy once',
    ent_buy_credits: 'Buy credits',
    ent_unlock: 'Unlock this feature',
    ent_wait: 'Pricing is being adjusted — purchases are paused.',
    cap_locked: 'Included in Pro.'
  }, window.VR_ACCOUNT_TEXT || {});

  /** 只支持 %d / %s：文案表里出现别的占位符就是拼错了，别用模板字符串硬拼 */
  function fmt(tpl, values) {
    return String(tpl).replace(/%[ds]/g, function (m) {
      var v = values.shift();
      return v === undefined || v === null ? '' : String(v);
    });
  }

  if (!SITE_ID) {
    // 页面忘了写 data-account-site：不静默降级（否则表现为"登录了但永远是 Sign in"）
    if (window.console && console.error) {
      console.error('[account] 缺少 data-account-site：<script src=".../account.js" data-account-site="{site_id}"></script>');
    }
  }

  const S = {
    booted: false,
    site_off: false,   // me 返回 404 = 这站没开账号（不是"未登录"）
    user: null,        // account/me 的 data
    billing: null,     // billing/status 的 data
    quota: null,       // 额度状态（来自 status，或 check 响应）
    plans: [],
    // 运行时权益契约（P1，F5 起真接）：回答"下一步干什么 + 还能不能用"。
    // 与 `billing.pricing` 分工不同 —— 那个管"这站能不能收钱"，这个管"这个人该看到什么"。
    ent: null,
    entEtag: '',       // 上次渲染用的 etag（同版本不重画，避免每次进页面闪一下）
    entErr: null,      // 拉不到时的原因（'network' / '404' / …），只用于降级上报
    authMode: 'login',
    busy: false
  };

  const $ = (id) => document.getElementById(id);

  /**
   * 会员页（2026-11-27）：账号/档位/到期日/API key 都只属于"当前这个人"，
   * 所以从首页搬到了独立页 `/account`，页头只留一个入口。
   * 不用 CFG 里的常量：这是同站静态页，写死路径比多一个可能对不上的配置项安全。
   */
  const ACCOUNT_PAGE = '/account';

  /** 账号页的身份由 body[data-page] 说明，不解析 URL（斜杠 / ?paid=1 都会变） */
  function isAccountPage() {
    return document.body && document.body.getAttribute('data-page') === 'account';
  }

  /**
   * `?paid=1` 落在别的页面（旧回跳地址、手工拼的链接）时统一送到账号页。
   * 成功提示只能有一个主人：两处各写一套，早晚会在"钱到了、这边还说 Free"上打架。
   */
  function redirectPaidReturn() {
    if (!queryFlag('paid') || isAccountPage()) return false;
    try {
      window.location.replace(ACCOUNT_PAGE + '?paid=1');
    } catch (e) {
      window.location.href = ACCOUNT_PAGE + '?paid=1';
    }
    return true;
  }

  /**
   * `/pricing` 的 "Subscribe" 链接带 `?plan=pro_monthly` 过来。
   * 读一次就够：登录成功后要接着进 checkout，不能因为 URL 没变就重复触发。
   */
  let consumedPlan = '';

  /**
   * `?paid=1` 回跳后的轮询状态。
   *
   * 渠道回跳只带一个标记，**不是付款证据**（谁都能手工加）；真正算数的是
   * `billing/status` 的 `paid`，而它由 webhook 落库后才变。webhook 通常 1–5 秒到，
   * 慢的时候十几秒 —— 不等它，用户就会停在"钱扣了、页面还显示 Free"这一屏然后来问。
   */
  const PAID_POLL = { attempts: 0, max: 20, everyMs: 3000, timer: null };

  function queryFlag(name) {
    try {
      return new URLSearchParams(window.location.search).get(name) === '1';
    } catch (e) {
      return false;
    }
  }

  /** S7：不可售时把 `?plan=` 从地址栏摘掉，避免刷新重复触发，也避免旧链接继续传播 */
  function stripPlanParam() {
    try {
      const p = new URLSearchParams(window.location.search);
      if (!p.has('plan')) return;
      p.delete('plan');
      const q = p.toString();
      window.history.replaceState(null, '', window.location.pathname + (q ? '?' + q : ''));
    } catch (e) {
      // 老浏览器没有 replaceState：参数留着只影响观感，不影响判据
    }
  }

  function pendingPlan() {
    if (consumedPlan) return '';
    try {
      const p = new URLSearchParams(window.location.search).get('plan') || '';
      return /^pro_(monthly|yearly)$/.test(p) ? p : '';
    } catch (e) {
      return '';
    }
  }

  /**
   * 从定价页/旧邮件/书签过来的 `?plan=pro_monthly`。
   *
   * S7：判据必须是 `pricing.sellable === true`（原来的 `purchasable` 在 S0 期仍为 true，
   * 手工拼一个 URL 就能绕过页面直接进结账）。不可售时**吃掉参数、清掉 URL、只 toast**，
   * 绝不发 `/billing/checkout` —— 页面没有入口，不等于用户点不到。
   */
  async function resumePendingPlan() {
    const plan = pendingPlan();
    if (!plan) return;

    if (!isSellable()) {
      consumedPlan = plan;
      stripPlanParam();
      toast(TEXT.not_on_sale, 'info');
      return;
    }

    // 已经 Pro 的人不要再进结账页：后端会 409，但让他一路点到付款页再被弹回，
    // 观感是"这站在坑我钱"。如实说清楚，并把 URL 参数吃掉，避免刷新重复触发。
    if (isPro()) {
      consumedPlan = plan;
      stripPlanParam();
      toast('You already have Pro — nothing was charged.', 'info');
      return;
    }
    if (S.user && S.user.logged_in) {
      consumedPlan = plan;
      await startCheckout(plan);
      return;
    }
    // 真的可售、但还没登录：带到注册/登录，登录完会再走到这里进 checkout
    openAuth('register');
  }

  // ---------------------------------------------------------------- 基础

  function toast(msg, kind) {
    const el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'toast show' + (kind ? ' ' + kind : '');
    setTimeout(() => el.classList.remove('show'), 3200);
  }

  async function req(url, opts) {
    opts = opts || {};
    const init = {
      method: opts.body ? 'POST' : 'GET',
      credentials: 'same-origin',
      headers: {}
    };
    if (opts.body) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    try {
      const resp = await fetch(url, init);
      let env = null;
      try { env = await resp.json(); } catch (e) { env = null; }
      return { status: resp.status, env: env };
    } catch (e) {
      return { status: 0, env: null };
    }
  }

  function bizOk(res) {
    if (!res || !res.env) return false;
    const code = res.env.code;
    return res.status === 200 && (code === 0 || code === '0');
  }

  function planName(code) {
    const p = S.plans.filter(function (x) { return x.plan_code === code; })[0];
    return p ? p.name : (code === 'pro_yearly' ? 'Pro (yearly)' : 'Pro');
  }

  function priceText(plan) {
    if (!plan) return '';
    const amount = (plan.price_cents / 100);
    const symbol = (plan.currency || 'usd').toLowerCase() === 'usd' ? '$' : '';
    const fixed = amount % 1 === 0 ? String(amount) : amount.toFixed(2);
    return symbol + fixed;
  }

  function intervalLabel(plan) {
    if (!plan) return '';
    return plan.billing_interval === 'year' ? '/year' : '/month';
  }

  /** 距离重置还有多久（用服务端给的 epoch，避免浏览器时区/时钟漂移造成的"已重置"假象） */
  function resetsInText(epochSec) {
    if (!epochSec) return '';
    const ms = epochSec * 1000 - Date.now();
    if (ms <= 0) return 'resetting now';
    const totalMin = Math.ceil(ms / 60000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h <= 0) return m + 'm';
    return h + 'h' + (m ? ' ' + m + 'm' : '');
  }

  function isPro() {
    // 有 billing/status 就以它为准，不要再用 quota 兜底 —— 两个字段来自同一份服务端数据，
    // 混着判会在"订阅已失效但额度快照还没刷新"时把免费用户显示成 Pro（假绿比假红更贵：
    // 他以为有权限，点下去 403）。只有状态接口整个拿不到时才退回额度里的 plan。
    if (S.billing) return S.billing.paid === true;
    if (S.quota && S.quota.plan === 'pro') return true;
    return false;
  }

  /**
   * 把服务端的 `YYYY-MM-DD HH:MM:SS` 格式化成 "Dec 24, 2026"。
   *
   * 刻意**不**用 `new Date(...)`：这个字符串没有时区，`new Date('2026-12-24 18:47:39')`
   * 在 Safari 直接 Invalid Date，在别处又会按浏览器本地时区解释 —— 同一个人换个时区
   * 就看到不同的到期日。字符串切分没有这个问题。
   */
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtYmd(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
    if (!m) return '';
    const idx = parseInt(m[2], 10) - 1;
    if (!MONTHS[idx]) return '';
    return MONTHS[idx] + ' ' + parseInt(m[3], 10) + ', ' + m[1];
  }

  // ---------------------------------------------------------------- 数据

  async function loadMe() {
    const res = await req(api('account/me'));
    if (bizOk(res) && res.env.data) {
      S.user = res.env.data;
    } else if (res.status === 404) {
      // 404 = 这站没开账号（sites.account_enabled=0），不是"未登录"。混成未登录会让页头
      // 永远画一个点不开的 Sign in（D1）。记下来后由 renderSlot / boot 整块清空。
      if (!S.site_off && window.console && console.info) {
        console.info('[account] ' + SITE_ID + ' 未开放账号（account/me 返回 404）：不显示登录入口');
      }
      S.site_off = true;
      S.user = { logged_in: false };
    } else {
      S.user = { logged_in: false, degraded: true };
    }
  }

  async function loadStatus() {
    const res = await req(api('billing/status'));
    if (!bizOk(res) || !res.env.data) {
      // 拿不到计费状态时**不显示任何"升级"入口**：宁可少一个 CTA，
      // 也不要让人点了之后才发现买不了。
      S.billing = null;
      S.plans = [];
      return;
    }
    S.billing = res.env.data;
    S.plans = Array.isArray(S.billing.plans) ? S.billing.plans : [];
    if (S.billing.quota) S.quota = S.billing.quota;
  }

  /**
   * 运行时权益契约（F5，`GET /{site}/entitlement`，后端 P1 已上线）。
   *
   * 三件不能用别的东西替代的事：
   *   ① 「下一步干什么」由服务端说（七枚举），前端不再自己 `isPro()` 推一遍 ——
   *      两个地方各推一次，改一次模型就要改九个站。
   *   ② 次数由 `meter.limit` 说。`limit === null` 就是「不限」，此时**整句不出现**；
   *      前端把 `used` 拿来算「还剩几次」是本项目踩过的坑（"3 of 3" 硬编码）。
   *   ③ 判不了时服务端给 `degraded:true`，这时按**最宽松**放行并上报 ——
   *      接口抖动把人锁死，比少拦一个免费用户贵得多（与 `sellable` 的 fail-closed 方向相反）。
   */
  async function loadEntitlement() {
    if (S.site_off) { S.ent = null; return; }
    const res = await req(api('entitlement'));
    if (bizOk(res) && res.env.data && typeof res.env.data.next_action === 'string') {
      S.ent = res.env.data;
      S.entErr = null;
      return;
    }
    // 拉不到（404/500/网络）：不伪造一份「免费用户」，交给 entDegraded() 统一降级
    if (S.ent === null) S.entErr = res.status ? String(res.status) : 'network';
  }

  /** 契约不可用（没拿到 / 服务端说 degraded）→ 一律按最宽松放行。 */
  function entDegraded() {
    if (!S.ent) return true;
    return S.ent.degraded === true;
  }

  /** 七枚举里当前这一个。空串 = 契约不可用 → 调用方沿用旧判据（最宽松）。 */
  function nextAction() {
    if (!S.ent || typeof S.ent.next_action !== 'string') return '';
    return S.ent.next_action;
  }

  /** 与 V1/后端同口径：`limit === null` 即不限，绝不当成 0。 */
  function meterOf() {
    if (S.ent && S.ent.meter && typeof S.ent.meter === 'object') return S.ent.meter;
    return S.quota;
  }

  /**
   * `entitlement.meter.resets_at` 是 ISO 8601（带时区），`quota_info` 是 epoch 秒 ——
   * 两种形态都要能喂给 `resetsInText()`，否则"几分钟后重置"会算成 NaN。
   */
  function meterResetEpoch(m) {
    if (!m) return 0;
    if (typeof m.resets_at_epoch === 'number') return m.resets_at_epoch;
    if (!m.resets_at) return 0;
    const t = Date.parse(String(m.resets_at));
    return isNaN(t) ? 0 : Math.floor(t / 1000);
  }

  async function boot() {
    if (S.booted) return;
    S.booted = true;
    // 先判回跳再发请求：这一页马上就要跳走，没必要先拉两份状态
    if (redirectPaidReturn()) return;
    await Promise.all([loadMe(), loadStatus()]);
    // entitlement 必须排在 loadMe 之后：`next_action` 取决于"这个人是谁"。
    // 与 status 并行能省一次往返，但未登录/登录两种结果会撞在一起 —— 不值。
    await loadEntitlement();
    renderAll();
    reportPricingSeen();
    reportEntDegraded();
    // 404（这站没开账号）：不弹登录框、不处理 ?paid / ?plan，页头也不留入口
    if (S.site_off) return;
    startSellableWatch();
    if (queryFlag('signin') && !(S.user && S.user.logged_in)) openAuth('login');
    // 账号页是"只有登录会员才看得到内容"的页面：没登录直接把登录框递到面前，
    // 而不是让人读一段"请登录"再去找按钮
    if (isAccountPage() && !(S.user && S.user.logged_in)) openAuth('login');
    await handlePaidReturn();
    await resumePendingPlan();
  }

  async function refresh() {
    await Promise.all([loadMe(), loadStatus()]);
    await loadEntitlement();
    renderAll();
    reportEntDegraded();
  }

  // §9.1②：sellable 从 false 变 true 时前端自动刷新，不依赖用户手动刷新页面。
  // 触发：① 定价/账号页标签页重新可见（visibilitychange hidden→visible）；② 定价页未开卖时低频轮询。
  let SELLABLE_WATCH = { started: false, pollTimer: null, pollEveryMs: 5 * 60 * 1000 };

  function isPricingPage() {
    return document.body && document.body.getAttribute('data-page') === 'pricing';
  }

  async function recheckSellable() {
    const wasSellable = isSellable();
    try {
      await loadStatus();
      try { await loadEntitlement(); } catch (e) { /* 契约失败不影响"能不能卖"的判断 */ }
    } catch (e) {
      // 网络抖动：保留当前渲染，不因一次失败就清掉已开卖的卡片
      return;
    }
    renderIfChanged();
    // 定价状态翻转时重置上报闸门，让新状态再上报一次（同一状态不重复上报）
    if (wasSellable !== isSellable()) pricingReported = false;
    reportPricingSeen();
    reportEntDegraded();
  }

  function scheduleSellablePoll() {
    if (SELLABLE_WATCH.pollTimer) { clearTimeout(SELLABLE_WATCH.pollTimer); SELLABLE_WATCH.pollTimer = null; }
    // 只在定价页且当前不可卖时轮询；开卖后 renderAll 已长出卡片，即停
    if (!isPricingPage() || isSellable()) return;
    SELLABLE_WATCH.pollTimer = setTimeout(function () {
      recheckSellable().then(scheduleSellablePoll);
    }, SELLABLE_WATCH.pollEveryMs);
  }

  function startSellableWatch() {
    if (SELLABLE_WATCH.started) return;
    SELLABLE_WATCH.started = true;
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && (isPricingPage() || isAccountPage())) recheckSellable();
    });
    scheduleSellablePoll();
  }

  // ---------------------------------------------------------------- 功能位（F5.4）

  /**
   * 功能位只有 `capabilities` 一个真相源：**不许**自己读 `plans[].features` 推一遍。
   * 那些 `features` 在服务端没有执行点，照它画锁就会画出"页面上锁着、接口照样给"。
   */
  function caps() {
    if (S.ent && S.ent.capabilities && typeof S.ent.capabilities === 'object') {
      return S.ent.capabilities;
    }
    // 契约不可用 → 全开（fail-open，与后端同方向）
    return { export: true, batch: true, api: true, history: true };
  }

  function can(cap) {
    return caps()[cap] !== false;
  }

  /**
   * 给受控元素加锁/解锁。
   *
   * 约定：任何「高级功能」元素写 `data-cap="export|batch|api|history"` 即受控，
   * 站点脚本要自查时用 `window.VR_CAP.can('export')`。本文件不猜 id ——
   * 九站 DOM 各不相同，猜 id 的结果是"改了九个站才有一个真锁上"。
   *
   * 锁的表现是 `disabled` + `aria-disabled` + 标题说明，**不隐藏**：
   * 藏起来会让人以为功能没了，而不是"要升级"。
   */
  function applyCapabilities() {
    const nodes = document.querySelectorAll('[data-cap]');
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      const cap = el.getAttribute('data-cap');
      if (!cap) continue;
      const ok = can(cap);
      /*
       * 「解锁」只许撤自己的锁，不许替站点打开它本来就关着的功能。
       *
       * 站点自己的按钮常常默认 disabled（要在一次渲染之后才可用，比如 audiogram 的
       * Download / Copy caption）。早先这里直接 `el.disabled = !ok`，于是在
       * capabilities 全开（= 几乎所有时候）时把那些按钮**提前打开**了：
       * 用户点到一个还没有内容可导出的按钮，看起来是"功能坏了"。
       * 所以第一次碰到这个元素时记下它当时的状态，解锁时只还原到那个状态。
       */
      if (el.dataset.vrCapPrev === undefined) {
        el.dataset.vrCapPrev = el.disabled ? '1' : '0';
      }
      if (ok) {
        el.disabled = el.dataset.vrCapPrev === '1';
      } else {
        el.disabled = true;
      }
      el.setAttribute('aria-disabled', ok ? 'false' : 'true');
      if (ok) {
        el.removeAttribute('title');
        el.classList.remove('is-locked');
      } else {
        el.setAttribute('title', TEXT.cap_locked);
        el.classList.add('is-locked');
      }
    }
    window.VR_CAP = { can: can, caps: caps, apply: applyCapabilities };
  }

  // ---------------------------------------------------------------- 埋点

  /** 上报走站点已有的通道（`VR.track` / `Telemetry.track`），不发明新接口。 */
  function trackEvent(name, payload) {
    try {
      if (window.VR && typeof window.VR.track === 'function') {
        window.VR.track(name, payload);
      } else if (window.Telemetry && typeof window.Telemetry.track === 'function') {
        window.Telemetry.track(name, payload);
      }
    } catch (e) { /* 埋点失败不影响页面 */ }
  }

  let entReported = '';
  /**
   * 契约降级上报（F5.5）。没有它，"接口抖动时放行了谁"永远查不到 ——
   * 降级放行本身是对的，但它必须是可见的，否则和"真的不限"长得一模一样。
   */
  function reportEntDegraded() {
    if (!entDegraded()) return;
    const state = S.ent ? 'degraded' : (S.entErr || 'missing');
    if (entReported === state) return;
    entReported = state;
    trackEvent('entitlement_degraded', { site: SITE_ID, reason: state });
  }

  // ---------------------------------------------------------------- 渲染

  function renderAll() {
    // 记账放在渲染里，而不是放在 renderIfChanged 里：任何直接调 renderAll 的路径
    // （首帧、支付回跳）也必须把 etag 记下来，否则下一次轮询会重复画一遍。
    S.entEtag = (S.ent && S.ent.etag) ? String(S.ent.etag) : '';
    renderSlot();
    renderQuota();
    renderProPanel();
    renderAccountPage();
    renderPricingPage();
    applyCapabilities();
  }

  /**
   * etag 没变就不重画（F5.7）：同一份配置连续进两次页面，不该闪一下。
   * 首帧（还没有 etag）必须画；etag 缺失时也画（宁可多画一次，也不留空白页）。
   */
  function renderIfChanged() {
    const tag = (S.ent && S.ent.etag) ? String(S.ent.etag) : '';
    if (tag !== '' && tag === S.entEtag) return;
    renderAll();
  }

  // ---------------------------------------------------------------- 定价判据

  /** billing/status.pricing 块（B1 未上线时为空对象） */
  function pricingBlock() {
    return (S.billing && S.billing.pricing) ? S.billing.pricing : {};
  }

  /**
   * 唯一判据：严格等于 true 才能渲染任何付费元素。
   * 字段缺失 / 接口失败 / false 一律按"不可卖"（fail-closed）。
   */
  function isSellable() {
    return pricingBlock().sellable === true;
  }

  /**
   * 七枚举 → 按钮文案（F5.2）。**前端不做"哪个档位该买"的推理**，只把服务端的意思翻成字。
   * 契约不可用（`act === ''`）时沿用旧的 Upgrade 文案：这是最宽松的那一条，
   * 而不是"什么都不画"——什么都不画会让九站在接口抖动时看起来像不能买。
   */
  function ctaLabel(act) {
    switch (act) {
      case 'signup': return TEXT.ent_signup;
      case 'buy_once': return TEXT.ent_buy_once;
      case 'buy_credits': return TEXT.ent_buy_credits;
      case 'unlock_feature': return TEXT.ent_unlock;
      case 'subscribe': return TEXT.upgrade;
      default: return TEXT.upgrade;
    }
  }

  /** 会员页档位卡下方的一句话（§7 第 6/12 条）。只影响文案，不影响布局。 */
  function pricingNoticeText() {
    if (!S.billing) return '';
    if (isSellable()) return '';
    const p = pricingBlock();
    if (p.state === 'on_sale') return TEXT.pricing_updating;
    const n = p.notice ? String(p.notice) : '';
    if (n.length > 60) return n.slice(0, 60) + '…';
    return n || TEXT.not_on_sale;
  }

  /**
   * 定价页（F2b）：骨架已在 DOM 里、默认 hidden，内容与显隐全由接口决定。
   * sellable !== true 时只显示"现在免费"两句，不拉任何结账相关请求。
   */
  function renderPricingPage() {
    if (!(document.body && document.body.getAttribute('data-page') === 'pricing')) return;

    const notes = $('pricing-free-note');
    const plans = $('pricing-plans');
    const tm = $('pricing-testmode');
    const sellable = isSellable();

    // 这段文案会被 `wait` 分支改写，所以先记下 HTML 里的原文：
    // 不记的话，一次"计费调整中"之后只要刷新一次状态，页面上就永久留着那句话。
    if (notes && notes.getAttribute('data-vr-orig') === null) {
      notes.setAttribute('data-vr-orig', notes.textContent);
    }

    if (tm) tm.hidden = true;
    if (notes) {
      notes.hidden = sellable;
      if (!sellable) notes.textContent = notes.getAttribute('data-vr-orig') || '';
    }
    if (!plans) return;

    if (!sellable) {
      plans.textContent = '';
      plans.hidden = true;
      return;
    }

    // F5.2：`wait`（计费调整中）= 页面**无价格、无按钮**。
    // 画一个禁用的购买按钮会让人以为是网络问题、反复刷新；明说"调整中"才是诚实的。
    const act = nextAction();
    if (act === 'wait') {
      plans.textContent = '';
      plans.hidden = true;
      if (notes) {
        notes.hidden = false;
        notes.textContent = TEXT.ent_wait;
      }
      return;
    }
    // `none` = 这个人不需要做任何事（已付费，或这个模型本来就没有"下一步"）→ 不画收银台
    if (act === 'none') {
      plans.textContent = '';
      plans.hidden = true;
      return;
    }

    // 价格只来自 plans[]；取不到就整块不渲染，不回退任何默认价。
    // 真实 plans[] 里还有 Free（price_cents=0、sellable=false）：免费档不是付费卡，
    // 绝不能给它配一个购买 CTA，所以只画"price>0 且未被标记为不可售"的档位。
    const list = (S.plans || []).filter(function (x) {
      return x && typeof x.price_cents === 'number' && x.price_cents > 0 && x.sellable !== false;
    });
    if (!list.length) {
      plans.textContent = '';
      plans.hidden = true;
      if (notes) notes.hidden = false;
      return;
    }

    plans.textContent = '';
    list.forEach(function (plan) {
      const card = document.createElement('div');
      card.className = 'pricing-plan';

      const name = document.createElement('h2');
      name.className = 'pricing-plan-name';
      name.textContent = plan.name || plan.plan_code || plan.code || '';
      card.appendChild(name);

      const price = document.createElement('p');
      price.className = 'pricing-plan-price';
      price.textContent = priceText(plan) + ' ' + intervalLabel(plan);
      card.appendChild(price);

      const cta = document.createElement('button');
      cta.type = 'button';
      cta.className = 'btn btn-primary';
      cta.textContent = ctaLabel(act);
      cta.addEventListener('click', function () {
        // `signup` 是免费动作：开注册弹层，不要拉结账（画一个点下去 401 的按钮更差）
        if (act === 'signup') { openAuth('register'); return; }
        startCheckout(plan.plan_code || plan.code);
      });
      card.appendChild(cta);

      if (S.billing && S.billing.simulated === true) {
        const note = document.createElement('p');
        note.className = 'account-note account-testmode';
        note.textContent = TEXT.test_mode;
        card.appendChild(note);
      }

      plans.appendChild(card);
    });
    plans.hidden = false;
  }

  let pricingReported = false;
  /**
   * F5.6：拿到配置后上报一次"用户看到的是哪一版定价"。
   *
   * 事件名从 `pricing_state_seen` 改为 `pricing_config_seen`（§6/§8 的口径），
   * 并补 `pricing_version` —— 它来自 `entitlement.pricing_version`（运行时真实生效的那一版），
   * 而不是 `billing.pricing.version`（配置页面的版本）：灰度期间两者可以不同，
   * 核对"我配的和我看到的"必须用前者。
   */
  function reportPricingSeen() {
    if (pricingReported) return;
    pricingReported = true;
    const p = pricingBlock();
    const ent = S.ent || {};
    trackEvent('pricing_config_seen', {
      site: SITE_ID,
      state: p.state || null,
      preset: ent.preset || p.preset || null,
      pricing_version: (typeof ent.pricing_version === 'number') ? ent.pricing_version : null,
      version: (typeof p.version === 'number') ? p.version : null,
      sellable: p.sellable === true
    });
  }

  function renderSlot() {
    const slot = $('account-slot');
    if (!slot) return;
    slot.innerHTML = '';
    if (S.site_off) return; // 这站没开账号：槽位保持空，不画 Sign in

    const loggedIn = !!(S.user && S.user.logged_in);

    if (!loggedIn) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'account-link';
      btn.textContent = TEXT.sign_in;
      btn.addEventListener('click', function () { openAuth('login'); });
      slot.appendChild(btn);
      return;
    }

    // 邮箱与 Pro 徽标都是「我的账号」的入口：账号相关的东西全在 /account，
    // 页头只负责带路。用链接而不是按钮，用户能中途开新标签页。
    const who = document.createElement('a');
    who.className = 'account-who';
    who.href = ACCOUNT_PAGE;
    who.title = TEXT.your_account;
    who.textContent = (S.user && S.user.email_masked) ? S.user.email_masked : TEXT.sign_in;
    slot.appendChild(who);

    if (isPro()) {
      const badge = document.createElement('a');
      badge.className = 'account-badge';
      badge.href = ACCOUNT_PAGE;
      badge.title = TEXT.your_account + ' — ' + TEXT.pro_badge;
      badge.textContent = TEXT.pro_badge;
      slot.appendChild(badge);
    }

    const out = document.createElement('button');
    out.type = 'button';
    out.className = 'account-link';
    out.textContent = TEXT.sign_out;
    out.addEventListener('click', signOut);
    slot.appendChild(out);
  }

  /**
   * 免费额度的文案（一处生成、两处挂载：首页额度行 + 账号页档位卡）。
   * 前端不算次数，只翻译服务端给的 used/limit/resets_at —— 数字一律来自接口。
   *
   * `limit === null` = 不限（P01 或判不了）：**整句不出现**，不许写成 "3 of 3"。
   */
  function freeQuotaText(q) {
    if (!q || q.limit === null || q.limit === undefined) return '';
    const resetTxt = resetsInText(meterResetEpoch(q));
    if (q.is_blocked) {
      return 'Free checks for today are used up' + (resetTxt ? ' · resets in ' + resetTxt : '');
    }
    return q.remaining + ' of ' + q.limit + ' free checks left today'
      + (resetTxt ? ' · resets in ' + resetTxt : '');
  }

  function renderQuota() {
    const line = $('quota-line');
    if (!line) return;

    // 额度以 `entitlement.meter` 为权威；契约不可用时退回 `quota_info`（旧字段仍在）。
    const q = meterOf();
    if (!q) {
      line.hidden = true;
      return;
    }

    // 付费：不显示次数（避免"还剩 987 次"这种没意义的读数），但要告诉他买到什么时候 ——
    // 订阅到期后会自动回到免费档，用户有权知道是哪一天（不该靠"哪天突然不能用了"发现）。
    if (isPro() || q.limit === null) {
      const until = isPro() && S.billing ? fmtYmd(S.billing.current_period_end) : '';
      line.textContent = isPro()
        ? ('Pro — unlimited checks' + (until ? ' · active until ' + until : ''))
        : '';
      line.hidden = line.textContent === '';
      line.classList.remove('is-blocked');
      return;
    }

    line.hidden = false;
    line.classList.toggle('is-blocked', q.is_blocked === true);
    line.textContent = freeQuotaText(q);
  }

  // ---------------------------------------------------------------- 账号页

  /**
   * `/account`：只画"当前这个人"的东西。
   *
   * 三档状态必须分得比"Pro / Free"更细：
   *   paid === true  → 已开通，说到期日
   *   paid === false → 确定是免费档，说还剩几次
   *   paid === null  → 读不到（DB/接口抖动），只能说"没读到"，**不许**降级成 Free
   *                    （把付费用户显示成免费是真实伤害，和把免费显示成 Pro 一样贵）
   */
  function renderAccountPage() {
    if (!isAccountPage()) return;

    const loading = $('account-loading');
    if (loading) loading.hidden = true;

    const guest = $('account-guest');
    const box = $('account-signedin');
    const closed = $('account-closed');

    // 站点没开账号（me 返回 404）：只给一句话，别让人反复点登录
    if (S.site_off) {
      if (closed) closed.hidden = false;
      if (guest) guest.hidden = true;
      if (box) box.hidden = true;
      return;
    }
    if (closed) closed.hidden = true;

    const loggedIn = !!(S.user && S.user.logged_in);
    if (guest) guest.hidden = loggedIn;
    if (box) box.hidden = !loggedIn;
    if (!loggedIn) return;

    setText('account-email', (S.user && S.user.email_masked) ? S.user.email_masked : 'Signed in');

    const since = fmtYmd(S.user && S.user.since);
    const sinceWrap = $('account-since-wrap');
    if (sinceWrap) sinceWrap.hidden = !since;
    if (since) setText('account-since', since);

    const badge = $('account-plan-badge');
    const name = $('account-plan-name');
    const line = $('account-plan-line');
    const quota = $('account-quota');
    const manage = $('account-manage');
    const upgrade = $('account-upgrade');
    const testmode = $('account-testmode');
    const notice = $('account-pricing-notice');

    function hidePurchaseUi() {
      if (upgrade) upgrade.hidden = true;
      if (testmode) testmode.hidden = true;
    }

    // 读不到订阅（billing/status 整体失败，或 paid === null）：说"没读到"，不许降级成 Free
    const paidRaw = S.billing ? S.billing.paid : null;
    if (!S.billing || paidRaw === null) {
      if (badge) badge.hidden = true;
      if (name) name.textContent = TEXT.plan_unavailable;
      if (line) line.textContent = 'We could not read your subscription just now. Reload this page — '
        + 'if it keeps failing, email 269715607@qq.com.';
      if (quota) quota.hidden = true;
      if (manage) manage.hidden = true;
      if (notice) notice.hidden = true;
      hidePurchaseUi();
      return;
    }

    const paid = paidRaw === true;
    if (badge) {
      badge.hidden = false;
      badge.textContent = paid ? TEXT.pro_badge : TEXT.free_badge;
      badge.classList.toggle('is-free', !paid);
    }
    if (name) name.textContent = paid ? planName(S.billing.plan || '') : TEXT.free_plan;

    if (paid) {
      const until = fmtYmd(S.billing.current_period_end);
      if (line) {
        line.textContent = (until ? TEXT.pro_until + ' ' + until + '. ' : '')
          + TEXT.pro_line;
      }
      // 付费档不显示"还剩 N 次"：那是免费额度，混在一起看会以为 Pro 也有上限
      if (quota) quota.hidden = true;
      if (manage) manage.hidden = false;
      if (notice) notice.hidden = true;
      hidePurchaseUi(); // 已开通的人不需要 Upgrade
      return;
    }

    // 免费档
    const daily = S.billing.free_quota_daily;
    if (line) {
      // 撤限（free_quota_daily === null）时整句换成 Early access；
      // 只有整数才套 free_includes 模板（否则会印出 "Includes null ..."）。
      line.textContent = (typeof daily === 'number' && daily > 0)
        ? fmt(TEXT.free_includes, [daily])
        : TEXT.free_unlimited;
    }
    const qTxt = freeQuotaText(S.quota);
    if (quota) {
      quota.hidden = qTxt === '';
      quota.textContent = qTxt;
      quota.classList.toggle('is-blocked', !!(S.quota && S.quota.is_blocked === true));
    }
    if (manage) manage.hidden = true;

    // 定价说明（§7 第 6/12 条）：不可售时给一句话，不出现任何价格
    const nTxt = pricingNoticeText();
    if (notice) {
      notice.hidden = nTxt === '';
      notice.textContent = nTxt;
    }

    // 购买入口只在真的能卖、且这个**人**确实需要买时出现（sellable === true 且 next_action 不是 none/wait）。
    // 契约不可用（act === ''）时退回旧判据：宁可多给一个能用的入口，也不要因为接口抖动把它藏掉。
    const act = nextAction();
    const buyable = isSellable() && act !== 'none' && act !== 'wait';
    if (buyable) {
      if (upgrade) {
        upgrade.hidden = false;
        upgrade.textContent = ctaLabel(act);
      }
      if (testmode) testmode.hidden = !(S.billing && S.billing.simulated === true);
    } else {
      hidePurchaseUi();
    }
  }

  function setText(id, text) {
    const el = $(id);
    if (el) el.textContent = text;
  }

  // ---------------------------------------------------------------- 付费墙

  /**
   * 把付费墙画进容器（app.js 在 403 QUOTA_BLOCKED 时调用）。
   * 规则：能买才给购买按钮；不能买就说清楚"还没开放"+ 多久重置。
   */
  function showPaywall(container) {
    if (!container) return;
    container.innerHTML = '';

    const card = document.createElement('section');
    card.className = 'paywall';
    card.setAttribute('role', 'region');
    card.setAttribute('aria-label', 'Free limit reached');

    const eyebrow = document.createElement('p');
    eyebrow.className = 'paywall-eyebrow';
    eyebrow.textContent = 'Daily free limit';
    card.appendChild(eyebrow);

    const h = document.createElement('h3');
    h.textContent = "You've used today's free checks";
    card.appendChild(h);

    const q = S.quota || {};
    const resetTxt = resetsInText(q.resets_at_epoch);
    const p = document.createElement('p');
    // S4：撤限后 q.limit 是 null，不能再用 `|| 3` 兜底 —— 那会把已撤掉的限制重新宣布出来。
    // 有整数才说次数，否则只说"用完了"。
    const hasLimit = (q.limit !== null && q.limit !== undefined);
    p.textContent = (hasLimit ? 'The free plan includes ' + q.limit + ' checks per day.' : 'You have reached the free limit.')
      + (resetTxt ? ' Your quota resets in ' + resetTxt + '.' : '')
      + ' Nothing is lost — come back later.';
    card.appendChild(p);

    // 计划卡片：价格只显示，不运算（金额由服务端 PlanCatalog 决定）
    const sellable = S.plans.filter(function (x) { return x.sellable === true; });
    if (sellable.length) {
      const wrap = document.createElement('div');
      wrap.className = 'paywall-plans';
      sellable.forEach(function (plan) {
        const box = document.createElement('div');
        box.className = 'paywall-plan' + (plan.billing_interval === 'year' ? ' is-featured' : '');

        const name = document.createElement('p');
        name.className = 'paywall-plan-name';
        name.textContent = plan.name;
        box.appendChild(name);

        const price = document.createElement('p');
        price.className = 'paywall-plan-price';
        price.textContent = priceText(plan) + ' ' + intervalLabel(plan);
        box.appendChild(price);

        if (plan.billing_interval === 'year') {
          const per = document.createElement('p');
          per.className = 'paywall-plan-note';
          per.textContent = 'about ' + priceText({ price_cents: Math.round(plan.price_cents / 12), currency: plan.currency }) + '/month';
          box.appendChild(per);
        }
        wrap.appendChild(box);
      });
      card.appendChild(wrap);
    }

    const actions = document.createElement('div');
    actions.className = 'paywall-actions';

    // 判据只有 pricing.sellable === true（D5）。purchasable 只表示"配了真产品"，
    // S0 期 solar 仍为 true，用它画按钮等于把已下架的东西挂回货架。
    if (isSellable() && sellable.length) {
      const buy = document.createElement('button');
      buy.type = 'button';
      buy.className = 'btn btn-primary';
      buy.textContent = 'Go unlimited with Pro';
      buy.addEventListener('click', function () {
        // 默认买月付；年付在卡片上更划算，但点了"升级"的人想的是先试一个月
        const monthly = sellable.filter(function (x) { return x.billing_interval === 'month'; })[0];
        startCheckout((monthly || sellable[0]).plan_code);
      });
      actions.appendChild(buy);
      // S5：模拟渠道下每个 CTA 下方都要标注，免得让人以为真扣款
      if (S.billing && S.billing.simulated === true) {
        const tm = document.createElement('p');
        tm.className = 'account-note account-testmode';
        tm.textContent = TEXT.test_mode;
        actions.appendChild(tm);
      }
    } else {
      // 买不了就说实话：不放假按钮，也不假装"正在处理"
      const note = document.createElement('p');
      note.className = 'paywall-note';
      note.textContent = 'Pro is not on sale yet — checkout opens soon. Free checks reset every day, so this tool stays usable meanwhile.';
      card.appendChild(note);
    }

    if (!(S.user && S.user.logged_in)) {
      const signin = document.createElement('button');
      signin.type = 'button';
      signin.className = 'btn btn-secondary';
      signin.textContent = 'Sign in';
      signin.addEventListener('click', function () { openAuth('login'); });
      actions.appendChild(signin);
    }

    card.appendChild(actions);
    container.appendChild(card);
    container.hidden = false;
  }

  // ---------------------------------------------------------------- 网络限额

  /**
   * 匿名身份日限（403 ABUSE_CAPPED）—— 与"额度用尽"是两件事，必须分开讲：
   *   · QUOTA_BLOCKED = 你自己的 3 次用完了 → 付费墙；
   *   · ABUSE_CAPPED = 这个网络今天启动的免费次数太多（共享出口 / 有人在刷）→ 登录即可继续。
   *
   * 不把两者混成一个文案，是因为它们的出路不同：前者只能等重置或付费，后者登录就能继续。
   * 服务端按 `ip|ua` 计身份，共享出口（公司网 / 移动网络）下真实用户会被别人的用量连累，
   * 所以这里**必须**给登录入口 —— 没有出路的 403 就是把人赶走。
   */
  function showNetworkCap(container, capInfo) {
    if (!container) return;
    container.innerHTML = '';

    const card = document.createElement('section');
    card.className = 'paywall';
    card.setAttribute('role', 'region');
    card.setAttribute('aria-label', 'Network limit reached');

    const eyebrow = document.createElement('p');
    eyebrow.className = 'paywall-eyebrow';
    eyebrow.textContent = 'Network limit';
    card.appendChild(eyebrow);

    const h = document.createElement('h3');
    h.textContent = 'Free checks from this network are paused';
    card.appendChild(h);

    const cap = capInfo || {};
    const resetTxt = resetsInText(cap.resets_at_epoch);
    const p = document.createElement('p');
    p.textContent = 'Too many free checks were started from your network today'
      + (resetTxt ? '. The network limit resets in ' + resetTxt : '')
      + '. Your own free checks are counted per account, so signing in gets you going again right away.';
    card.appendChild(p);

    const actions = document.createElement('div');
    actions.className = 'paywall-actions';

    if (!(S.user && S.user.logged_in)) {
      const signin = document.createElement('button');
      signin.type = 'button';
      signin.className = 'btn btn-primary';
      signin.textContent = 'Sign in';
      signin.addEventListener('click', function () { openAuth('login'); });
      actions.appendChild(signin);

      const create = document.createElement('button');
      create.type = 'button';
      create.className = 'btn btn-secondary';
      create.textContent = 'Create free account';
      create.addEventListener('click', function () { openAuth('register'); });
      actions.appendChild(create);
    }

    if (actions.childNodes.length) card.appendChild(actions);
    container.appendChild(card);
    container.hidden = false;
  }

  // ---------------------------------------------------------------- 购买

  async function startCheckout(planCode) {
    if (S.busy) return;
    const plan = S.plans.filter(function (x) { return x.plan_code === planCode; })[0];
    if (!plan) return;

    S.busy = true;
    const res = await req(api('billing/checkout'), { body: { plan: planCode } });
    S.busy = false;

    if (bizOk(res)) {
      const url = res.env.data && res.env.data.checkout_url;
      if (url) { location.href = url; return; }
      toast('Checkout is not ready yet. Please try again later.', 'error');
      return;
    }

    if (res.status === 401) {
      openAuth('login');
      return;
    }

    if (res.status === 409) {
      // 服务端说"你已经订阅了"：这可能来自旧标签页、收藏的 /?plan= 链接、或连点两次。
      // 先把状态刷新成真的再说话，别让界面继续显示"可购买"。
      await refresh();
      const d = (res.env && res.env.data) || {};
      const until = d.current_period_end ? fmtYmd(d.current_period_end) : '';
      toast('You already have Pro' + (until ? ' until ' + until : '') + '. Nothing was charged.', 'info');
      return;
    }

    if (res.status === 503) {
      // 渠道没配 / 报文翻译没实现：把状态同步下来，别让按钮继续骗人
      renderAll();
      toast('Pro is not on sale yet. We are opening checkout soon.', 'error');
      return;
    }

    const msg = (res.env && res.env.msg) ? String(res.env.msg) : '';
    toast(msg && msg !== 'ok' ? 'Could not start checkout: ' + msg : 'Could not start checkout. Please retry.', 'error');
  }

  // ---------------------------------------------------------------- 登录/注册

  function openAuth(mode) {
    S.authMode = mode === 'register' ? 'register' : 'login';
    const modal = $('auth-modal');
    if (!modal) return;
    modal.hidden = false;
    document.body.classList.add('modal-open');
    syncAuthMode();
    const email = $('auth-email');
    if (email) email.focus();
  }

  function closeAuth() {
    const modal = $('auth-modal');
    if (!modal) return;
    modal.hidden = true;
    document.body.classList.remove('modal-open');
    setAuthError('');
  }

  function syncAuthMode() {
    const isLogin = S.authMode === 'login';
    const title = $('auth-title');
    const sub = $('auth-sub');
    const submit = $('auth-submit');
    const sw = $('auth-switch');
    const pw = $('auth-password');
    if (title) title.textContent = isLogin ? TEXT.sign_in : TEXT.create_account;
    if (sub) sub.textContent = isLogin ? TEXT.auth_sub_login : TEXT.auth_sub_register;
    if (submit) submit.textContent = isLogin ? TEXT.sign_in : TEXT.create_account;
    if (sw) sw.textContent = isLogin ? TEXT.auth_switch_to_register : TEXT.auth_switch_to_login;
    if (pw) pw.setAttribute('autocomplete', isLogin ? 'current-password' : 'new-password');
    setAuthError('');
  }

  function setAuthError(msg) {
    const el = $('auth-error');
    if (!el) return;
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  function authErrorText(status, env) {
    const reason = env && env.msg ? String(env.msg) : '';
    // 注册日限（服务端闸二）：要如实说"这个网络今天注册太多了"，而不是含糊的"稍后再试"——
    // 前者用户知道该换网络或明天再来，后者只会让人反复点。
    if (env && env.code === 'SIGNUP_CAPPED') return 'Too many accounts were created from this network today. Try again tomorrow, or sign in if you already have one.';
    if (status === 409 || reason === 'email_taken') return 'That email is already registered. Sign in instead.';
    if (status === 429 || reason === 'too_many_attempts') return 'Too many attempts. Please wait a few minutes.';
    if (reason === 'invalid_credentials') return 'Email or password is incorrect.';
    if (reason === 'invalid_email') return 'That email address looks invalid.';
    if (reason === 'weak_password') return 'Password must be at least 8 characters and not a common one.';
    if (status === 404) return 'Sign-in is not available on this site yet.';
    if (status === 0) return 'Network error. Please retry.';
    return reason ? 'Could not continue: ' + reason : 'Could not continue. Please retry.';
  }

  async function submitAuth(evt) {
    if (evt) evt.preventDefault();
    if (S.busy) return;
    const email = ($('auth-email') || {}).value || '';
    const password = ($('auth-password') || {}).value || '';
    if (!email || !password) {
      setAuthError('Email and password are required.');
      return;
    }

    S.busy = true;
    const submit = $('auth-submit');
    if (submit) submit.disabled = true;

    const url = S.authMode === 'login' ? api('account/login') : api('account/register');
    const res = await req(url, { body: { email: email, password: password } });

    S.busy = false;
    if (submit) submit.disabled = false;

    if (bizOk(res)) {
      closeAuth();
      await refresh();
      toast(S.authMode === 'login' ? TEXT.signed_in : TEXT.account_created, 'ok');
      const form = $('auth-form');
      if (form) form.reset();
      // 从付款页回跳后引导登录的人：登录完成就该看到"已开通"，而不是停在"请登录"
      await handlePaidReturn();
      // 从 /pricing 点 "Subscribe" 过来的：登录完直接进 checkout，不再让他找一遍按钮
      await resumePendingPlan();
      return;
    }
    setAuthError(authErrorText(res.status, res.env));
  }

  async function signOut() {
    await req(api('account/logout'), { body: {} });
    keysLoaded = false;
    const secretBox = $('api-key-secret');
    if (secretBox) secretBox.hidden = true;
    banner('', 'info');
    await refresh();
    toast(TEXT.signed_out, 'ok');
  }

  /** app.js 在每次 check 成功后把新的额度状态交过来（服务端算的，不用本地加减） */
  function onQuota(quotaInfo) {
    if (!quotaInfo) return;
    S.quota = quotaInfo;
    renderQuota();
    // 登录态可能在别处变化过（比如另一个标签页登出），顺手校一次槽位
    renderSlot();
  }

  // ---------------------------------------------------------------- 付款回跳

  const BANNER_STYLE = {
    ok: 'max-width:760px;margin:16px auto 0;padding:12px 16px;border:1px solid #bfe3c8;background:#effaf1;color:#175c2b;border-radius:10px;font-size:.95rem;line-height:1.5;',
    info: 'max-width:760px;margin:16px auto 0;padding:12px 16px;border:1px solid #c7d7f5;background:#f2f6ff;color:#1e3a8a;border-radius:10px;font-size:.95rem;line-height:1.5;',
    warn: 'max-width:760px;margin:16px auto 0;padding:12px 16px;border:1px solid #f3d6a0;background:#fdf7ec;color:#7a4a06;border-radius:10px;font-size:.95rem;line-height:1.5;'
  };

  function banner(text, kind) {
    const box = $('paid-banner');
    if (!box) return;
    box.textContent = '';
    if (!text) {
      box.hidden = true;
      return;
    }
    box.style.cssText = BANNER_STYLE[kind] || BANNER_STYLE.info;
    box.textContent = text;
    box.hidden = false;
  }

  function paidActiveText() {
    const until = (S.billing && S.billing.current_period_end) ? fmtYmd(S.billing.current_period_end) : '';
    return 'Pro is active' + (until ? ' until ' + until : '')
      + '. ' + (TEXT.paid_active_note || 'Your Pro features are on.');
  }

  /** 确认已开通后把 ?paid=1 摘掉：留着它，刷新一次就重放一遍提示，像在反复邀功 */
  function clearPaidParam() {
    if (PAID_POLL.timer) {
      clearTimeout(PAID_POLL.timer);
      PAID_POLL.timer = null;
    }
    try {
      const p = new URLSearchParams(window.location.search);
      p.delete('paid');
      const q = p.toString();
      window.history.replaceState(null, '', window.location.pathname + (q ? '?' + q : ''));
    } catch (e) {
      // 老浏览器没有 replaceState：参数留着只影响观感，不影响权限判断
    }
  }

  async function handlePaidReturn() {
    if (!queryFlag('paid')) return;
    if (isPro()) {
      banner(paidActiveText(), 'ok');
      clearPaidParam();
      return;
    }
    if (!(S.user && S.user.logged_in)) {
      // 没登录时无从判断是谁付的款：只提示去登录，绝不宣告"已收到"
      banner('If you just paid, sign in with the email you used at checkout to unlock Pro.', 'info');
      return;
    }
    // 措辞刻意不写 "Payment received"：?paid=1 只是个参数，凭它宣告收款等于给任何人
    // 一个伪造成功页的能力。等 isPro() 为真才说"已开通"，之前只说"正在核对"。
    banner('Checking your payment with Creem — this page updates by itself once Pro is active.', 'info');
    PAID_POLL.attempts = 0;
    pollPaid();
  }

  function pollPaid() {
    if (PAID_POLL.attempts >= PAID_POLL.max) {
      banner('Creem has not confirmed this payment yet. Wait a couple of minutes and reload — '
        + 'if Pro still is not active, email 269715607@qq.com with your receipt number.', 'warn');
      return;
    }
    PAID_POLL.attempts += 1;
    PAID_POLL.timer = setTimeout(async function () {
      await loadStatus();
      renderAll();
      if (isPro()) {
        banner(paidActiveText(), 'ok');
        clearPaidParam();
        return;
      }
      pollPaid();
    }, PAID_POLL.everyMs);
  }

  // ---------------------------------------------------------------- Pro 面板

  /** key 列表只自动拉一次：每次 onQuota 都发请求会把限流额度浪费在刷新自己上 */
  let keysLoaded = false;

  function renderProPanel() {
    const panel = $('pro-panel');
    if (!panel) return;
    if (!(S.user && S.user.logged_in) || !isPro()) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;

    // 这里**不**判 `capabilities.api`：这个面板只有 Pro 看得见，而服务端对付费用户
    // 的四个能力位恒为全开（`Entitlement::capabilities()` 的显式分支）。在这里加一个
    // 永远走不到的分支，就是本项目反复删掉的"恒定假状态"。真要锁 api，锁的是
    // 免费用户的入口，那不在这个面板里 —— 用 `data-cap="api"` 标在对应元素上即可。

    if (!keysLoaded) {
      keysLoaded = true;
      loadKeys();
    }
  }

  async function loadKeys() {
    const list = $('api-key-list');
    if (!list) return;
    const res = await req(api('account/api-keys'));
    list.textContent = '';

    if (!bizOk(res)) {
      list.appendChild(note('Could not load your API keys. Reload the page to retry.'));
      return;
    }
    const keys = ((res.env.data || {}).keys) || [];
    const live = keys.filter(function (k) { return !k.revoked_at; });
    if (!live.length) {
      list.appendChild(note('No API key yet. Create one to call the estimate endpoint from your own scripts.'));
      return;
    }
    live.forEach(function (k) { list.appendChild(keyRow(k)); });
  }

  function note(text) {
    const p = document.createElement('p');
    p.style.cssText = 'margin:0 0 .5rem;color:#6b7280;font-size:.9rem';
    p.textContent = text;
    return p;
  }

  function keyRow(k) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;'
      + 'padding:.5rem 0;border-top:1px solid #f1f2f4';

    const name = document.createElement('code');
    name.textContent = String(k.key_prefix || '') + '…';
    row.appendChild(name);

    const meta = document.createElement('span');
    meta.style.cssText = 'color:#6b7280;font-size:.86rem;flex:1 1 220px';
    meta.textContent = (k.label ? k.label + ' · ' : '')
      + 'created ' + (fmtYmd(k.created_at) || '—')
      + (k.last_used_at ? ' · last used ' + fmtYmd(k.last_used_at) : ' · never used');
    row.appendChild(meta);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-secondary';
    btn.textContent = 'Revoke';
    btn.addEventListener('click', function () { revokeKey(k.key_id, btn); });
    row.appendChild(btn);

    return row;
  }

  async function revokeKey(keyId, btn) {
    if (S.busy) return;
    S.busy = true;
    if (btn) btn.disabled = true;
    const res = await req(api('account/api-keys/revoke'), { body: { key_id: keyId } });
    S.busy = false;
    if (bizOk(res)) {
      toast('API key revoked.', 'ok');
      await loadKeys();
      return;
    }
    if (btn) btn.disabled = false;
    toast('Could not revoke that key. Please retry.', 'error');
  }

  async function createKey() {
    if (S.busy) return;
    S.busy = true;
    const res = await req(api('account/api-keys'), { body: { label: 'dashboard' } });
    S.busy = false;

    if (!bizOk(res)) {
      toast('Could not create an API key. Please retry.', 'error');
      return;
    }

    const secret = (((res.env.data || {}).key) || {}).secret || '';
    const box = $('api-key-secret');
    if (box && secret) {
      box.textContent = '';
      box.style.cssText = 'margin-top:.8rem;padding:12px 14px;border:1px solid #f3d6a0;'
        + 'background:#fdf7ec;border-radius:10px;color:#7a4a06;font-size:.9rem';

      const warn = document.createElement('p');
      warn.style.cssText = 'margin:0 0 .5rem';
      warn.textContent = 'Copy this key now — it is shown once and cannot be retrieved later.';
      box.appendChild(warn);

      const code = document.createElement('code');
      code.style.cssText = 'display:block;word-break:break-all;background:#fff;padding:8px 10px;'
        + 'border-radius:6px;border:1px solid #eadfc8;color:#111';
      code.textContent = secret;
      box.appendChild(code);

      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'btn btn-secondary';
      copy.style.cssText = 'margin-top:.6rem';
      copy.textContent = 'Copy key';
      copy.addEventListener('click', function () {
        copyText(secret).then(function (ok) {
          toast(ok ? 'Key copied.' : 'Select the key above and copy it manually.', ok ? 'ok' : 'error');
        });
      });
      box.appendChild(copy);

      box.hidden = false;
    }

    await loadKeys();
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return false; });
    }
    return Promise.resolve(false);
  }

  // ---------------------------------------------------------------- 对外

  window.VRAccount = {
    boot: boot,
    refresh: refresh,
    onQuota: onQuota,
    showPaywall: showPaywall,
    showNetworkCap: showNetworkCap,
    openAuth: openAuth,
    startCheckout: startCheckout,
    isPro: isPro,
    createKey: createKey,
    state: S
  };

  // entitlement 已在 boot() 里由 `loadEntitlement()` 真接（F5）。
  // 旧的 `window.VR_ENTITLEMENT_HOOK` 空位到此删除：留着它，站点脚本会以为
  // "这里还有个由我接管的入口"，而实际上契约已经由本文件统一拉取与渲染。

  // 旧名保留一个版本，免得已上线的 app.js 立刻断；下一轮统一删。
  window.SolarAccount = window.VRAccount;

  window.addEventListener('load', function () {
    // 表单已就绪后再拉会话：避免 POST 抢在 cookie 之前
    boot();

    const form = $('auth-form');
    if (form) form.addEventListener('submit', submitAuth);

    const close = $('auth-close');
    if (close) close.addEventListener('click', closeAuth);

    const switchBtn = $('auth-switch');
    if (switchBtn) {
      switchBtn.addEventListener('click', function () {
        S.authMode = S.authMode === 'login' ? 'register' : 'login';
        syncAuthMode();
      });
    }

    const modal = $('auth-modal');
    if (modal) {
      modal.addEventListener('click', function (e) {
        if (e.target === modal) closeAuth();
      });
    }

    const createBtn = $('api-key-create');
    if (createBtn) createBtn.addEventListener('click', createKey);

    // 账号页的未登录态：两个按钮都开弹层，不跳回首页（跳走会丢掉"我在看账号页"的上下文）
    const guestSignin = $('account-signin');
    if (guestSignin) guestSignin.addEventListener('click', function () { openAuth('login'); });
    const guestRegister = $('account-register');
    if (guestRegister) guestRegister.addEventListener('click', function () { openAuth('register'); });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeAuth();
    });
  });
})();
