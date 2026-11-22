(function () {
  const CFG = window.SITE_CONFIG;
  const API = window.SolarPMAPI;
  const T = window.Telemetry;

  if (T) {
    T.init({
      siteId: CFG.SITE_ID,
      endpoint: CFG.SDK_ENDPOINT,
      manifestUrl: CFG.MANIFEST_URL,
      consent: false,
      production: CFG.ENV === "prod"
    });
  }

  const $ = (id) => document.getElementById(id);

  function initCustomSelect(selectId, containerId, label) {
    const native = $(selectId);
    const container = $(containerId);
    if (!native || !container) return;

    container.innerHTML = "";
    const cselect = document.createElement("div");
    cselect.className = "cselect";

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.id = containerId + "-trigger";
    trigger.className = "cselect-trigger";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");

    const valueSpan = document.createElement("span");
    const hasValue = native.selectedIndex >= 0 && native.value !== "";
    valueSpan.className = "cselect-value" + (hasValue ? "" : " placeholder");
    valueSpan.textContent = hasValue ? native.options[native.selectedIndex].textContent : "Select…";
    trigger.appendChild(valueSpan);

    const arrow = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    arrow.setAttribute("class", "cselect-arrow");
    arrow.setAttribute("viewBox", "0 0 24 24");
    arrow.setAttribute("fill", "none");
    arrow.setAttribute("stroke", "currentColor");
    arrow.setAttribute("stroke-width", "2");
    arrow.setAttribute("stroke-linecap", "round");
    arrow.setAttribute("stroke-linejoin", "round");
    arrow.innerHTML = '<polyline points="6 9 12 15 18 9"></polyline>';
    trigger.appendChild(arrow);
    cselect.appendChild(trigger);

    const panel = document.createElement("ul");
    panel.className = "cselect-panel";
    panel.setAttribute("role", "listbox");
    panel.setAttribute("aria-label", label);
    panel.hidden = true;

    const closePanel = (cs) => {
      cs.classList.remove("open");
      const csTrigger = cs.querySelector(".cselect-trigger");
      if (csTrigger) csTrigger.setAttribute("aria-expanded", "false");
      const csPanel = cs.querySelector(".cselect-panel");
      if (csPanel) csPanel.hidden = true;
    };
    const openPanel = () => {
      document.querySelectorAll(".cselect.open").forEach(closePanel);
      cselect.classList.add("open");
      trigger.setAttribute("aria-expanded", "true");
      panel.hidden = false;
    };

    native.querySelectorAll("option").forEach((opt, i) => {
      if (!opt.value && i > 0) return;
      const li = document.createElement("li");
      li.className = "cselect-option";
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", String(opt.value === native.value));
      li.tabIndex = -1;
      li.dataset.value = opt.value;
      li.textContent = opt.textContent;
      if (opt.value === native.value) li.classList.add("selected");

      const check = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      check.setAttribute("class", "cselect-check");
      check.setAttribute("viewBox", "0 0 24 24");
      check.setAttribute("fill", "none");
      check.setAttribute("stroke", "currentColor");
      check.setAttribute("stroke-width", "2.5");
      check.setAttribute("stroke-linecap", "round");
      check.setAttribute("stroke-linejoin", "round");
      check.innerHTML = '<polyline points="20 6 9 17 4 12"></polyline>';
      li.appendChild(check);

      li.addEventListener("click", (ev) => {
        ev.stopPropagation();
        native.value = opt.value;
        native.dispatchEvent(new Event("change", { bubbles: true }));
        closePanel(cselect);
        trigger.focus();
      });
      li.addEventListener("mouseenter", () => {
        panel.querySelectorAll(".cselect-option.active").forEach(x => x.classList.remove("active"));
        li.classList.add("active");
      });
      panel.appendChild(li);
    });

    cselect.appendChild(panel);
    container.appendChild(cselect);

    trigger.addEventListener("click", (ev) => {
      ev.stopPropagation();
      cselect.classList.contains("open") ? closePanel(cselect) : openPanel();
    });
    trigger.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " " || ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        openPanel();
        const lis = panel.querySelectorAll(".cselect-option");
        const selected = panel.querySelector(".cselect-option.selected");
        const index = selected ? Array.prototype.indexOf.call(lis, selected) : 0;
        setTimeout(() => focusOption(lis, Math.max(0, index)), 0);
      }
    });
    panel.addEventListener("keydown", (ev) => {
      const lis = panel.querySelectorAll(".cselect-option");
      if (ev.key === "ArrowDown") { ev.preventDefault(); moveActive(lis, 1); }
      else if (ev.key === "ArrowUp") { ev.preventDefault(); moveActive(lis, -1); }
      else if (ev.key === "Home") { ev.preventDefault(); focusOption(lis, 0); }
      else if (ev.key === "End") { ev.preventDefault(); focusOption(lis, lis.length - 1); }
      else if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        const active = panel.querySelector(".cselect-option.active");
        if (active) active.click();
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        closePanel(cselect);
        trigger.focus();
      }
    });

    document.addEventListener("click", (ev) => {
      if (!cselect.contains(ev.target)) closePanel(cselect);
    });

    native.addEventListener("change", () => {
      const val = native.value;
      valueSpan.textContent = native.options[native.selectedIndex]?.textContent || "Select…";
      valueSpan.classList.toggle("placeholder", !val);
      panel.querySelectorAll(".cselect-option").forEach(li => {
        const selected = li.dataset.value === val;
        li.classList.toggle("selected", selected);
        li.setAttribute("aria-selected", String(selected));
      });
    });
  }

  function moveActive(lis, dir) {
    const cur = document.activeElement;
    let i = 0;
    lis.forEach((li, idx) => { if (li === cur) i = idx; });
    const n = (i + dir + lis.length) % lis.length;
    focusOption(lis, n);
  }
  function focusOption(lis, i) {
    if (!lis.length) return;
    lis.forEach(x => x.classList.remove("active"));
    lis[i].classList.add("active");
    lis[i].focus();
  }

  function fillFormOptions() {
    const OPT_LABELS = {
      state: {
        "US": "All U.S. (national benchmark)",
        "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas",
        "CA": "California", "CO": "Colorado", "CT": "Connecticut", "DE": "Delaware",
        "FL": "Florida", "GA": "Georgia", "HI": "Hawaii", "ID": "Idaho",
        "IL": "Illinois", "IN": "Indiana", "IA": "Iowa", "KS": "Kansas",
        "KY": "Kentucky", "LA": "Louisiana", "ME": "Maine", "MD": "Maryland",
        "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota", "MS": "Mississippi",
        "MO": "Missouri", "MT": "Montana", "NE": "Nebraska", "NV": "Nevada",
        "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico", "NY": "New York",
        "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma",
        "OR": "Oregon", "PA": "Pennsylvania", "RI": "Rhode Island", "SC": "South Carolina",
        "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas", "UT": "Utah",
        "VT": "Vermont", "VA": "Virginia", "WA": "Washington", "WV": "West Virginia",
        "WI": "Wisconsin", "WY": "Wyoming", "DC": "Washington D.C."
      },
      experience_bucket: { "0-2": "0–2 years", "3-5": "3–5 years", "6plus": "6+ years" },
      certification: { "none": "No certification", "pmp": "PMP", "osha30": "OSHA 30", "electrical": "Electrical License", "nabcep": "NABCEP PVIP" },
      segment: { "all": "All segments", "utility": "Utility-scale", "commercial": "Commercial", "residential": "Residential", "storage": "Energy Storage", "wind": "Wind" }
    };

    const fill = (selectId, enumArr, labels, defaultVal) => {
      const sel = $(selectId);
      if (!sel) return;
      sel.innerHTML = "";
      enumArr.forEach(v => {
        const opt = document.createElement("option");
        opt.value = v;
        opt.textContent = labels[v] || v;
        if (v === defaultVal) opt.selected = true;
        sel.appendChild(opt);
      });
    };

    const stateArr = Object.keys(OPT_LABELS.state);
    fill("field-state", stateArr, OPT_LABELS.state, "US");
    fill("field-experience", CFG.ENUMS.experience_bucket, OPT_LABELS.experience_bucket, "3-5");
    fill("field-certification", CFG.ENUMS.certification, OPT_LABELS.certification, "none");
    fill("field-segment", CFG.ENUMS.segment, OPT_LABELS.segment, "all");

    initCustomSelect("field-state", "cselect-state", "State");
    initCustomSelect("field-metro", "cselect-metro", "Metro (optional)");
    initCustomSelect("field-experience", "cselect-experience", "Experience");
    initCustomSelect("field-certification", "cselect-certification", "Primary Certification");
    initCustomSelect("field-segment", "cselect-segment", "Segment");
  }

  function initCertChips() {
    document.querySelectorAll(".cert-chip").forEach(chip => {
      chip.setAttribute("aria-pressed", String(chip.classList.contains("active")));
      chip.addEventListener("click", () => {
        const active = chip.classList.toggle("active");
        chip.setAttribute("aria-pressed", String(active));
      });
    });
  }

  function collectForm() {
    const state  = $("field-state").value;
    const metro  = $("field-metro").value || null;
    const experience_bucket = $("field-experience").value;
    const certification = $("field-certification").value;
    const seg    = $("field-segment").value;
    const chips  = [...document.querySelectorAll(".cert-chip.active")].map(c => c.dataset.cert);
    if (certification !== "none" && !chips.includes(certification)) chips.unshift(certification);
    const cert_stack = chips.length ? chips.join(",") : null;

    return { state, metro, experience_bucket, certification, cert_stack, segment: seg };
  }

  function factPairAll(f) {
    return {
      state: f.state,
      metro: f.metro || "",
      experience_bucket: f.experience_bucket,
      certification: f.certification,
      cert_stack: f.cert_stack || "",
      segment: f.segment
    };
  }

  function factPairLite(f) {
    return {
      state: f.state,
      experience_bucket: f.experience_bucket,
      certification: f.certification,
      segment: f.segment
    };
  }

  function factPairConfirm(f) {
    return {
      state: f.state,
      experience_bucket: f.experience_bucket,
      certification: f.certification,
      cert_stack: f.cert_stack || "",
      segment: f.segment
    };
  }

  function ev(name, payload) {
    if (T && typeof T.track === "function") T.track(name, payload || {});
  }

  function toolStarted() { ev("tool_started", { tool_name: "solar-pm-salary" }); }
  function toolCompleted(durationMs, succeeded) {
    ev("tool_completed", { tool_name: "solar-pm-salary", succeeded: succeeded === true, duration_ms: durationMs });
  }
  // error_stage：失败发生在哪一段（init/input/parse/compute/render/network/timeout/unknown）。
  // 只记 error_code 的话，"接口报错"和"渲染崩了"在数据里长得一模一样，没法定位。
  function toolFailed(errorCode, errorStage) {
    ev("tool_failed", { error_code: errorCode, error_stage: errorStage || "unknown" });
  }

  function checkStarted(f) {
    ev("check_started", factPairAll(f));
  }
  function attributionFields(item) {
    const valid = item && typeof item === "object";
    return {
      rule_id: valid && item.rule_id ? item.rule_id : null,
      rule_version: valid && item.rule_version !== undefined ? item.rule_version : null,
      confidence: valid && typeof item.confidence === "number" ? item.confidence : 0,
      matched_terms: valid && Array.isArray(item.matched_terms) ? item.matched_terms : [],
      diff_detail: valid && item.diff_detail ? item.diff_detail : "",
      sample_source: valid && item.sample_source ? item.sample_source : "system"
    };
  }
  function checkCompleted(item, f, backendCheckDurationMs, renderMs, itemsCount, dimensionCount, errorCode, processingTimeMs) {
    ev("check_completed", Object.assign(
      {
        check_duration_ms: backendCheckDurationMs,
        processing_time_ms: typeof processingTimeMs === "number" ? Math.round(processingTimeMs) : undefined,
        render_ms: renderMs,
        items_count: itemsCount,
        dimension_count: dimensionCount,
        error_code: errorCode || null
      },
      attributionFields(item),
      factPairAll(f)
    ));
  }
  function checkFailed(f, errorCode, httpStatus) {
    ev("check_failed", Object.assign(
      {
        error_code: errorCode,
        http_status: httpStatus,
        state: f.state,
        certification: f.certification
      },
      attributionFields(null)
    ));
  }

  function resultViewed(f, renderMs, dimCount, hasPremium) {
    ev("result_viewed", Object.assign(
      { render_ms: renderMs, dimension_count: dimCount, has_premium: !!hasPremium },
      factPairLite(f)
    ));
  }
  function certPremiumExpanded(certEnum) {
    ev("cert_premium_expanded", { cert: certEnum });
  }
  function resultDwell(dwellSeconds, dimCount) {
    ev("result_dwell", { dwell_seconds: dwellSeconds, dimension_count: dimCount });
  }

  function hasAttribution(item) {
    return !!(item && item.rule_id && item.rule_version !== null && item.rule_version !== undefined && item.rule_version !== "");
  }

  function correctionConfirmed(item, f) {
    ev("correction_confirmed", Object.assign(
      {
        rule_id: item.rule_id,
        rule_version: item.rule_version,
        confidence: item.confidence,
        matched_terms: item.matched_terms,
        sample_source: item.sample_source,
        has_correction: false
      },
      factPairConfirm(f)
    ));
  }
  function correctionSubmitted(item, f, attemptCount, salaryBucket, reason) {
    ev("correction_submitted", Object.assign(
      {
        rule_id: item.rule_id,
        rule_version: item.rule_version,
        confidence: item.confidence,
        matched_terms: item.matched_terms,
        diff_detail: item.diff_detail || "",
        sample_source: item.sample_source,
        attempt_count: attemptCount,
        salary_bucket: salaryBucket,
        expected_net_bucket: salaryBucket,
        system_amount_bucket: API.bucketizeSalary(item.median),
        correction_reason: reason,
        has_correction: true
      },
      factPairAll(f)
    ));
  }
  function falseNegativeFlagged(item, f, reason) {
    ev("false_negative_flagged", Object.assign(
      {
        rule_id: null,
        rule_version: null,
        confidence: item.confidence ?? 0.5,
        matched_terms: item.matched_terms || [],
        diff_detail: item.diff_detail || "",
        sample_source: item.sample_source || "user",
        correction_reason: reason
      },
      factPairAll(f)
    ));
  }
  function consentChanged(consentBool) {
    ev("consent_changed", { consent: !!consentBool });
  }

  const consentBanner = document.getElementById("consent-banner");
  const consentBtnAccept = document.getElementById("consent-accept");
  const consentBtnReject = document.getElementById("consent-reject");

  function loadConsent() {
    try { return localStorage.getItem(CFG.CONSENT_KEY); } catch (e) { return null; }
  }
  function saveConsent(val) {
    try { localStorage.setItem(CFG.CONSENT_KEY, val); } catch (e) {}
  }
  function initConsent() {
    const stored = loadConsent();
    if (stored === "accepted") {
      if (T && typeof T.setConsent === "function") T.setConsent(true);
      if (consentBanner) consentBanner.remove();
    } else if (stored === "rejected") {
      if (T && typeof T.setConsent === "function") T.setConsent(false);
      if (consentBanner) consentBanner.remove();
    } else if (consentBanner) {
      // 2026-11-20 修：此前首屏 display:none，要等用户先点页面任意处才 reveal。
      // 后果是"打开看一眼就走"的访客永远看不到横幅 → 永远不表态 → pv_real 恒为 0，
      // 判定永远停在"样本不够"。同意横幅必须在首屏可见，且不遮挡工具主体。
      consentBanner.style.display = "";
    }
    if (consentBtnAccept) consentBtnAccept.addEventListener("click", () => {
      saveConsent("accepted");
      if (T && typeof T.setConsent === "function") T.setConsent(true);
      if (consentBanner) consentBanner.style.display = "none";
      consentChanged(true);
    });
    if (consentBtnReject) consentBtnReject.addEventListener("click", () => {
      saveConsent("rejected");
      if (T && typeof T.setConsent === "function") T.setConsent(false);
      if (consentBanner) consentBanner.style.display = "none";
      consentChanged(false);
    });

    // P1-7：页脚 Cookie 设置 = 撤回入口。撤回后横幅重新出现，人能立刻改主意；
    // 会话标识与缓冲由 SDK 的 setConsent(false) 一并清掉（P1-6）。
    const settings = document.getElementById("solar-consent-settings");
    if (settings) {
      settings.addEventListener("click", (e) => {
        if (e && e.preventDefault) e.preventDefault();
        saveConsent("rejected");
        if (T && typeof T.setConsent === "function") T.setConsent(false);
        consentChanged(false);
        if (consentBanner) consentBanner.style.display = "";
        toast("Cookie 同意已撤回，本站不再采集使用数据。");      });
    }
  }

  const state = {
    view: "idle",
    currentItem: null,
    currentForm: null,
    requestId: 0,
    abortCtrl: null,
    checkDurationMs: 0,
    renderMs: 0,
    resultShown: false,
    isMock: false,
    attemptCount: 0,
    dwellStartTs: 0,
    dwellReported: false,
    resultObserver: null,
    dimensionCount: 0,
    rateLimitReset: null,
    rateLimitTimer: null,
    degradedCount: 0
  };

  function setView(next) { state.view = next; }

  function validate(f) {
    if (!f.state) return "Select a state";
    if (!CFG.ENUMS.experience_bucket.includes(f.experience_bucket)) return "Select a valid experience band";
    if (!CFG.ENUMS.certification.includes(f.certification)) return "Select a valid certification";
    if (!CFG.ENUMS.segment.includes(f.segment)) return "Select a valid segment";
    return null;
  }

  function onSubmit(e) {
    e.preventDefault();
    if (state.rateLimitReset && state.rateLimitReset > Date.now()) {
      toast("Rate limited. Retry in " + countdownText(state.rateLimitReset) + ".", "error");
      return;
    }

    setView("validating");
    const f = collectForm();
    const err = validate(f);
    if (err) {
      setView("param_error");
      toast(err, "error");
      return;
    }

    if (state.abortCtrl) state.abortCtrl.abort();
    state.abortCtrl = new AbortController();
    state.requestId++;
    const myId = state.requestId;

    state.currentForm = f;
    state.currentItem = null;
    state.isMock = false;
    state.attemptCount = 0;
    resetResultTracking();
    showFallback(false);
    hideRateLimit();
    hideResults();
    setView("loading");
    setLoading(true);

    checkStarted(f);
    const submitStart = performance.now();

    API.postCheck({
      state: f.state,
      metro: f.metro || undefined,
      experience: f.experience_bucket,
      certification: f.certification,
      cert_stack: f.cert_stack || undefined,
      segment: f.segment,
      dimensions: "salary,premium,comparison",
      detail_level: "full"
    }, { signal: state.abortCtrl.signal }).then(function (resp) {
      if (myId !== state.requestId || resp.code === "ABORTED") return;

      state.checkDurationMs = Math.round(performance.now() - submitStart);
      if (!resp.ok) {
        handleError(resp, f);
        toolFailed(String(resp.code || "UNKNOWN_ERROR").toLowerCase(), "compute");
        toolCompleted(Math.round(performance.now() - submitStart), false);
        return;
      }

      state.isMock = resp.isMock === true;
      showFallback(state.isMock);
      const renderStart = performance.now();
      renderResults(resp, f);
      const renderMs = Math.round(performance.now() - renderStart);
      state.renderMs = renderMs;

      const data = resp.data || {};
      const items = Array.isArray(data.items) ? data.items : [];
      const dimensionCount = new Set(items.map(item => item.dimension).filter(Boolean)).size || (items.length ? 1 : 0);
      const hasPremium = items.some(item => Array.isArray(item.premiums) && item.premiums.length > 0) ||
        !!(data.summary && Array.isArray(data.summary.cert_premiums) && data.summary.cert_premiums.length);

      if (state.isMock) {

        checkFailed(f, "NETWORK", 0);
        toolFailed("mock_fallback", "compute");
      } else {
        checkCompleted(items[0], f, state.checkDurationMs, renderMs, items.length, dimensionCount, null, state.checkDurationMs + renderMs);
        state.resultShown = items.length > 0;
        state.dwellStartTs = state.resultShown ? Date.now() : 0;

        if (items.length) {
          observeResults(f, renderMs, dimensionCount, hasPremium);
        }
      }
      toolCompleted(Math.round(performance.now() - submitStart), !state.isMock);
    }).catch(function () {
      if (myId !== state.requestId) return;
      handleError({ ok: false, code: "RENDER_ERROR", http: 0 }, f);
      toolFailed("render_error", "render");
      toolCompleted(Math.round(performance.now() - submitStart), false);
    }).finally(function () {
      if (myId !== state.requestId) return;
      setLoading(false);
    });
  }

  function renderResults(resp, f) {
    const data = resp.data || {};
    const items = Array.isArray(data.items) ? data.items : [];
    const resultsEl = document.getElementById("results");
    resultsEl.innerHTML = "";

    if (!items.length) {
      state.currentItem = null;
      setView("empty");
      showEmptyState();
      return;
    }

    state.currentItem = items[0];
    const item = items[0];
    setView("success");

    const rangeCard = document.createElement("section");
    rangeCard.className = "range-card";
    rangeCard.innerHTML =
      '<h3>Salary Range</h3>' +
      '<div class="range-percentiles">' +
        percentileBlock("P25", item.p25) +
        percentileBlock("Median", item.median) +
        percentileBlock("P75", item.p75) +
      '</div>' +
      renderRangeBar(item.p25, item.median, item.p75) +
      '<p class="data-source-note">Data source: BLS OEWS × experience coefficient × certification premium matrix. Version 2026.11. Estimates only.</p>';
    resultsEl.appendChild(rangeCard);

    const table = document.createElement("section");
    table.className = "cert-premium-table";
    table.innerHTML =
      '<h3 style="margin-top:40px">Certification Premiums</h3>' +
      renderPremiumTable(Array.isArray(item.premiums) ? item.premiums : []);
    resultsEl.appendChild(table);

    const compBar = document.createElement("section");
    compBar.className = "comparison-bar";
    compBar.innerHTML =
      '<h3>How Does This Compare?</h3>' +
      renderComparisonBars(item.median, data.summary && data.summary.national_median, f.state);
    resultsEl.appendChild(compBar);

    const actions = document.createElement("div");
    actions.className = "result-actions";
    const disabled = state.isMock ? ' disabled aria-disabled="true" title="Unavailable for local mock data"' : "";
    actions.innerHTML =
      '<button type="button" class="action-btn confirm" id="btn-confirm"' + disabled + '>✓ This looks right</button>' +
      '<button type="button" class="action-btn correct" id="btn-correct"' + disabled + '>✗ Salary needs correction</button>' +
      '<button type="button" class="action-btn missing" id="btn-missing"' + disabled + '>! Something else is off</button>';
    resultsEl.appendChild(actions);

    document.getElementById("btn-confirm").addEventListener("click", (event) => {
      if (state.isMock) return;
      const it = state.currentItem;
      if (!hasAttribution(it)) {
        state.degradedCount++;
        toast("Feedback unavailable: result attribution is missing.", "error");
        return;
      }
      correctionConfirmed(it, state.currentForm);
      event.currentTarget.disabled = true;
      toast("Got it. Thanks!", "success");
    });
    document.getElementById("btn-correct").addEventListener("click", () => openCorrectionPanel("correct"));
    document.getElementById("btn-missing").addEventListener("click", () => openCorrectionPanel("missing"));

    showResults();
  }

  function percentileBlock(label, val) {
    return '<div class="percentile-block">' +
      '<div class="percentile-label">' + label + '</div>' +
      '<div class="percentile-value">$' + API.escapeHtml(val != null ? Number(val).toLocaleString() : "—") + '</div>' +
      '<div class="percentile-unit">per year</div>' +
    '</div>';
  }

  function renderRangeBar(p25, med, p75) {
    if (!p25 || !p75) return "";
    const min = p25 - (p75 - p25) * 0.2;
    const max = p75 + (p75 - p25) * 0.2;
    const pos = (v) => Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100));
    return '<div class="range-bar">' +
      '<div class="range-bar-fill" style="left:' + pos(p25) + '%;width:' + (pos(p75) - pos(p25)) + '%"></div>' +
      '<div class="range-bar-marker" style="left:' + pos(med) + '%"></div>' +
    '</div>';
  }

  function renderPremiumTable(premiums) {
    const rows = premiums.map(p => {
      const badge = p.type === "status"
        ? '<span class="status-badge ' + (p.amount === "Required" ? "status-required" : "status-preferred") + '">' + API.escapeHtml(p.amount) + '</span>'
        : '<strong style="color:var(--color-blue-700)">' + API.escapeHtml(p.amount) + '</strong>';
      return '<tr>' +
        '<td><button type="button" class="premium-toggle" data-cert="' + API.escapeHtml(p.cert) + '">' +
          API.escapeHtml(labelizeCert(p.cert)) + '</button></td>' +
        '<td>' + badge + '</td>' +
      '</tr>';
    }).join("");
    return '<table class="cert-premium-table">' +
      '<thead><tr><th>Certification</th><th>Impact</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>';
  }

  function labelizeCert(cert) {
    const map = { pmp: "PMP", osha30: "OSHA 30", electrical: "Electrical License", nabcep: "NABCEP PVIP" };
    return map[cert] || cert;
  }

  function renderComparisonBars(median, nationalMedian, location) {
    const localValue = Number(median);
    const nationalValue = Number(nationalMedian);
    if (!Number.isFinite(localValue) || !Number.isFinite(nationalValue) || localValue <= 0 || nationalValue <= 0) return "";
    const max = Math.max(localValue, nationalValue);
    const locPct = Math.round(localValue / max * 100);
    const natPct = Math.round(nationalValue / max * 100);
    return '<div class="comparison-row">' +
        '<div class="comparison-label">' + API.escapeHtml((location || "US").toUpperCase()) + ' Median</div>' +
        '<div class="comparison-track"><div class="comparison-fill" style="width:' + locPct + '%"></div></div>' +
        '<div class="comparison-value">$' + localValue.toLocaleString() + '</div>' +
      '</div>' +
      '<div class="comparison-row">' +
        '<div class="comparison-label">National Median</div>' +
        '<div class="comparison-track"><div class="comparison-fill" style="width:' + natPct + '%"></div></div>' +
        '<div class="comparison-value">$' + nationalValue.toLocaleString() + '</div>' +
      '</div>';
  }

  function openCorrectionPanel(mode) {
    const it = state.currentItem;
    if (state.isMock) return;
    if (!it) { toast("Run a salary check first", "error"); return; }
    if (mode === "correct" && !hasAttribution(it)) {
      state.degradedCount++;
      toast("Feedback unavailable: result attribution is missing.", "error");
      return;
    }

    document.getElementById("correction-panel")?.remove();
    const panel = document.createElement("div");
    panel.id = "correction-panel";
    panel.className = "correction-panel";
    const reasonOptions = mode === "correct" ? CFG.ENUMS.correction_reason_correct : CFG.ENUMS.correction_reason_fn;
    const reasonLabels = {
      premium_wrong: "Certification premium off",
      baseline_wrong: "State baseline wrong",
      state_mismatch: "Wrong state picked",
      cert_impact_misjudged: "Cert impact misjudged",
      item_missing: "Something missing entirely",
      premium_missing: "A premium is missing",
      baseline_missing: "Baseline is missing",
      other: "Other",
      unspecified: "Prefer not to say"
    };

    const bucketHtml = CFG.SALARY_BUCKETS.map(b =>
      '<button type="button" class="bucket-chip" data-bucket="' + API.escapeHtml(b.key) + '" aria-pressed="false">' + API.escapeHtml(b.label) + '</button>'
    ).join("");
    const reasonHtml = reasonOptions.map(r =>
      '<option value="' + API.escapeHtml(r) + '"' + (r === "unspecified" ? " selected" : "") + '>' + API.escapeHtml(reasonLabels[r] || r) + '</option>'
    ).join("");
    const intro = mode === "correct"
      ? 'Which range should it fall into? (Original $' + Number(it.median).toLocaleString() + ')'
      : 'Choose the closest reason. Only categorical context is sent; no original salary is collected.';

    panel.innerHTML =
      '<h4>' + (mode === "correct" ? "Correct the Salary" : "Report Something Missing") + '</h4>' +
      '<p>' + intro + '</p>' +
      (mode === "correct" ? '<div class="bucket-options">' + bucketHtml + '</div>' : '') +
      '<label for="reason-select" style="font-weight:600;font-size:14px;color:var(--text-primary);display:block;margin-top:12px">Reason</label>' +
      '<div id="cselect-reason"></div>' +
      '<select class="reason-select cselect-native" id="reason-select" aria-hidden="true" tabindex="-1">' + reasonHtml + '</select>' +
      '<div style="margin-top:16px;display:flex;gap:12px">' +
        '<button type="button" class="btn btn-primary" id="btn-correction-submit">' + (mode === "correct" ? "Submit correction" : "Report missing item") + '</button>' +
        '<button type="button" class="btn btn-secondary" id="btn-correction-cancel">Cancel</button>' +
      '</div>';

    document.getElementById("results").appendChild(panel);
    initCustomSelect("reason-select", "cselect-reason", "Reason");

    let pickedBucket = null;
    panel.querySelectorAll(".bucket-chip").forEach(b => {
      b.addEventListener("click", () => {
        panel.querySelectorAll(".bucket-chip").forEach(x => {
          x.classList.remove("active");
          x.setAttribute("aria-pressed", "false");
        });
        b.classList.add("active");
        b.setAttribute("aria-pressed", "true");
        pickedBucket = b.dataset.bucket;
      });
    });

    panel.querySelector("#btn-correction-cancel").addEventListener("click", () => panel.remove());
    panel.querySelector("#btn-correction-submit").addEventListener("click", () => {
      const reason = panel.querySelector("#reason-select").value || "unspecified";
      if (mode === "correct") {
        if (!pickedBucket) { toast("Pick a salary bucket", "error"); return; }
        if (!hasAttribution(it)) {
          state.degradedCount++;
          toast("Feedback unavailable: result attribution is missing.", "error");
          return;
        }
        const nextAttempt = state.attemptCount + 1;
        correctionSubmitted(it, state.currentForm, nextAttempt, pickedBucket, reason);
        state.attemptCount = nextAttempt;
        toast("Thanks — we'll calibrate.", "success");
      } else {
        falseNegativeFlagged(it, state.currentForm, reason);
        toast("Got it — we'll investigate.", "success");
      }
      panel.remove();
    });
  }

  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".premium-toggle");
    if (!btn) return;
    const cert = btn.dataset.cert;
    certPremiumExpanded(cert);
    toast("Opened " + labelizeCert(cert) + " details", "success");
  });

  function handleError(resp, f) {
    const errCode = String(resp.code || "INTERNAL");
    const httpStatus = Number(resp.http) || 0;
    resetResultTracking();
    state.currentItem = null;
    state.isMock = false;
    showFallback(false);
    hideResults();
    checkFailed(f, errCode.slice(0, 24), httpStatus);

    let title = "Something went wrong";
    let message = "The salary check could not be completed. Please try again.";
    let canRetry = true;

    if (resp.http === 429 || errCode === "RATE_LIMITED") {
      setView("rate_limited");
      title = "Too many requests";
      message = "You can retry when the countdown ends.";
      canRetry = false;
      const resetHeader = Number(resp.rateLimit && resp.rateLimit.reset);
      const retryAfter = Number(resp.rateLimit && resp.rateLimit.retryAfter);
      const reset = Number.isFinite(resetHeader) && resetHeader > 0
        ? resetHeader * 1000
        : Date.now() + (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 60000);
      showRateLimit(reset);
    } else if (errCode === "INVALID_PARAM" || errCode === "PAYLOAD_TOO_LARGE" || resp.http === 400 || resp.http === 413) {
      setView("param_error");
      title = "Check your selections";
      message = "One or more parameters were rejected. Adjust your selections and submit again.";
      canRetry = false;
    } else if (resp.http === 403 || errCode === "QUOTA_BLOCKED") {
      setView("quota_blocked");
      title = "Free quota exhausted";
      message = "The server reports that the free quota is exhausted. Please try again later.";
      canRetry = false;
    } else if (errCode === "NETWORK_TIMEOUT") {
      setView("network_timeout");
      title = "Request timed out";
      message = "The server did not respond within 15 seconds. Please retry.";
    } else {
      setView("server_error");
      if (errCode === "NETWORK") message = "The salary service is unreachable. Check your connection and retry.";
      if (errCode === "RENDER_ERROR") message = "The response was received but could not be rendered. Please retry.";
    }

    showErrorState(title, message, canRetry);
    const trace = resp.trace_id ? " Ref " + String(resp.trace_id).slice(-6) : "";
    toast(message + trace, "error");
  }

  function showEmptyState() {
    const resultsEl = document.getElementById("results");
    resultsEl.innerHTML = "";
    const card = document.createElement("div");
    card.className = "range-card";
    card.setAttribute("role", "status");
    const title = document.createElement("h3");
    title.textContent = "No benchmark found";
    const text = document.createElement("p");
    text.textContent = "No salary range matches this combination. Try the national benchmark or a different segment.";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn btn-secondary";
    button.textContent = "Change selections";
    button.addEventListener("click", () => document.getElementById("cselect-state-trigger")?.focus());
    card.append(title, text, button);
    resultsEl.appendChild(card);
    showResults();
  }

  function showErrorState(titleText, messageText, canRetry) {
    const resultsEl = document.getElementById("results");
    const card = document.createElement("div");
    card.className = "range-card";
    card.setAttribute("role", "alert");
    const title = document.createElement("h3");
    title.textContent = titleText;
    const message = document.createElement("p");
    message.textContent = messageText;
    card.append(title, message);
    if (canRetry) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "btn btn-secondary";
      retry.textContent = "Try again";
      retry.addEventListener("click", () => document.getElementById("salary-form").requestSubmit());
      card.appendChild(retry);
    }
    resultsEl.appendChild(card);
    showResults();
  }

  function observeResults(f, renderMs, dimensionCount, hasPremium) {
    state.dimensionCount = dimensionCount;
    const resultsEl = document.getElementById("results");
    if (!resultsEl) return;
    if (typeof IntersectionObserver !== "function") {
      resultViewed(f, renderMs, dimensionCount, hasPremium);
      return;
    }
    state.resultObserver = new IntersectionObserver((entries, observer) => {
      if (entries.some(entry => entry.isIntersecting)) {
        resultViewed(f, renderMs, dimensionCount, hasPremium);
        observer.disconnect();
        state.resultObserver = null;
      }
    }, { threshold: 0.5 });
    state.resultObserver.observe(resultsEl);
  }

  function resetResultTracking() {
    if (state.resultObserver) state.resultObserver.disconnect();
    state.resultObserver = null;
    state.resultShown = false;
    state.dwellStartTs = 0;
    state.dwellReported = false;
    state.dimensionCount = 0;
  }

  function reportDwell() {
    if (!state.resultShown || state.dwellReported || !state.dwellStartTs) return;
    const seconds = Math.round((Date.now() - state.dwellStartTs) / 1000);
    if (seconds < 3) return;
    state.dwellReported = true;
    resultDwell(seconds, state.dimensionCount);
  }

  function countdownText(resetMs) {
    return Math.max(0, Math.ceil((resetMs - Date.now()) / 1000)) + "s";
  }

  function setLoading(on) {
    const el = document.getElementById("btn-submit");
    if (!el) return;
    el.disabled = on;
    if (on) { el.dataset.loading = "1"; el.textContent = "Calculating…"; }
    else { delete el.dataset.loading; el.textContent = "Check Salary"; }
  }
  function showResults() { document.getElementById("results").classList.add("show"); }
  function hideResults() { document.getElementById("results").classList.remove("show"); document.getElementById("results").innerHTML = ""; }
  function showRateLimit(reset) {
    const ban = document.getElementById("rate-limit-banner");
    if (!ban) return;
    if (state.rateLimitTimer) clearTimeout(state.rateLimitTimer);
    state.rateLimitReset = reset;
    ban.style.display = "";
    const countdown = ban.querySelector("[data-countdown]");
    if (!countdown) return;
    const update = () => {
      const left = Math.max(0, Math.ceil((reset - Date.now()) / 1000));
      countdown.textContent = left > 0 ? left + "s" : "0s";
      if (left > 0) {
        state.rateLimitTimer = setTimeout(update, 1000);
      } else {
        ban.style.display = "none";
        state.rateLimitReset = null;
        state.rateLimitTimer = null;
      }
    };
    update();
  }
  function hideRateLimit() {
    const ban = document.getElementById("rate-limit-banner");
    if (ban) ban.style.display = "none";
    if (state.rateLimitTimer) clearTimeout(state.rateLimitTimer);
    state.rateLimitTimer = null;
    state.rateLimitReset = null;
  }
  function showFallback(on) {
    const ban = document.getElementById("fallback-banner");
    if (!ban) return;
    ban.style.display = on ? "" : "none";
  }
  function toast(msg, kind) {
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.className = "toast show" + (kind ? " " + kind : "");
    setTimeout(() => el.classList.remove("show"), 2800);
  }

  window.addEventListener("load", () => {
    fillFormOptions();
    initCertChips();
    initConsent();
    toolStarted();
    document.getElementById("salary-form").addEventListener("submit", onSubmit);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") reportDwell();
    });
    window.addEventListener("pagehide", reportDwell);
  });
})();
