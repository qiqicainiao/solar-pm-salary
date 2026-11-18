/**
 * /_bottrack/* —— AI 爬虫旁路自检端点（施工蓝图 v5.2 阶段 0.5）。
 *
 * 用途：部署后确认「Function 已生效 + 三个环境变量已配齐」，不暴露 token 值。
 * 真正的采集逻辑在同目录 _middleware.js（全站拦截），本文件只做健康自检。
 *
 * 自检：
 *   curl https://<站点>/_bottrack/health                       → 变量齐否
 *   curl "https://<站点>/_bottrack/health?selftest=<TOKEN>"    → 真发一次上报并回显结果
 *     （selftest 必须等于 BOT_TRACK_TOKEN，防止被任意人当写接口刷计数）
 */

/** token 指纹（sha256 前 8 位十六进制）：排障时核对"两边是不是同一个 token"，不泄露原值 */
async function tokenFingerprint(value) {
  if (!value) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .slice(0, 4)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const jsonResponse = (payload, status) =>
  new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export async function onRequest(context) {
  const { env, request } = context;
  const configured = Boolean(
    env && env.BOT_SITE_ID && env.BOT_TRACK_URL && env.BOT_TRACK_TOKEN
  );

  const selftest = new URL(request.url).searchParams.get('selftest');
  if (selftest !== null) {
    if (!configured) {
      return jsonResponse({ ok: false, error: 'env_not_configured' }, 503);
    }
    if (selftest !== env.BOT_TRACK_TOKEN) {
      return jsonResponse(
        {
          ok: false,
          error: 'selftest_token_invalid',
          given_fp: await tokenFingerprint(selftest),
          env_fp: await tokenFingerprint(env.BOT_TRACK_TOKEN),
        },
        401
      );
    }
    try {
      const res = await fetch(env.BOT_TRACK_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-bot-track-token': env.BOT_TRACK_TOKEN,
        },
        body: JSON.stringify({ site_id: env.BOT_SITE_ID, bot: 'GPTBot', path: '/selftest' }),
      });
      const text = await res.text();
      return jsonResponse(
        { ok: res.ok, status: res.status, upstream_body: text.slice(0, 300), site_id: env.BOT_SITE_ID },
        res.ok ? 200 : 502
      );
    } catch (e) {
      return jsonResponse({ ok: false, error: String(e) }, 502);
    }
  }

  return jsonResponse(
    {
      ok: configured,
      service: 'ai-bot-track',
      site_id: (env && env.BOT_SITE_ID) || null,
      endpoint_set: Boolean(env && env.BOT_TRACK_URL),
      token_set: Boolean(env && env.BOT_TRACK_TOKEN),
      token_fp: await tokenFingerprint(env && env.BOT_TRACK_TOKEN),
      middleware: 'functions/_middleware.js',
      selftest_hint: '?_bottrack/health?selftest=<BOT_TRACK_TOKEN> 可主动发一次上报并回显结果',
      note: 'UA 匹配为信号非身份认证；计数落到后端 ops/ai-crawler，驾驶舱⑥ ai_crawler 维度读取',
    },
    configured ? 200 : 503
  );
}
