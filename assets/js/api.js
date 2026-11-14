(function () {
  const CFG = window.SITE_CONFIG;

  const HTTP_CODE = {
    OK: 200,
    RATE_LIMITED: 429,
    QUOTA_BLOCKED: 403,
    BAD_REQUEST: 400,
    PAYLOAD_TOO_LARGE: 413
  };

  const BIZ_CODE = {
    OK: 0,
    INVALID_PARAM: "INVALID_PARAM",
    RATE_LIMITED: "RATE_LIMITED",
    PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
    QUOTA_BLOCKED: "QUOTA_BLOCKED",
    INTERNAL: "INTERNAL"
  };

  async function postCheck(payload, opts) {
    opts = opts || {};
    const externalSignal = opts.signal || null;
    if (externalSignal && externalSignal.aborted) {
      return { ok: false, data: null, code: "ABORTED", http: 0, trace_id: null };
    }

    const controller = new AbortController();
    let timedOut = false;
    const abortFromOutside = () => controller.abort();
    if (externalSignal) externalSignal.addEventListener("abort", abortFromOutside, { once: true });
    const timeoutId = setTimeout(() => { timedOut = true; controller.abort(); }, 15000);
    const body = Object.assign({ site_id: CFG.SITE_ID }, payload);

    try {
      const resp = await fetch(CFG.CHECK_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      let envelope = null;
      try { envelope = await resp.json(); } catch (e) {
        if (resp.status !== HTTP_CODE.RATE_LIMITED) {
          return { ok: false, data: null, code: "PARSE_ERROR", http: resp.status, trace_id: null };
        }
      }

      if (resp.status === HTTP_CODE.RATE_LIMITED) {
        return {
          ok: false,
          data: null,
          code: BIZ_CODE.RATE_LIMITED,
          http: 429,
          trace_id: envelope && envelope.trace_id ? envelope.trace_id : null,
          msg: envelope && envelope.msg ? envelope.msg : "rate limit exceeded",
          rateLimit: {
            reset: resp.headers.get("X-RateLimit-Reset"),
            retryAfter: resp.headers.get("Retry-After"),
            limit: resp.headers.get("X-RateLimit-Limit"),
            remaining: resp.headers.get("X-RateLimit-Remaining")
          }
        };
      }

      if (!envelope || typeof envelope !== "object") {
        return { ok: false, data: null, code: "PARSE_ERROR", http: resp.status, trace_id: null };
      }

      const bizCode = envelope.code;
      const data = envelope.data == null ? null : envelope.data;
      return {
        ok: resp.ok && (bizCode === BIZ_CODE.OK || bizCode === "0"),
        data: data,
        code: bizCode,
        http: resp.status,
        msg: typeof envelope.msg === "string" ? envelope.msg : "",
        trace_id: envelope.trace_id || null,
        quota_info: envelope.quota_info || (data && data.quota_info) || null
      };
    } catch (e) {
      if (timedOut) {
        return { ok: false, data: null, code: "NETWORK_TIMEOUT", http: 0, trace_id: null };
      }
      if ((externalSignal && externalSignal.aborted) || e.name === "AbortError") {
        return { ok: false, data: null, code: "ABORTED", http: 0, trace_id: null };
      }

      if (CFG.ENV === "dev") {
        clearTimeout(timeoutId);
        try { return await makeMockCheckResp(); } catch (mockError) {                }
      }
      return { ok: false, data: null, code: "NETWORK", http: 0, trace_id: null };
    } finally {
      clearTimeout(timeoutId);
      if (externalSignal) externalSignal.removeEventListener("abort", abortFromOutside);
    }
  }

  async function makeMockCheckResp() {
    const resp = await fetch("assets/mock/solar-pm-salary-check.mock.json?v=" + encodeURIComponent(CFG.VERSION), {
      cache: "no-store"
    });
    if (!resp.ok) throw new Error("mock unavailable");
    const envelope = await resp.json();
    if (!envelope || envelope.code !== BIZ_CODE.OK || !envelope.data) {
      throw new Error("invalid mock envelope");
    }
    return {
      ok: true,
      code: BIZ_CODE.OK,
      http: 200,
      msg: envelope.msg || "ok",
      trace_id: envelope.trace_id || null,
      isMock: true,
      data: envelope.data
    };
  }

  function genEventId() {
    const hex = "0123456789abcdef";
    const buf = new Uint8Array(8);
    try { globalThis.crypto.getRandomValues(buf); }
    catch (e) { for (let i = 0; i < 8; i++) buf[i] = Math.floor(Math.random() * 256); }
    let out = "";
    for (let i = 0; i < 8; i++) out += hex[buf[i] >> 4] + hex[buf[i] & 15];
    return out;
  }

  function bucketizeSalary(amount) {
    if (amount == null || isNaN(amount)) return null;
    const amt = Number(amount);
    for (const b of CFG.SALARY_BUCKETS) {
      if (amt >= b.min && amt <= b.max) return b.key;
    }
    return null;
  }

  function escapeHtml(str) {
    if (str == null) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  window.SolarPMAPI = {
    postCheck, genEventId, bucketizeSalary, escapeHtml,
    CODES: BIZ_CODE
  };
})();
