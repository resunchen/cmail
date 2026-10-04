## GitHub Actions 安全部署

部署期通过 Cloudflare D1 管理 API 建表、升级并刷新 KV 设置缓存，然后一次发布代码和 secret bindings。线上没有数据库 bootstrap 接口。

### 凭据与配置

以下值只能放在 **Settings → Secrets and variables → Actions → Repository secrets**，不能从普通 GitHub Variables 回退。

| GitHub Secret | 用途 | Worker 绑定 |
| --- | --- | --- |
| `JWT_SECRET` | JWT 签名；至少 32 字节，推荐随机生成的 32 字节密钥 | `jwt_secret`，`secret_text` |
| `LINUXDO_CLIENT_SECRET` | 配置 LinuxDO OAuth 时必需 | `linuxdo_client_secret`，`secret_text` |
| `CLOUDFLARE_API_TOKEN` | 发布 Worker、读取/创建部署所需资源 | 不绑定 |
| `D1_MIGRATION_API_TOKEN` | 独立的 D1 读写和 KV 写入管理令牌 | 不绑定 |

迁移令牌和发布令牌分别创建、撤销，并限制到需要的账户/资源。迁移令牌不需要 Worker 发布权限。JWT 和 OAuth 密钥不参与管理 API 授权，不写入 Wrangler `[vars]`、`wrangler-deploy.json`、URL 或命令行参数。

发布使用锁文件固定的 Wrangler 4.90.0 的 `deploy --secrets-file`，同时更新代码和 secret bindings。临时载荷目录权限为 0700、文件权限为 0600，成功和失败都会删除，另有工作流 `always()` 清理。它是 secret 上传载荷，不是 Wrangler 配置。Wrangler 子进程拿不到 JWT/OAuth/迁移凭据的环境变量；原始输出不回显，调试日志指向 `/dev/null`，遥测关闭。前端在发布凭据进入步骤前完成构建。

非敏感配置可使用同名 GitHub Variables；为了兼容旧配置，也接受 Secrets。

| 配置 | 要求 |
| --- | --- |
| `NAME` | 默认 `cloud-mail`；小写字母/数字/连字符 |
| `CLOUDFLARE_ACCOUNT_ID` | 必需，目标账户 ID |
| `DOMAIN` | 必需，非空 JSON 字符串数组，例如 `["example.com"]` |
| `ADMIN` | 必需，管理员邮箱 |
| `D1_DATABASE_ID` / `KV_NAMESPACE_ID` | 推荐指定；省略时按 `NAME` 查找或创建 |
| `CUSTOM_DOMAIN` / `R2_BUCKET_NAME` | 可选；R2 桶须提前创建 |
| `LINUXDO_SWITCH` | 仅明确为 `true` 时启用 OAuth；默认关闭 |
| `LINUXDO_CLIENT_ID` / `LINUXDO_CALLBACK_URL` | 配置 OAuth 时与 client secret 一起完整提供 |
| `AI_MODEL` / `ANALYSIS_CACHE` / `PROJECT_LINK` / `CF_EMAIL` | 保留原有对应功能配置 |

### 首次发布与历史库升级

1. 记录可恢复的 D1 Time Travel 时间点或完成备份。历史库升级安排合适的维护窗口。
2. 旧部署曾将 JWT 放入访问 URL 或普通变量时，准备新的随机 JWT Secret；更换后旧 JWT 登录会话会失效。OAuth client secret 曾放入普通变量时也应更换。改代码不会自动撤销旧凭据。
3. 配置 Secrets 和资源标识，运行 **Deploy cmail to Cloudflare Workers**。
4. 门禁和测试通过后，依次构建前端、准备资源、生成非敏感配置、迁移 D1、刷新 KV 缓存、发布 Worker。任意步骤失败都会阻止新版本发布。
5. 不再使用 `INIT_URL` 或公开初始化地址。退休路径的所有请求返回 404。

`scripts/migrations.mjs` 保留原初始化器的 SQL、默认数据和历史升级顺序，并移出 Worker bundle。重复列通过明确的 schema 检查跳过，其他错误不会被吞掉。关联的数据转换使用 D1 batch，包括旧收件字段转换、邮箱名初始化和首次添加 unread。部分升级库逐列修复；已有 unread 不会被重新覆盖。邮件收发和用户权限业务未变更。

每个完成阶段写入 `cmail_schema_migrations` 和校验和，重复运行跳过完成阶段。不要修改已发布迁移函数；后续升级新增阶段。阶段内并非整库原子事务：失败阶段可能留下此前成功的独立语句，重试通过 schema 检查继续；D1 batch 内部语句一起提交。D1 成功而 KV 刷新失败时阻止发布，重试跳过完成的 D1 阶段并重新刷新缓存。

数据库锁 `cmail_schema_lock` 拒绝并发迁移，GitHub concurrency 串行发布。正常完成/报错会释放锁。runner 被强制终止后，锁不会自动过期：运维人员确认没有迁移仍在运行，再通过 Cloudflare D1 管理控制台检查并删除锁记录、重新运行。管理 API 响应体和错误不会回显到日志。

### 本地验证及手动部署

```bash
cd mail-worker
pnpm install --frozen-lockfile
pnpm security:check
pnpm test
```

测试使用 Node 22 内置 SQLite 和现有 Vitest，不访问生产资源。`pnpm test` 现在运行测试，避免原命令意外部署测试 Worker。

手动部署先提供非敏感资源配置，并完成不带发布凭据的前端构建：

```bash
pnpm --dir ../mail-vue install --frozen-lockfile
pnpm --dir ../mail-vue run build
python3 scripts/prepare_config.py
python3 scripts/security_gate.py --config wrangler-deploy.json
```

从安全的凭据提供方为单次迁移进程提供 `D1_MIGRATION_API_TOKEN`，执行 `pnpm db:migrate`；成功后为发布进程提供 `CLOUDFLARE_API_TOKEN`、`JWT_SECRET` 及需要的 OAuth secret，执行 `node scripts/deploy.mjs`。不要在命令中填入真实密钥，不要开启 shell xtrace，不要归档 secret 上传载荷。

本地开发用 git 忽略的 `.dev.vars` 提供至少 32 字节的 `jwt_secret`，不再在 `wrangler*.toml` 设置密钥。直接 `wrangler deploy` 不执行数据库升级；生产发布使用完整流程。

### 自动门禁

`.github/workflows/security.yml` 对 PR 和 main 提交运行静态门禁及测试；部署工作流也在使用生产资源前运行。仓库管理员可将 **Security gates / security** 配为 main 必需检查。本补丁不修改远端分支保护或自动部署。

覆盖普通变量回退、Wrangler 明文凭据、配置/URL/日志插值、公开 bootstrap 恢复、运行时误引入迁移、凭据缺失、临时载荷和输出清理、旧库数据保留、重复/部分/失败升级、校验和、并发锁及 JWT 签名。
