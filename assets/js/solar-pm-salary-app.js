(function () {
  const CFG = window.SITE_CONFIG;
  const API = window.SolarPMAPI;

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

  function factPairConfirm(f) {
    return {
      state: f.state,
      experience_bucket: f.experience_bucket,
      certification: f.certification,
      cert_stack: f.cert_stack || "",
      segment: f.segment
    };
  }

  function reportTrainingEvent(name, payload) {
    const debug = window.VR.debug();
    if (debug.isolated || debug.consentMode !== "granted") return;

    const userAgent = String(window.navigator.userAgent || "").toLowerCase();
    let deviceType = "unknown";
    if (userAgent) {
      deviceType = /ipad|tablet/.test(userAgent) || (/android/.test(userAgent) && !/mobile/.test(userAgent))
        ? "tablet"
        : (/mobile|iphone|ipod|android|phone/.test(userAgent) ? "mobile" : "desktop");
    }
    let referrerHost = "direct";
    if (document.referrer) {
      try {
        referrerHost = new URL(document.referrer).hostname.toLowerCase().replace(/^www\./, "") || "direct";
      } catch (e) {}
    }

    const event = Object.assign({
      event: name,
      event_id: API.genEventId(),
      ts: Date.now()
    }, payload || {});
    fetch(debug.endpoint, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({
        site_id: debug.siteId,
        consent: true,
        sess_ref: debug.sessRef,
        page_path: debug.path || location.pathname,
        device_type: deviceType,
        referrer_host: referrerHost,
        schema_v: 1,
        sdk_v: debug.version,
        events: [event]
      }),
      keepalive: true
    }).catch(function () {});
  }

  /** 复制与导出共用同一份事实，避免"屏幕上看到的"和"复制出去的"不一致。 */
  function resultLines(item, f) {
    const money = (v) => (v != null && Number.isFinite(Number(v)) ? "$" + Number(v).toLocaleString() : "—");
    const lines = [
      "Solar PM Salary Benchmark — estimate",
      "State: " + ((f && f.state) || "—") + " | Experience: " + ((f && f.experience_bucket) || "—"),
      "P25 " + money(item.p25) + " | Median " + money(item.median) + " | P75 " + money(item.p75)
    ];
    const premiums = Array.isArray(item.premiums) ? item.premiums : [];
    if (premiums.length) {
      lines.push("Certification impact:");
      premiums.forEach((p) => lines.push("  " + labelizeCert(p.cert) + ": " + p.amount));
    }
    lines.push("Source: BLS OEWS 2026.11 — estimates only.");
    return lines;
  }

  function copyResult(item, f) {
    const text = resultLines(item, f).join("\n");
    const done = () => toast("Copied to clipboard.", "success");
    const fail = () => toast("Copy blocked by your browser. Select the numbers above instead.", "error");
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      navigator.clipboard.writeText(text).then(done).catch(fail);
      return;
    }
    // 非安全上下文（http）没有 clipboard API，退回 execCommand。
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand ? document.execCommand("copy") : false;
      document.body.removeChild(ta);
      if (ok) { done(); } else { fail(); }
    } catch (e) { fail(); }
  }

  function csvCell(v) {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function exportResultCsv(item, f) {
    const premiums = Array.isArray(item.premiums) ? item.premiums : [];
    const rows = [
      ["metric", "value"],
      ["state", (f && f.state) || ""],
      ["experience_bucket", (f && f.experience_bucket) || ""],
      ["p25", item.p25 != null ? item.p25 : ""],
      ["median", item.median != null ? item.median : ""],
      ["p75", item.p75 != null ? item.p75 : ""]
    ];
    premiums.forEach((p) => rows.push(["cert:" + p.cert, p.amount]));
    const csv = rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
    try {
      const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "solar-pm-salary-" + ((f && f.state) || "us").toLowerCase() + ".csv";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast("CSV downloaded.", "success");
    } catch (e) {
      toast("Export failed in this browser.", "error");
    }
  }

  function hasAttribution(item) {
    return !!(item && item.rule_id && item.rule_version !== null && item.rule_version !== undefined && item.rule_version !== "");
  }

  function correctionConfirmed(item, f) {
    reportTrainingEvent("correction_confirmed", Object.assign(
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
    reportTrainingEvent("correction_submitted", Object.assign(
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
    reportTrainingEvent("false_negative_flagged", Object.assign(
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
  const consentBanner = document.getElementById("consent-banner");
  const consentBtnAccept = document.getElementById("consent-accept");
  const consentBtnReject = document.getElementById("consent-reject");

  function initConsent() {
    if (consentBanner) {
      consentBanner.style.display = window.VR.debug().consentMode === "unset" ? "" : "none";
    }
    if (consentBtnAccept) consentBtnAccept.addEventListener("click", () => {
      window.VR.setConsent(true);
      if (consentBanner) consentBanner.style.display = "none";
    });
    if (consentBtnReject) consentBtnReject.addEventListener("click", () => {
      window.VR.setConsent(false);
      if (consentBanner) consentBanner.style.display = "none";
    });

    // P1-7：页脚 Cookie 设置 = 撤回入口。撤回后横幅重新出现，人能立刻改主意；
    // 会话标识与缓冲由 SDK 的 setConsent(false) 一并清掉（P1-6）。
    const settings = document.getElementById("solar-consent-settings");
    if (settings) {
      settings.addEventListener("click", (e) => {
        if (e && e.preventDefault) e.preventDefault();
        window.VR.setConsent(false);
        if (consentBanner) consentBanner.style.display = "";
        toast("Cookie consent withdrawn. This site no longer collects usage data.");
      });
    }
  }

  const state = {
    view: "idle",
    currentItem: null,
    currentForm: null,
    requestId: 0,
    abortCtrl: null,
    activeRun: null,
    isMock: false,
    attemptCount: 0,
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

  function runErrorCode(resp) {
    const code = String(resp.code || "");
    if (resp.http === 401 || code === "UNAUTHORIZED") return "auth";
    if (resp.http === 429 || resp.http === 403 || code === "RATE_LIMITED" || code === "QUOTA_BLOCKED" || code === "ABUSE_CAPPED") return "quota";
    if (code === "NETWORK_TIMEOUT") return "timeout";
    if (resp.http === 400 || resp.http === 413 || code === "INVALID_PARAM" || code === "PAYLOAD_TOO_LARGE") return "input_invalid";
    return "upstream_5xx";
  }

  function finishRun(run, errorCode) {
    if (state.activeRun !== run) return;
    state.activeRun = null;
    if (errorCode) run.fail(errorCode);
    else run.ok();
  }

  function onSubmit(e) {
    e.preventDefault();
    if (state.rateLimitReset && state.rateLimitReset > Date.now()) {
      window.VR.blocked("anon_limit");
      toast("Rate limited. Retry in " + countdownText(state.rateLimitReset) + ".", "error");
      return;
    }

    state.requestId++;
    const myId = state.requestId;
    if (state.abortCtrl) state.abortCtrl.abort();
    state.abortCtrl = null;
    if (state.activeRun) finishRun(state.activeRun, "timeout");

    const run = window.VR.run("solar-pm-salary");
    state.activeRun = run;

    setView("validating");
    const f = collectForm();
    const err = validate(f);
    if (err) {
      finishRun(run, "input_invalid");
      setLoading(false);
      setView("param_error");
      toast(err, "error");
      return;
    }

    state.abortCtrl = new AbortController();

    state.currentForm = f;
    state.currentItem = null;
    state.isMock = false;
    state.attemptCount = 0;
    showFallback(false);
    hideRateLimit();
    hideResults();
    setView("loading");
    setLoading(true);

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
      if (myId !== state.requestId) return;
      if (resp.code === "ABORTED") {
        finishRun(run, "timeout");
        return;
      }
      if (!resp.ok) {
        finishRun(run, runErrorCode(resp));
        handleError(resp);
        return;
      }

      state.isMock = resp.isMock === true;
      showFallback(state.isMock);
      renderResults(resp, f);

      const data = resp.data || {};
      // 额度以服务端返回为准（含剩余次数与重置时刻）：本地加减会在多标签/多设备下错账
      if (window.SolarAccount && data.quota_info) {
        window.SolarAccount.onQuota(data.quota_info);
      }
      finishRun(run, state.isMock ? "upstream_5xx" : null);
    }).catch(function () {
      if (myId !== state.requestId) return;
      finishRun(run, "unknown");
      handleError({ ok: false, code: "RENDER_ERROR", http: 0 });
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
      '<button type="button" class="action-btn missing" id="btn-missing"' + disabled + '>! Something else is off</button>' +
      '<button type="button" class="action-btn util" id="btn-copy-result">⧉ Copy result</button>' +
      '<button type="button" class="action-btn util" id="btn-export-csv">↓ Export CSV</button>';
    resultsEl.appendChild(actions);

    // 复制/导出不依赖后端归因，mock 模式下也照常可用（方便本地验收）。
    const copyBtn = document.getElementById("btn-copy-result");
    if (copyBtn) copyBtn.addEventListener("click", () => copyResult(item, f));
    const exportBtn = document.getElementById("btn-export-csv");
    if (exportBtn) exportBtn.addEventListener("click", () => exportResultCsv(item, f));

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
    toast("Opened " + labelizeCert(cert) + " details", "success");
  });

  function handleError(resp) {
    const errCode = String(resp.code || "INTERNAL");
    state.currentItem = null;
    state.isMock = false;
    showFallback(false);
    hideResults();

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
    } else if (errCode === "ABUSE_CAPPED") {
      // 与"额度用尽"分开：这里是**网络**被限（共享出口或有人在刷），登录即可继续。
      // 合并成一个付费墙就是骗人 —— 用户会以为自己用完了 3 次，其实一次都没用。
      setView("quota_blocked");
      title = "Free checks from this network are paused";
      message = "Sign in to use your own free checks.";
      canRetry = false;
      if (window.SolarAccount && typeof window.SolarAccount.showNetworkCap === "function") {
        const box = document.getElementById("results");
        if (box) {
          showResults();
          window.SolarAccount.showNetworkCap(box, resp.data && resp.data.cap_info);
          toast("Network limit reached — sign in to keep going.", "error");
          return; // 不走通用错误卡
        }
      }
    } else if (resp.http === 403 || errCode === "QUOTA_BLOCKED") {
      setView("quota_blocked");
      // 额度用尽不是"故障"，是商业边界：给付费墙，不给"稍后重试"。
      // 重试按钮在这里是骗人的 —— 再点一百次也不会通过，只会让人更烦。
      const quota = resp.quota_info || (resp.data && resp.data.quota_info) || null;
      if (window.SolarAccount) {
        if (quota) window.SolarAccount.onQuota(quota);
        if (typeof window.SolarAccount.showPaywall === "function") {
          const box = document.getElementById("results");
          if (box) {
            showResults();
            window.SolarAccount.showPaywall(box);
            toast("Daily free limit reached.", "error");
            return; // 不走通用错误卡
          }
        }
      }
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
    document.getElementById("salary-form").addEventListener("submit", onSubmit);
    window.addEventListener("pagehide", () => {
      if (state.activeRun) finishRun(state.activeRun, "timeout");
    });
  });
})();
