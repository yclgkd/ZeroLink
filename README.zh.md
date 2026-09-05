<!-- synced-with: 74da277 -->

> **语言**: [English](./README.md) | 中文

# ZeroLink

> 零知识安全传递工具：无账号、端到端加密、发送方管理但服务器无法解密。
> 可安全传递密码、API 令牌、恢复码、私密消息或任何敏感内容，无需创建账号。

**🌟 在线演示 (Live Demo)**：[zerolink.dev](https://zerolink.dev)

## 概述

ZeroLink 是一款安全优先的秘密分享工具，具有以下特点：

- **零知识架构**：服务器不存明文与任何私钥
- **端到端加密**：只有接收方可解密内容
- **双模式创建**：Quick Share（密码）/ Secure Share（Passkey）
- **WebAuthn 管理**：Secure Share 使用系统/硬件密钥管理权（不可导出）
- **TOFU 防护**：URL Fragment + Lock Challenge 防止抢占锁定
- **密文长度保护**：Padding 降低长度泄露精度
- **当前产品模式**：仅保留 Quick Share / Secure Share 两种模式

## 核心流程

```
1. Sender → Create (Quick Share 密码模式 / Secure Share Passkey 模式)
          → 分享链接: /s/:uuid#k=<lock_secret>[&af=<sender_auth_fpr>]

2. Receiver → Lock (输入密码 → 生成 RSA keypair → 本地存储)
            → 展示 Safety Code (Emoji/Color)

3. Sender → 核对 Safety Code (带外)
          → Deliver (混合加密 + Padding → 投递密文)

4. Receiver → 输入密码 → 解密查看
```

## 文档

### 快速开始
- [快速启动指南](./docs/QUICK_START.zh.md) - 从零到运行开发环境
- [部署指南](./docs/DEPLOYMENT.zh.md) - 手动部署到 Cloudflare Workers
- [自部署部署指南](./docs/SELF_HOSTED_DEPLOYMENT.zh.md) - 使用发布的 Docker Compose 栈或本地 build override
- [技术栈规范](./docs/TECH_STACK.zh.md) - 完整技术栈与工具链

### 设计文档
- [完整 PRD v3.0](./docs/PRD.zh.md) - 产品需求文档
- [架构概览](./docs/ARCHITECTURE.zh.md) - 技术架构与核心协议
- [安全模型](./docs/SECURITY.zh.md) - 威胁模型与安全保证

### 导航
- [文档索引](./docs/INDEX.zh.md) - AI 助手和开发者的快速导航

## 技术栈

### 前端
- React 19 + Vite 7 + React Router
- Tailwind CSS v4 + shadcn/ui（基于 Radix primitives）
- Zustand + Zod
- Web Crypto API (AES-GCM, RSA-OAEP, SHA-256)
- WebAuthn (FIDO2)
- Argon2id (KDF)

### 后端
- Cloudflare Workers + Durable Objects（提供免费层，支持 SQLite 后端）
- 可选：通过 GHCR 预构建镜像或本地 build override 运行 Docker Compose 自部署

## 浏览器兼容性

| 浏览器 | 最低版本 | 发布时间 |
|--------|----------|----------|
| Chrome / Edge | 93+ | 2021 年 9 月 |
| Firefox | 92+ | 2021 年 9 月 |
| Safari | 15.4+ | 2022 年 3 月 |

**说明**：
- WebAuthn（硬件密钥）需要 HTTPS，本地开发使用 `localhost` 即可
- Ed25519 签名验证：Chrome 113+ / Safari 16.4+ 使用原生 WebCrypto；旧版本自动降级到纯 JS 实现（`@noble/ed25519`）
- 不提供 polyfill，不支持 Internet Explorer

## 安全特性

### v3.0 当前重点

1. **Lock Secret (URL Fragment)**: 防止预加载爬虫抢占锁定
2. **Padding (4KB 块)**: 降低密文长度泄露精度
3. **Argon2id 强制**: 接收方私钥包裹（250-500ms 目标耗时）
4. **双模式创建**: Quick Share（密码）/ Secure Share（Passkey）
5. **可验证发布链**: Signed Manifest + 运行时哈希验证

### 安全保证

- ✅ 服务器零知识
- ✅ 端到端保密
- ✅ 更新/销毁不可伪造（WebAuthn 或 ECDSA）
- ✅ 抗重放/乱序/并发覆盖（DO 原子性）
- ✅ 最小元数据泄露
- ✅ 前端完整性可验证（CSP + Signed Manifest）
- ✅ Secure Share 管理权私钥不可导出（WebAuthn）；Quick Share 管理密钥编码在管理链接中

## 部署 / Deploy

ZeroLink 目前提供两条部署路径：

- Cloudflare Workers 手动部署，见 [部署指南](./docs/DEPLOYMENT.zh.md)
- Docker Compose 自部署，见 [自部署部署指南](./docs/SELF_HOSTED_DEPLOYMENT.zh.md)

### Cloudflare 部署前提 / Cloudflare Deployment Prerequisites

- Cloudflare 账号（免费计划即可，支持 Durable Objects 免费层）
- Node.js >=22.22.0 · pnpm 9+ · Wrangler CLI 4+

完整部署文档见 [部署指南](./docs/DEPLOYMENT.zh.md)。Docker Compose 自部署不需要
Cloudflare 工具链。

### 自部署快速开始 / Self-Hosted Quick Start

请使用已发布版本号，这样下载到的 Compose 文件与拉取的镜像 tag 保持一致：

```bash
export ZEROLINK_VERSION=YOUR_RELEASE_VERSION
mkdir zerolink-selfhost
cd zerolink-selfhost
curl -fsSLO "https://raw.githubusercontent.com/yclgkd/zerolink/v${ZEROLINK_VERSION}/deploy/selfhost/docker-compose.yml"
curl -fsSLO "https://raw.githubusercontent.com/yclgkd/zerolink/v${ZEROLINK_VERSION}/deploy/selfhost/garage.toml"
curl -fsSLO "https://raw.githubusercontent.com/yclgkd/zerolink/v${ZEROLINK_VERSION}/deploy/selfhost/garage-init.sh"
curl -fsSLo .env.example "https://raw.githubusercontent.com/yclgkd/zerolink/v${ZEROLINK_VERSION}/deploy/selfhost/.env.example"
cp .env.example .env
sed -i.bak "s/^ZEROLINK_IMAGE_TAG=.*/ZEROLINK_IMAGE_TAG=${ZEROLINK_VERSION}/" .env && rm .env.bak
docker compose --profile storage up -d
```

默认栈会拉取 `${ZEROLINK_IMAGE_REPOSITORY:-ghcr.io/yclgkd}/zerolink-api` 和
`${ZEROLINK_IMAGE_REPOSITORY:-ghcr.io/yclgkd}/zerolink-web`。
如果镜像来自 fork 或组织镜像仓库，可在 `.env` 里设置 `ZEROLINK_IMAGE_REPOSITORY`；
如果要本地源码构建，请看 [自部署部署指南](./docs/SELF_HOSTED_DEPLOYMENT.zh.md)。

---

## 快速开始（本地开发）/ Quick Start (Local Dev)

```bash
git clone https://github.com/yclgkd/zerolink.git
cd zerolink
pnpm install
pnpm dev
```

## 参与贡献

欢迎贡献！提交 Pull Request 前请先阅读[贡献指南](./CONTRIBUTING.md)。

## 安全

ZeroLink 是一个安全优先的项目。如果您发现安全漏洞，**请不要提交公开 Issue**。请参阅[安全策略](./SECURITY.md)了解负责任的披露流程。

技术安全模型与威胁分析请参见[安全模型](./docs/SECURITY.zh.md)。

## License

本项目基于 GNU Affero General Public License v3.0 (AGPL-3.0) 协议开源。详情请参阅 [LICENSE](./LICENSE) 文件。
