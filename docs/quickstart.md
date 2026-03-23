# Quickstart: SDK Integration (Progressive Onboarding)

这份 Quickstart 面向**把 Vluna 接入自己产品后端的开发者**：用 SDK 的调用方式把 `authorize → commit` 跑通，并按“逐步暴露（progressive disclosure）”的顺序逐步引入价格、余额、售卖与强门控。

self-hosted 的安装与 Service Key 生成流程见：`INSTALL.md`。

---

## 0) 先准备这些值（云托管 vs self-hosted）

你的后端服务需要两类输入：**部署级配置**（通常是常量）与 **请求级上下文**（随客户变化）。

### 部署级配置（通常是常量）

- `realm_id`：你的业务项目/租户域。
- `service_key_id` / `service_key_secret`：你的后端使用 Service Key 调用 S2S 能力时的凭据（像密码一样管理）。

### 请求级上下文（随你的客户变化）

- `principal_id`：你系统里的“客户主体标识”（org/team/tenant/user 等任意一种稳定 ID）。
- `billing_account_id`：Vluna 的计费账户 ID（RLS 的 account 级锚点）, 与 principal_id 1:1 对应, 推荐在首次通过 principal_id 得到 billing_account_id 后在你自己的数据库里保存和维护映射。
- `user_id`：你系统里的最终用户标识（常用于签发 Bearer token、审计与 UI 体验），不等同于 `principal_id`。

### 云托管（Vluna Cloud）

从云托管的 Web Dashboard 获取：

- `realm_id`
- `service_key_id`
- `service_key_secret`

并把 SDK 的 `base_url` 指向你的云端地址（Dashboard 会给出），而不是本地 `http://localhost:3002`。

### self-hosted（本仓库 OSS）

请先按 `INSTALL.md` 启动 API + 数据库并生成 Service Key：

- `INSTALL.md#1-docker-compose-recommended`（启动）
- `INSTALL.md#36-provision-a-service-key-for-sdk-integrations`（生成 `realm_id` + `service_key_id/secret`）

---

## 2) 只用两种 SDK Client：`ServiceClient` 与 `BearerClient`

建议你的集成结构固定为两段：

- `ServiceClient`（S2S，Service Key）：你的后端服务用它做 `gate_authorize`、`gate_commit`、wallet、签发 Bearer token 等。
- `BearerClient`（end-user，Bearer token）：你的前端/移动端拿到你后端通过 /token/issue 获得签发的 token 后，用它调用 checkout/portal/catalog 等面向用户的能力。

原则：**任何会产生扣费/授信/授权效果的调用，都放在后端用 `ServiceClient` 完成。**

---

## 3) 阶段 1（Day 0）：先跑通 `authorize → commit`

### 3.1 你需要在业务代码里做的两步

在你的业务逻辑里：

1) 执行工作前：`gate_authorize(...)` 获取 `lease_token`
2) 执行工作后：`gate_commit(...)` 上报用量并获得权威的 pricing snapshot（即使你还没配置价格，也能返回可观测的 `hints`）

### 3.2 最小可用的 SDK 调用示例（Python）

这段代码只把“如何用 SDK 跑通流程”讲清楚：

- `realm_id`、`service_key_id/secret` 是部署级配置（示例用 env 读，生产建议来自配置中心/Secret Manager）
- `principal_id` / `billing_account_id` / `user_id` 是请求级变量（来自你的业务请求/数据库）

```python
import asyncio
import os

from vlunaai import (
  VlunaAIConfig,
  RequestContext,
  ServiceClientOptions,
  ServiceKeyCredentials,
  create_service_client,
)


def env(name: str) -> str:
  v = os.environ.get(name)
  if not v:
    raise RuntimeError(f"Missing env: {name}")
  return v


async def main() -> None:
  client = create_service_client(
    ServiceClientOptions(
      config=VlunaAIConfig(
        base_url=os.environ.get("VLUNA_SERVICE_BASE_URL", "http://localhost:3002/mgt/v1"),
        realm_id=env("VLUNA_REALM_ID"),
      ),
      service_key=ServiceKeyCredentials(
        key_id=env("VLUNA_SERVICE_KEY_ID"),
        secret=env("VLUNA_SERVICE_KEY_SECRET"),  # base64-encoded secret
      ),
    )
  )
  try:
    principal_id = "customer_123"  # from your app (org/team/tenant id)
    ctx = RequestContext(principal_id=principal_id)
    feature_code = "openai.gpt5.2"

    authz = await client.gate_authorize(
      body={"feature_code": feature_code, "feature_family_code": "llm.premium"},
      context=ctx,
    )
    if not authz.ok or not authz.data:
      raise RuntimeError(f"authorize denied: {authz.model_dump()}")
    lease_token = authz.data.lease_token

    # ...perform the protected work...

    commit = await client.gate_commit(
      body={"lease_token": lease_token, "feature_code": feature_code, "quantity_minor": "1234"},
      context=ctx,
    )
    print(commit.model_dump())
  finally:
    await client.close()


asyncio.run(main())
```

提示：

- SDK 会为写入型请求自动生成幂等键；如果你要在超时后“安全重试同一次请求”，可以显式设置 `RequestContext(idempotency_key=...)` 并复用。

### 3.3 `feature_code` / `feature_family_code` 怎么选

- `feature_code`：你业务侧“要被门控/记账”的入口 key（会新增/会变化）。
- `feature_family_code`：更稳定、适合售卖/授权的抽象单元（可选）。

推荐路径：

- Day 0：先只稳定住 `feature_code` 命名规则
- 需要售卖/分层时：逐步把多个 `feature_code` 归到少数稳定的 `feature_family_code`

---

## 4) 阶段 1 的关键：用 `hints` 做“允许但可观测”

`hints` 是一组机读信号，可能出现在成功与失败两种返回里：

- `ok=false`：通常代表应该拒绝执行（硬门控）。
- `ok=true` 且 `hints` 非空：代表允许执行，但你应该记录/打点，并根据业务决定是否降级。

你至少应该先“识别并上报”这些常见 hints（名称以 SDK 返回为准）：

- `pricing.not_configured`：还没配价格（Day 0 常见）
- `quota.remaining` / `rate.limit`：配额/速率接近上限（建议退避/排队/降级）
- `funding.xusd_shortfall` / `budget.shortfall`：余额/预算不足或临界（决定软拒绝或硬拒绝）
- `pricing.changed`：客户端预期价格与 commit 时权威价格不一致（决定是否重试/提示）
- `lease.*`：lease 过期相关（通常需要重新 authorize）

---

## 5) 阶段 2：开始“真钱”闭环（价格 + 余额）

当你要把“可观测”推进到“可收费/可拦截”，你只需要再补两类能力：

1) **价格**：commit 返回的 `pricing_snapshot` 是权威结果（fingerprint 变化代表价格输入变了）。
2) **余额/授信来源**：wallet/grants/budgets 决定一笔 commit 是否能被覆盖。

当你希望在系统里缓存 `billing_account_id`（例如 Bearer API 需要 account 上下文、或你想减少解析成本），可以在你已经拥有 `principal_id` 的情况下先读一次余额：

```python
balance = await client.get_credit_balance(context=RequestContext(principal_id=principal_id))
billing_account_id = (balance.data.billing_account_id if balance.data else None)
```

然后把 `principal_id → billing_account_id` 持久化到你自己的数据库。

---

## 6) 阶段 3：产品化售卖（签发 Bearer token + 给前端用）

当你需要前端/移动端访问 checkout/portal/catalog：

1) 你的后端用 `ServiceClient.issue_platform_token(...)` 给某个 `principal_id` / `user_id` 签发短期 token
2) 前端拿到 token 后，用 `BearerClient` 调用所需能力

示意（token 签发）：

```python
token_envelope = await client.issue_platform_token(
  body={
    "principal_id": principal_id,
    "user_id": user_id,
    "scopes": ["checkout", "portal"],
    "session_ttl_sec": 900,
  },
  context=RequestContext(principal_id=principal_id),
)
access_token = token_envelope.data.access_token  # type: ignore[union-attr]
```

前端调用时你通常还需要一个 account 上下文（`billing_account_id`）。建议从你自己的映射表里取出并传入：

```python
from vlunaai import (
  VlunaAIConfig,
  BearerClientOptions,
  RequestContext,
  create_bearer_client,
)

bearer_client = create_bearer_client(
  BearerClientOptions(
    config=VlunaAIConfig(
      base_url=os.environ.get("VLUNA_BEARER_BASE_URL", "http://localhost:3002/api/v1"),
      realm_id=env("VLUNA_REALM_ID"),
    )
  )
)
ctx = RequestContext(access_token=access_token, billing_account_id=billing_account_id)
products = await bearer_client.list_catalog_products(context=ctx)
```

---

## 7) 阶段 4：更细粒度权限与限制（Billing Plan 作为统一载体）

当你需要把“权限 + 限额/限速 + 赠送额度”打包成套餐时，再引入 Billing Plan：

- Billing Plan 作为统一载体，把 feature_family（权限）+ gate policies（限额/速率）+ grants（资金）组合起来

你的集成代码不需要改变 `authorize → commit` 的调用方式，只是服务端的“允许/拒绝 + hints + 结算结果”会更丰富。

---

## 8) 常见集成问题

- `realm_id` 配错：请求都会落到错误的 Realm，表现为“查不到/没权限/数据不一致”。
- `principal_id` 不稳定：同一客户在你系统里用多个 ID，会导致在 Vluna 里生成多个计费账户。
- 重试不安全：在超时/网络抖动时，显式设置并复用 `RequestContext(idempotency_key=...)`，避免重复记账。
