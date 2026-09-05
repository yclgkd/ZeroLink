# Contributing to ZeroLink

Thank you for your interest in contributing to ZeroLink! This guide will help you get started.

## Prerequisites

- [Node.js](https://nodejs.org/) >=22.22.0
- [pnpm](https://pnpm.io/) 9+
- [Git](https://git-scm.com/)

## Getting Started

```bash
git clone https://github.com/yclgkd/zerolink.git
cd zerolink
pnpm install
pnpm dev
```

- Frontend: http://localhost:5173
- Backend (Cloudflare Workers dev): http://localhost:8787

## Project Structure

```
packages/
  shared/     — Types, schemas, crypto helpers (@zerolink/shared)
  frontend/   — React web app (@zerolink/frontend)
  backend/    — Cloudflare Workers + Durable Objects (@zerolink/backend)
services/
  selfhost-api/ — Go self-hosted backend
```

## Monorepo Commands

All commands run from the repository root:

```bash
pnpm dev          # Start all packages in dev mode
pnpm build        # Build all packages
pnpm test         # Run all unit/integration tests
pnpm test:e2e     # Run Playwright E2E tests
pnpm typecheck    # TypeScript type checking
pnpm lint         # Biome lint + format check
```

Filter to a specific package:

```bash
pnpm --filter @zerolink/frontend <command>
pnpm --filter @zerolink/backend <command>
pnpm --filter @zerolink/shared <command>
```

Self-hosted Go backend:

```bash
cd services/selfhost-api
make run        # Start API server
make test       # Run Go tests
make migrate    # Run DB migrations
```

## Code Style

- **Linter**: [Biome](https://biomejs.dev/) (not ESLint/Prettier)
- **Quotes**: Single quotes
- **Formatting**: Enforced by Biome — run `pnpm lint` to check
- **Pre-commit hook**: Automatically runs Biome check + TypeScript type check on staged files

Do not add ESLint, Prettier, or other formatting tool configurations.

## Branch Naming

```
<type>/<short-description>
```

- Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`, `security`, `style`, `revert`
- Use kebab-case for the description
- Examples: `feat/totp-support`, `fix/lock-race-condition`, `docs/update-readme`

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>: <description>

<optional body>
```

- Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`, `security`
- Keep the subject line under 72 characters
- Use imperative mood ("add feature" not "added feature")

## Pull Requests

1. One logical change per PR
2. Target the `main` branch
3. Fill in the PR template completely
4. All CI checks must pass (typecheck, lint, tests, build)
5. PRs with unchecked checklist items cannot be merged (enforced by CI)

## Testing

- **Unit / Integration**: [Vitest](https://vitest.dev/) — `pnpm test`
- **E2E**: [Playwright](https://playwright.dev/) — `pnpm test:e2e`

Write tests for new features and bug fixes. Maintain existing test coverage.

## Security Considerations

ZeroLink is a security-focused project. When contributing:

- Never log, store, or transmit plaintext secrets or private keys in code
- Keep key material in URL fragments, not query parameters
- Validate all inputs at system boundaries
- If you discover a security vulnerability, see [SECURITY.md](./SECURITY.md) — **do NOT open a public issue**

## License

By contributing to ZeroLink, you agree that your contributions will be licensed under the [GNU Affero General Public License v3.0 (AGPL-3.0)](./LICENSE).
