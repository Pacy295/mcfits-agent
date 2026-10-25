# 麦门营养决策官（McFit Agent）

自然语言驱动的营养、价格与口味联合优化智能配餐 Agent。

- **第一阶段（已完成）**：真实数据管线 —— 门店菜单 / 商品详情 / 官方营养映射 / 套餐 rounds / 真实核价。
- **第二阶段（已完成）**：自然语言 → 结构化约束（可编辑）→ 合法候选生成 → MCP 逐个核价 → 帕累托非支配筛选 → 2–4 套差异化方案 + 不可行量化解释。
- **第三阶段（已完成）**：正式产品界面 + 交互式条件调整（改预算/营养即重新搜索核价）+ 套餐真实规格替换（中杯→大杯、中薯→大薯，服务端重算营养与价格）+ 模型/限流安全边界。

> 本项目是独立开发的非官方应用，与麦当劳无授权、合作或隶属关系；使用 MCP 接口不等同于品牌授权。不做登录、支付、下单。商品、价格及营养取自 MCP，缓存带时间与来源，组合营养为组件求和；模型仅做语义解析。

---

## 一、技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 后端 | Node.js 22（ESM，**零 npm 依赖**） | 内置 `fetch` 直连 MCP 与 LLM，内置 `http` 提供 API 与静态页 |
| MCP | 手写 JSON-RPC over Streamable HTTP 客户端 | `tools/list` / `tools/call`，令牌桶限流 + 重试 + 只读白名单 |
| LLM | OpenAI 兼容 `/chat/completions`（实测 `mimo-v2.6-pro`） | JSON 模式 + 数值反幻觉校验；不可用时降级规则解析 |
| 优化 | 自研有限枚举 + 帕累托 + 最远点采样 | 纯函数模块，可注入假依赖单测 |
| 缓存 | 文件缓存（`cache/*.json`）+ 进程内 Map | 分级 TTL，价格 5 分钟且必带 `checkedAt` |
| 前端 | 原生 ES Module + CSS（无构建） | 验证台；第二阶段在此基础上加了一块配餐面板 |
| 测试 | `node:test`（100 项）+ CDP 无头浏览器冒烟 + 真实 MCP 验收脚本 | 单测不联网，验收脚本打真实接口 |

**为什么不上 React/Vite（至今）**：交付成本优先。后端 API 契约已按前端消费定型（状态枚举、来源字段、错误码），后续迁 React 只替换 `public/`，`src/` 不用改。

---

## 二、目录结构

```
mcfits/
├─ src/
│  ├─ config.js                  # 配置、Token 加载、只读工具白名单、TTL
│  ├─ mcp/client.js              # MCP JSON-RPC 客户端（限流/重试/写操作阻断）
│  ├─ llm/provider.js            # LLM 端点解析、JSON 模式调用、健康探测
│  ├─ parse/
│  │  ├─ schema.js               # 约束结构 + 数值反幻觉 + 目标证据校验
│  │  ├─ rule-parser.js          # 确定性规则解析（降级 & 交叉校验）
│  │  └─ llm-parser.js           # 提示词 + 模型调用 + 双路合并
│  ├─ optimize/
│  │  ├─ classify.js             # 商品角色（main/side/drink/dessert/other）
│  │  ├─ candidates.js           # 套餐变体 + 单品组合生成、内容签名去重
│  │  ├─ objectives.js           # 维度定义、支配判定、帕累托
│  │  ├─ diversity.js            # 近重复去重 + 最远点采样 / 价格梯度
│  │  ├─ infeasible.js           # 单约束放宽 + 最接近方案量化
│  │  ├─ compare.js              # 方案差异（真实数值相减）
│  │  └─ engine.js               # 编排：生成→预筛→核价→复核→筛选→组装
│  ├─ data/                      # 第一阶段：cache/store/营养表/匹配/套餐/价格
│  ├─ services/
│  │  ├─ data-service.js         # 数据服务门面（6 类能力 + 覆盖率）
│  │  └─ recommend-service.js    # 优化池构建、参考价表、候选核价、预热
│  └─ http/                      # routes.js / server.js
├─ data/nutrition-aliases.json   # 人工确认的营养别名
├─ public/
│  ├─ index.html / product.js / product.css   # 产品页（面向用户）
│  └─ console.html / app.js / stage2.js / styles.css  # 工程验证台（数据诊断）
├─ scripts/                      # 验收、覆盖率、UI 冒烟、探查脚本
├─ test/                         # unit / parse / optimize / api
└─ cache/                        # 运行时缓存与验收报告（gitignore）
```

---

## 三、快速开始

### 1. 环境要求

- **Node.js 22+**（项目零 npm 依赖，无需 `npm install`）
- **麦当劳 MCP Token（必需）**：没有它无法获取真实菜单、营养与价格
- 可选：OpenAI 兼容的大模型端点；不配置时自动降级为规则解析

### 2. 配置

```bash
cp .env.example .env
# 至少填写 MCD_MCP_TOKEN
# 需要自然语言解析时，再填写 MCFIT_LLM_BASE_URL / MCFIT_LLM_API_KEY / MCFIT_LLM_MODEL
```

> 本仓库**不包含任何真实凭证**。服务自动加载仓库根目录 `.env`，已有进程环境优先，未设置时默认 `NODE_ENV=production`。任何模式均默认禁止读取本机私人配置；仅显式设置 `MCFIT_LLM_ALLOW_LOCAL=1` / `MCFIT_ALLOW_LOCAL_MCP=1` 时允许对应读取。
> 所有凭证只从环境变量（或部署方自己的密钥管理）注入。

### 3. 启动

```bash
node src/http/server.js          # http://localhost:5173
```

服务启动时会后台预热候选池与参考价，把首个用户请求的冷启动成本降到 ~0.5 s。`MCFIT_PREWARM=0` 可关闭。

### 4. 自检

```bash
# 离线单测（不需要任何凭证）
node --test test/unit.test.js test/parse.test.js test/optimize.test.js test/pareto.test.js test/stage5.test.js test/recommend-quality.test.js

# 完整测试（需要 MCP Token；门店打烊时集成用例会显式跳过并说明原因）
npm test

# 真实端到端验收（需要 MCP Token，可选 LLM）
node scripts/verify-stage1.js
node scripts/verify-stage2.js
```

### 5. 没有凭证时会怎样

| 缺失项 | 影响 |
|---|---|
| `MCD_MCP_TOKEN` | 菜单、营养、核价、推荐全部不可用；接口返回「当前门店暂时无法获取菜单，暂时不能进行实时核价」 |
| `MCFIT_LLM_*` | 自然语言解析降级为规则解析：仍能识别预算/营养/常见偏好，但语义理解能力有限 |
| 两项都缺 | 服务可以启动，但只能看到页面与错误提示，不能产生真实推荐 |

### 6. 最短复现路径（从零到一次真实推荐）

```bash
git clone <your-repo-url> mcfits && cd mcfits
cp .env.example .env          # 填写 MCD_MCP_TOKEN（必需）
node src/http/server.js       # 打开 http://localhost:5173
```

预期结果：

- `GET /api/health` → `ok: true` 且 `mcp.reachable: true`（Token 有效、网络可达）；
- 页面输入「40元以内，尽量高蛋白」→ 返回 1 主推 + 至多 2 套备选，每套都带 `price.traceId` 与 `price.checkedAt`；
- 未配置 `MCFIT_LLM_*` 时解析走规则模式（页面会标注来源），推荐仍可用；
- 门店打烊或 Token 无效时，接口会返回明确原因与「换门店 / 稍后再试」，不会编造方案。

目标用户：希望按预算、营养目标或日常偏好选择麦当劳餐品的个人用户。以上为决策辅助，不替代官方信息或专业建议。

> 完整接口与参数见 `## 五、API`；MCP 细节见 `MCP_INTEGRATION.md`。


---

## 四、第二阶段：一次推荐是怎么算出来的

```
自然语言
  └─ /api/parse ──→ LLM(JSON) + 规则解析 双路 → 数值反幻觉 → 结构化约束（可在页面编辑）
        └─ /api/recommend
             1. 真实菜单池：在售商品 → 角色分类 → 只保留营养 official 的商品与套餐
             2. 候选生成：套餐变体（每轮≤4选项，每套餐≤6配置）+ 单品组合（5 种形态）
             3. 营养硬约束预筛（与价格无关，不会误剪预算可行解）
             4. 参考价：套餐默认价 + ΣdiffPrice；单品实价求和（缺失即置 null，不当 0）
             5. 预算预筛（5% 容差）→ 按用户目标排序 + 主食轮转取样
             6. 真实核价：逐个 calculate-price（并发 6，保持优先级顺序）
             7. 用真实价复核全部硬约束 → 未核价的候选绝不进入方案
             8. 剔除非有效维度 → 帕累托 → 差异采样 → 2–4 套
             9. 无可行解 → 单约束放宽 + 最接近方案（带违反项与超出量）
```

### 关键取舍

| 问题 | 做法 | 理由 |
|---|---|---|
| 「高蛋白」怎么处理 | 只产出 `objectives.protein=max`，`proteinMin` 保持 null | 阈值必须由用户给出，模型不得推断 |
| 「蛋白质≥30g」要不要当优化维度 | 不当，只用阈值过滤 | 达标即可，否则会为多 2g 淘汰便宜 5 元的方案 |
| 「热量不超过750」要不要追最低 | 不追 | 只有用户明确想降热量才把 kcal 作为维度 |
| 只给预算时推荐什么 | 价格梯度：最便宜 / 每元蛋白最高 / 蛋白最高 + 差异化补充 | 没有偏好时"最便宜"不是唯一合理答案 |
| 补充方案能不能叫"非支配解" | 不能。`plans[].pareto.nonDominated=false`，并列出真实支配者与差价 | 价格单维时严格前沿只有最低价，其余必然被支配 |
| 界面要不要显示这两个词 | 不显示。卡片只用「最省钱 / 高蛋白选择 / 换一种搭配」等按真实数值生成的标签，技术口径收进「为什么推荐」 | 第四阶段可用性走查：术语对普通用户无意义 |
| 参考价能不能直接当结论 | 不能，必须逐个真实核价 | 优惠、套餐组成都可能让实价不同 |
| 缺参考价怎么算 | 整条置 null 并计数，不参与预算判断 | 当 0 会把超预算的组合算成可行 |
| 缺营养的商品 | 排除出优化，计数上报 | 按 0 参与求和解等于造假 |
| 不吃辣 | 标记 unverified，不声称满足 | 菜单无辣度/配料/过敏原字段 |
| 搜索不全 | `searchScope.completeness=partial` + 明示"不能断言全店无解" | 只有部分候选被核价 |

---

## 四点五、第三阶段：产品化交互

**两个入口**：`/` 是给用户的产品页；`/console.html` 是工程验证台（数据诊断 / 阶段一二的原始面板），互不影响。

### 页面结构

1. **需求输入**：一句话描述预算与目标，4 个示例短语，解析状态条（含降级说明、无法验证的忌口、待确认项）。
2. **条件面板**：预算 / 热量上下限 / 蛋白下限均可**开关 + 改值**；必含类别（硬）与优化倾向（软）分开；想吃/不要用 chips 增删。
3. **推荐方案**：2–4 张卡，含真实商品名、组成、MCP 实算价与核价时间、四项营养、满足条件数、帕累托标识；「为什么推荐 · 数据来源」可展开看 traceId 与口径。
4. **套餐详情抽屉**：rounds 规格下拉、价格、六项营养（含钠/钙）、逐条条件核对、特制说明。

### 交互规则

- 任何条件改动 → 420ms 防抖 → **重新调用 /api/recommend**（重新生成候选 + 重新核价 + 重判可行性与帕累托），不做前端本地过滤。
- 并发安全：请求序号 + AbortController，过期响应直接丢弃（专门用例：连续改预算 30→55→45，最终必须展示 45 的结果）。
- 规格替换走后端 `/api/plan/rebuild`：校验 rounds 合法性 → 重算营养 → calculate-price 重新核价 → 复核硬约束并给出超出量。前端不改任何数字。
- 没有官方营养数据的选项在下拉里直接标注「（该选项无官方营养数据）」，选中后营养显示为不完整，不会假装满足条件。
- 特制（去酱/去冰/去吉士）只做信息展示，明确声明营养变化无法计算。

### 运行安全

- 模型配置区分**开发者本机**与**部署显式配置**：生产环境（`NODE_ENV=production`）默认不读 `本地开发者配置（不随仓库提供）`，必须显式配置 `MCFIT_LLM_BASE_URL` / `MCFIT_LLM_API_KEY`；`/api/llm/status` 返回 `sourceKind` 与额度说明。
- 限流：parse 20/min、recommend 30/min、rebuild 60/min（按 IP + 路由），超限 429 + `Retry-After`。
- 输入上限 500 字符；密钥仅服务端持有，前端只有模型名。

## 五、API

**第一阶段**

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 服务与 MCP 连通性（无敏感信息） |
| GET | `/api/mcp/tools` | MCP 工具清单 + 是否只读 |
| GET | `/api/products?category=&refresh=` | 当前门店在售商品 |
| GET | `/api/products/:code` | 单品详情（含营养与 rounds） |
| GET | `/api/products/:code/nutrition` | 标准营养（套餐按默认组合求和） |
| GET | `/api/products/:code/rounds` | 套餐 rounds 与合法替换项 |
| POST | `/api/products/:code/price` | 按 `choices` 调 `calculate-price` |
| POST | `/api/compose` | 任意组件组合的营养求和 |
| POST | `/api/price` | 直接对 `items` 核价 |
| GET | `/api/coverage` | 营养匹配覆盖率 + 人工确认清单 |
| GET | `/api/nutrition/table?all=1` | 官方营养表 |

**第二阶段**

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/llm/status?probe=1` | LLM 端点/模型状态（不返回密钥） |
| POST | `/api/parse` | `{text, mode:'auto'\|'rule'}` → 结构化约束 + 警告 + 待确认项 |
| POST | `/api/recommend` | `{text}` 或 `{constraints, options}` → 方案 / 不可行分析 |
| POST | `/api/compare` | `{a, b}` → 差值（价格/热量/蛋白质）与一句话结论 |
| POST | `/api/plan/rebuild` | `{productCode, choices}` 或 `{components}` → 服务端校验 rounds、重算营养、重新核价、复核约束 |
| GET | `/api/optimize/pool` | 候选池统计（角色分布、缺营养排除数） |

`/api/recommend` 关键返回字段：

```jsonc
{
  "status": "ok | infeasible",
  "parse": { "source": "llm|rule|manual", "degraded": false, "warnings": [] },
  "plans": [{
    "id": "P1", "label": "价格最低",
    "productName": "...", "components": [{ "code", "name", "role" }],
    "price": { "fen", "yuan", "checkedAt", "mcpDatetime", "traceId", "status": "valued" },
    "nutrition": { "energyKcal", "protein", "fat", "carbohydrate", "status": "derived_sum" },
    "pareto": { "nonDominated": true, "label": "严格非支配", "dimensions": ["priceFen"], "dominatedBy": [], "note": "..." },
    "hardSatisfied": [], "softMatched": [], "advantages": [], "tradeoffs": []
  }],
  "selection": {
    "strategy": "...", "basis": "strict-front | ladder",
    "dimensions": [{ "key": "priceFen", "label": "价格", "dir": "min" }],
    "strictParetoSize": 2, "strictParetoCheapestFen": 3150, "strictParetoSample": [],
    "feasibleCount": 40, "nonDominatedSelected": 1, "diversifiedSelected": 3, "note": "..."
  },
  "searchScope": { "candidatesGenerated", "candidatesAfterNutritionFilter", "candidatesPriced", "pricedOk", "completeness", "spaceNote" },
  "timing": { "priceAtomsMs", "verifyMs", "generateMs", "totalMs" },
  "dataQuality": { "unverifiableRestrictions", "pricedFailed", "rejectedByHard", "excludedMatched" },
  "analysis": { "reason", "blocking", "relaxations", "closest", "unverifiable", "scopeNote" }  // 仅 infeasible
}
```

---

## 六、测试与验收

| 类型 | 命令 | 结果 |
|---|---|---|
| 纯函数单测 | `test/unit.test.js`（9） | 营养解析/规范化/匹配/求和/枚举 |
| 解析单测 | `test/parse.test.js`（19） | 场景 A/B/I/J、预算区间、用餐时段、反幻觉、硬软区分 |
| 优化单测 | `test/optimize.test.js`（11） | 场景 C/D/F/G/H、去重、梯度、不可行量化、对比 |
| 帕累托专项 | `test/pareto.test.js`（11） | 取值一致性、支配判定、严格前沿、差异化标注、对比同源、预算算术 |
| 第五阶段专项 | `test/stage5.test.js`（14） | 日常模式优先级、失败分类、门店诊断、健康门控 |
| 推荐质量专项 | `test/recommend-quality.test.js`（5） | 高蛋白一顿饭排除单件、区间参与排序、无糖仅认名称证据、数量不凑满 |
| API 集成 | `test/api.test.js`（11） | 真实启动服务，逐接口验证契约与红线（打烊时显式跳过） |
| 第三阶段接口 | `test/stage3.test.js`（16） | 套餐重建、规格替换、非法 rounds、约束算术、限流、输入长度 |
| 生产环境 | `test/production.test.js`（4） | 不读本机配置、无模型时降级、显式 Token 可用、响应无密钥 |

开发日志记录旧测试入口 **100/100 通过**，本轮未独立复测该联网结果。旧入口漏掉推荐质量专项 5 项；当前 `npm test` 包含所有 `*.test.js`（含安全回归）。69 项离线基线用 `npm run test:offline`，配置隔离回归用 `npm run test:security`。完整测试需真实 MCP 凭证，门店打烊时集成用例会显式跳过并注明原因。另有真实 MCP 端到端验收脚本（`scripts/verify-stage1.js`、`verify-stage2.js` 及预算/用餐场景/失败交互/回归四个专项脚本）与浏览器交互脚本（`ui-product.mjs`、`ui-smoke2.mjs`），需要真实凭证与营业时段，结果随环境而异，不并入 100 项计数。

第一阶段历史验收样例（不代表当前菜单或价格）：门店 117 个在售商品，官方营养表 160 条，麦香鱼 325 kcal。麦香鱼中套餐的三种口径（营养为组件官方值之和，价格由 MCP 实算）：默认 761 kcal / ¥34.00；**只换大杯可乐** 838 kcal / ¥36.00；**只换大薯条** 851 kcal / ¥36.00；**两项同时换** 928 kcal / ¥38.00。

---

## 七、已知限制

1. **官方营养表覆盖不到 2026 新品**：117 个商品中 40 个（龙焰系列、枫糖厚松饼系列、心形薯饼、脆皮鸡块等）无营养数据，被排除出优化。这是数据源缺口，不是匹配算法问题。
2. **营养单位未官方声明**：kcal / g / mg 与"每份"基准均为按字段名与量级推断。
3. **特制营养不可算**：去酱/去冰无配料级数据，统一标 `modificationImpact: not_modeled`，不给精确值。
4. **搜索非穷举**：候选空间有界（见 `spaceNote`），只对其中一部分做真实核价，`completeness` 如实标注。
5. **口味只能靠命中偏好词**：菜单没有辣度/甜度/口味强度字段。
6. **部分容器商品核价失败**（如「薄皮V翅双拼十翅」报 `60006 不可售`）：计入 `candidatesWithoutReferencePrice`，不进推荐。
7. **单品组合方案不支持换项**：详情抽屉对 `kind=single` 只展示组成；rounds 规格替换是第三阶段 P0，任意加减配料未做。
8. **限流是单进程内存**：多实例部署需要换共享存储（如 Redis）。
9. **价格口径**：前置报告的「麦香鱼 ¥23」是**单品**价，本项目实算的「¥34」是**麦香鱼中套餐**价，两者不是同一商品，不构成涨价。

---

## 八、交付材料

| 材料 | 位置 |
|---|---|
| 项目说明（功能/架构/运行/特色/限制/数据来源） | `README.md`（本文件） |
| WorkBuddy 参与记录（整理稿，非原始对话） | `workbuddy.md` |
| MCP 集成说明（协议、工具、白名单、限流、门店诊断） | `MCP_INTEGRATION.md` |
| 参赛声明 | `CONTEST_DECLARATION.md`，官方原文；作者已确认同意规则，原草稿仅留本地 |
| 使用说明（评委 3 分钟上手） | `docs/使用说明.md` |
| 项目简介（与普通营养计算器的区别） | `docs/项目简介.md` |
| 部署与运行指引（本地/局域网/生产配置/额度） | `docs/部署与运行指引.md` |
| 演示脚本（四幕，含解说词与画面要点） | `docs/演示脚本.md` |
| 演示截图（真实运行） | `docs/screenshots/`：`product-desktop.png`、`product-drawer.png`、`product-infeasible.png`、`product-mobile.png`、`product-mobile-drawer.png` |
| 技术决策记录（分阶段） | `docs/技术决策记录.md`、`docs/第二阶段技术决策记录.md`、`docs/第三阶段技术决策记录.md` |
| 验收输出存档 | `docs/第一阶段验收输出.txt`、`docs/第二阶段验收输出.txt` |
| 安全审计 | `node scripts/security-audit.mjs`（扫描 Token/Key，退出码 0=干净） |
| 可用性走查 | `docs/可用性检查.md`（含"未做真人试用"的说明） |
| 许可证与第三方说明 | `LICENSE`（MIT，自有代码与文档），见 `docs/第三方与素材说明.md` |
| 提交前人工清单 | `docs/提交前清单.md`（录屏操作卡 + 需你亲自完成的动作） |

**未包含**：录屏视频文件（需人工按 `docs/演示脚本.md` 录制）、公网部署地址、原始开发对话导出文件、参赛平台提交截图。

---

## 九、下一步建议


1. 让自然语言直接驱动**套餐内替换**（"饮料换成大杯"），复用现有 rounds + diffPrice 校验。
2. 方案解释文案接 LLM 润色，但必须走"只允许复述已计算数值"的约束通道。
3. 营养缺口人工补齐流程（把 `needsHumanReview` 做成管理页，确认后写入别名表）。
4. React 前端迁移：API 已稳定，只需替换 `public/`。

---

## 十、许可、商标与数据来源声明

**代码许可**：作者已确认采用现有 `LICENSE` 中的 MIT 许可，仅覆盖自有代码和文档。品牌、商标、餐品及接口数据的权利归各权利人，不由 MIT 授权。项目无第三方 npm 依赖；作者已确认保留当前界面和 13 张演示截图公开，未发现独立的品牌授权证据，接口接入不等于品牌授权，见 `docs/第三方与素材说明.md`。

**商标与非官方声明**：本项目是个人参赛作品，**与麦当劳（McDonald's）官方无关**，不提供下单、支付或优惠券服务。页面与截图中出现的「麦当劳」「麦咖啡」等名称、商品名与品牌标识，权利归其各自权利人所有，仅用于说明真实数据来源与演示用途；**开源代码不代表获得商标或图片使用授权**，公开仓库前请自行确认品牌素材的使用范围，必要时替换为不含品牌标识的截图。

**数据来源与边界**：
- 菜单、商品详情、套餐规格、价格均来自麦当劳 MCP 实时接口；营养值来自官方营养表并按组件求和。
- 官方未提供的字段（辣度、含糖量、食物温度、特制后的营养变化）一律标注「无法核实」，不做推断。
- 候选搜索非穷举，`searchScope` 会如实标注覆盖范围；门店营业时间会直接影响能否查到实时菜单。
- 本项目不构成营养、医疗或食品安全建议。

**凭证安全**：仓库不包含任何真实 API Key / MCP Token；`.env.example` 只有变量名与占位符。请勿把 `.env` 或任何私人配置提交到公开仓库。
