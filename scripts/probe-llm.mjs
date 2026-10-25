/** 探测本机可用的 OpenAI 兼容模型端点（只读，不落盘密钥） */
import { providerCandidates } from '../src/llm/provider.js';

const list = providerCandidates();
console.log('显式允许的模型配置数量:', list.length);

for (const m of list) {
  const url = m.url.replace(/\/$/, '') + '/chat/completions';
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${m.apiKey}` },
      body: JSON.stringify({
        model: m.id,
        messages: [
          { role: 'system', content: '你是JSON输出器，只输出JSON。' },
          { role: 'user', content: '把「40元以内 高蛋白」解析为 {"budgetMax":number|null,"proteinMin":number|null,"objective":"protein"}' },
        ],
        max_tokens: 200,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(45000),
    });
    const text = await res.text();
    console.log(`[${m.id}] HTTP ${res.status} ${Date.now() - t0}ms`);
    console.log('  ', text.slice(0, 400).replace(/\n/g, ' '));
  } catch (err) {
    console.log(`[${m.id}] 失败: ${err.message}`);
  }
  console.log();
}
