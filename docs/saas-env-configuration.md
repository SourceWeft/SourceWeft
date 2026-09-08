# Billing edition migration note (2026-09-09)

The source tree is now core: it does not run commercial credit/page accounts.
Use an explicitly prepared commercial build for the billing configuration below.
Old self-hosted deployments wishing to retain metering must select commercial;
core configurations must remove active billing flags or use disabled mode.
See `enterprise/billing/README.md` and its generated backend.env.example.
Existing Provider activation and BYOK configuration is unchanged.

---

# SourceWeft SaaS Env 配置清单

本文整理把 SourceWeft 作为 SaaS/Hosted 版本部署时需要配置的 env。核心版默认不运行 credits/pages 账本；商业版可以启用计量与拦截，支付、订阅 checkout、外部邮件和付费入口默认关闭。SaaS 需要显式打开总开关和相关 provider。

## 1. 最小 SaaS 启用清单

要让付费 checkout 和订阅入口真正可用，至少需要同时配置：

```env
SOURCEWEFT_EDITION=commercial
SOURCEWEFT_SAAS_ENABLED=true
BACKEND_BILLING_PROVIDER=creem
NEXT_PUBLIC_SOURCEWEFT_SAAS_ENABLED=true
NEXT_PUBLIC_BILLING_CHECKOUT_ENABLED=true
CREEM_API_KEY=
CREEM_WEBHOOK_SECRET=
CREEM_INDIVIDUAL_PRO_MONTHLY_PRODUCT_ID=
CREEM_INDIVIDUAL_PRO_YEARLY_PRODUCT_ID=
```

如果销售 team plan 或 top-up，还需要对应 product id：

```env
BACKEND_TEAM_BILLING_ENABLED=true
CREEM_TEAM_STANDARD_MONTHLY_PRODUCT_ID=
CREEM_TEAM_STANDARD_YEARLY_PRODUCT_ID=
CREEM_CREDIT_TOPUP_PRODUCT_ID=
CREEM_PAGE_TOPUP_PRODUCT_ID=
```

注意：后端只有 `SOURCEWEFT_SAAS_ENABLED=true` 且 `BACKEND_BILLING_PROVIDER=creem` 时才会启用 provider checkout。只填 `CREEM_API_KEY` 不会打开支付。

## 2. Core Runtime

这些是 SaaS/生产部署通常必须配置的基础项：

```env
NEXT_PUBLIC_WEB_BASE_URL=https://app.example.com
NEXT_PUBLIC_API_BASE_URL=https://api.example.com
BACKEND_API_HOST=0.0.0.0
BACKEND_API_PORT=3001

DATABASE_URL=postgresql://user:password@host:5432/sourceweft
REDIS_URL=redis://host:6379/0

BETTER_AUTH_SECRET=
MODEL_GATEWAY_ENCRYPTION_SECRET=
```

说明：

- `BETTER_AUTH_SECRET` 和 `MODEL_GATEWAY_ENCRYPTION_SECRET` 必须使用强随机值。
- `NEXT_PUBLIC_WEB_BASE_URL` / `NEXT_PUBLIC_API_BASE_URL` 会影响 auth callback、CORS、前端 SDK 请求地址。
- Docker 部署仍可使用 `DB_USER`、`DB_PASSWORD`、`DB_NAME` 生成默认 `DATABASE_URL`，但生产 SaaS 建议显式设置完整连接串。

### 文件上传方式

```env
SOURCE_UPLOAD_MODE=proxy
```

| 取值 | 行为 | 需要的额外配置 |
| --- | --- | --- |
| `proxy`（默认） | 文件经 API 中转再写入对象存储 | 无 |
| `direct` | 客户端拿 presigned PUT 直传对象存储，API 只处理两次元数据握手 | **bucket 必须配 CORS** |

`direct` 更快，且文件不再进入 API 进程的内存，但浏览器直传会触发 CORS 预检，所以 bucket 上必须有允许 `PUT` 的策略：

```json
[
  {
    "AllowedOrigins": ["https://app.example.com"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["content-type"],
    "ExposeHeaders": ["etag"],
    "MaxAgeSeconds": 3600
  }
]
```

默认留在 `proxy`，是为了让自托管和个人部署开箱可用——不配任何对象存储策略也能上传。SaaS 部署建议显式打开 `direct`。

切换不需要改前端：客户端调的始终是同一个方法，服务端在 `POST /sources/upload-intent` 的响应里返回当前模式，客户端据此走直传或回退到中转。所以这个开关**改完重启后端即可生效，不用重新构建镜像**。

## 3. Billing 与 Quota

商业发行版提供 pages/credits 计量和额度拦截；核心版不包含该账本。免费用户/默认个人空间的额度通过 env 控制：

```env
BACKEND_BILLING_MODE=enforced
BACKEND_BILLING_SCOPE=individual_only
BACKEND_CREDITS_ENABLED=true
BACKEND_PAGES_ENABLED=true
BACKEND_BILLING_ENFORCE_LIMITS=true
BACKEND_DEFAULT_PLAN_FAMILY=individual_free
BACKEND_DEFAULT_MONTHLY_PAGES=300
BACKEND_DEFAULT_MONTHLY_CREDITS=3000
BACKEND_CREDIT_UNIT_USD=0.00125
BACKEND_CREDIT_MARKUP_RATE=0.25
```

支付/订阅 provider：

```env
SOURCEWEFT_SAAS_ENABLED=true
BACKEND_BILLING_PROVIDER=creem
BACKEND_TEAM_BILLING_ENABLED=false
BACKEND_BILLING_RECONCILE_ENABLED=false
```

Creem 配置：

```env
CREEM_API_KEY=
CREEM_WEBHOOK_SECRET=
CREEM_TEST_MODE=true

BILLING_PRICE_INDIVIDUAL_PRO_MONTHLY_CENTS=1200
BILLING_PRICE_INDIVIDUAL_PRO_YEARLY_CENTS=9600
BILLING_PRICE_TEAM_STANDARD_MONTHLY_CENTS=4900
BILLING_PRICE_TEAM_STANDARD_YEARLY_CENTS=39200
BILLING_CREDIT_TOPUP_UNIT_AMOUNT=10000
BILLING_CREDIT_TOPUP_AMOUNT_CENTS=1250
BILLING_PAGE_TOPUP_UNIT_AMOUNT=1000
BILLING_PAGE_TOPUP_AMOUNT_CENTS=500

CREEM_INDIVIDUAL_PRO_MONTHLY_PRODUCT_ID=
CREEM_INDIVIDUAL_PRO_YEARLY_PRODUCT_ID=
CREEM_TEAM_STANDARD_MONTHLY_PRODUCT_ID=
CREEM_TEAM_STANDARD_YEARLY_PRODUCT_ID=
CREEM_CREDIT_TOPUP_PRODUCT_ID=
CREEM_PAGE_TOPUP_PRODUCT_ID=
```

说明：

- `BACKEND_DEFAULT_MONTHLY_PAGES` / `BACKEND_DEFAULT_MONTHLY_CREDITS` 只控制默认 free/个人空间额度。
- paid plan 和 team plan 的额度仍使用代码里的 plan quota。
- `BACKEND_TEAM_BILLING_ENABLED=true` 只在销售 team subscription 时需要。
- `BACKEND_BILLING_RECONCILE_ENABLED=true` 只在需要后台对账/修复 provider 状态时开启。
- `CREEM_TEST_MODE=false` 才是正式支付环境。

## 4. Web Public Env

前端付费入口由 public env 控制：

```env
NEXT_PUBLIC_SOURCEWEFT_SAAS_ENABLED=true
NEXT_PUBLIC_BILLING_CHECKOUT_ENABLED=true

NEXT_PUBLIC_PRICING_PRO_MONTHLY=1200
NEXT_PUBLIC_PRICING_PRO_YEARLY=9600
NEXT_PUBLIC_PRICING_TEAM_MONTHLY=4900
NEXT_PUBLIC_PRICING_TEAM_YEARLY=39200
```

说明：

- `NEXT_PUBLIC_SOURCEWEFT_SAAS_ENABLED=false` 或 `NEXT_PUBLIC_BILLING_CHECKOUT_ENABLED=false` 时，前端会隐藏/禁用 paid checkout、upgrade、billing portal 入口。
- Next.js 的 `NEXT_PUBLIC_*` 通常会在构建时写入客户端 bundle。使用预构建 Docker image 做 SaaS 时，需要确认这些 public env 是否在构建阶段已设置；最稳妥做法是用 SaaS public env 重新 build image。

## 5. Mail

OSS 默认 `MAIL_PROVIDER=console`，不会发送外部邮件。SaaS 生产邮件需要显式开启 provider：

```env
MAIL_PROVIDER=plunk
MAIL_FROM_ADDRESS=noreply@example.com
MAIL_FROM_NAME=SourceWeft
PLUNK_API_BASE_URL=https://next-api.useplunk.com
PLUNK_API_KEY=
```

说明：

- `MAIL_PROVIDER=console` 或 `MAIL_PROVIDER=noop` 适合本地/OSS，不需要 `PLUNK_API_KEY`。
- `MAIL_PROVIDER=plunk` 时必须配置 `PLUNK_API_KEY`。

## 6. Auth、OAuth 与 One Tap

基础 auth origin：

```env
BETTER_AUTH_TRUSTED_ORIGINS=https://app.example.com,https://api.example.com
BETTER_AUTH_LOG_LEVEL=info
```

Google/GitHub 登录：

```env
AUTH_GOOGLE_CLIENT_ID=
AUTH_GOOGLE_CLIENT_SECRET=
AUTH_GITHUB_CLIENT_ID=
AUTH_GITHUB_CLIENT_SECRET=
```

Google One Tap 前端开关：

```env
NEXT_PUBLIC_GOOGLE_ONE_TAP_ENABLED=true
NEXT_PUBLIC_GOOGLE_ONE_TAP_CLIENT_ID=
NEXT_PUBLIC_GOOGLE_ONE_TAP_FEDCM_ENABLED=false
AUTH_ONE_TAP_CLIENT_ID=
```

Passkey：

```env
AUTH_PASSKEY_RP_ID=app.example.com
AUTH_PASSKEY_RP_NAME=SourceWeft
```

说明：

- One Tap 默认关闭；只有 Google OAuth Web Client 配好并允许当前 web origin 后再开启。
- `AUTH_ONE_TAP_CLIENT_ID` 为空时可回退使用 `AUTH_GOOGLE_CLIENT_ID`，但 SaaS 生产建议显式配置。

## 7. Storage、Parsing、Search 与模型能力

文件上传/解析通常需要对象存储：

```env
S3_BUCKET=
S3_REGION=us-east-1
S3_ENDPOINT=
S3_FORCE_PATH_STYLE=false
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
```

文档解析：

`DOCUMENT_PARSE_PROVIDER` 在服务启动加载配置时校验：忽略大小写与前后空白，未设置或空白值仍使用 `pdf2markdown`；未知非空值直接令启动失败。升级或重启前请修正历史拼写错误，不会静默改用默认解析器。运行中的 parser 只使用已解析的配置，不再通过原始 env 绕过校验。

配置 ID 集合保持 `langchain`、`pdf2markdown`、`docling`、`llamaparse`、`unstructured`。目前只有前两个存在后端实现；后三个仍是占位 ID，被 registry 选中时按既有行为报未实现。`vision` 是图片解析内部路径，不是可选配置值。本批不改变解析策略或已有异步任务的 provider。

```env
DOCUMENT_PARSE_STRATEGY=explicit
DOCUMENT_PARSE_PROVIDER=pdf2markdown
PDF2MARKDOWN_API_KEY=
PDF2MARKDOWN_BASE_URL=https://pdf2markdown.io/api
PDF2MARKDOWN_OUTPUT=all
PDF2MARKDOWN_POLL_INITIAL_DELAY_MS=2000
PDF2MARKDOWN_POLL_MAX_DELAY_MS=15000
PDF2MARKDOWN_POLL_MAX_ATTEMPTS=40
PDF2MARKDOWN_REQUEST_TIMEOUT_MS=30000
```

Web search/fetch：

```env
ANYCRAWL_API_KEY=
```

模型 provider：

```env
OPENROUTER_API_KEY=
DEEPINFRA_API_KEY=
SILICONFLOW_API_KEY=
MODEL_GATEWAY_SYNC_OPENROUTER_CATALOG=false
```

说明：

- 模型 provider key 不影响应用启动；未配置时，实际模型调用会返回现有 provider 配置错误。
- SaaS 要提供可用聊天/模型能力，生产环境至少应配置一个模型 provider。

## 8. Ops Alerts

生产 SaaS 建议开启 billing/webhook 等异常告警：

```env
BACKEND_ALERTS_ENABLED=true
OPS_ALERT_EMAILS=ops@example.com
OPS_ALERT_COOLDOWN_MINUTES=30
OPS_ALERT_MIN_LEVEL=warn
```

## 9. Docker 放置位置

Docker 部署时建议把上述变量写入：

```text
docker/.env
```

其中 backend/api/worker/scheduler 使用普通 env，web 还需要 public env：

```env
NEXT_PUBLIC_SOURCEWEFT_SAAS_ENABLED=true
NEXT_PUBLIC_BILLING_CHECKOUT_ENABLED=true
```

如果 public env 需要进入客户端 bundle，请在 build image 时同步传入 build args，例如：

```bash
docker build \
  --build-arg NEXT_PUBLIC_API_BASE_URL=https://api.example.com \
  --build-arg NEXT_PUBLIC_WEB_BASE_URL=https://app.example.com \
  --build-arg NEXT_PUBLIC_SOURCEWEFT_SAAS_ENABLED=true \
  --build-arg NEXT_PUBLIC_BILLING_CHECKOUT_ENABLED=true \
  -t sourceweft:saas .
```

## 10. 快速核对

上线前确认：

- `SOURCEWEFT_SAAS_ENABLED=true`
- `BACKEND_BILLING_PROVIDER=creem`
- `NEXT_PUBLIC_SOURCEWEFT_SAAS_ENABLED=true`
- `NEXT_PUBLIC_BILLING_CHECKOUT_ENABLED=true`
- `CREEM_API_KEY`、`CREEM_WEBHOOK_SECRET`、需要销售的 product id 均已设置
- `MAIL_PROVIDER=plunk` 且 `PLUNK_API_KEY` 已设置
- `NEXT_PUBLIC_WEB_BASE_URL` / `NEXT_PUBLIC_API_BASE_URL` 是公网 HTTPS 地址
- OAuth callback/origin 与 `BETTER_AUTH_TRUSTED_ORIGINS` 匹配
- 至少一个模型 provider key 已配置
