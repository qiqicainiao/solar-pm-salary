window.SITE_CONFIG = {
  ENV: "prod",
  API_BASE: "",
  VERSION: "2.2.0",
  SITE_ID: "solar-pm-salary",
  SLUG: "solar-pm-salary",

  CHECK_PATH: "/bff/solar-pm-salary/check",
  TRACK_PATH: "/bff/solar-pm-salary/track",

  // 阶段二（2026-11-24）：账号与计费。全部走同源 /bff/ 反代（Pages Function），
  // 会话 cookie 由该反代转发；直连 API 域在 CF Pages 场景下不可用（跨站 cookie + CORS）。
  ACCOUNT_ME_PATH: "/bff/solar-pm-salary/account/me",
  ACCOUNT_LOGIN_PATH: "/bff/solar-pm-salary/account/login",
  ACCOUNT_REGISTER_PATH: "/bff/solar-pm-salary/account/register",
  ACCOUNT_LOGOUT_PATH: "/bff/solar-pm-salary/account/logout",
  BILLING_STATUS_PATH: "/bff/solar-pm-salary/billing/status",
  BILLING_CHECKOUT_PATH: "/bff/solar-pm-salary/billing/checkout",

  SDK_ENDPOINT: (location.origin === "null" ? "" : location.origin) + "/bff/solar-pm-salary/track",
  MANIFEST_URL: (location.origin === "null" ? "" : location.origin) + "/manifests/solar-pm-salary.json",

  SESS_SALT: "sps_val_20261112_a1b2c3d4e5f6",

  CONSENT_KEY: "solar-pm-salary_consent",

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
