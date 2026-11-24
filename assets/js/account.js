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
 *   · `checkout_started` 是**意图**，`payment_succeeded` 是**事实**（服务端 webhook 产生）。
 *     前者点按钮就发，后者前端永远发不出来（契约里是 server-only）。
 */
(function () {
  const CFG = window.SITE_CONFIG;
  const T = window.Telemetry;

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
  }

  async function refresh() {
    await Promise.all([loadMe(), loadStatus()]);
    renderAll();
  }

  // ---------------------------------------------------------------- 渲染

  function renderAll() {
    renderSlot();
    renderQuota();
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

  function trackCheckout(planCode, interval) {
    if (!T || typeof T.track !== 'function') return;
    T.track('checkout_started', {
      plan: String(planCode || '').slice(0, 20),
      billing_interval: interval === 'year' ? 'year' : 'month',
      source_page: (location.pathname || '/').slice(0, 120),
      trial: false
    });
  }

  async function startCheckout(planCode) {
    if (S.busy) return;
    const plan = S.plans.filter(function (x) { return x.plan_code === planCode; })[0];
    if (!plan) return;

    // 意图事件先发：即使用户在跳转前关掉页面，"想买"这件事也是真的
    trackCheckout(planCode, plan.billing_interval);

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
      return;
    }
    setAuthError(authErrorText(res.status, res.env));
  }

  async function signOut() {
    await req(CFG.ACCOUNT_LOGOUT_PATH, { body: {} });
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

  // ---------------------------------------------------------------- 对外

  window.SolarAccount = {
    boot: boot,
    refresh: refresh,
    onQuota: onQuota,
    showPaywall: showPaywall,
    showNetworkCap: showNetworkCap,
    openAuth: openAuth,
    startCheckout: startCheckout,
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

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeAuth();
    });
  });
})();
