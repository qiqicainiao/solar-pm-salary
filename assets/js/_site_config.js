(function migrateLegacyConsent() {
  try {
    var legacy = window.localStorage.getItem('solar-pm-salary_consent');
    if (legacy !== 'accepted' && legacy !== 'rejected') return;
    var current = window.localStorage.getItem('vr_consent_v1');
    if (current !== 'granted' && current !== 'denied') {
      window.localStorage.setItem('vr_consent_v1', legacy === 'accepted' ? 'granted' : 'denied');
    }
    window.localStorage.removeItem('solar-pm-salary_consent');
  } catch (error) {}
})();

window.SITE_CONFIG = {
  ENV: "prod",
  API_BASE: "",
  VERSION: "2.4.0",
  SITE_ID: "solar-pm-salary",
  SLUG: "solar-pm-salary",

  CHECK_PATH: "/bff/solar-pm-salary/check",

  // 账号与计费的路径**不在这里**：2026-11-27 起由 account.js 从自己的 script 标签
  // `data-account-site` 推出 `/bff/{site}/...`。九站各有一份 _site_config.js 且对象名
  // 不同（SITE_CONFIG / __SITE_CONFIG__ / ...），把路径放这里就会有一半站取不到。

  ENUMS: {
    experience_bucket: ["0-2", "3-5", "6plus"],
    certification:     ["none", "pmp", "osha30", "electrical", "nabcep"],
    segment:           ["all", "utility", "commercial", "residential", "storage", "wind"],
    sample_source:     ["user", "system", "mock"],
    salary_bucket:     ["under88k", "88k-105k", "105k-128k", "128k-160k", "160kplus"],
    cert_expand:       ["pmp", "osha30", "electrical", "nabcep"],
    correction_reason_correct:  ["premium_wrong", "baseline_wrong", "state_mismatch", "cert_impact_misjudged", "other", "unspecified"],
    correction_reason_fn:       ["item_missing", "premium_missing", "baseline_missing", "other", "unspecified"]
  },

  SALARY_BUCKETS: [
    { label: "Under $88k",      min: 0,    max: 87000,   key: "under88k" },
    { label: "$88k – $105k",    min: 88000, max: 104000,  key: "88k-105k" },
    { label: "$105k – $128k",   min: 105000, max: 127000, key: "105k-128k" },
    { label: "$128k – $160k",   min: 128000, max: 159000, key: "128k-160k" },
    { label: "$160k+",          min: 160000, max: 9e9,     key: "160kplus" }
  ]
};
