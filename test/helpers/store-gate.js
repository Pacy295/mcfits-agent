/**
 * 门店营业状态门控（测试专用，非产品代码）。
 *
 * 背景：门店有真实营业时间（默认门店 3350241 为 07:00–00:00），凌晨跑集成测试时
 * query-meals 必然返回业务错误 600057，接口返回 503 menu_unavailable。
 * 这是环境状态，不是产品缺陷；但也不能让测试永远"假绿"，所以门控只放行一种情况：
 *
 *   503 + code=menu_unavailable + category=outside_business_hours
 *
 * 并且必须同时断言这段 503 对用户是可用的人话、带恢复操作、技术证据只留在 diagnosis。
 * 其余任何 503（门店显示营业却查不到菜单、网络故障、限流、参数错误）一律判测试失败，
 * 避免"门店永远营业"的错误测试前提掩盖真实故障。
 */
import assert from 'node:assert/strict';

export const CLOSED_SKIP_REASON = '门店当前在营业时间外（outside_business_hours），该用例需营业时段复测';

/** 是否为「营业时间外」这一正常环境状态。 */
export function isClosedOutsideHours(payload) {
  return (
    payload?.ok === false &&
    payload?.error?.code === 'menu_unavailable' &&
    payload?.error?.category === 'outside_business_hours'
  );
}

/** 营业时间外的 503 必须仍然满足用户侧契约（人话 + 恢复操作 + 诊断留证）。 */
export function assertClosedResponse(payload) {
  const e = payload.error;
  assert.equal(typeof e.message, 'string');
  assert.ok(e.message.length > 0, '必须有面向用户的说明');
  assert.ok(!/600057|query-meals|traceId|budgetMax|mcp_business/i.test(e.message), `人话文案不得含技术细节：${e.message}`);
  assert.ok(Array.isArray(e.actions) && e.actions.length > 0, '必须给出可行的恢复操作');
  assert.ok(e.store?.code, '必须带门店号，便于用户确认切换对象');
  assert.ok(e.diagnosis?.traceId, '技术证据（traceId）必须保留在诊断区');
  assert.ok(e.diagnosis?.storeEvidence, '必须带门店营业状态证据，不能只靠文字推测');
}

/**
 * 读取响应体并处理营业时间外的 503。
 * 返回 { closed, json }；closed 为 true 时调用方应立即 return（本用例已被 skip）。
 */
export async function readOrSkipClosed(res, t) {
  const json = await res.json();
  if (res.status === 503 && isClosedOutsideHours(json)) {
    assertClosedResponse(json);
    t.skip(CLOSED_SKIP_REASON);
    return { closed: true, json };
  }
  assert.ok(res.status !== 503, `503 但不是「营业时间外」的正常状态，按真实业务故障处理：${JSON.stringify(json?.error || json)}`);
  return { closed: false, json };
}
