> **Language**: English | [中文](./QUICK_START.zh.md)

# Quick Start

## Prerequisites

- Node.js >=22.22.0
- pnpm >= 9

## Local Development

```bash
# Install dependencies
pnpm install

# Start all packages (frontend + backend in parallel)
pnpm dev
```

- Frontend (Vite): http://localhost:5173
- Backend (Wrangler): http://localhost:8787

### Starting Individually

```bash
pnpm --filter frontend dev
pnpm --filter backend dev
```

## Common Commands

```bash
pnpm test          # Run all tests
pnpm typecheck     # Type checking
pnpm lint          # Code linting
pnpm build         # Build all packages
```

## Deployment

See [DEPLOYMENT.md](./DEPLOYMENT.md).
