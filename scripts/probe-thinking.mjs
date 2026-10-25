/**
 * 思考模式 A/B 探针（一次性诊断，不进入业务链路）。
 *
 * 目的：验证调用网关是否真正支持并转发 "thinking": {"type":"disabled"} 参数。
 * 判定标准（不只看 HTTP 200）：
 *  - usage 中 reasoning token 是否归零/大幅下降（completion_tokens_details.reasoning_tokens 或 usage.reasoning_tokens）
 *  - 响应 message 是否出现 reasoning_content 等思考痕迹
 *  - 端到端耗时是否显著下降
 *  - 若网关拒绝参数（400）或行为无变化，如实记录，不改试其他参数名
 *
 * 安全：密钥只经 provider.js 的凭证解析使用，不打印、不落盘。
 */
import { providerCandidates } from '../src/llm/provider.js';

const TEXT = process.argv[2] || '52块钱预算，今天想吃点温和的。';

const SYSTEM_PROMPT = '你是麦当劳配餐需求的语义解析器。把用户的中文口语需求转成 JSON 结构化约束。只输出一个 JSON 对象，不要任何解释文字。';
const USER_PROMPT = `用户原话："""${TEXT}"""\n\n请输出 JSON：`;

function usageSummary(usage) {
  if (!usage) return null;
  return {
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
    reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens ?? null,
    completion_tokens_details: usage.completion_tokens_details ?? null,
  };
}

async function callOnce(label, thinkingParam) {
  const p = providerCandidates()[0];
  if (!p) throw new Error('no provider');
  const body = {
    model: p.id,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: USER_PROMPT },
    ],
    max_tokens: 900,
    temperature: 0,
    response_format: { type: 'json_object' },
  };
  if (thinkingParam) body.thinking = thinkingParam;

  const t0 = Date.now();
  let res;
  try {
    res = await fetch(`${p.url}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(40000),
    });
  } catch (err) {
    console.log(`[${label}] NETWORK ERROR: ${err.message} (${Date.now() - t0}ms)`);
    return;
  }
  const ms = Date.now() - t0;
  const text = await res.text();
  if (!res.ok) {
    console.log(`[${label}] HTTP ${res.status} (${ms}ms): ${text.slice(0, 300)}`);
    return;
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    console.log(`[${label}] non-JSON body (${ms}ms): ${text.slice(0, 200)}`);
    return;
  }
  const msg = json?.choices?.[0]?.message || {};
  const out = {
    label,
    ms,
    model: json?.model,
    finish_reason: json?.choices?.[0]?.finish_reason ?? null,
    usage: usageSummary(json?.usage),
    message_keys: Object.keys(msg),
    has_reasoning_content: Boolean(msg.reasoning_content ?? msg.reasoning),
    reasoning_len: String(msg.reasoning_content ?? msg.reasoning ?? '').length,
    content_len: String(msg.content ?? '').length,
    content_head: String(msg.content ?? '').slice(0, 160),
  };
  console.log(JSON.stringify(out, null, 1));
}

const n = Number(process.env.PROBE_ROUNDS || 2);
for (let i = 1; i <= n; i += 1) {
  console.log(`\n===== round ${i} / A: 原始（不传 thinking，默认深度思考） =====`);
  await callOnce(`A-r${i}`, null);
  console.log(`----- round ${i} / B: thinking disabled -----`);
  await callOnce(`B-r${i}`, { type: 'disabled' });
}
