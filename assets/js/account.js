/**
 * Solar PM Salary — account + free quota UI（阶段二 P2 的前端接入，2026-11-24）
 *
 * 这一层只做三件事，每件都对应一个"不接就会撒的谎"：
 *
 *   ① 会话：没接账号时，服务端把每次 check 都算成一个匿名设备。
 *      接了之后 `account_id` 才会进信封 —— 订阅、额度、历史才挂得住人。
 *   ② 额度：`check` 的响应里带 `quota_info`（used / remaining / resets_at）。
 *      不显示它就等于让用户在第 4 次点击时突然撞上 403，而前 3 次毫无预警。
 *   ③ 付费墙：只在**真的能买到**的时候给购买按钮（`purchasable`）。
 *      渠道没开户时 checkout 只会 503，摆一个点了没用的按钮比不做付费墙更伤。
 *
 * 三条硬约束：
 *   · **金额不参与**：价格从 `billing/status` 读（服务端 PlanCatalog 定价），
 *     前端只负责显示；`checkout` 也只传 plan_code，绝不传金额。
 *   · **cookie 靠同源代理**：`/bff/` 是 Pages Function 反代，会话 cookie 由它转发，
 *     所以这里一律 `credentials: 'same-origin'`，不跨域。
 */
(function () {
  const CFG = window.SITE_CONFIG;

  const S = {
    booted: false,
    user: null,        // account/me 的 data
    billing: null,     // billing/status 的 data
    quota: null,       // 额度状态（来自 status，或 check 响应）
    plans: [],
    purchasable: false,
    authMode: 'login',
    busy: false
  };

  const $ = (id) => document.getElementById(id);

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

  function pendingPlan() {
    if (consumedPlan) return '';
    try {
      const p = new URLSearchParams(window.location.search).get('plan') || '';
      return /^pro_(monthly|yearly)$/.test(p) ? p : '';
    } catch (e) {
      return '';
    }
  }

  /** 从定价页过来的人只差一步：已登录就进 checkout，未登录先让他注册 */
  async function resumePendingPlan() {
    const plan = pendingPlan();
    if (!plan) return;
    // 已经 Pro 的人不要再进结账页：后端会 409，但让他一路点到付款页再被弹回，
    // 观感是"这站在坑我钱"。如实说清楚，并把 URL 参数吃掉，避免刷新重复触发。
    if (isPro()) {
      consumedPlan = plan;
      toast('You already have Pro — nothing was charged.', 'info');
      return;
    }
    if (S.user && S.user.logged_in) {
      consumedPlan = plan;
      await startCheckout(plan);
      return;
    }
    if (S.purchasable) {
      openAuth('register');
    } else {
      // 渠道没开户时不说"请稍后"，直接说事实（与卡片上的文案一致）
      toast('Pro is not on sale yet. We are opening checkout soon.', 'info');
    }
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
    if (S.billing && S.billing.paid === true) return true;
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
    const res = await req(CFG.ACCOUNT_ME_PATH);
    if (bizOk(res) && res.env.data) {
      S.user = res.env.data;
    } else if (res.status === 404) {
      // 站点没开账号（site.json account.enabled=false）：不是错误，静默降级为无账号
      S.user = { logged_in: false };
    } else {
      S.user = { logged_in: false, degraded: true };
    }
  }

  async function loadStatus() {
    const res = await req(CFG.BILLING_STATUS_PATH);
    if (!bizOk(res) || !res.env.data) {
      // 拿不到计费状态时**不显示任何"升级"入口**：宁可少一个 CTA，
      // 也不要让人点了之后才发现买不了。
      S.billing = null;
      S.plans = [];
      S.purchasable = false;
      return;
    }
    S.billing = res.env.data;
    S.plans = Array.isArray(S.billing.plans) ? S.billing.plans : [];
    S.purchasable = S.billing.purchasable === true;
    if (S.billing.quota) S.quota = S.billing.quota;
  }

  async function boot() {
    if (S.booted) return;
    S.booted = true;
    await Promise.all([loadMe(), loadStatus()]);
    renderAll();
    if (queryFlag('signin') && !(S.user && S.user.logged_in)) openAuth('login');
    await handlePaidReturn();
    await resumePendingPlan();
  }

  async function refresh() {
    await Promise.all([loadMe(), loadStatus()]);
    renderAll();
  }

  // ---------------------------------------------------------------- 渲染

  function renderAll() {
    renderSlot();
    renderQuota();
    renderProPanel();
  }

  function renderSlot() {
    const slot = $('account-slot');
    if (!slot) return;
    slot.innerHTML = '';

    const loggedIn = !!(S.user && S.user.logged_in);

    if (!loggedIn) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'account-link';
      btn.textContent = 'Sign in';
      btn.addEventListener('click', function () { openAuth('login'); });
      slot.appendChild(btn);
      return;
    }

    const who = document.createElement('span');
    who.className = 'account-who';
    who.textContent = (S.user && S.user.email_masked) ? S.user.email_masked : 'Signed in';
    slot.appendChild(who);

    if (isPro()) {
      const badge = document.createElement('span');
      badge.className = 'account-badge';
      badge.textContent = 'Pro';
      slot.appendChild(badge);
    }

    const out = document.createElement('button');
    out.type = 'button';
    out.className = 'account-link';
    out.textContent = 'Sign out';
    out.addEventListener('click', signOut);
    slot.appendChild(out);
  }

  function renderQuota() {
    const line = $('quota-line');
    if (!line) return;

    const q = S.quota;
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

    const left = q.remaining;
    const limit = q.limit;
    line.hidden = false;
    line.classList.toggle('is-blocked', q.is_blocked === true);

    if (q.is_blocked) {
      line.textContent = 'Free checks for today are used up · resets in ' + resetsInText(q.resets_at_epoch);
    } else {
      line.textContent = left + ' of ' + limit + ' free checks left today · resets in ' + resetsInText(q.resets_at_epoch);
    }
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
    p.textContent = 'The free plan includes ' + (q.limit || 3) + ' checks per day.'
      + (resetTxt ? ' Your quota resets in ' + resetTxt + '.' : '')
      + ' Nothing is lost — come back later, or go unlimited with Pro.';
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

    if (S.purchasable && sellable.length) {
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
    const res = await req(CFG.BILLING_CHECKOUT_PATH, { body: { plan: planCode } });
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
      S.purchasable = false;
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
    if (title) title.textContent = isLogin ? 'Sign in' : 'Create account';
    if (sub) sub.textContent = isLogin ? 'Your checks and Pro plan are tied to this account.' : 'One account for your checks and your Pro plan.';
    if (submit) submit.textContent = isLogin ? 'Sign in' : 'Create account';
    if (sw) sw.textContent = isLogin ? 'New here? Create an account' : 'Already have an account? Sign in';
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

    const url = S.authMode === 'login' ? CFG.ACCOUNT_LOGIN_PATH : CFG.ACCOUNT_REGISTER_PATH;
    const res = await req(url, { body: { email: email, password: password } });

    S.busy = false;
    if (submit) submit.disabled = false;

    if (bizOk(res)) {
      closeAuth();
      await refresh();
      toast(S.authMode === 'login' ? 'Signed in.' : 'Account created.', 'ok');
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
    await req(CFG.ACCOUNT_LOGOUT_PATH, { body: {} });
    keysLoaded = false;
    const secretBox = $('api-key-secret');
    if (secretBox) secretBox.hidden = true;
    banner('', 'info');
    await refresh();
    toast('Signed out.', 'ok');
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
      + '. Unlimited checks, CSV export and API access are on.';
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
      banner('Payment received. Sign in with the email you used at checkout to unlock Pro.', 'info');
      return;
    }
    banner('Payment received. Activating Pro — this page updates by itself.', 'info');
    PAID_POLL.attempts = 0;
    pollPaid();
  }

  function pollPaid() {
    if (PAID_POLL.attempts >= PAID_POLL.max) {
      banner('Payment received, but Pro has not switched on yet. Wait a couple of minutes and reload — '
        + 'if it still shows Free, email 269715607@qq.com with your receipt number.', 'warn');
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

    const sum = $('pro-summary');
    if (sum) {
      const code = S.billing && S.billing.plan ? S.billing.plan : '';
      const name = code ? planName(code) : 'Pro';
      const until = S.billing ? fmtYmd(S.billing.current_period_end) : '';
      sum.textContent = name + (until ? ' · active until ' + until : '')
        + ' · unlimited checks, CSV export and ' + '1,000 API calls per day.';
    }
    if (!keysLoaded) {
      keysLoaded = true;
      loadKeys();
    }
  }

  async function loadKeys() {
    const list = $('api-key-list');
    if (!list) return;
    const res = await req(CFG.ACCOUNT_API_KEYS_PATH);
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
    const res = await req(CFG.ACCOUNT_API_KEYS_REVOKE_PATH, { body: { key_id: keyId } });
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
    const res = await req(CFG.ACCOUNT_API_KEYS_PATH, { body: { label: 'dashboard' } });
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

  window.SolarAccount = {
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

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeAuth();
    });
  });
})();
