const $ = (id) => document.getElementById(id);
const state = {
  store: null,
  products: [],
  categories: [],
  coverage: null,
  mealCode: '9900005460',
  meal: null,
  selection: {},
  lastPrice: null,
  flow: null,
};

const fmtMoney = (fen) => (fen == null ? '—' : `¥${(fen / 100).toFixed(2)}`);
const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '—');
const num = (v, unit = '') => (v == null ? '—' : `${v}${unit}`);

async function api(pathname, opts) {
  const res = await fetch(pathname, opts);
  const json = await res.json();
  if (!res.ok || json.ok === false) {
    const err = new Error(json?.error?.message || `HTTP ${res.status}`);
    err.code = json?.error?.code;
    err.detail = json?.error;
    throw err;
  }
  return json;
}

/* ---------------- 顶部状态 ---------------- */
async function loadHealth() {
  const h = await api('/api/health');
  state.store = h.store;
  const pills = [];
  pills.push(`<span class="pill ${h.ok ? 'ok' : 'bad'}">MCP ${h.mcp.reachable ? '已连接' : '不可用'}</span>`);
  pills.push(`<span class="pill">${h.store.name} · ${h.store.code}</span>`);
  if (h.mcp.serverTime) pills.push(`<span class="pill mono">服务端 ${h.mcp.serverTime}</span>`);
  pills.push(`<span class="pill">MCP 调用 ${h.mcp.metrics.calls} 次 / 失败 ${h.mcp.metrics.errors}</span>`);
  $('statusBar').innerHTML = pills.join('');
  $('footSrc').textContent = `MCP 端点 ${h.mcp.url} · beType=${h.store.beType} orderType=${h.store.orderType} · 价格缓存 TTL ${h.caches.priceMs / 1000}s · 商品详情 TTL ${h.caches.detailMs / 3600000}h`;
  if (!h.ok && h.mcp.error) {
    $('statusBar').insertAdjacentHTML('beforeend', `<span class="pill bad">${h.mcp.error.message}</span>`);
  }
}

/* ---------------- 覆盖率 ---------------- */
function renderCoverage(cov) {
  state.coverage = cov;
  const c = cov.coverage;
  const bar = (label, pct) => `
    <div class="block">
      <div class="row"><span>${label}</span><b>${pct}%</b></div>
      <div class="bar"><i style="width:${Math.min(100, pct)}%"></i></div>
    </div>`;

  $('coverageBody').innerHTML = `
    ${bar('单品营养覆盖', c.singleItems)}
    ${bar('套餐可求和率', c.meals)}
    ${bar('整体可用率', c.overall)}
    <div class="stat">
      在售 <b>${cov.counts.onMenuProducts}</b> 个商品（单品 ${cov.counts.singleItems} / 套餐 ${cov.counts.meals}），
      官方营养表 <b>${cov.officialTableRows}</b> 条，可直接用于优化计算 <b>${c.usable}</b> 个。
    </div>
    <div class="stat">
      名称匹配：精确 ${cov.singleItemMatch.matched_exact} · 标点级 ${cov.singleItemMatch.matched_loose} ·
      别名 ${cov.singleItemMatch.matched_alias} · 存疑 ${cov.singleItemMatch.ambiguous} · 无条目 ${cov.singleItemMatch.unmatched}
    </div>
    <div class="stat">
      套餐组合：完整求和 ${cov.mealComposition.derived} · 部分可算 ${cov.mealComposition.partial} · 完全不可算 ${cov.mealComposition.unknown}
    </div>
    <div class="review">
      <b>${cov.reviewCount} 个商品需要人工确认</b>：官方营养表没有对应条目，这些商品在优化中按“无营养数据”处理，不会用 0 或近似值顶替。
    </div>`;
}

/* ---------------- 套餐 ---------------- */
async function loadProducts() {
  const r = await api('/api/products');
  state.products = r.products;
  state.categories = r.categories;
  const catFilter = $('catFilter');
  catFilter.innerHTML = `<option value="">全部分类</option>` + state.categories.map((c) => `<option>${c}</option>`).join('');
  renderProducts();

  const meals = state.products.filter((p) => p.isMeal);
  const sel = $('mealSelect');
  const preferred = ['9900005460', '9900005453', '9900004064', '9900004236'];
  const ordered = [...meals].sort((a, b) => {
    const ia = preferred.indexOf(a.code);
    const ib = preferred.indexOf(b.code);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  sel.innerHTML = ordered
    .map((m) => `<option value="${m.code}"${m.code === state.mealCode ? ' selected' : ''}>${m.name || m.code}${m.nutritionStatus === 'unknown' ? '（部分营养缺失）' : ''}</option>`)
    .join('');
  if (!ordered.some((m) => m.code === state.mealCode) && ordered.length) {
    state.mealCode = ordered[0].code;
    sel.value = state.mealCode;
  }
}

async function loadMeal(code) {
  state.mealCode = code;
  const data = await api(`/api/products/${code}/rounds`);
  state.meal = data;
  state.selection = {};
  for (const r of data.rounds) {
    state.selection[r.id] = r.choices.find((c) => c.isDefault)?.code || r.choices[0]?.code;
  }
  $('mealHint').textContent = `${data.name} · ${data.roundCount} 个 round · 合法组合 ${data.totalCombos} 种 · 每轮各选 1 项`;
  renderRounds();
  await recompose();
}

function renderRounds() {
  const area = $('roundsArea');
  area.innerHTML = state.meal.rounds
    .map((r) => {
      const opts = r.choices
        .map((c) => {
          const diff = c.diffPriceFen == null ? '' : c.diffPriceFen === 0 ? '（默认价）' : `（${c.diffPriceFen > 0 ? '+' : ''}¥${(c.diffPriceFen / 100).toFixed(1)}）`;
          return `<option value="${c.code}"${state.selection[r.id] === c.code ? ' selected' : ''}>${c.name}${diff}</option>`;
        })
        .join('');
      return `<div class="round">
        <span class="rname" title="${r.name}">${r.name}</span>
        <select class="select" data-round="${r.id}">${opts}</select>
      </div>`;
    })
    .join('');
  area.querySelectorAll('select').forEach((el) => {
    el.addEventListener('change', () => {
      state.selection[el.dataset.round] = el.value;
      state.lastPrice = null;
      $('priceOut').className = 'price-out empty';
      $('priceOut').textContent = '套餐已调整，请重新核价';
      recompose();
    });
  });
}

function currentComponents() {
  return state.meal.rounds.map((r) => {
    const code = state.selection[r.id];
    const choice = r.choices.find((c) => c.code === code);
    return { code, quantity: 1, fallbackName: choice?.name ?? null };
  });
}

async function recompose() {
  const res = await api('/api/compose', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ components: currentComponents() }),
  });
  state.flow = res;
  renderNutrition(res);
}

function renderNutrition(res) {
  const totals = res.totals;
  const partial = res.status !== 'derived_sum';
  $('kcalLabel').textContent = partial ? '已确认部分小计（不完整）' : '各组件官方值之和';
  $('kcalValue').textContent = totals?.energyKcal != null ? totals.energyKcal : partial ? (res.knownSubtotal?.energyKcal ?? '—') : '—';
  $('kcalMeta').textContent = partial
    ? `缺 ${res.unknownComponents.length} 项官方营养，不给出总量`
    : `官方未提供套餐级营养标示，此为算术求和`;

  const g = partial ? res.knownSubtotal || {} : totals || {};
  $('macroGrid').innerHTML = [
    ['蛋白质', g.protein, 'g'],
    ['脂肪', g.fat, 'g'],
    ['碳水', g.carbohydrate, 'g'],
    ['钠', g.sodium, 'mg'],
  ]
    .map(([k, v, u]) => `<div class="m"><b>${num(v)}</b><span>${k} ${u}</span></div>`)
    .join('');
}

async function doPrice() {
  const btn = $('priceBtn');
  btn.disabled = true;
  btn.textContent = '正在调用 MCP calculate-price…';
  const out = $('priceOut');
  try {
    const res = await api(`/api/products/${state.mealCode}/price`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ choices: state.meal.rounds.map((r) => ({ round: r.id, code: state.selection[r.id] })) }),
    });
    state.lastPrice = res;
    if (res.status === 'valued') {
      out.className = 'price-out';
      out.innerHTML = `
        <div><span class="big">${fmtMoney(res.priceFen)}</span>
        ${res.discountFen ? `<span class="badge official">已优惠 ${fmtMoney(res.discountFen)}</span>` : '原价，无优惠'}
        ${res.cacheMeta?.cache === 'hit' ? '<span class="badge meal">缓存命中</span>' : ''}</div>
        <span class="src">MCP 返回于 ${res.mcpDatetime} · 核价时间 ${fmtTime(res.checkedAt)} · traceId ${res.traceId}</span>
        <span class="src">口径：calculate-price 试算，不生成订单</span>`;
    } else {
      throw new Error(res.error?.message || '核价失败');
    }
  } catch (err) {
    out.className = 'price-out err';
    out.innerHTML = `核价失败：${err.message}<span class="src">不会用历史价格顶替当前价</span>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '用 MCP 实算这份套餐价格';
  }
}

/* ---------------- 商品表 ---------------- */
const STATUS_ORDER = { official: 0, derived_sum: 1, partial: 2, unknown: 3 };

function renderProducts() {
  const kw = $('search').value.trim().toLowerCase();
  const cat = $('catFilter').value;
  const status = $('statusFilter').value;
  const rows = state.products
    .filter((p) => {
      if (cat && !p.categories.includes(cat)) return false;
      if (status && p.nutritionStatus !== status) return false;
      if (!kw) return true;
      return (p.name || '').toLowerCase().includes(kw) || p.code.includes(kw);
    })
    .sort((a, b) => {
      const d = (STATUS_ORDER[a.nutritionStatus] ?? 9) - (STATUS_ORDER[b.nutritionStatus] ?? 9);
      if (d !== 0) return d;
      return (a.name || a.code).localeCompare(b.name || b.code, 'zh');
    });
  $('productRows').innerHTML = rows
    .map((p) => {
      const st = p.nutritionStatus;
      const cls = st === 'official' ? 'official' : st === 'derived_sum' ? 'derived_sum' : st === 'partial' ? 'partial' : 'unknown';
      const label = { official: '官方值', derived_sum: '组合求和', partial: '部分缺失', unknown: '无数据' }[cls];
      return `<tr>
        <td class="code">${p.code}</td>
        <td class="pname">${p.name || '<span class="loading">名称未知</span>'}</td>
        <td class="pcat" title="${p.categories.join(' / ')}">${p.categories[0] || '—'}</td>
        <td>${p.isMeal ? '<span class="badge meal">套餐</span>' : '单品'}</td>
        <td class="num">${num(p.energyKcal)}</td>
        <td class="num">${num(p.protein)}</td>
        <td><span class="badge ${cls}">${label}</span></td>
      </tr>`;
    })
    .join('');
  if (!rows.length) $('productRows').innerHTML = `<tr><td colspan="7" class="loading">没有匹配的商品</td></tr>`;
}

/* ---------------- 启动 ---------------- */
async function boot() {
  try {
    await loadHealth();
    // 先跑覆盖率统计（顺带为套餐补全组合营养），再取商品列表，避免并行时套餐营养字段尚未回填
    const cov = await api('/api/coverage');
    renderCoverage(cov);
    await loadProducts();
    await loadMeal(state.mealCode);
  } catch (err) {
    $('statusBar').innerHTML = `<span class="pill bad">初始化失败：${err.message}</span>`;
    console.error(err);
  }
}

$('mealSelect').addEventListener('change', (e) => {
  state.lastPrice = null;
  $('priceOut').className = 'price-out empty';
  $('priceOut').textContent = '尚未核价';
  loadMeal(e.target.value).catch((err) => {
    $('mealHint').textContent = `套餐加载失败：${err.message}`;
  });
});
$('priceBtn').addEventListener('click', doPrice);
$('search').addEventListener('input', renderProducts);
$('catFilter').addEventListener('change', renderProducts);
$('statusFilter').addEventListener('change', renderProducts);
$('refreshBtn').addEventListener('click', async () => {
  const btn = $('refreshBtn');
  btn.disabled = true;
  btn.textContent = '刷新中…';
  try {
    const [cov] = await Promise.all([api('/api/coverage?refresh=1'), loadProducts()]);
    renderCoverage(cov);
    await loadMeal(state.mealCode);
    await loadHealth();
  } finally {
    btn.disabled = false;
    btn.textContent = '刷新数据';
  }
});

boot();
