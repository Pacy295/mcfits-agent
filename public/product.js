/* 麦门营养决策官 · 产品端交互
 * 职责：自然语言 → 可编辑约束 → 真实推荐；方案比较；套餐规格替换（走服务端重算）。
 * 原则：前端只负责展示与收集输入，价格/营养/可行性一律以服务端返回为准。
 */

const $ = (id) => document.getElementById(id);
const API = {
  parse: '/api/parse',
  recommend: '/api/recommend',
  compare: '/api/compare',
  rebuild: '/api/plan/rebuild',
  rounds: (code) => `/api/products/${encodeURIComponent(code)}/rounds`,
  llm: '/api/llm/status',
  health: '/api/health',
};

const ROLE_LABEL = { main: '主食', side: '小食', drink: '饮料', dessert: '甜品' };
const NUM_KEYS = ['budgetMax', 'caloriesMax', 'caloriesMin', 'proteinMin'];

const state = {
  enabled: { budgetMax: false, caloriesMax: false, caloriesMin: false, proteinMin: false },
  base: {
    requiredCategories: [],
    objectives: [],
    preferredFoods: [],
    excludedFoods: [],
    dietaryRestrictions: [],
    clarifications: [],
    budgetIntent: null,
    budgetMin: null,
    preferences: null,
  },
  rawText: '', // 用户原话：重搜时随请求传递，保住预算意图与口味偏好
  intent: null, // 解析层给出的意图（mode/budget/preferences）
  result: null,
  compare: [],
  overrides: {}, // planId -> 重建后的 plan
  seq: 0,
  abort: null,
  debounceTimer: null,
  drawerSeq: 0,
  rebuildSeq: 0,
  drawer: { planId: null, code: null, kind: null, rounds: null, choices: {}, last: null },
  llm: null,
  store: { code: null, name: '' }, // 当前门店（默认门店≠用户位置，不声称"附近门店"）
  storeSwitchSeq: 0,
};

/* ---------------- 基础工具 ---------------- */
const yuan = (fen) => (fen == null ? '—' : `¥${(fen / 100).toFixed(2)}`);
const numText = (v, unit = '') => (v == null || !Number.isFinite(v) ? '—' : `${v}${unit}`);
const timeText = (ts) => (ts ? new Date(ts).toLocaleTimeString('zh-CN', { hour12: false }) : '—');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** 门店号贯穿所有数据接口（catalog/缓存/推荐/核价/重建按门店隔离，见服务端 storeCode 键控） */
function withStore(path) {
  if (!state.store.code) return path;
  return `${path}${path.includes('?') ? '&' : '?'}store=${encodeURIComponent(state.store.code)}`;
}

async function api(path, { method = 'GET', body, signal } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) {
    const e = json?.error || {};
    const err = new Error(e.message || `请求失败（HTTP ${res.status}）`);
    err.code = e.code;
    err.category = e.category || null;
    err.reason = e.reason || null;
    err.actions = e.actions || [];
    err.diagnosis = e.diagnosis || null;
    err.store = e.store || null;
    err.payload = json;
    throw err;
  }
  return json;
}

/* ---------------- 模型状态 ---------------- */
async function loadModelStatus() {
  try {
    const s = await api(API.llm);
    state.llm = s;
    const btn = $('modelBtn');
    if (!s.configured) {
      btn.className = 'pill pill-warn';
      btn.textContent = '仅规则解析（无模型）';
      btn.title = s.quotaNote || s.note;
    } else {
      btn.className = 'pill pill-ok';
      const model = s.providers?.[0]?.model || '模型';
      btn.textContent = `解析：${model}`;
      btn.title = `${s.quotaNote || ''}\n${s.note || ''}`;
    }
  } catch {
    $('modelBtn').className = 'pill pill-bad';
    $('modelBtn').textContent = '解析服务不可用';
  }
}

$('modelBtn').addEventListener('click', async () => {
  const s = state.llm;
  if (!s) return;
  alert(
    [
      `模型：${s.providers?.map((p) => p.model).join('、') || '无'}`,
      `来源：${s.sourceKind === 'deployment-env' ? '部署环境显式配置' : s.sourceKind === 'developer-local' ? '开发者本机授权配置' : '未配置'}`,
      '',
      s.quotaNote || '',
      '密钥仅在服务端使用，不会出现在浏览器。',
    ].join('\n'),
  );
});

/* ---------------- 需求解析 ---------------- */
function showParseStatus(kind, html) {
  const el = $('parseStatus');
  el.className = `parse-status ${kind}`;
  el.innerHTML = html;
}

async function ask() {
  const text = $('q').value.trim();
  if (!text) {
    showParseStatus('warn', '<span class="ps-title">先说说你想吃什么</span>比如预算、口味或忌口，一句话就行。');
    $('q').focus();
    return;
  }
  const btn = $('askBtn');
  btn.disabled = true;
  btn.querySelector('.btn-label').textContent = '正在想…';
  state.rawText = text;
  showParseStatus('info', '<span class="ps-title">正在理解你的话</span>马上直接给推荐，不用再点别的按钮。');

  try {
    const r = await api(API.parse, { method: 'POST', body: { text } });
    applyParsed(r);
    await recommend('parse'); // 解析完成自动搜索，不再要求用户点「重新配餐」
  } catch (err) {
    // 解析失败也走统一人话分类，不把错误码/工具名透到主界面
    const h = humanizeError(err);
    showParseStatus(
      'bad',
      `<span class="ps-title">这次没解析成功</span>${esc(h.body)}` +
        ` <button class="btn btn-ghost" type="button" data-act="reparse">重试</button>`,
    );
    $('results').innerHTML = '';
  } finally {
    btn.disabled = false;
    btn.querySelector('.btn-label').textContent = '直接推荐';
  }
}

function applyParsed(r) {
  const c = r.constraints || {};
  state.base.requiredCategories = [...(c.requiredCategories || [])];
  state.base.objectives = [...(c.objectives || [])];
  state.base.preferredFoods = [...(c.preferredFoods || [])];
  state.base.excludedFoods = [...(c.excludedFoods || [])];
  state.base.dietaryRestrictions = [...(c.dietaryRestrictions || [])];
  state.base.clarifications = [...(c.clarifications || [])];
  state.base.budgetIntent = c.budgetIntent || null;
  state.base.budgetMin = c.budgetMin ?? null;
  state.base.preferences = c.preferences || null;
  state.intent = r.intent || null;

  for (const k of NUM_KEYS) {
    state.enabled[k] = c[k] != null;
    $(`in-${k}`).value = c[k] == null ? '' : c[k];
  }
  syncConstraintUI();
  renderUnderstanding(r);

  // 降级/警告放轻量状态条；正常解析不打扰（需求理解标签已经是反馈）
  if (r.degraded) {
    // 模型解析降级：给可行操作（继续推荐 / 手动改条件 / 重试解析），不只是提示文案
    showParseStatus(
      'warn',
      `<span class="ps-title">模型暂时不可用，已按规则理解</span>${esc(r.fallbackReason || '')}推荐照常给出，条件不对可以手动改。` +
        ` <button class="btn btn-ghost" type="button" data-act="edit-constraints">改条件</button>` +
        `<button class="btn btn-ghost" type="button" data-act="reparse">重试解析</button>`,
    );
  } else if (humanizeWarnings(r.warnings).length) {
    showParseStatus('warn', `<span class="ps-title">有一点没听清</span>${esc(humanizeWarnings(r.warnings).join('；'))}`);
  } else {
    $('parseStatus').classList.add('hidden');
  }
}

/**
 * 主界面只显示自然语言提示：字段名/模型-规则分歧/反幻觉等技术诊断一律不进主界面
 * （工程细节保留在接口返回的 warnings 里，供工程台/诊断使用）。
 * 真冲突的用户可读说明走「我暂时按 X 元以内理解，你可以修改预算。」这类自然语句（notes/clarification）。
 */
function humanizeWarnings(list) {
  const TECHNICAL = /budgetMax|budgetMin|calories|proteinMin|budgetIntent|模型给|规则给|模型漏抽|已用规则|已采用模型|置空|臆造|不是数字|超出合理范围|已按原文纠正|已按区间|已修正|对齐顺序/;
  return (list || []).filter((w) => !TECHNICAL.test(String(w)));
}

/* ---------------- 需求理解（默认视图） ---------------- */
function renderUnderstanding(r) {
  const und = $('understanding');
  und.classList.remove('hidden');

  const chips = r.chips?.length ? r.chips : [describeConstraints(readConstraints())];
  $('undChips').innerHTML = chips.map((t) => `<span class="chip chip-static chip-und">${esc(t)}</span>`).join('');

  // 简短诚实说明：口味/温度/医学边界，不做大警告框
  const notes = [...(state.intent?.preferences?.notes || []), ...splitNotes(r.constraints?.notes)];
  $('undNotes').innerHTML = notes.length ? notes.map((t) => `<p>${esc(t)}</p>`).join('') : '';

  // 反问收敛到最多 1 个，且只在真正矛盾时出现
  const clar = r.clarification || (r.constraints?.clarifications || [])[0] || null;
  const box = $('clarifyInline');
  if (clar) {
    box.classList.remove('hidden');
    box.innerHTML = `<b>想确认一下：</b>${esc(clar.question || clar.text || '')}`;
  } else {
    box.classList.add('hidden');
    box.innerHTML = '';
  }
}

function splitNotes(v) {
  if (!v) return [];
  return String(v).split(/[；;]/).map((s) => s.trim()).filter(Boolean).slice(0, 4);
}

/* ---------------- 约束面板 ---------------- */
function syncConstraintUI() {
  for (const k of NUM_KEYS) {
    const on = state.enabled[k];
    $(`on-${k}`).checked = on;
    $(`in-${k}`).disabled = !on;
    $(`in-${k}`).closest('.cond').classList.toggle('active', on);
  }
  $('requiredChips').querySelectorAll('input').forEach((el) => {
    el.checked = state.base.requiredCategories.includes(el.value);
  });
  const objKeys = new Set((state.base.objectives || []).map((o) => `${o.metric}:${o.direction}`));
  $('objectiveChips').querySelectorAll('input').forEach((el) => {
    el.checked = objKeys.has(el.value);
  });
  renderChipList('prefChips', state.base.preferredFoods, 'pref');
  renderChipList('exclChips', state.base.excludedFoods, 'excl');

  const diet = state.base.dietaryRestrictions || [];
  const dietBox = $('dietBox');
  if (diet.length) {
    dietBox.classList.remove('hidden');
    dietBox.innerHTML = `<b>无法验证的限制</b>${diet
      .map((d) => esc(d.text))
      .join('、')}：菜单数据没有辣度、配料和过敏原信息，系统不会把它当成已满足，只在结果里提示。`;
  } else dietBox.classList.add('hidden');

  const clar = state.base.clarifications || [];
  const clBox = $('clarifyBox');
  if (clar.length) {
    clBox.classList.remove('hidden');
    clBox.innerHTML = `<b>有几点需要你确认</b><ul>${clar.map((x) => `<li>${esc(x.question)}</li>`).join('')}</ul>`;
  } else clBox.classList.add('hidden');
}

function renderChipList(id, list, kind) {
  const box = $(id);
  box.innerHTML = list.length
    ? list
        .map(
          (v, i) =>
            `<span class="chip chip-static">${esc(v)}<button type="button" class="chip-x" data-kind="${kind}" data-i="${i}" aria-label="移除">×</button></span>`,
        )
        .join('')
    : '<span class="muted" style="font-size:12px">暂无</span>';
}

function readConstraints() {
  const c = {
    budgetMax: null,
    budgetMin: state.base.budgetMin ?? null,
    caloriesMax: null,
    caloriesMin: null,
    proteinMin: null,
    budgetIntent: state.base.budgetIntent || null,
    preferences: state.base.preferences || null,
    requiredCategories: [...state.base.requiredCategories],
    preferredCategories: [],
    preferredFoods: [...state.base.preferredFoods],
    excludedFoods: [...state.base.excludedFoods],
    dietaryRestrictions: state.base.dietaryRestrictions,
    objectives: [...state.base.objectives],
  };
  for (const k of NUM_KEYS) {
    if (!state.enabled[k]) continue;
    const raw = $(`in-${k}`).value.trim();
    if (raw === '') continue;
    const v = Number(raw);
    if (Number.isFinite(v) && v >= 0) c[k] = v;
  }
  return c;
}

function describeConstraints(c) {
  const parts = [];
  if (c.budgetMax != null) parts.push(c.budgetMin != null ? `¥${c.budgetMin}–${c.budgetMax}` : `≤ ¥${c.budgetMax}`);
  if (c.caloriesMax != null) parts.push(`≤ ${c.caloriesMax} kcal`);
  if (c.caloriesMin != null) parts.push(`≥ ${c.caloriesMin} kcal`);
  if (c.proteinMin != null) parts.push(`蛋白 ≥ ${c.proteinMin} g`);
  if (c.requiredCategories.length) parts.push(`必含 ${c.requiredCategories.map((r) => ROLE_LABEL[r]).join('/')}`);
  if (c.objectives.length) {
    const map = { 'protein:max': '高蛋白', 'calories:min': '更低热量', 'price:min': '更便宜', 'taste:max': '口味优先' };
    parts.push(`优先 ${c.objectives.map((o) => map[`${o.metric}:${o.direction}`] || o.metric).join('/')}`);
  }
  return parts.length ? parts.join(' · ') : '未设置硬约束（仅按真实菜单给方案）';
}

/* ---------------- 推荐 ---------------- */
function scheduleRecommend(reason) {
  clearTimeout(state.debounceTimer);
  state.debounceTimer = setTimeout(() => recommend(reason), 420);
}

async function recommend(reason = 'manual') {
  const constraints = readConstraints();
  $('constraintMeta').textContent = describeConstraints(constraints);

  const seq = ++state.seq;
  if (state.abort) state.abort.abort();
  const controller = new AbortController();
  state.abort = controller;

  renderLoading();
  try {
    const r = await api(withStore(API.recommend), {
      method: 'POST',
      // text 随请求传递：手动改条件后重搜也保留「60 元的套餐」这类预算意图与口味偏好。
      // intent 只传 preferences，不传 mode——模式必须随当前条件重新推导，不能被旧解析钉死。
      body: {
        constraints,
        text: state.rawText,
        intent: state.intent?.preferences ? { preferences: state.intent.preferences } : undefined,
        planCount: 4,
        maxVerify: 40,
      },
      signal: controller.signal,
    });
    if (seq !== state.seq) return; // 过期响应，直接丢弃
    state.result = r;
    state.compare = [];
    state.overrides = {};
    renderResult(r);
  } catch (err) {
    if (err.name === 'AbortError' || seq !== state.seq) return;
    renderError(err);
  }
}

/* ---------------- 渲染：加载 / 错误 ---------------- */
function renderLoading() {
  $('results').innerHTML = `
    <div class="res-head"><h2>正在按你的需求搜索</h2></div>
    <div class="skeleton-grid">${'<div class="skeleton"></div>'.repeat(3)}</div>`;
}

/* ---------------- 失败交互：按失败类型给可行操作 ----------------
 * 5 类失败各有各的人话与可行操作：
 * ① 门店菜单不可查 ② 网络失败 ③ 模型解析降级 ④ 无符合条件方案 ⑤ 价格验证失败
 * 主界面只说人话：不出现 MCP 工具名 / 错误码 / 字段名；
 * 技术证据统一收进「诊断详情」折叠区（供工程台排查）。
 */
function humanizeError(err) {
  const isMenu = err.code === 'menu_unavailable';
  const isLimited = err.code === 'rate_limited';
  const isNetwork = err.category === 'network' || err.code === 'mcp_network' || err.code === 'mcp_http';
  if (isMenu) {
    return {
      kind: 'menu',
      title: err.message || '当前门店暂时无法获取菜单，暂时不能进行实时核价。',
      body: '这不是「没有符合你要求的套餐」，而是现在拿不到门店菜单，没法实时核价。',
      reason: err.reason || '',
    };
  }
  if (isLimited) return { kind: 'limited', title: '点得有点快，先歇一下', body: err.message || '等一会儿再试就好。', reason: '' };
  if (isNetwork) return { kind: 'network', title: '网络不太稳定，这次没连上', body: '可以点「重试」再试一次。', reason: '' };
  return { kind: 'other', title: '这次没算出来', body: '服务暂时没响应过来，你可以重试一次。', reason: '' };
}

function renderError(err) {
  const h = humanizeError(err);
  const isMenu = h.kind === 'menu';
  const title = h.title;
  const body = h.body;
  const reason = h.reason;

  const acts = err.actions?.length ? err.actions : ['retry'];
  const btns = [];
  if (acts.includes('retry') || acts.includes('retry_later')) {
    btns.push(`<button class="btn btn-primary" data-act="retry">${acts.includes('retry_later') ? '过一会儿再试' : '重试'}</button>`);
  }
  if (acts.includes('switch_store') || isMenu) {
    btns.push('<button class="btn btn-primary" data-act="switch-store">换一家门店</button>');
  }

  // 诊断详情只进折叠区（工具名 / 错误码 / traceId / 营业证据），不进主文案
  const d = err.diagnosis || {};
  const detailBits = [
    err.code ? `错误码 ${err.code}` : '',
    err.category ? `分类 ${err.category}` : '',
    d.tool ? `工具 ${d.tool}` : '',
    d.code ? `业务码 ${d.code}` : '',
    d.traceId ? `traceId ${d.traceId}` : '',
    d.storeEvidence
      ? `门店证据 营业状态=${d.storeEvidence.businessStatus} 时间=${d.storeEvidence.businessStartTime}-${d.storeEvidence.businessEndTime}`
      : '',
  ].filter(Boolean);

  $('results').innerHTML = `
    <div class="state">
      <h3>${esc(title)}</h3>
      <p>${esc(body)}</p>
      ${reason ? `<p class="muted">${esc(reason)}</p>` : ''}
      <div class="state-actions">${btns.join('')}</div>
      ${detailBits.length ? `<details class="data-note"><summary>诊断详情（排查用）</summary><p><code>${esc(detailBits.join(' · '))}</code></p></details>` : ''}
    </div>`;
}

/* ---------------- 门店切换（用户确认 + 真实验证后才切换） ---------------- */
async function openStorePicker() {
  const seq = ++state.storeSwitchSeq;
  $('results').innerHTML = `
    <div class="res-head"><h2>换一家门店</h2></div>
    <div class="state"><p>正在读取可选门店…</p></div>`;
  let r;
  try {
    r = await api('/api/stores');
  } catch (err) {
    if (seq !== state.storeSwitchSeq) return;
    $('results').innerHTML = `
      <div class="state">
        <h3>门店列表暂时没取到</h3>
        <p>${esc(err.reason || '稍后再试一次。')}</p>
        <div class="state-actions">
          <button class="btn btn-primary" data-act="switch-store">重试</button>
          <button class="btn btn-ghost" data-act="retry">返回推荐</button>
        </div>
      </div>`;
    return;
  }
  if (seq !== state.storeSwitchSeq) return;
  const rows = (r.stores || [])
    .map((s) => {
      const open = s.businessStatus === true;
      const hours = s.businessStartTime && s.businessEndTime ? `${s.businessStartTime}–${s.businessEndTime}` : '营业时间未知';
      return `
      <div class="store-row">
        <div>
          <b>${esc(s.storeName || s.storeCode)}</b>
          ${s.storeCode === state.store.code ? '<span class="flag flag-ok">当前门店</span>' : ''}
          <div class="muted">${esc(s.address || '')}${s.distance != null ? ` · 距 ${s.distance} 米` : ''}</div>
          <div class="muted">${open ? '营业中' : '当前休息'} · ${esc(hours)}</div>
        </div>
        ${
          s.storeCode === state.store.code
            ? ''
            : `<button class="btn btn-ghost" data-store="${esc(s.storeCode)}" data-storename="${esc(s.storeName || s.storeCode)}">选这家</button>`
        }
      </div>`;
    })
    .join('');
  $('results').innerHTML = `
    <div class="res-head"><h2>换一家门店</h2></div>
    <p class="res-why">当前门店：${esc(state.store.name || '默认门店')}。这里的距离和营业状态来自官方门店数据；标「营业中」的门店，切换前我们还会真实查一次菜单确认可用。换门店后，菜单、价格和推荐都会按新门店重新查询。</p>
    <div class="store-list">${rows || '<p class="muted">暂时没找到可选门店。</p>'}</div>
    <div id="storeVerify"></div>
    <div class="state-actions"><button class="btn btn-ghost" data-act="retry">返回推荐</button></div>`;
}

async function pickStore(code, name) {
  if (!window.confirm(`切换到「${name}」？\n之后的菜单、价格和推荐都按这家门店计算。`)) return;
  const slot = $('storeVerify');
  const seq = ++state.storeSwitchSeq;
  if (slot) slot.innerHTML = '<p class="muted">正在确认这家门店能查到菜单…</p>';
  try {
    await api('/api/stores/verify', { method: 'POST', body: { storeCode: code } });
    if (seq !== state.storeSwitchSeq) return;
    state.store = { code, name };
    if (slot) slot.innerHTML = `<p class="muted">已切换到「${esc(name)}」，正在按新门店重新查询。</p>`;
    recommend('store-switch');
  } catch (err) {
    if (seq !== state.storeSwitchSeq) return;
    // 验证没过就是没过：如实说原因（含营业时间证据），不切换、不冒充可用
    if (slot) {
      slot.innerHTML = `
        <div class="state">
          <h3>这家门店暂时查不到菜单，先不切换</h3>
          <p>${esc(err.reason || err.message || '换一家门店试试。')}</p>
        </div>`;
    }
  }
}

/* ---------------- 渲染：结果 ---------------- */
function planLabel(plan, ctx, seenMinPrice) {
  const prices = ctx.plans.map((p) => p.price.fen).filter((v) => v != null);
  const proteins = ctx.plans.map((p) => p.nutrition.protein).filter((v) => v != null);
  const minPrice = Math.min(...prices);
  const maxProtein = Math.max(...proteins);
  const wantsProtein = (ctx.constraints.objectives || []).some((o) => o.metric === 'protein' && o.direction === 'max');

  if (plan.price.fen === minPrice) {
    // 同价并列时，第一套标最省钱，其余说明同样最低价但搭配不同，不重复贴同一个标签
    return seenMinPrice
      ? { text: '同样最低价 · 不同搭配', cls: 'label-soft' }
      : { text: '当前已核价候选中最省钱', cls: 'label-best' };
  }
  if (wantsProtein && plan.nutrition.protein === maxProtein) return { text: '高蛋白选择', cls: 'label-best' };
  if (plan.pareto?.nonDominated) return { text: '同价不同搭配', cls: 'label-soft' };
  if (plan.softMatched?.length) return { text: '更接近你的偏好', cls: 'label-soft' };
  return { text: '换一种搭配', cls: 'label-alt' };
}

/* ---------------- 用餐时段提示：只说「现在只能核实当前时段」，不预测未来菜单 ---------------- */
function mealTimeNote(r) {
  const t = r.mealTime;
  if (!t || !t.mismatch || !t.note) return '';
  return `<p class="res-why" data-mealtime>${esc(t.note)}</p>`;
}

function renderResult(r) {
  if (r.status === 'infeasible') {
    renderInfeasible(r);
    return;
  }
  if (!r.plans?.length) {
    // 失败分类④：无符合条件方案 —— 给可行操作（放宽预算 / 手动改条件）
    $('results').innerHTML = `
      <div class="state">
        <h3>没有可用方案</h3>
        <p>当前条件下没找到能核价的组合，试着放宽预算或去掉一个必须项。</p>
        <div class="state-actions">
          <button class="btn btn-primary" data-act="loosen">帮我把预算放宽一点</button>
          <button class="btn btn-ghost" data-act="edit-constraints">手动改条件</button>
        </div>
      </div>`;
    return;
  }
  // 日常点餐：1 套主推 + 至多 2 套备选，解释用短句，不把用户当营养师
  if (r.selection?.basis === 'daily') {
    renderDailyResult(r);
    return;
  }
  const ctx = { plans: r.plans, constraints: r.constraints };
  const sel = r.selection || {};
  const strictN = r.plans.filter((p) => p.pareto?.nonDominated).length;
  const divN = r.plans.length - strictN;
  const dims = (sel.dimensions || []).map((d) => d.label).join('、');
  // 用直白的话解释为什么给多套，术语只留在展开面板里
  const why =
    sel.basis === 'strict-front'
      ? `这几套${dims ? `在「${dims}」上` : ''}各有优势，没有一套在所有指标上都更好，所以都留给你挑。`
      : `按「${dims || '价格'}」先排：最省的 ${strictN} 套，加上 ${divN} 套更有特点的搭配（价格更高，但营养或口味更合适）。`;
  const head = `
    <div class="res-head">
      <h2>为你找到 ${r.plans.length} 套方案</h2>
      ${state.store.name ? `<span class="res-scope">门店：${esc(state.store.name)}</span>` : ''}
    </div>
    <p class="res-why">${esc(why)}</p>
    ${mealTimeNote(r)}`;
  let seenMin = false;
  const cards = r.plans
    .map((p, i) => {
      const isMin = p.price.fen === Math.min(...r.plans.map((x) => x.price.fen));
      const card = planCard(p, i, ctx, seenMin);
      if (isMin) seenMin = true;
      return card;
    })
    .join('');
  $('results').innerHTML = `${head}<div class="card-grid">${cards}</div><div id="compareSlot"></div>${dataNote(r)}`;
  renderCompareBar();
}

/* ---------------- 日常模式：主推 + 备选 ---------------- */
function renderDailyResult(r) {
  const plans = r.plans;
  const primary = plans.find((p) => p.isPrimary) || plans[0];
  const alternates = plans.filter((p) => p !== primary).slice(0, 2);
  const head = `
    <div class="res-head"><h2>直接给你推荐</h2>${state.store.name ? `<span class="res-scope">门店：${esc(state.store.name)}</span>` : ''}</div>
    <p class="res-why">${esc(r.selection?.note || '按你的口味和价位挑的，不是单纯挑最便宜。')}</p>
    ${mealTimeNote(r)}`;
  const hero = dailyCard(primary, 0, r);
  const alts = alternates.map((p, i) => dailyCard(p, i + 1, r)).join('');
  $('results').innerHTML = `
    ${head}
    ${hero}
    ${alternates.length ? `<h3 class="alt-title">不合口味可以换这几套</h3><div class="card-grid">${alts}</div>` : ''}
    <div id="compareSlot"></div>
    ${dataNote(r)}`;
  renderCompareBar();
}

function dailyCard(plan, index, r) {
  const p = state.overrides[plan.id] || plan;
  const d = p.daily || plan.daily || {};
  const nut = p.nutrition || {};
  const picked = state.compare.includes(plan.id);
  const reasons = (d.reasons || []).filter(Boolean);
  const cautions = (d.cautions || []).filter(Boolean);
  const unverifiable = (r.constraints?.dietaryRestrictions || []).filter((x) => !x.verified);

  return `
  <article class="pcard ${index === 0 ? 'pcard-hero' : ''} ${picked ? 'picked' : ''}" data-plan="${esc(plan.id)}" data-kind="${esc(p.kind)}" data-price="${p.price.fen}" data-kcal="${nut.energyKcal ?? ''}" data-protein="${nut.protein ?? ''}">
    <div class="pcard-top">
      <div>
        <span class="pcard-label ${index === 0 ? 'label-best' : 'label-soft'}">${index === 0 ? '主推' : `备选 ${index}`}</span>
        <h3 class="pcard-title">${esc(p.productName)}</h3>
      </div>
      <div class="pcard-price">
        <b>${yuan(p.price.fen)}</b>
        <span>${timeText(p.price.checkedAt)} 实算</span>
      </div>
    </div>

    <div class="pcard-comp">${(p.components || [])
      .map((c) => `${esc(c.name)}${c.quantity > 1 ? ` ×${c.quantity}` : ''}`)
      .join('<em> + </em>')}</div>

    <div class="macros">
      <div><b>${numText(nut.energyKcal)}</b><span>kcal</span></div>
      <div><b>${numText(nut.protein)}</b><span>蛋白质 g</span></div>
      <div><b>${numText(nut.fat)}</b><span>脂肪 g</span></div>
      <div><b>${numText(nut.carbohydrate)}</b><span>碳水 g</span></div>
    </div>

    ${reasons.length ? `<ul class="daily-reasons">${reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}

    ${(cautions.length || unverifiable.length) ? `<div class="daily-cautions">${[
      ...cautions,
      ...unverifiable.map((x) => `${esc(x.text)}：菜单无对应数据，无法核实`),
    ].map((x) => `<p>${esc(x)}</p>`).join('')}</div>` : ''}

    <div class="pcard-why">
      <button class="why-toggle" type="button" data-why="${esc(plan.id)}">为什么推荐 · 数据来源</button>
      <div class="why-body hidden" data-whybody="${esc(plan.id)}">
        ${d.tags?.length ? `<div class="muted">标签：${esc(d.tags.join('、'))}</div>` : ''}
        <div class="muted">${esc(p.nutrition?.basis || '')}${p.nutrition?.status === 'derived_sum' ? '' : '（部分组件缺官方营养，不能据此判定营养约束）'}</div>
        <div class="muted">排序口径：先满足硬条件，再按「像不像一顿饭 + 口味 + 温度 + 价位意图」排；辣度/温度没有官方字段，按名称保守判断。</div>
        <code>traceId ${esc(p.mcp?.traceId || '—')} · 核价 ${timeText(p.price.checkedAt)}</code>
      </div>
    </div>

    <div class="pcard-actions">
      <button class="btn btn-ghost" type="button" data-detail="${esc(plan.id)}">${p.kind === 'meal' ? '调整套餐' : '查看组成'}</button>
      <button class="btn btn-ghost" type="button" data-cmp="${esc(plan.id)}">${picked ? '取消对比' : '加入对比'}</button>
    </div>
  </article>`;
}

/** 搜索范围/核价口径默认收起：普通用户不需要看候选数和覆盖度 */
function dataNote(r) {
  const s = r.searchScope;
  if (!s) return '';
  return `<details class="data-note"><summary>数据说明（搜索范围与核价口径）</summary>
    <p>${esc(scopeText(s))}</p>
    <p>${esc(s.spaceNote || '')}</p></details>`;
}

function scopeText(s) {
  if (!s) return '';
  const parts = [`门店在售 ${s.pool.meals + Object.values(s.pool.singles).reduce((a, b) => a + b, 0)} 个商品`];
  parts.push(`候选 ${s.candidatesGenerated} 个，核价 ${s.candidatesPriced} 个`);
  parts.push(s.completeness === 'full' ? '已覆盖符合条件的全部候选' : '覆盖部分候选（非穷举）');
  return parts.join(' · ');
}

function planCard(plan, index, ctx, seenMinPrice = false) {
  const p = state.overrides[plan.id] || plan;
  const label = planLabel(p, ctx, seenMinPrice);
  const picked = state.compare.includes(plan.id);
  const nut = p.nutrition || {};
  const flags = [];
  if (p.hardSatisfied?.length) flags.push(`<span class="flag flag-ok">满足 ${p.hardSatisfied.length} 项条件</span>`);
  // 面向用户不展示"非支配 / 差异化补充"这类术语，改在"为什么推荐"里用直白的话说明
  if (p.price?.status === 'valued') flags.push('<span class="flag flag-ok">MCP 实算价格</span>');
  if (p.nutrition?.status !== 'derived_sum') flags.push('<span class="flag flag-warn">营养不完整</span>');
  const unverifiable = (ctx.constraints.dietaryRestrictions || []).filter((d) => !d.verified);
  if (unverifiable.length) flags.push(`<span class="flag flag-warn">${unverifiable.length} 项条件无法验证</span>`);

  return `
  <article class="pcard ${picked ? 'picked' : ''}" data-plan="${esc(plan.id)}" data-kind="${esc(p.kind)}" data-price="${p.price.fen}" data-kcal="${nut.energyKcal ?? ''}" data-protein="${nut.protein ?? ''}">
    <div class="pcard-top">
      <div>
        <span class="pcard-idx">${index + 1}</span>
        <h3 class="pcard-title">${esc(p.productName)}</h3>
        <span class="pcard-label ${label.cls}">${esc(label.text)}</span>
      </div>
      <div class="pcard-price">
        <b>${yuan(p.price.fen)}</b>
        <span>${timeText(p.price.checkedAt)} 实算</span>
      </div>
    </div>

    <div class="pcard-comp">${(p.components || [])
      .map((c) => `${esc(c.name)}${c.quantity > 1 ? ` ×${c.quantity}` : ''}`)
      .join('<em> + </em>')}</div>

    <div class="macros">
      <div><b>${numText(nut.energyKcal)}</b><span>kcal</span></div>
      <div><b>${numText(nut.protein)}</b><span>蛋白质 g</span></div>
      <div><b>${numText(nut.fat)}</b><span>脂肪 g</span></div>
      <div><b>${numText(nut.carbohydrate)}</b><span>碳水 g</span></div>
    </div>

    <div class="pcard-flags">${flags.join('')}</div>

    <div class="pcard-why">
      <button class="why-toggle" type="button" data-why="${esc(plan.id)}">为什么推荐 · 数据来源</button>
      <div class="why-body hidden" data-whybody="${esc(plan.id)}">
        <div>${p.advantages?.length ? esc(p.advantages.join(' / ')) : '在已核价候选中属于可行解'}</div>
        ${p.tradeoffs?.length ? `<div class="muted">代价：${esc(p.tradeoffs.join(' / '))}</div>` : ''}
        <div class="muted">${esc(p.nutrition?.basis || '')}${p.nutrition?.status === 'derived_sum' ? '' : '（部分组件缺官方营养，不能据此判定营养约束）'}</div>
        ${p.pareto?.dominatedBy?.length ? `<div class="muted">和「${esc(p.pareto.dominatedBy[0].name)}」相比，这套贵 ${yuan(-p.pareto.dominatedBy[0].deltaFen)}；选它是因为它在其它方面有优势。</div>` : '<div class="muted">在已核价的方案里，没有别的方案在价格和蛋白质上同时优于它。</div>'}
        <code>traceId ${esc(p.mcp?.traceId || '—')} · 核价 ${timeText(p.price.checkedAt)}</code>
      </div>
    </div>

    <div class="pcard-actions">
      <button class="btn btn-ghost" type="button" data-detail="${esc(plan.id)}">${p.kind === 'meal' ? '调整套餐' : '查看组成'}</button>
      <button class="btn btn-ghost" type="button" data-cmp="${esc(plan.id)}">${picked ? '取消对比' : '加入对比'}</button>
    </div>
  </article>`;
}

/* ---------------- 不可行 ---------------- */
function renderInfeasible(r) {
  const a = r.analysis || {};
  const enabled = (a.enabledConstraints || []).map((x) => KEY_LABEL[x.key] || x.label).join('、') || '无';
  const relax = (a.relaxations || [])
    .map(
      (x) =>
        `<li class="relax-item"><b>放宽「${esc(x.label)}」</b>：${esc(x.note)}${
          x.cheapest ? `<br/><span class="muted">最便宜：${esc(x.cheapest.name)} ${yuan(x.cheapest.priceFen)} · ${numText(x.cheapest.kcal)} kcal · 蛋白 ${numText(x.cheapest.protein)} g</span>` : ''
        }</li>`,
    )
    .join('');
  const rows = (a.closest || [])
    .map(
      (c) => `<tr>
        <td>${esc(c.candidate.name)}</td>
        <td class="num">${yuan(c.candidate.priceFen)}</td>
        <td class="num">${numText(c.candidate.kcal)}</td>
        <td class="num">${numText(c.candidate.protein)}</td>
        <td>${c.violations
          .filter((v) => v.verified !== false)
          .map((v) => `<span class="flag flag-bad">${esc(v.detail)}</span>`)
          .join(' ')}</td>
      </tr>`,
    )
    .join('');

  $('results').innerHTML = `
    <div class="res-head"><h2>这些条件凑不出一餐</h2><span class="res-scope">${esc(scopeText(r.searchScope))}</span></div>
    <div class="infeasible">
      <h3>${esc(a.reason || '没有找到同时满足全部条件的组合')}</h3>
      <p>你启用的硬约束：${esc(enabled)}。下面是基于已核价候选的真实结果，不是猜的。</p>
      <h4>如果放宽其中一个条件</h4>
      <ul>${relax || '<li>没有可放宽的条件</li>'}</ul>
      ${rows ? `<h4>最接近的组合（都标注了差多少）</h4>
      <table class="alt-table"><thead><tr><th>组合</th><th class="num">核价</th><th class="num">kcal</th><th class="num">蛋白</th><th>差距</th></tr></thead><tbody>${rows}</tbody></table>` : ''}
      ${a.unverifiable?.length ? `<p class="muted">无法验证：${a.unverifiable.map((u) => esc(u.text)).join('、')} —— 系统不会声称已满足。</p>` : ''}
      <p class="muted">${esc(a.scopeNote || '')}</p>
      <button class="btn btn-primary" type="button" data-act="loosen">帮我把预算放宽一点</button>
    </div>`;
}

const KEY_LABEL = { budgetMax: '预算上限', caloriesMax: '热量上限', caloriesMin: '热量下限', proteinMin: '蛋白质下限', requiredCategories: '必须包含' };

/* ---------------- 比较 ---------------- */
function toggleCompare(id) {
  const i = state.compare.indexOf(id);
  if (i >= 0) state.compare.splice(i, 1);
  else {
    if (state.compare.length >= 2) state.compare.shift();
    state.compare.push(id);
  }
  // 只更新卡片状态与对比条，不整块重绘（否则第二次点击会点到已被替换的按钮）
  document.querySelectorAll('.pcard').forEach((card) => {
    const on = state.compare.includes(card.dataset.plan);
    card.classList.toggle('picked', on);
    const btn = card.querySelector('[data-cmp]');
    if (btn) btn.textContent = on ? '取消对比' : '加入对比';
  });
  renderCompareBar();
}

async function renderCompareBar() {
  const slot = $('compareSlot');
  if (!slot) return;
  if (state.compare.length < 2) {
    slot.innerHTML =
      state.compare.length === 1
        ? `<div class="compare-bar"><div class="cmp-head"><span class="cmp-title">已选 1 套，再选一套即可对比</span><button class="cmp-close" data-act="clearCmp">清除</button></div></div>`
        : '';
    return;
  }
  const [a, b] = state.compare.map((id) => state.overrides[id] || state.result.plans.find((p) => p.id === id));
  slot.innerHTML = `<div class="compare-bar"><div class="cmp-head"><span class="cmp-title">对比中…</span></div></div>`;
  try {
    const r = await api(API.compare, { method: 'POST', body: { a, b } });
    const d = r.delta;
    const cell = (v, unit, invert) => {
      if (v == null) return '<td class="num">—</td>';
      const cls = invert ? (v > 0 ? 'down' : v < 0 ? 'up' : '') : v > 0 ? 'up' : v < 0 ? 'down' : '';
      return `<td class="num ${cls}">${v > 0 ? '+' : ''}${v}${unit}</td>`;
    };
    slot.innerHTML = `
      <div class="compare-bar">
        <div class="cmp-head">
          <span class="cmp-title">${esc(a.productName)} ↔ ${esc(b.productName)}</span>
          <button class="cmp-close" data-act="clearCmp">关闭对比</button>
        </div>
        <table class="cmp-table">
          <thead><tr><th>指标</th><th>A</th><th>B</th><th>差值（B−A）</th></tr></thead>
          <tbody>
            <tr><td>价格</td><td class="num">${yuan(r.a.priceFen)}</td><td class="num">${yuan(r.b.priceFen)}</td><td class="num">${d.priceYuan == null ? '—' : `${d.priceYuan > 0 ? '+' : ''}¥${d.priceYuan.toFixed(2)}`}</td></tr>
            <tr><td>热量</td><td class="num">${numText(r.a.kcal)}</td><td class="num">${numText(r.b.kcal)}</td>${cell(d.kcal, ' kcal', true)}</tr>
            <tr><td>蛋白质</td><td class="num">${numText(r.a.protein)}</td><td class="num">${numText(r.b.protein)}</td>${cell(d.protein, ' g', false)}</tr>
          </tbody>
        </table>
        <p class="cmp-summary">${esc(r.summary)}</p>
      </div>`;
  } catch (err) {
    slot.innerHTML = `<div class="compare-bar"><div class="cmp-head"><span class="cmp-title">对比失败：${esc(err.message)}</span><button class="cmp-close" data-act="clearCmp">关闭</button></div></div>`;
  }
}

/* ---------------- 详情抽屉 + 规格替换 ---------------- */
async function openDetail(planId) {
  const plan = state.overrides[planId] || state.result?.plans?.find((p) => p.id === planId);
  if (!plan) return;
  const seq = ++state.drawerSeq;
  state.rebuildSeq += 1; // 换方案时作废上一套方案在途的重算
  state.drawer = { planId, code: plan.productCode, kind: plan.kind, rounds: null, choices: {}, last: plan };
  $('drawer').classList.remove('hidden');
  $('drawerTitle').textContent = plan.productName;
  $('drawerSub').textContent = `${plan.kind === 'meal' ? '官方套餐 · 可调整规格' : '单品组合 · 由多个单品组成'}`;
  $('drawerContent').innerHTML = '<div class="state"><p>读取套餐结构…</p></div>';

  try {
    if (plan.kind === 'meal') {
      const r = await api(withStore(API.rounds(plan.productCode)));
      if (seq !== state.drawerSeq || state.drawer.planId !== planId) return;
      state.drawer.rounds = r;
      for (const round of r.rounds) {
        const fromPlan = plan.rounds?.find((x) => String(x.round) === String(round.id));
        state.drawer.choices[round.id] = fromPlan?.code || round.choices.find((c) => c.isDefault)?.code || round.choices[0].code;
      }
      renderDrawer(plan, r);
    } else {
      if (seq !== state.drawerSeq) return;
      renderDrawer(plan, null);
    }
  } catch (err) {
    $('drawerContent').innerHTML = `<div class="state"><p>读取失败：${esc(err.message)}</p></div>`;
  }
}

function renderDrawer(plan, rounds) {
  const p = state.overrides[plan.id] || plan;
  const nut = p.nutrition || {};
  const checks = p._checks || null;

  const roundsHtml = rounds
    ? `<div>
        <p class="sec-title">套餐组成 <span class="muted">改动后会重新核价</span></p>
        ${rounds.rounds
          .map((r) => {
            const cur = state.drawer.choices[r.id];
            const opts = r.choices
              .map((c) => {
                const diff = c.diffPriceFen == null ? '' : c.diffPriceFen === 0 ? '（原价）' : `（${c.diffPriceFen > 0 ? '+' : ''}¥${(c.diffPriceFen / 100).toFixed(1)}）`;
                // 没有官方营养数据的替换项必须显式标注，不能让它看起来也能算营养
                const unknown = c.nutrition && c.nutrition.status !== 'official' ? '（该选项无官方营养数据）' : '';
                return `<option value="${esc(c.code)}" ${c.code === cur ? 'selected' : ''}>${esc(c.name)}${diff}${unknown}</option>`;
              })
              .join('');
            const unknownCount = r.choices.filter((c) => c.nutrition && c.nutrition.status !== 'official').length;
            return `<div class="round-row">
              <label for="round-${esc(r.id)}">${esc(r.name)}</label>
              <select id="round-${esc(r.id)}" data-round="${esc(r.id)}">${opts}</select>
              <span class="r-note">可选 ${r.choices.length} 种${unknownCount ? ` · ${unknownCount} 项无营养数据` : ''}</span>
            </div>`;
          })
          .join('')}
      </div>`
    : `<div><p class="sec-title">组成</p><div class="pcard-comp">${(p.components || []).map((c) => esc(c.name)).join('<em> + </em>')}</div></div>`;

  const modItems = (rounds?.rounds || [])
    .flatMap((r) => (r.choices || []).filter((c) => c.code === state.drawer.choices[r.id]).flatMap((c) => (c.modification?.items || []).flatMap((g) => g.values.map((v) => `${r.name}：${v.name}`))));
  const modHtml = modItems.length
    ? `<div class="mod-box"><b>特制选项（仅信息展示）</b>
        <div>这份套餐在门店还支持：${esc([...new Set(modItems)].join('、'))}。但官方没有提供这些特制后的营养数据，系统无法计算去酱/去冰/去吉士后的热量与蛋白质，因此不会把特制版本当成"满足营养条件"。</div>
      </div>`
    : '';

  $('drawerContent').innerHTML = `
    ${roundsHtml}
    <div>
      <p class="sec-title">价格 <span class="muted">MCP calculate-price 实算</span></p>
      <div class="price-line">
        <b>${yuan(p.price.fen)}</b>
        <span class="muted">${timeText(p.price.checkedAt)} 核价</span>
      </div>
      <div class="prov">traceId ${esc(p.mcp?.traceId || '—')}</div>
    </div>

    <div>
      <p class="sec-title">营养（标准配置） <span class="muted">各组件官方值之和</span></p>
      <div class="nutri-grid">
        <div><b class="${nut.energyKcal == null ? 'na' : ''}">${numText(nut.energyKcal)}</b><span>热量 kcal</span></div>
        <div><b class="${nut.protein == null ? 'na' : ''}">${numText(nut.protein)}</b><span>蛋白质 g</span></div>
        <div><b class="${nut.fat == null ? 'na' : ''}">${numText(nut.fat)}</b><span>脂肪 g</span></div>
        <div><b class="${nut.carbohydrate == null ? 'na' : ''}">${numText(nut.carbohydrate)}</b><span>碳水 g</span></div>
        <div><b class="${nut.sodium == null ? 'na' : ''}">${numText(nut.sodium)}</b><span>钠 mg</span></div>
        <div><b class="${nut.calcium == null ? 'na' : ''}">${numText(nut.calcium)}</b><span>钙 mg</span></div>
      </div>
      ${nut.status !== 'derived_sum' ? '<p class="muted" style="font-size:12px;margin-top:8px">部分组件缺少官方营养数据，以上数值不完整，不能用来宣称满足营养条件。</p>' : ''}
    </div>

    <div>
      <p class="sec-title">条件核对</p>
      <div class="check-list" id="checkList">${renderChecks(p, checks)}</div>
    </div>

    ${modHtml}
    <div class="muted" style="font-size:11.5px">${esc(p.nutrition?.basis || '')}</div>`;
}

function renderChecks(p, checks) {
  const rows = [];
  const violations = checks?.violations || [];
  const satisfied = checks?.satisfied || p.hardSatisfied || [];
  for (const s of satisfied) rows.push(`<div class="check-row"><span class="dot dot-ok"></span><span>${esc(s)}</span></div>`);
  for (const v of violations) rows.push(`<div class="check-row"><span class="dot dot-bad"></span><span>${esc(KEY_LABEL[v.key] || v.key)}：${esc(v.detail)}</span></div>`);
  if (!rows.length) rows.push(`<div class="check-row"><span class="dot dot-warn"></span><span>没有启用硬约束</span></div>`);
  for (const d of state.base.dietaryRestrictions || []) {
    rows.push(`<div class="check-row"><span class="dot dot-warn"></span><span>${esc(d.text)}：菜单无辣度/过敏原数据，无法验证</span></div>`);
  }
  return rows.join('');
}

async function rebuildFromDrawer() {
  const { planId, kind, rounds } = state.drawer;
  if (!planId) return;
  /**
   * 连续快速改多个 round 时，先发的请求可能后返回。
   * 这里用序号守卫：只有最后一次改动的核价结果才允许写回界面，
   * 否则会出现下拉已经是大杯、营养还是中杯的自相矛盾。
   */
  const seq = ++state.rebuildSeq;
  const plan = state.overrides[planId] || state.result?.plans?.find((p) => p.id === planId);
  if (!plan) return;

  const list = $('drawerContent');
  const checksEl = $('checkList');
  if (checksEl) checksEl.innerHTML = '<div class="check-row"><span class="dot dot-warn"></span><span>正在重新核价…</span></div>';

  const body =
    kind === 'meal'
      ? { productCode: plan.productCode, choices: rounds.rounds.map((r) => ({ round: String(r.id), code: state.drawer.choices[r.id] })) }
      : { components: (plan.components || []).map((c) => ({ code: c.code, quantity: c.quantity ?? 1 })) };
  body.constraints = readConstraints();

  try {
    const r = await api(withStore(API.rebuild), { method: 'POST', body });
    if (seq !== state.rebuildSeq) return; // 过期响应，丢弃
    if (r.status !== 'ok') {
      // 价格验证失败：保留分类字段，让人话分类和诊断折叠区都能用
      const e = r.error || {};
      const err = new Error(e.message || '核价失败');
      err.code = e.code || null;
      err.category = e.category || null;
      err.reason = e.reason || null;
      err.diagnosis = e.diagnosis || null;
      throw err;
    }
    const rebuilt = { ...r.plan, id: planId, _checks: r.checks, pareto: plan.pareto };
    state.overrides[planId] = rebuilt;
    state.drawer.last = rebuilt;
    renderDrawer(rebuilt, rounds);
    // 同步更新卡片（价格/营养/核价时间）
    if (state.result) renderResult(state.result);
    // 抽屉被 renderResult 重绘不影响，重新打开只更新内容
    if (list) list.scrollTop = 0;
  } catch (err) {
    if (seq !== state.rebuildSeq) return;
    const h = humanizeError(err);
    if (checksEl) {
      // 价格验证失败：说清「没核上就是没核上」，改动不写回、旧价格不冒充新搭配，并给重试入口
      checksEl.innerHTML = `
        <div class="check-row"><span class="dot dot-bad"></span><span>重新核价没成功：${esc(h.title)}</span></div>
        <div class="check-row"><span class="dot dot-warn"></span><span>这次改动没有写回；价格和营养仍是你上次核价的结果，不会拿旧价格冒充新搭配。</span></div>
        ${h.reason ? `<div class="check-row"><span class="dot dot-warn"></span><span>${esc(h.reason)}</span></div>` : ''}
        <button class="btn btn-primary" type="button" data-act="retry-rebuild">重试核价</button>`;
    }
  }
}

/* ---------------- 事件绑定 ---------------- */
$('askBtn').addEventListener('click', ask);
$('q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    ask();
  }
});
$('examples').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-q]');
  if (!btn) return;
  $('q').value = btn.dataset.q;
  ask();
});

for (const k of NUM_KEYS) {
  $(`on-${k}`).addEventListener('change', (e) => {
    state.enabled[k] = e.target.checked;
    // 关闭时清空，避免灰色输入框里残留一个看起来仍然生效的数值
    if (!e.target.checked) $(`in-${k}`).value = '';
    else if ($(`in-${k}`).value === '') $(`in-${k}`).focus();
    syncConstraintUI();
    scheduleRecommend('number');
  });
  $(`in-${k}`).addEventListener('input', () => scheduleRecommend('number'));
}

$('requiredChips').addEventListener('change', (e) => {
  const v = e.target.value;
  const set = new Set(state.base.requiredCategories);
  e.target.checked ? set.add(v) : set.delete(v);
  state.base.requiredCategories = [...set];
  scheduleRecommend('chips');
});

$('objectiveChips').addEventListener('change', () => {
  const obj = [];
  $('objectiveChips')
    .querySelectorAll('input:checked')
    .forEach((el) => {
      const [metric, dir] = el.value.split(':');
      obj.push({ metric, direction: dir });
    });
  state.base.objectives = obj;
  scheduleRecommend('chips');
});

function addChip(kind) {
  const input = kind === 'pref' ? $('prefInput') : $('exclInput');
  const key = kind === 'pref' ? 'preferredFoods' : 'excludedFoods';
  const v = input.value.trim();
  if (!v) return;
  if (!state.base[key].includes(v)) state.base[key].push(v);
  input.value = '';
  syncConstraintUI();
  scheduleRecommend('chips');
}

document.querySelectorAll('[data-add]').forEach((btn) => {
  btn.addEventListener('click', () => addChip(btn.dataset.add));
});
['prefInput', 'exclInput'].forEach((id) => {
  $(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addChip(id === 'prefInput' ? 'pref' : 'excl');
    }
  });
});

$('prefChips').addEventListener('click', (e) => {
  const b = e.target.closest('.chip-x');
  if (!b) return;
  state.base.preferredFoods.splice(Number(b.dataset.i), 1);
  syncConstraintUI();
  scheduleRecommend('chips');
});
$('exclChips').addEventListener('click', (e) => {
  const b = e.target.closest('.chip-x');
  if (!b) return;
  state.base.excludedFoods.splice(Number(b.dataset.i), 1);
  syncConstraintUI();
  scheduleRecommend('chips');
});

$('regenBtn').addEventListener('click', () => recommend('manual'));

// 高级条件面板默认收起：普通用户看「需求理解」就够了，想改再展开
$('advToggle').addEventListener('click', () => {
  const panel = $('constraintsPanel');
  const nowHidden = panel.classList.toggle('hidden');
  $('advToggle').textContent = nowHidden ? '微调条件 ▾' : '收起条件 ▴';
  if (!nowHidden) panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

$('results').addEventListener('click', (e) => {
  const why = e.target.closest('[data-why]');
  if (why) {
    const body = $('results').querySelector(`[data-whybody="${why.dataset.why}"]`);
    if (body) body.classList.toggle('hidden');
    return;
  }
  const cmp = e.target.closest('[data-cmp]');
  if (cmp) return toggleCompare(cmp.dataset.cmp);
  const det = e.target.closest('[data-detail]');
  if (det) return openDetail(det.dataset.detail);
  const storeBtn = e.target.closest('[data-store]');
  if (storeBtn) return pickStore(storeBtn.dataset.store, storeBtn.dataset.storename);
  const act = e.target.closest('[data-act]');
  if (act) {
    if (act.dataset.act === 'retry') return recommend('retry');
    if (act.dataset.act === 'switch-store') return openStorePicker();
    if (act.dataset.act === 'clearCmp') {
      state.compare = [];
      return state.result ? renderResult(state.result) : null;
    }
    if (act.dataset.act === 'loosen') {
      const cur = Number($('in-budgetMax').value) || 30;
      state.enabled.budgetMax = true;
      $(`in-budgetMax`).value = Math.round(cur * 1.5);
      syncConstraintUI();
      return recommend('manual');
    }
    if (act.dataset.act === 'edit-constraints') {
      const panel = $('constraintsPanel');
      if (panel.classList.contains('hidden')) $('advToggle').click();
      else panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }
  }
});

$('drawer').addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) {
    $('drawer').classList.add('hidden');
    state.drawerSeq += 1;
    return;
  }
  // 价格验证失败后的「重试核价」（失败分类⑤的可行操作）
  const act = e.target.closest('[data-act]');
  if (act && act.dataset.act === 'retry-rebuild') return rebuildFromDrawer();
});

// 解析状态条上的可行操作（失败分类③：改条件 / 重试解析）
$('parseStatus').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]');
  if (!act) return;
  if (act.dataset.act === 'reparse') return ask();
  if (act.dataset.act === 'edit-constraints') {
    const panel = $('constraintsPanel');
    if (panel.classList.contains('hidden')) $('advToggle').click();
    else panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
});

// 规格下拉用 change 事件（select 的 click 只代表展开下拉，不代表值变了）
$('drawer').addEventListener('change', (e) => {
  const sel = e.target.closest('select[data-round]');
  if (!sel) return;
  state.drawer.choices[sel.dataset.round] = sel.value;
  rebuildFromDrawer();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('drawer').classList.contains('hidden')) {
    $('drawer').classList.add('hidden');
    state.drawerSeq += 1;
  }
});

/* ---------------- 启动 ---------------- */
(async function boot() {
  window.__productReady = true;
  loadModelStatus();
  try {
    const h = await api(API.health);
    // 记下当前门店（默认门店≠用户位置，界面上只说"当前门店"，不说"附近门店"）
    if (h.store?.code) state.store = { code: String(h.store.code), name: h.store.name || h.store.code };
  } catch {
    showParseStatus('bad', '<span class="ps-title">服务未就绪</span>请稍后刷新重试。');
  }
})();
