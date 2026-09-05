<!-- synced-with: 7e8ffef -->

> **语言**: [English](./DEPLOYMENT.md) | 中文

# ZeroLink 部署指南 / Deployment Guide

如需 Docker Compose 自部署，请参见 [SELF_HOSTED_DEPLOYMENT.zh.md](./SELF_HOSTED_DEPLOYMENT.zh.md)。

> 本文档涵盖将 ZeroLink 部署到 Cloudflare 的完整步骤。
> This document covers the complete steps to deploy ZeroLink to Cloudflare.

---

## 目录 / Table of Contents

1. [前提条件 / Prerequisites](#前提条件--prerequisites)
2. [架构概览 / Architecture Overview](#架构概览--architecture-overview)
3. [手动部署 / Manual Deploy](#手动部署--manual-deploy)
4. [环境变量参考 / Environment Variables](#环境变量参考--environment-variables)
5. [Manifest 签名（可选）/ Manifest Signing](#manifest-签名可选--manifest-signing)
6. [自定义域名 / Custom Domain](#自定义域名--custom-domain)
7. [CI/CD 自动部署 / Automated Deployment](#cicd-自动部署--automated-deployment)
8. [故障排查 / Troubleshooting](#故障排查--troubleshooting)

---

## 前提条件 / Prerequisites

| 要求 | 说明 | 最低版本 |
|------|------|---------|
| Cloudflare 账号 | 免费版即可（支持 Durable Objects 免费层） | — |
| Node.js | JavaScript 运行时 | >=22.22.0 |
| pnpm | 包管理器 | 9.x |
| Wrangler CLI | Cloudflare 官方部署工具 | 4.x |

> **重要 / Important**: Durable Objects 自 2026 年起提供 **免费层 (Free Tier)**。
> 本项目已适配 **SQLite 存储后端**，支持在免费计划下运行（每日 10 万次请求限额）。
> Durable Objects now offer a **Free Tier**. This project uses the **SQLite backend**, which is supported on the free plan (100k daily requests).

安装 Wrangler CLI / Install Wrangler CLI:
```bash
npm install -g wrangler
```

---

## 架构概览 / Architecture Overview

```
用户浏览器                 Cloudflare 边缘
──────────                 ──────────────────────────────────
Frontend SPA    ──→        Worker (zerolink-api)
  + API 请求                         │  ├─ run_worker_first = true
                                     │  ├─ 注入安全响应头
                                     │  ├─ /api/* → 业务逻辑 + multipart 协调
                                     │  └─ 其余路径 → Workers Assets (静态文件)
                                     │
                                     │
                              Durable Object
                               (SecretVault)
                              [状态机/SQLite]
                                     │
                                     ▼
                              R2 FILE_BUCKET
                             （加密文件分片）
```

- **Cloudflare Worker**：统一处理所有请求（API + 静态文件），注入安全响应头
- **Workers Assets**：Worker 内置静态资源托管，静态资源请求免费无限额
- **Durable Object**：每个 Secret 的原子状态机（SQLite 后端）；存储 inline 密文或 multipart `fileRef` 元数据
- **R2 FILE_BUCKET**：存储大文件的加密分片；由 Worker 通过 `/api/file/*` 路由做协调

> **架构说明 / Architecture Note**: 本项目采用 **Workers Assets 统一部署**模式，不使用
> Cloudflare Pages。前端构建产物通过 `wrangler.toml` 的 `[assets]` 绑定随 Worker 一起部署，
> 安全响应头由 Worker 代码统一注入，无需 `_headers` / `_redirects` 文件。

---

## 手动部署 / Manual Deploy

### 第 1 步：克隆仓库并安装依赖

```bash
git clone https://github.com/yclgkd/zerolink.git
cd zerolink
pnpm install --frozen-lockfile
```

### 第 2 步：登录 Wrangler

```bash
npx wrangler login
```

### 第 3 步：先创建 R2 bucket

先创建 `packages/backend/wrangler.toml` 里声明的 bucket。

```bash
# Production
npx wrangler r2 bucket create zerolink-files

# Staging（如果你也部署 staging，就一起创建）
npx wrangler r2 bucket create zerolink-files-staging
```

如果 `wrangler.toml` 里引用的 bucket 不存在，`wrangler deploy` 会直接失败。

### 第 4 步：在设置 Secrets 前先确定最终访问域名

在运行 `pnpm setup` 之前，先决定 ZeroLink 最终是挂在自定义域名，还是挂在
`*.workers.dev` 主机名上。`RP_ID` 和 `RP_ORIGIN` 必须与最终浏览器访问的 Origin
完全一致。

#### 选项 A：自定义域名

在部署前先把 `packages/backend/wrangler.toml` 里的示例 `zerolink.dev` routes 改成你自己的
域名；如果你也会部署 staging，则 `[env.staging].routes` 也要一起更新。

```toml
routes = [
  { pattern = "example.com", zone_name = "example.com" },
  { pattern = "example.com/*", zone_name = "example.com" },
]
```

#### 选项 B：`*.workers.dev`

如果你想先不绑定自定义域名，请移除目标环境对应的 `routes` 配置块。这样 Cloudflare 会把
Worker 挂到默认的 `*.workers.dev` 主机名上。

- `RP_ID` 必须是最终的 `worker-name.<your-workers-subdomain>.workers.dev` 主机名。
- `RP_ORIGIN` 必须是完整的 `https://worker-name.<your-workers-subdomain>.workers.dev`。
- 如果你还不知道最终主机名，可以先在没有 routes 的情况下部署一次，记下生成的
  `*.workers.dev` URL，再重新运行 `pnpm setup` 并重新部署。

### 第 5 步：运行 setup 脚本

```bash
pnpm setup
```

脚本会交互式地完成以下工作：
- 自动生成并设置 `COMMIT_TOKEN_SECRET`
- 提示输入 `RP_ID` 和 `RP_ORIGIN`，设置为 Worker Secret
- 让你选择 `production`、`staging` 或 `both`

这里输入的值必须与第 4 步确定的最终 Origin 完全一致。如果之后改了访问域名，需要重新运行
`pnpm setup` 更新 Secrets，再继续依赖 WebAuthn。

```
🚀 ZeroLink Cloudflare Setup

Checking Wrangler login... ✅

Environment to set up (production / staging / both) [production]: production

WebAuthn configuration for production:
  RP_ID    (domain without https://, e.g. zerolink.dev): zerolink.dev
  RP_ORIGIN (full URL,   e.g. https://zerolink.dev): https://zerolink.dev

📦 Setting up production...
  Setting COMMIT_TOKEN_SECRET... ✅
  Setting RP_ID... ✅
  Setting RP_ORIGIN... ✅

🎉 Setup complete!
```

### 第 6 步：构建前端

```bash
pnpm --filter @zerolink/frontend build
# 构建输出在 packages/frontend/dist/ 目录
```

默认的 `pnpm build` 产物是可运行但**未验证**的前端壳。它不会启用 fail-closed 的
`Verified Release` 启动门禁，因此适用于本地预览和未签名的手动部署。

### 第 7 步：部署

根据你实际要部署的环境选择对应命令：

```bash
cd packages/backend

# Production（顶层环境）
npx wrangler deploy --env=""

# Staging
npx wrangler deploy --env staging
```

一条命令同时部署 Worker 代码和前端静态资源。

> **WebAuthn 说明 / WebAuthn Note**:
> - `RP_ID` = 最终主机名（不含协议），例如 `example.com`
> - `RP_ORIGIN` = 最终完整 Origin，例如 `https://example.com`
> - 如果使用 `*.workers.dev`，则这两个值都必须从最终的
>   `worker-name.<subdomain>.workers.dev` 主机名推导
> - 这两个值必须与实际访问域名完全匹配，否则 WebAuthn 认证会失败

### 第 8 步：验证部署

```bash
cd packages/backend

# 查看 production 日志
npx wrangler tail --env=""

# 查看 staging 日志
npx wrangler tail --env staging

# 验证 Worker 可达（把 <your-origin> 替换成实际访问域名）
curl -s https://<your-origin>/api/public/00000000-0000-0000-0000-000000000000 | head -c 200

# 验证文件策略与 multipart 开关
curl -s https://<your-origin>/api/file_policy
```

默认 Worker 配置下，`/api/file_policy` 应返回 `"multipartSupported": true`。

---

## 环境变量参考 / Environment Variables

### Worker 运行时变量（在 Cloudflare Dashboard 中配置）

| 变量名 | 必须 | 说明 | 示例 |
|--------|------|------|------|
| `RP_ID` | ✅ | WebAuthn Relying Party ID（域名，不含协议） | `zerolink.dev` |
| `RP_ORIGIN` | ✅ | WebAuthn Origin（完整 URL） | `https://zerolink.dev` |
| `COMMIT_TOKEN_SECRET` | ✅ | 用于 commit-cookie 绑定和 multipart upload session 签名的 HMAC 密钥（随机 32 字节 hex） | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |

### Cloudflare 绑定（在 `wrangler.toml` 中声明）

| 绑定名 | 类型 | 说明 |
|--------|------|------|
| `SECRET_VAULT` | Durable Object | Channel 生命周期状态机 |
| `ASSETS` | Workers Assets | 前端静态文件 |
| `FILE_BUCKET` | R2 bucket | multipart 文件加密分片 |

`packages/backend/wrangler.toml` 已在 production 和 staging 的 `[vars]` 里默认开启
`FILE_MULTIPART_SUPPORTED=true`。

### CI/CD Secrets（GitHub Actions）

| Secret 名 | 说明 |
|-----------|------|
| `CLOUDFLARE_API_TOKEN` | 具备 Worker 路由和目标 R2 bucket 部署权限的 Cloudflare API Token |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账号 ID |
| `MANIFEST_SIGNING_KEY` | PEM 文本格式的 Ed25519 私钥，用于 manifest 签名 |
| `RELEASE_PLEASE_TOKEN` | GitHub PAT 或 GitHub App token，用于创建 Release PR、tag 和 GitHub Release，并确保后续 workflow 能被正常触发；若缺失，release-please workflow 会在预检查步骤里直接报错并给出配置提示 |

### 创建 Cloudflare API Token

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. 进入 **My Profile → API Tokens → Create Token**
3. 创建一个同时能部署 Worker 且能访问目标 R2 bucket 的 token
4. 复制 Token 并保存到 GitHub Secrets

对于 GitHub Actions 自动部署，ZeroLink 期望的权限至少等价于以下集合：
- Account：`Workers Scripts (edit)` 和 `Workers R2 Storage (edit)`
- Zone：部署目标 zone 的 `Workers Routes (edit)`
- User token 补充：Cloudflare Workers Builds 文档里，自动生成的 user token 还会带上 `Account Settings (read)`、`User Details (read)` 和 `Memberships (read)`

ZeroLink 的 deploy preflight 以这些写权限为准。如果 token 可以通过 Cloudflare token API 自检，workflow 会在前端构建前直接验证这些 scope；如果 token 不能调用这些 introspection endpoint，workflow 会降级为 best-effort 的 Workers / Routes 可达性检查，加一个无副作用的 R2 写权限探针，并输出 warning，而不是在 deploy 之前直接阻断。

preflight 会直接读取 `packages/backend/wrangler.toml` 里当前环境的 `routes` 和 `r2_buckets`。
如果你在那里改了部署 zone 或 bucket 名，脚本会自动按新配置校验，不再默认假定
`zerolink.dev`。

如果你使用的是 account-owned token，而不是 user token，请确保授予与上述相同的 account / zone 权限。

---

## Manifest 签名（可选）/ Manifest Signing

ZeroLink 支持对前端构建产物进行 Ed25519 签名，供用户验证完整性。只有显式启用了
`VITE_RELEASE_VERIFICATION_REQUIRED=true` 且同时发布签名产物的构建，才会在浏览器端
启用 fail-closed 的 `Verified Release` 启动校验。

### 生成密钥对

```bash
# 使用 OpenSSL 生成 Ed25519 密钥
openssl genpkey -algorithm ed25519 -out keys/manifest-signing.pem
openssl pkey -in keys/manifest-signing.pem -pubout -out keys/manifest-signing.pub

# GitHub Secret MANIFEST_SIGNING_KEY 直接保存 PEM 文本内容
cat keys/manifest-signing.pem
```

> 私钥（`.pem`）已在 `.gitignore` 中排除，**切勿提交到 git**。

### 本地签名流程

```bash
# 构建
VITE_RELEASE_VERIFICATION_REQUIRED=true pnpm --filter @zerolink/frontend build

# 生成 manifest（记录 `entryAssetPath`，并仅哈希 `dist/assets/` 下的稳定运行时资源；
# 根目录文档如 `index.html`、`robots.txt` 不进入签名集）
pnpm manifest:generate

# 签名 manifest
MANIFEST_SIGNING_KEY="$(cat keys/manifest-signing.pem)" \
  pnpm manifest:sign

# 验证签名
pnpm manifest:verify
```

缓存策略由 Worker 代码统一控制：SPA 入口请求返回 `Cache-Control: no-store`，哈希后的
`/assets/*` 使用长期 immutable 缓存（`public, max-age=31536000, immutable`）。签名
manifest 仅覆盖 `dist/assets/` 下的稳定运行时产物，不覆盖 `index.html` 等根目录文档。
生成的 `manifest.json` 会记录当前应执行的入口 bundle (`entryAssetPath`)，浏览器端
bootstrap 会先确认自己正在运行的入口资源与 manifest 一致；若不一致，会先触发一次受控
刷新，仍无法恢复时再 fail-closed 阻断。

---

## 自定义域名 / Custom Domain

如果你使用自定义域名，请在 `wrangler.toml` 中配置 routes，让 Worker 处理该域名下的所有
请求（API + 静态资源）。下面只是示例值，必须替换成你自己的 zone：

```toml
routes = [
  { pattern = "example.com", zone_name = "example.com" },
  { pattern = "example.com/*", zone_name = "example.com" },
]
```

如果你使用 `*.workers.dev`，请跳过本节，并保持目标环境对应的 `routes` 配置已移除。

或通过 Cloudflare Dashboard：**Workers → <your-worker-name> → Settings → Domains & Routes → Add**

> **注意**: 使用两条独立的路由条目——一条匹配裸根路径（`example.com`），一条匹配所有子路径
> （`example.com/*`）——以确保根路径 `/` 也被正确匹配。

---

## CI/CD 自动部署 / Automated Deployment

项目包含一个独立的部署工作流 `.github/workflows/deploy.yml`，支持：
- 命中 workflow 触发条件的 `push` 到 `main` 时自动部署 staging
- 命中 workflow 触发条件的 `v*` tag 推送时自动部署 production
- 命中 `v*` tag 推送时自动发布 self-host 用的 `zerolink-api` 与 `zerolink-web` GHCR 镜像

工作流执行顺序：`install → preflight cloudflare → build frontend → generate manifest → sign manifest → verify manifest → publish ghcr images（仅 tag）→ wrangler deploy`

前端构建开始前，workflow 会先运行 `pnpm deploy:preflight`。脚本会先读取
`packages/backend/wrangler.toml` 里当前环境的 `routes` 和 `r2_buckets`，因此改了自定义
zone 或 bucket 名后不需要再去改脚本。当 Cloudflare 允许 token 自检时，它会先验证当前
token 处于 active 状态，再校验该 token 是否对当前 account / zone 实际拥有
`Workers Scripts Write`、`Workers Routes Write`（仅当该环境配置了 routes 时才检查）和
`Workers R2 Storage Write`，最后确认当前环境要求的 R2 bucket 已存在。有些 account-owned
deploy token 无法读取自己的 policy 详情；这种情况下，preflight 会回退为 best-effort 的
Workers / Routes 可达性检查、一个无效请求的 R2 写权限探针，以及 bucket 存在性检查，
输出 warning，并把最终的 route / script 写权限约束交给 `wrangler deploy`。

另有独立的 `.github/workflows/release-please.yml` 负责在 `main` 上生成或更新 Release PR。该 workflow 会先预检查 `RELEASE_PLEASE_TOKEN`，然后继续执行 commit-pinned 官方 `release-please` action。当前上游 action 仍声明 `runs: node20`，因此 GitHub 可能显示 Node 20 deprecation warning；ZeroLink 暂不通过运行时安装 npm 包去规避这个告警，待上游升级后再更新 pin。合并 Release PR 后，Release Please 会：
- 更新根目录 `version.txt`
- 维护根目录 `CHANGELOG.md`
- 创建新的 `v*` tag 和 GitHub Release
- 通过该 tag 继续复用现有 production deploy workflow，同时发布 self-host GHCR 镜像

版本来源约定：
- production 构建以 git tag 为唯一发布版本来源，`v1.2.3` 会注入为 `ZEROLINK_VERSION=1.2.3`
- staging 构建固定注入 `ZEROLINK_VERSION=0.0.0-dev+<short_sha>`，用于在 `Verified Release` 卡片和 `manifest.json` 中追踪部署来源
- `packages/frontend/package.json` 的 `version` 仅作为本地/未注入环境的兜底值，不再代表正式发布版本

对于 production tag，同一个 workflow 还会发布：

- `ghcr.io/<repository-owner>/zerolink-api:latest`
- `ghcr.io/<repository-owner>/zerolink-api:<tag-version>`
- `ghcr.io/<repository-owner>/zerolink-web:latest`
- `ghcr.io/<repository-owner>/zerolink-web:<tag-version>`

这些镜像会以 `linux/amd64` 和 `linux/arm64` 多架构 manifest 的形式推送，并附带 Buildx
生成的 provenance 与 SBOM attestation。workflow 使用仓库自带的 `GITHUB_TOKEN` 和
`packages: write` 权限完成公开包发布，不需要额外新增 GHCR secret。使用发布版 self-host
Compose 文件的运维用户，应从同一个 `v*` tag 下载 Compose 文件，并把 `ZEROLINK_IMAGE_TAG`
设置为对应发布版本，以获得可复现的拉取结果。如果 workflow 运行在 fork 或组织镜像仓库里，
请在 `.env` 中设置 `ZEROLINK_IMAGE_REPOSITORY`，让 Compose 从该仓库自己的 GHCR namespace
拉取，而不是默认回落到上游地址。

### 配置步骤

1. 在 GitHub 仓库 Settings → Secrets and variables → Actions 中添加所有必要 Secrets
2. 推送 `v*` tag 触发自动部署和 GHCR 镜像发布：

```bash
git tag v1.0.0
git push origin v1.0.0
```

3. 当前工作流没有 `workflow_dispatch`，如需手动补发请重新推送对应分支或 tag
4. 在 GitHub 仓库 **Settings → Actions → General** 中开启 **Allow GitHub Actions to create and approve pull requests**
5. 使用 `RELEASE_PLEASE_TOKEN`（PAT 或 GitHub App token），不要退回到默认 `GITHUB_TOKEN`，否则 Release Please 创建的 PR / tag 默认不会继续触发后续 workflow
6. 如果 `release-please.yml` 失败并出现 `Missing RELEASE_PLEASE_TOKEN` 注解，按上一步补齐 secret 后直接重新运行该 workflow
7. 如果 GitHub 对该 workflow 标出 Node 20 deprecation warning，这是当前官方 action 的上游 runtime 告警，不是 ZeroLink 自己的脚本错误；待上游 action 升级后再 bump pin

### Release Please 提交约定

在 ZeroLink 当前的 commitlint 约束下，应使用 `feat` / `fix` 作为可发版提交类型。仓库保留 `security:` 作为合法 Conventional Commit type，但它**不会**自动触发发版。

如需让安全修复参与自动版本发布，请使用：

```text
fix(security): ...
feat(security): ...
```

不要依赖裸 `security:` 提交去触发 Release PR。

### 手动构建时覆盖发布版本

如果你在 GitHub Actions 之外手动生成**已启用验证门禁**的签名发布产物，并且希望 `manifest.json` 中的版本号与外部发布版本保持一致，可显式注入 `ZEROLINK_VERSION`：

```bash
ZEROLINK_VERSION=1.0.0 VITE_RELEASE_VERIFICATION_REQUIRED=true \
  pnpm --filter @zerolink/frontend build
ZEROLINK_VERSION=1.0.0 pnpm manifest:generate
```

未设置该环境变量时，manifest 会回退到 `packages/frontend/package.json` 中的版本号。

---

## 故障排查 / Troubleshooting

### Worker 返回 `INTERNAL_ERROR`（DO 构造函数失败）

**症状**: 所有 API 请求返回 `{"ok":false,"code":"INTERNAL_ERROR"}`，`wrangler tail` 日志显示：
```
Error: COMMIT_TOKEN_SECRET environment variable is missing or empty
  at new SecretVault (...)
```

**解决方案**: Cloudflare Dashboard 中缺少必需的 Secret。依次检查并补全：
- `COMMIT_TOKEN_SECRET`（最常见的遗漏项）
- `RP_ID`
- `RP_ORIGIN`

```bash
cd packages/backend

# 查看 production 当前已配置的 secrets
npx wrangler secret list --name zerolink-api

# 查看 staging 当前已配置的 secrets
npx wrangler secret list --name zerolink-api-staging

# 补充缺失的 production secret（以 COMMIT_TOKEN_SECRET 为例）
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" | \
  npx wrangler secret put COMMIT_TOKEN_SECRET

# 补充缺失的 staging secret
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" | \
  npx wrangler secret put COMMIT_TOKEN_SECRET --name zerolink-api-staging
```

> 这三个变量在 Worker 启动时会被校验，任何一个缺失都会导致 Durable Object 构造失败，所有请求均返回 500。

---

### WebAuthn 认证失败

**症状**: 无法创建或验证 passkey

**解决方案**:
- 确认 `RP_ID` 与访问域名完全匹配（不含 `https://`）
- 确认 `RP_ORIGIN` 与浏览器访问的 Origin 完全匹配（含 `https://`）
- WebAuthn 不支持 `localhost` 以外的非 HTTPS 域名

### Durable Object 迁移失败

**症状**: Worker 返回 500 错误，日志显示 DO 相关错误

**解决方案**:
```bash
cd packages/backend

# 查看 production 日志
npx wrangler tail --env=""

# 查看 staging 日志
npx wrangler tail --env staging

# 确认 wrangler.toml 中的 migrations 配置正确
cat wrangler.toml
```

### 构建失败

```bash
# 清理缓存重新构建
rm -rf packages/*/dist
pnpm install --frozen-lockfile
pnpm build
```

### 静态资源 404

**症状**: 前端页面加载但 JS/CSS 等资源返回 404

**解决方案**:
- 确认 `packages/frontend/dist/` 目录存在且包含构建产物（先运行 `pnpm --filter @zerolink/frontend build`）
- 确认 `wrangler.toml` 中 `[assets] directory = "../frontend/dist"` 路径相对于 `packages/backend/` 正确
- `wrangler deploy` 需要在前端构建完成后执行

---

## 相关文档 / Related Docs

- [快速启动指南](./QUICK_START.zh.md) - 本地开发环境配置
- [技术栈规范](./TECH_STACK.zh.md) - 完整技术栈说明
- [架构概览](./ARCHITECTURE.zh.md) - 系统设计
- [安全模型](./SECURITY.zh.md) - 威胁模型与安全保证

---

**最后更新 / Last Updated**: 2026-03-17
