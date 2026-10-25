/* 第二阶段测试界面：自然语言 → 可编辑约束 → 多方案 → 两两对比 / 不可行解释 */

const $ = (id) => document.getElementById(id);
const S2 = { parse: null, plans: [], comparePicks: [], lastResult: null };

const yuan = (fen) => (fen == null ? '—' : `¥${(fen / 100).toFixed(2)}`);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const timeStr = (ts) => (ts ? new Date(ts).toLocaleTimeString('zh-CN', { hour12: false }) : '—');

async function api(path, opts) {
  const res = await fetch(path, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) {
    const e = new Error(json?.error?.message || `HTTP ${res.status}`);
    e.payload = json;
    throw e;
  }
  return json;
}

const post = (path, body) =>
  api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/* ---------------- LLM 状态 ---------------- */
async function loadLlmStatus() {
  try {
    const s = await api('/api/llm/status?probe=1');
    const p = s.probed;
    if (p?.ok) {
      $('llmBadge').className = 'pill ok';
      $('llmBadge').textContent = `LLM 可用 · ${p.model}`;
      $('llmBadge').title = `端点：${s.providers[0]?.baseUrl || ''}（密钥仅服务端持有）`;
    } else {
      $('llmBadge').className = 'pill bad';
      $('llmBadge').textContent = `LLM 不可用${p?.error ? '：' + p.error.slice(0, 40) : ''}`;
    }
  } catch {
    $('llmBadge').className = 'pill bad';
    $('llmBadge').textContent = 'LLM 状态未知';
  }
}

/* ---------------- 解析 ---------------- */
async function doParse(mode) {
  const text = $('nlInput').value.trim();
  if (!text) {
    showNotice('warn', '请先输入需求描述');
    return;
  }
  $('parseBtn').disabled = true;
  $('ruleBtn').disabled = true;
  $('parseMeta').textContent = '解析中…';
  try {
    const r = await post('/api/parse', { text, mode });
    S2.parse = r;
    fillForm(r.constraints);
    $('constraintForm').classList.remove('hidden');
    $('recBtn').disabled = false;

    const meta = [];
    meta.push(r.source === 'llm' ? `模型解析：${r.llm?.model}（${r.llm?.ms} ms）` : '规则解析（确定性）');
    if (r.degraded) meta.push('⚠️ 已降级');
    $('parseMeta').textContent = meta.join(' · ');

    if (r.degraded) {
      showNotice('warn', `模型不可用，已改用确定性规则解析，未伪造 AI 结果。<br/>原因：${esc(r.fallbackReason || '')}`);
    } else if (r.warnings?.length) {
      showNotice('warn', r.warnings.map(esc).join('<br/>'));
    } else {
      hideNotice();
    }
  } catch (err) {
    showNotice('err', `解析失败：${esc(err.message)}`);
    $('parseMeta').textContent = '';
  } finally {
    $('parseBtn').disabled = false;
    $('ruleBtn').disabled = false;
  }
}

function showNotice(kind, html) {
  const el = $('parseNotice');
  el.className = `notice ${kind}`;
  el.innerHTML = html;
}
function hideNotice() {
  $('parseNotice').className = 'notice hidden';
}

/* ---------------- 可编辑约束 ---------------- */
function fillForm(c) {
  if (!c) return;
  $('fBudget').value = c.budgetMax ?? '';
  $('fKcalMax').value = c.caloriesMax ?? '';
  $('fKcalMin').value = c.caloriesMin ?? '';
  $('fProteinMin').value = c.proteinMin ?? '';
  const req = new Set(c.requiredCategories || []);
  $('fReqMain').checked = req.has('main');
  $('fReqSide').checked = req.has('side');
  $('fReqDrink').checked = req.has('drink');
  $('fReqDessert').checked = req.has('dessert');
  const obj = new Set((c.objectives || []).map((o) => `${o.metric}:${o.direction}`));
  $('fObjProtein').checked = obj.has('protein:max');
  $('fObjCalories').checked = obj.has('calories:min');
  $('fObjPrice').checked = obj.has('price:min');
  $('fObjTaste').checked = obj.has('taste:max');
  $('fPref').value = (c.preferredFoods || []).join(', ');
  $('fExcl').value = (c.excludedFoods || []).join(', ');

  const extra = [];
  if (c.dietaryRestrictions?.length) {
    extra.push(
      `<div class="cf-extra-line"><b>饮食限制（系统无法验证）</b>：` +
        c.dietaryRestrictions.map((d) => `<span class="badge partial">${esc(d.text)} · 未验证</span>`).join(' ') +
        `<div class="muted small">菜单数据不含辣度/配料/过敏原字段，系统不会声称已满足这些限制，只会在结果中提示。</div></div>`,
    );
  }
  if (c.clarifications?.length) {
    extra.push(
      `<div class="cf-extra-line"><b>待确认</b>：<ul>` +
        c.clarifications.map((x) => `<li>${esc(x.question)}<span class="muted small">（${esc(x.reason || '')}）</span></li>`).join('') +
        `</ul></div>`,
    );
  }
  if (c.hardConstraints?.length) {
    extra.push(`<div class="cf-extra-line"><b>硬约束</b>：${c.hardConstraints.map((h) => `<span class="badge official">${esc(h)}</span>`).join(' ')}</div>`);
  }
  if (c.softPreferences?.length) {
    extra.push(`<div class="cf-extra-line"><b>软偏好</b>：${c.softPreferences.map((h) => `<span class="badge meal">${esc(h)}</span>`).join(' ')}</div>`);
  }
  $('cfExtra').innerHTML = extra.join('');
}

function readForm() {
  const num = (id) => {
    const v = $(id).value.trim();
    return v === '' ? null : Number(v);
  };
  const list = (id) =>
    $(id)
      .value.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  const objectives = [];
  if ($('fObjProtein').checked) objectives.push({ metric: 'protein', direction: 'max' });
  if ($('fObjCalories').checked) objectives.push({ metric: 'calories', direction: 'min' });
  if ($('fObjPrice').checked) objectives.push({ metric: 'price', direction: 'min' });
  if ($('fObjTaste').checked) objectives.push({ metric: 'taste', direction: 'max' });
  const requiredCategories = [];
  if ($('fReqMain').checked) requiredCategories.push('main');
  if ($('fReqSide').checked) requiredCategories.push('side');
  if ($('fReqDrink').checked) requiredCategories.push('drink');
  if ($('fReqDessert').checked) requiredCategories.push('dessert');
  return {
    budgetMax: num('fBudget'),
    caloriesMax: num('fKcalMax'),
    caloriesMin: num('fKcalMin'),
    proteinMin: num('fProteinMin'),
    requiredCategories,
    preferredCategories: [],
    preferredFoods: list('fPref'),
    excludedFoods: list('fExcl'),
    objectives,
    dietaryRestrictions: S2.parse?.constraints?.dietaryRestrictions || [],
  };
}

/* ---------------- 推荐 ---------------- */
async function doRecommend() {
  const btn = $('recBtn');
  btn.disabled = true;
  btn.textContent = '正在生成（真实核价中）…';
  $('plansOut').innerHTML = `<div class="loading">候选生成 → 参考价预筛 → MCP 逐个核价 → 非支配筛选，首次运行约 10 秒…</div>`;
  const t0 = performance.now();
  try {
    const constraints = $('constraintForm').classList.contains('hidden') ? null : readForm();
    const r = await post('/api/recommend', { text: $('nlInput').value.trim(), constraints, planCount: 4, maxVerify: 40 });
    S2.lastResult = r;
    renderPlans(r);
    const ms = Math.round(performance.now() - t0);
    $('parseMeta').textContent = `${$('parseMeta').textContent} · 推荐耗时 ${ms} ms`;
    if (!$('constraintForm').classList.contains('hidden')) fillForm(constraints);
  } catch (err) {
    $('plansOut').innerHTML = `<div class="notice err">生成失败：${esc(err.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '生成配餐方案';
  }
}

function scopeLine(s) {
  if (!s) return '';
  const parts = [
    `菜单池：套餐 ${s.pool.meals} 个 / 单品 主食${s.pool.singles.main} 小食${s.pool.singles.side} 饮料${s.pool.singles.drink} 甜品${s.pool.singles.dessert}`,
    `候选 ${s.candidatesGenerated} → 预筛后 ${s.candidatesAfterHardPrefilter}`,
    `真实核价 ${s.candidatesPriced} 个（成功 ${s.pricedOk}）`,
    `完整性：${s.completeness === 'full' ? '已覆盖预筛后全部候选' : s.completeness === 'partial' ? '部分覆盖（见下方说明）' : '预筛后无可核价候选'}`,
  ];
  return `<div class="scope">${parts.map(esc).join(' · ')}<div class="muted small">${esc(s.spaceNote)}</div></div>`;
}

function renderPlans(r) {
  const head = scopeLine(r.searchScope);
  if (r.status === 'infeasible') {
    $('plansOut').innerHTML = head + renderInfeasible(r);
    $('compareOut').classList.add('hidden');
    return;
  }
  S2.plans = r.plans || [];
  S2.comparePicks = [];
  const cards = S2.plans
    .map((p) => {
      const nut = p.nutrition;
      return `<article class="plan" data-id="${p.id}">
        <header>
          <div>
            <span class="plan-id">${esc(p.id)}</span>
            <b>${esc(p.productName)}</b>
            <span class="badge meal">${p.kind === 'meal' ? '官方套餐' : '单品组合'}</span>
            ${
              p.pareto
                ? `<span class="badge ${p.pareto.nonDominated ? 'official' : 'partial'}" title="${esc(p.pareto.note)}">${esc(p.pareto.label)}</span>`
                : ''
            }
          </div>
          <div class="plan-price">${yuan(p.price.fen)}<small>${timeStr(p.price.checkedAt)} 核价</small></div>
        </header>
        <div class="plan-components">${p.components.map((c) => `<span>${esc(c.name)}</span>`).join('<i>+</i>')}</div>
        <div class="plan-macros">
          <div><b>${nut.energyKcal}</b><span>kcal</span></div>
          <div><b>${nut.protein}</b><span>蛋白质 g</span></div>
          <div><b>${nut.fat}</b><span>脂肪 g</span></div>
          <div><b>${nut.carbohydrate}</b><span>碳水 g</span></div>
        </div>
        <div class="plan-lists">
          ${p.pareto && !p.pareto.nonDominated && p.pareto.dominatedBy?.length ? `<div class="dis"><b>帕累托</b>价格高于「${esc(p.pareto.dominatedBy[0].name)}」¥${((-p.pareto.dominatedBy[0].deltaFen) / 100).toFixed(2)}（${esc(p.pareto.label)}）</div>` : ''}
          ${p.advantages.length ? `<div class="adv"><b>优势</b>${p.advantages.map(esc).join(' / ')}</div>` : ''}
          ${p.tradeoffs.length ? `<div class="dis"><b>代价</b>${p.tradeoffs.map(esc).join(' / ')}</div>` : ''}
          ${p.hardSatisfied.length ? `<div class="hard"><b>满足</b>${p.hardSatisfied.map(esc).join(' · ')}</div>` : ''}
          ${p.softMatched.length ? `<div class="soft"><b>偏好</b>${p.softMatched.map(esc).join(' · ')}</div>` : ''}
        </div>
        <footer>
          <span class="muted small">营养：${esc(nut.basis)}</span>
          <span class="muted small mono">traceId ${esc(p.mcp.traceId)}</span>
          <button class="btn ghost small pick" data-id="${p.id}">加入对比</button>
        </footer>
      </article>`;
    })
    .join('');

  const sel = r.selection || {};
  const strictCount = S2.plans.filter((p) => p.pareto?.nonDominated).length;
  const divCount = S2.plans.length - strictCount;
  const dims = (sel.dimensions || []).map((d) => d.label).join(' + ') || '—';
  $('plansOut').innerHTML =
    head +
    `<div class="sel-note"><b>筛选口径</b>：${esc(dims)}｜<span class="badge official">严格非支配 ${strictCount} 套</span> <span class="badge partial">差异化补充 ${divCount} 套</span><br/>${esc(sel.note || '')}${sel.strategy ? `（${esc(sel.strategy)}）` : ''}</div>` +
    `<div class="plan-grid">${cards}</div>`;
  $('plansOut').querySelectorAll('.pick').forEach((b) => b.addEventListener('click', () => togglePick(b.dataset.id, b)));
}

function togglePick(id, btn) {
  const i = S2.comparePicks.indexOf(id);
  if (i >= 0) {
    S2.comparePicks.splice(i, 1);
    btn.textContent = '加入对比';
    btn.classList.remove('on');
  } else {
    if (S2.comparePicks.length >= 2) {
      const drop = S2.comparePicks.shift();
      const prev = document.querySelector(`.pick[data-id="${drop}"]`);
      if (prev) {
        prev.textContent = '加入对比';
        prev.classList.remove('on');
      }
    }
    S2.comparePicks.push(id);
    btn.textContent = '已选（对比中）';
    btn.classList.add('on');
  }
  renderCompare();
}

async function renderCompare() {
  const box = $('compareOut');
  if (S2.comparePicks.length < 2) {
    box.classList.add('hidden');
    return;
  }
  const [a, b] = S2.comparePicks.map((id) => S2.plans.find((p) => p.id === id));
  try {
    const r = await post('/api/compare', { a, b });
    box.classList.remove('hidden');
    const d = r.delta;
    box.innerHTML = `
      <h3>方案对比：${esc(a.id)} ↔ ${esc(b.id)}</h3>
      <table class="cmp">
        <tr><th></th><th>${esc(a.productName)}</th><th>${esc(b.productName)}</th><th>差值（B−A）</th></tr>
        <tr><td>价格</td><td>${yuan(r.a.priceFen)}</td><td>${yuan(r.b.priceFen)}</td><td class="${d.priceFen > 0 ? 'up' : d.priceFen < 0 ? 'down' : ''}">${d.priceYuan == null ? '—' : (d.priceYuan > 0 ? '+' : '') + '¥' + d.priceYuan.toFixed(2)}</td></tr>
        <tr><td>热量</td><td>${r.a.kcal ?? '—'} kcal</td><td>${r.b.kcal ?? '—'} kcal</td><td>${d.kcal == null ? '—' : (d.kcal > 0 ? '+' : '') + d.kcal + ' kcal'}</td></tr>
        <tr><td>蛋白质</td><td>${r.a.protein ?? '—'} g</td><td>${r.b.protein ?? '—'} g</td><td>${d.protein == null ? '—' : (d.protein > 0 ? '+' : '') + d.protein + ' g'}</td></tr>
      </table>
      <p class="cmp-summary">${esc(r.summary)}</p>
      <p class="muted small">${esc(r.note)}</p>`;
  } catch (err) {
    box.classList.remove('hidden');
    box.innerHTML = `<div class="notice err">对比失败：${esc(err.message)}</div>`;
  }
}

function renderInfeasible(r) {
  const a = r.analysis;
  const rel = (a.relaxations || [])
    .map(
      (x) =>
        `<li><b>放宽「${esc(x.label)}」</b>：${esc(x.note)}${
          x.cheapest ? `（最便宜：${esc(x.cheapest.name)} ${yuan(x.cheapest.priceFen)} / ${x.cheapest.kcal} kcal / ${x.cheapest.protein}g）` : ''
        }</li>`,
    )
    .join('');
  const close = (a.closest || [])
    .map(
      (c) => `<tr>
        <td>${esc(c.candidate.name)}</td>
        <td class="num">${yuan(c.candidate.priceFen)}</td>
        <td class="num">${c.candidate.kcal} kcal</td>
        <td class="num">${c.candidate.protein} g</td>
        <td>${c.violations.filter((v) => v.verified !== false).map((v) => `<span class="badge unknown">${esc(v.detail)}</span>`).join(' ')}</td>
      </tr>`,
    )
    .join('');
  return `<div class="infeasible">
    <h3>没有找到同时满足全部硬约束的组合</h3>
    <p>${esc(a.reason)}</p>
    <div class="blocking">${(a.blocking || []).map((b) => `<span class="badge partial">${esc(b.label)}：${b.violatedBy}/${b.ofTotal} 个候选不满足</span>`).join(' ')}</div>
    <h4>单项放宽后的真实结果（基于已核价候选，不重新猜测）</h4>
    <ul>${rel || '<li>没有可放宽的约束</li>'}</ul>
    <h4>最接近可行的方案（每条都标注超出多少）</h4>
    <table class="grid2"><thead><tr><th>组合</th><th class="num">核价</th><th class="num">热量</th><th class="num">蛋白质</th><th>违反项</th></tr></thead><tbody>${close}</tbody></table>
    ${a.unverifiable?.length ? `<p class="notice warn">无法验证的限制：${a.unverifiable.map((u) => esc(u.text)).join('、')} —— 系统不会声称已满足。</p>` : ''}
    <p class="muted small">${esc(a.scopeNote)}</p>
  </div>`;
}

async function showPool() {
  const box = $('plansOut');
  box.innerHTML = '<div class="loading">读取候选池…</div>';
  try {
    const p = await api('/api/optimize/pool');
    const s = p.stats;
    box.innerHTML = `<div class="pool">
      <h3>候选池（真实门店菜单 + 官方营养可用性过滤）</h3>
      <p class="muted">套餐 ${p.meals.length} 个 · 单品 ${
        Object.values(p.singles).reduce((a, b) => a + b.length, 0)
      } 个 · 容器型商品 ${s.containerProducts} 个 · 因缺营养数据被排除 ${s.nutritionUnknownExcluded} 个 · 官方组件营养已解析 ${s.componentResolved} 条</p>
      ${Object.entries(p.singles)
        .map(
          ([role, list]) =>
            `<div class="pool-role"><b>${role}</b>（${list.length}）：${list
              .map((x) => `${esc(x.name)} <span class="muted">${x.kcal ?? '—'}kcal/${x.protein ?? '—'}g${x.container ? '·容器' : ''}</span>`)
              .join('、')}</div>`,
        )
        .join('')}
      <div class="pool-role"><b>套餐</b>（${p.meals.length}）：${p.meals.map((m) => esc(m.name)).join('、')}</div>
    </div>`;
  } catch (err) {
    box.innerHTML = `<div class="notice err">读取失败：${esc(err.message)}</div>`;
  }
}

/* ---------------- 事件 ---------------- */
$('parseBtn').addEventListener('click', () => doParse('auto'));
$('ruleBtn').addEventListener('click', () => doParse('rule'));
$('recBtn').addEventListener('click', doRecommend);
$('poolBtn').addEventListener('click', showPool);
$('nlInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) doParse('auto');
});

window.__s2ready = true;
loadLlmStatus();
$('nlInput').value = '40元以内，蛋白质至少30g，热量不超过750kcal，最好来杯无糖可乐';
