<!-- synced-with: 940a85a -->

> **语言**: [English](./QUICK_START.md) | 中文

# 快速启动

## 前置要求

- Node.js >=22.22.0
- pnpm >= 9

## 本地开发

```bash
# 安装依赖
pnpm install

# 启动所有包（前端 + 后端并行）
pnpm dev
```

- Frontend (Vite): http://localhost:5173
- Backend (Wrangler): http://localhost:8787

### 单独启动

```bash
pnpm --filter frontend dev
pnpm --filter backend dev
```

## 常用命令

```bash
pnpm test          # 运行所有测试
pnpm typecheck     # 类型检查
pnpm lint          # 代码检查
pnpm build         # 构建所有包
```

## 部署

见 [DEPLOYMENT.zh.md](./DEPLOYMENT.zh.md)。
