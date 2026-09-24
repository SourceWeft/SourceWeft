# 使用发布镜像部署

[English](README.md) | [简体中文](README.zh-CN.md)

只需要 Docker Engine/Desktop、Compose v2.24+ 和 POSIX 终端（Linux、macOS 或 WSL）。不需要本机安装 Node.js、Rust、重新构建镜像或单独搭建文件存储。Web 和 API 共用一个网关入口；PostgreSQL、Redis 和默认 SeaweedFS S3 服务只在 Compose 内网访问，数据卷按项目隔离。

## 首次安装

从所选 GitHub Release 下载 `sourceweft-selfhost-vX.Y.Z.tar.gz` 并解压，也可以在 Git 中切换到同一个发布标签。不要把 main 分支的 Compose 文件与旧镜像混用。在包含 `docker/` 的目录中执行：

```sh
VERSION=v0.3.0-rc.2 # 改成所下载的发布版本
IMAGE=ghcr.io/sourceweft/sourceweft:$VERSION
docker run --rm --user "$(id -u):$(id -g)" --entrypoint node \
  -e SOURCEWEFT_IMAGE="$IMAGE" -v "$PWD/docker:/config" "$IMAGE" \
  /app/docker/init-config.mjs /config
docker compose --env-file docker/.env -f docker/docker-compose.yml up -d --wait --wait-timeout 300
```

初始化命令生成 `.env`，其中包含独立随机的数据库、存储、认证和加密密钥。已有 `.env` 时会拒绝覆盖。不要在已有安装上重新初始化，也不要随意更换模型凭据加密密钥。

打开 **http://localhost:3000** 注册登录。数据库迁移和存储桶初始化成功后，API 和 worker 才会启动。邮件、OAuth、支付和模型账号不是启动应用的前提；聊天和依赖向量的索引需要配置模型 Provider（例如分别设置 `OPENROUTER_ENABLED` 和 API key）或授权的 BYOK 模型。缺少模型时不会自动改用其他供应商。

默认私有桶用于上传文件；可选的 `PUBLIC_S3_*` 配置用于公开博客资源，两者用途不同。

## 修改地址或端口

修改 `docker/.env` 后重新执行相同的 `up` 命令，无需重建镜像。

```dotenv
WEB_PORT=8080
# 留空时使用 http://localhost:WEB_PORT；通过域名/IP 访问时设置实际 origin。
PUBLIC_WEB_BASE_URL=https://notes.example.com
# 留空时使用同一入口；仅在明确分离 API 时设置。
PUBLIC_API_BASE_URL=
```

只发布网关端口，外部 HTTPS 代理可以转发到该端口。公开地址应与浏览器使用的 origin 一致。网关禁用 SSE 缓冲并转发 WebSocket Upgrade。Web 容器通过 `INTERNAL_API_BASE_URL=http://api:3001` 访问 API，不依赖公开地址。

## 可选服务

- 外部 S3：设置 `COMPOSE_PROFILES=` 停用内置存储，填写 `S3_ENDPOINT`、`S3_REGION`、`S3_BUCKET`、`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY` 和路径样式配置。使用已有桶时设置 `S3_CREATE_BUCKET=false`。初始化会检查桶是否可用，缺失或无权访问时明确失败。
- 默认 `SOURCE_UPLOAD_MODE=proxy`：文件上传、预览和下载经过 API。直传模式需要浏览器可访问的 S3 地址及相应 CORS 配置。两种模式都要求私有桶。
- 外部 PostgreSQL：设置完整的 `DATABASE_URL`，明确安排好外部数据库后再停止或覆盖内置 PostgreSQL 服务。默认部署中保持 `DATABASE_URL` 留空，由入口脚本对 `DB_*` 字段进行 URL 编码后生成连接串。`DB_*` 用于初始化新数据库；修改已有数据库密码时，还需要同步修改数据库角色密码。
- OAuth、邮件、公开博客存储、OCR、沙箱和商业计费均为可选功能，配置项见 `.env.example`。Google One Tap 的公开参数使用 `PUBLIC_GOOGLE_ONE_TAP_*`，在运行时注入。
- 网页搜索和抓取使用 `ANYCRAWL_API_KEY`。未配置时不阻塞普通模型聊天；显式调用网页工具会报告未配置 Provider，不会自动更换数据源。

## 检查、停止与重启

```sh
docker compose --env-file docker/.env -f docker/docker-compose.yml ps -a
docker compose --env-file docker/.env -f docker/docker-compose.yml logs --tail=100 migrate storage-init api worker
curl -f http://localhost:3000/v1/health
docker compose --env-file docker/.env -f docker/docker-compose.yml down
# 重新执行 up 可再次启动，数据卷会保留。
```

`down` 保留数据。**`down -v` 会删除当前实例的数据**，仅用于明确需要丢弃的临时实例。健康检查返回 HTTP 200 不能代替登录、文件上传和模型响应验证。

## 升级

1. 停止写入，使用现有备份工具备份 PostgreSQL 和 S3 数据，并保存 `.env` 及加密密钥。
2. 下载新版本对应的 Compose 文件，保留现有 `.env`，对照新 `.env.example` 补充配置，不要重新生成密钥。
3. 将 `SOURCEWEFT_IMAGE` 改为准确的新标签，执行 `docker compose ... pull`，然后执行相同的 `up -d --wait` 命令。迁移失败会阻止 API 启动，需要先检查日志。
4. 验证登录、已有文件和对话。如果迁移后需要回退，必须将兼容的数据库及存储备份与旧镜像一起恢复；仅降级镜像不等于数据库回滚。

## 旧版本固定数据卷

旧 Compose 使用 `sourceweft-postgres` 和 `sourceweft-redis` 固定卷名。升级时如需保留这些卷，应在每条 Compose 命令中显式加入覆盖文件：

```sh
docker compose --env-file docker/.env -f docker/docker-compose.yml \
  -f docker/compose.legacy-volumes.yml up -d --wait
```

覆盖文件将旧数据卷声明为外部卷，卷不存在时会失败。不要在首次安装或第二个实例中使用该覆盖文件。新实例可以使用 `-p another-instance`、独立配置目录和不同 `WEB_PORT`，保持数据隔离。

## 自动验收

CI 构建通用镜像，使用随包模板初始化全新项目和数据卷，启动真实 Compose 服务，并验证注册登录、私有文件上传/下载、聊天流式响应、停止生成和换端口重启。

模型使用明确声明的 OpenAI 兼容测试服务；认证、PostgreSQL、Redis、S3、网关和应用均为真实组件。该验收不代表已验证外部模型供应商的响应质量。
