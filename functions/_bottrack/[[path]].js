/**
 * /_bottrack/* —— AI 爬虫旁路自检端点（施工蓝图 v5.2 阶段 0.5）。
 *
 * 用途：部署后确认「Function 已生效 + 三个环境变量已配齐」，不暴露 token 值。
 * 真正的采集逻辑在同目录 _middleware.js（全站拦截），本文件只做健康自检。
 *
 * 自检：curl https://<站点>/\_bottrack/health  → {"ok":true,...}
 */

export async function onRequest(context) {
  const { env } = context;
  const configured = Boolean(
    env && env.BOT_SITE_ID && env.BOT_TRACK_URL && env.BOT_TRACK_TOKEN
  );

  return new Response(
    JSON.stringify({
      ok: configured,
      service: 'ai-bot-track',
      site_id: (env && env.BOT_SITE_ID) || null,
      endpoint_set: Boolean(env && env.BOT_TRACK_URL),
      token_set: Boolean(env && env.BOT_TRACK_TOKEN),
      middleware: 'functions/_middleware.js',
      note: 'UA 匹配为信号非身份认证；计数落到后端 ops/ai-crawler，驾驶舱⑥ ai_crawler 维度读取',
    }, null, 2),
    {
      status: configured ? 200 : 503,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    }
  );
}
