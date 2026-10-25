/**
 * 门店可用性诊断：把菜单查询失败翻译成用户能懂的原因，并给出可行操作。
 *
 * 铁律（对应任务 #9）：
 * 1. 不硬编码「code=600057 → 门店关闭」。600057 等业务错误码只做留证，
 *    真实原因必须由 query-nearby-stores 的营业状态/营业时间 + now-time-info 的当前时间
 *    交叉验证后给出；没有证据就只说"暂时无法获取菜单"，绝不猜测。
 * 2. 主界面文案不出现 MCP 工具名 / 错误码 / 字段名；技术证据只进 diagnostics
 *    （供工程台 / 诊断详情展示）。
 * 3. 备选门店必须真实 query-meals 验证通过才允许切换（verifyStoreUsable），
 *    不拿"搜出来的门店列表"冒充可用门店。
 * 4. 全部门店不可用时的口径固定为：
 *    「当前门店暂时无法获取菜单，暂时不能进行实时核价。」
 *    绝不说成「没有符合你要求的套餐。」
 */
import { config } from '../config.js';
import { mcp, McpError } from '../mcp/client.js';

/** 失败分类（用户可理解的五类，不含任何技术码） */
export const MENU_FAILURE_CATEGORY = {
  OUTSIDE_BUSINESS_HOURS: 'outside_business_hours', // 营业时间外（有营业时间证据）
  STORE_UNAVAILABLE: 'store_unavailable', // 门店状态异常/不支持线上菜单（无打烊证据）
  RATE_LIMITED: 'rate_limited', // 查询过于频繁
  NETWORK: 'network', // 网络/临时故障（可重试）
  BUSINESS: 'business', // 其他业务错误（原因未知，如实说）
};

const MENU_UNAVAILABLE_MSG = '当前门店暂时无法获取菜单，暂时不能进行实时核价。';

/** 「HH:MM」转当天分钟数；跨零点（如 07:00-00:00）按 [start, 24h) ∪ [0, end) 处理 */
export function minutesOfDay(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return v >= 0 && v <= 24 * 60 ? v : null;
}

export function isWithinBusinessHours(nowMinutes, start, end) {
  const s = minutesOfDay(start);
  const e = minutesOfDay(end);
  if (s == null || e == null) return null; // 无证据
  if (s === e) return true; // 24 小时营业
  if (s < e) return nowMinutes >= s && nowMinutes < e;
  return nowMinutes >= s || nowMinutes < e; // 跨零点
}

/**
 * 纯函数分类：给定错误 + 门店证据 + 当前时间，产出诊断。
 * @param {object} p
 * @param {{kind:string, message:string, detail?:object}} p.err MCP 错误
 * @param {object|null} p.storeInfo query-nearby-stores 里的门店证据（businessStatus/营业时间）
 * @param {number} p.nowMinutes 当前时间（当天分钟数）
 * @returns {{category:string, userMessage:string, reason:string, actions:string[], diagnostics:object}}
 */
export function classifyMenuFailure({ err, storeInfo = null, nowMinutes = null }) {
  const kind = err?.kind || 'unknown';
  const code = err?.detail?.code ?? null;
  const tool = err?.detail?.tool ?? null;
  const traceId = err?.detail?.traceId ?? null;
  const diagnostics = {
    // 工程台专用：技术证据集中在这里，主界面只看 userMessage/reason
    tool,
    code,
    traceId,
    errKind: kind,
    rawMessage: err?.message || null,
    storeEvidence: storeInfo
      ? {
          storeCode: storeInfo.storeCode ?? null,
          businessStatus: storeInfo.businessStatus ?? null,
          businessStartTime: storeInfo.businessStartTime ?? null,
          businessEndTime: storeInfo.businessEndTime ?? null,
        }
      : null,
    checkedAt: Date.now(),
    rule: 'business 业务错误不硬编码含义；outside_business_hours 仅在营业时间证据成立时给出',
  };

  // 1) 查询限制（本端限流 / 上游明确限流文案 / 429）——优先于传输层归类，
  //    否则以 http/rpc 到达的 429 会被当成普通网络故障，用户得不到「歇一会」的正确建议
  const limitedByUs = /rate_limited|请求过于频繁/.test(String(err?.message || ''));
  const limitedByUpstream = /限流|频繁|limit|429/i.test(String(err?.message || ''));
  if (limitedByUs || limitedByUpstream) {
    return {
      category: MENU_FAILURE_CATEGORY.RATE_LIMITED,
      userMessage: '查询有点频繁，先歇一下。',
      reason: '等一会儿再试就好，也可以先看看其他门店。',
      actions: ['retry_later', 'switch_store'],
      diagnostics,
    };
  }

  // 2) 网络/传输层故障 → 可重试的临时故障
  if (['network', 'http', 'rpc', 'parse'].includes(kind)) {
    return {
      category: MENU_FAILURE_CATEGORY.NETWORK,
      userMessage: '网络不太稳定，菜单没取回来。',
      reason: '可以点「重试」再试一次，或稍后再来。',
      actions: ['retry', 'switch_store'],
      diagnostics,
    };
  }

  // 3) 业务错误：必须拿门店营业证据说话
  if (kind === 'business') {
    const hoursKnown =
      storeInfo && minutesOfDay(storeInfo.businessStartTime) != null && minutesOfDay(storeInfo.businessEndTime) != null;
    const within = hoursKnown ? isWithinBusinessHours(nowMinutes, storeInfo.businessStartTime, storeInfo.businessEndTime) : null;

    if (within === false || storeInfo?.businessStatus === false) {
      const hoursText = hoursKnown ? `${storeInfo.businessStartTime}–${storeInfo.businessEndTime}` : null;
      return {
        category: MENU_FAILURE_CATEGORY.OUTSIDE_BUSINESS_HOURS,
        userMessage: MENU_UNAVAILABLE_MSG,
        reason: hoursText
          ? `这家门店的营业时间是 ${hoursText}，现在还没开门（或已打烊）。`
          : '这家门店现在没有营业。',
        actions: ['switch_store', 'retry_later'],
        diagnostics,
      };
    }
    if (within === true && storeInfo?.businessStatus !== false) {
      // 显示在营业却查不到菜单：门店状态异常/查询受限，如实说，不猜"已关闭"
      return {
        category: MENU_FAILURE_CATEGORY.STORE_UNAVAILABLE,
        userMessage: MENU_UNAVAILABLE_MSG,
        reason: '门店显示在营业，但线上菜单暂时查不到，你可以换一家门店试试。',
        actions: ['switch_store', 'retry'],
        diagnostics,
      };
    }
    // 无营业证据：只说事实，不猜原因
    return {
      category: MENU_FAILURE_CATEGORY.BUSINESS,
      userMessage: MENU_UNAVAILABLE_MSG,
      reason: '暂时查不到原因，你可以换一家门店，或者稍后再试。',
      actions: ['switch_store', 'retry'],
      diagnostics,
    };
  }

  return {
    category: MENU_FAILURE_CATEGORY.BUSINESS,
    userMessage: MENU_UNAVAILABLE_MSG,
    reason: '暂时查不到原因，你可以换一家门店，或者稍后再试。',
    actions: ['switch_store', 'retry'],
    diagnostics,
  };
}

/**
 * 用 query-nearby-stores 查门店营业证据。找不到就返回 null（不猜）。
 * @param {string} storeCode
 * @returns {Promise<object|null>}
 */
export async function lookupStoreInfo(storeCode) {
  try {
    const r = await mcp.callTool('query-nearby-stores', {
      beType: config.store.beType === 5 ? 5 : 1,
      searchType: 2,
      city: config.store.searchCity,
      keyword: config.store.searchKeyword,
    });
    const list = Array.isArray(r.data?.stores) ? r.data.stores : Array.isArray(r.data) ? r.data : [];
    return list.find((s) => String(s.storeCode) === String(storeCode)) || null;
  } catch {
    return null; // 证据查询本身失败时，宁可没有证据也不编造
  }
}

/**
 * 菜单失败 → 完整诊断（查证据 + 分类）。
 * @param {string} storeCode
 * @param {McpError} err
 */
export async function diagnoseMenuFailure(storeCode, err) {
  const [storeInfo, now] = await Promise.all([
    err?.kind === 'business' ? lookupStoreInfo(storeCode) : Promise.resolve(null),
    mcp.callTool('now-time-info', {}).catch(() => null),
  ]);
  // now-time-info 返回 {datetime:"2026-10-25T01:06:16.358", formatted:"2026-10-25 01:06:16", ...}
  // 用它报告的时间为准（而不是本机时钟），避免机器时区差异导致营业时间判断错位
  const nowStr = String(now?.data?.datetime || now?.data?.formatted || '');
  const hm = /T?(\d{1,2}):(\d{2})/.exec(nowStr);
  const nowMinutes = hm ? Number(hm[1]) * 60 + Number(hm[2]) : new Date().getHours() * 60 + new Date().getMinutes();
  const d = classifyMenuFailure({ err, storeInfo, nowMinutes: Number.isFinite(nowMinutes) ? nowMinutes : null });
  return { ...d, storeCode, storeName: storeInfo?.storeName || config.store.storeName };
}

/**
 * 备选门店列表（含营业状态/营业时间/距离）。注意：这只是"搜索结果"，
 * 是否可用必须由 verifyStoreUsable 真实验证后才能下结论。
 */
export async function listStoreOptions() {
  const r = await mcp.callTool('query-nearby-stores', {
    beType: config.store.beType === 5 ? 5 : 1,
    searchType: 2,
    city: config.store.searchCity,
    keyword: config.store.searchKeyword,
  });
  const list = Array.isArray(r.data?.stores) ? r.data.stores : Array.isArray(r.data) ? r.data : [];
  return {
    current: config.store.defaultStoreCode,
    source: { tool: 'query-nearby-stores', datetime: r.datetime, traceId: r.traceId },
    stores: list.map((s) => ({
      storeCode: String(s.storeCode),
      storeName: s.storeName || null,
      address: s.address || null,
      distance: s.distance ?? null,
      businessStatus: s.businessStatus ?? null,
      businessStartTime: s.businessStartTime || null,
      businessEndTime: s.businessEndTime || null,
    })),
  };
}

/**
 * 真实验证门店可用：直接调 query-meals（走 getMenu 会污染缓存，这里调 MCP 原语，
 * 成功才算可用；失败时返回诊断而不是抛裸错）。
 * @returns {Promise<{usable:boolean, categories?:number, diagnosis?:object, meta:object}>}
 */
export async function verifyStoreUsable(storeCode) {
  const t0 = Date.now();
  try {
    const r = await mcp.callTool('query-meals', {
      storeCode: String(storeCode),
      orderType: config.store.orderType,
      beType: config.store.beType,
    });
    const categories = (r.data?.categories || []).length;
    return {
      usable: categories > 0,
      categories,
      meta: { verifiedAt: t0, source: { tool: 'query-meals', datetime: r.datetime, traceId: r.traceId } },
    };
  } catch (err) {
    const diagnosis = await diagnoseMenuFailure(String(storeCode), err);
    return { usable: false, diagnosis, meta: { verifiedAt: t0 } };
  }
}
