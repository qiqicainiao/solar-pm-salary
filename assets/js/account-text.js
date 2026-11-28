/**
 * Solar PM Salary — 本站专属文案覆盖（只有 solar 有这个文件）。
 *
 * 为什么单独一个文件：`account.js` 是九站共用的一份实现，它的默认文案必须是中性的
 * （否则另外八站会把"CSV export / 1,000 API calls"当成自己的承诺展示 = 收钱不交付）。
 * solar 是唯一真卖 Pro 的站，所以把本站承诺放在这里，在 `account.js` **之前**加载。
 *
 * 只覆盖两件事，其它键一律沿用 account.js 的默认值。
 */
window.VR_ACCOUNT_TEXT = Object.assign(window.VR_ACCOUNT_TEXT || {}, {
  pro_line: 'Unlimited checks, CSV export and 1,000 API calls per day.',
  free_includes: 'Includes %d salary lookups per day, no card needed.',
  paid_active_note: 'Unlimited checks, CSV export and API access are on.'
});
