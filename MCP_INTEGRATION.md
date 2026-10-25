# MCP 集成说明（MCP_INTEGRATION.md）

本文描述本项目如何接入麦当劳 MCP（Model Context Protocol）服务，内容与仓库代码一一对应，便于评审复核。

- 客户端实现：`src/mcp/client.js`
- 配置与白名单：`src/config.js`
- 数据编排：`src/services/data-service.js`、`src/services/recommend-service.js`
- 门店诊断：`src/services/store-health.js`

---

## 1. 接入方式

| 项 | 实际实现 |
|---|---|
| 协议 | JSON-RPC 2.0 over Streamable HTTP |
| 默认端点 | `https://mcp.mcd.cn`（可用 `MCD_MCP_URL` 覆盖） |
| 认证 | `Authorization: Bearer <MCD_MCP_TOKEN>`，令牌只从服务端环境变量读取 |
| 客户端 | 手写 `fetch` 调用，**零 npm 依赖**，不依赖 WorkBuddy 对话内的工具通道 |
| 调用方式 | 直接 `tools/list` / `tools/call`；客户端未实现 initialize 握手，每次请求带超时与重试 |

令牌解析顺序（`src/config.js` 的 `resolveToken`）：

1. 环境变量 `MCD_MCP_TOKEN`；
2. 仅 `MCFIT_ALLOW_LOCAL_MCP=1` 时，读取本机环境文件；
3. 仅 `MCFIT_ALLOW_LOCAL_MCP=1` 时，读取本机 WorkBuddy MCP 配置。

> 服务自动加载仓库 `.env`，任何模式均默认不读私人配置，只有对应显式开关为 1 时才读取。未开启时，缺少 `MCD_MCP_TOKEN` 时服务会明确报错，而不是悄悄使用他人凭证。

---

## 2. 用到的工具（只读）

核心链路：

| 工具 | 用途 |
|---|---|
| `now-time-info` | 取服务端时间，用于营业时间判断（避免本机时区误差） |
| `query-nearby-stores` | 查门店列表、营业状态、营业时间、距离 |
| `query-meals` | 查某门店的在售菜单（商品 + 套餐 + 分类） |
| `query-meal-detail` | 查套餐的 rounds 规格与可选项、差价 |
| `list-nutrition-foods` | 官方营养表（按商品名匹配） |
| `calculate-price` | 真实核价（套餐基准价 + rounds 差价） |

只读白名单（`config.mcp.readOnlyAllowlist`）还包含促销/优惠券/订单查询类工具，用于展示可用信息；**所有写操作工具在客户端层直接拒绝**：

- `create-order`、`cancel-order`、`submit-order`
- `auto-bind-coupons`、`draw-lottery`
- 其他未列入白名单的 `tools/call`

被拒绝时抛出 `McpError('blocked')`，不会发出网络请求。本项目不提供下单、支付、领券、抽奖能力。

---

## 3. 数据如何变成一次推荐

```
query-meals(storeCode)
  → 商品/套餐列表 + 分类
  → query-meal-detail(套餐) 取 rounds 与选项差价
  → list-nutrition-foods / 商品详情 取官方营养（按组件求和）
  → 候选生成（套餐变体 + 单品组合）
  → calculate-price 逐个真实核价（含 traceId / checkedAt）
  → 硬约束复核 → 排序/帕累托 → 1 主推 + ≤2 备选
```

关键约束：

- **价格必须来自 `calculate-price`**，缓存 5 分钟并带 `checkedAt`；过期重新核价，不用旧价冒充。
- **营养必须来自官方值求和**；官方缺失时标 `unknown` 并排除出优化，不用同类均值估算。
- 候选空间有界（每轮最多 4 个选项、每套餐最多 6 个配置、单品组合 5 种形态），`searchScope` 如实标注覆盖率，不宣称全店穷举。

---

## 4. 可靠性设计

| 机制 | 实现 |
|---|---|
| 限流 | 令牌桶（默认 8 次/秒），并发信号量（`MCD_MCP_CONCURRENCY`，默认 10） |
| 重试 | 指数退避，`MCD_MCP_MAX_RETRIES`（默认 2），仅对可重试错误 |
| 超时 | `MCD_MCP_TIMEOUT_MS`（默认 20000） |
| 错误分类 | `no_token` / `network` / `http` / `rpc` / `business` / `blocked` / `parse` |
| 错误脱敏 | 所有错误消息经 `redact()`，不把 Token 带进响应或日志 |
| 缓存 | 菜单/详情/营养/价格分级 TTL，按门店分键（`menu_<store>`、`price_<store>_*`），不跨店复用 |

---

## 5. 门店与营业时间

- 默认门店由 `MCFIT_STORE_CODE` 指定（示例：`3350241` 济南凤鸣广场餐厅），**不代表用户实际位置**。
- 门店列表、营业状态、营业时间来自 `query-nearby-stores`；当前时间来自 `now-time-info`。
- 业务错误码（如 `600057`）**不硬编码含义**：只有「门店状态 + 营业时间」证据成立时才判定为「营业时间外」；同码不同证据会得到不同结论。
- 门店不可用时的用户提示固定为「当前门店暂时无法获取菜单，暂时不能进行实时核价。」，并提供「换一家门店 / 稍后再试」。
- 切换门店前会用真实 `query-meals` 验证目标门店可用（`POST /api/stores/verify`），切换后菜单、价格、缓存全部按新门店重建。

---

## 6. 无凭证 / 异常时的行为

| 场景 | 行为 |
|---|---|
| 未配置 `MCD_MCP_TOKEN` | 启动成功但 MCP 不可用；`/api/health` 返回 `reachable:false`，推荐接口返回明确错误 |
| 门店打烊 | 返回「营业时间外」分类 + 营业时间证据 + 换店/稍后再试，不伪造菜单 |
| 触发限流 | 返回 `rate_limited` 与「稍后再试」建议 |
| 核价失败 | 该候选不计入推荐，`dataQuality.pricedFailed` 记录，不用参考价顶替 |

---

## 7. 复现步骤（需要真实 MCP Token）

```bash
cp .env.example .env
# 填写 MCD_MCP_TOKEN

node src/http/server.js

# 健康检查：确认 mcp.reachable 为 true
curl http://localhost:5173/api/health

# 门店状态（含营业时间）
curl http://localhost:5173/api/stores

# 真实推荐（自然语言；需要模型配置，否则加 "mode":"rule" 走规则解析）
curl -X POST http://localhost:5173/api/recommend \
  -H 'Content-Type: application/json' \
  -d '{"text":"40元以内，尽量高蛋白"}'
```

返回中的 `plans[].price.traceId` 即本次真实核价的凭据，可在 MCP 侧对照。

---

## 8. 合规边界

- 仅使用官方 MCP 提供的只读接口；不绕过限流、不缓存超期数据、不把缓存价当实时价。
- 不接入支付、不创建订单、不代领优惠券。
- 门店、商品、价格、营养均来自官方接口；本项目与麦当劳官方无隶属关系。

## 配置示例与报名材料

根目录 `mcp-config.example.json` 为官方规则要求的脱敏 MCP 配置示例，使用 `${MCD_MCP_TOKEN}` 占位符。该 JSON 供支持环境变量替换的 MCP 客户端参考；本应用运行时仍由服务端环境变量配置，不会读取该示例作为凭证。`CONTEST_DECLARATION.md` 已按作者确认采用官方原文；原草稿留本地，不进入仓库。
