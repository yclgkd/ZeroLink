# Self-Hosted API

This module contains the Go-based self-hosted backend for ZeroLink.

## Current Scope

- Environment-based config loading with validation
- Structured JSON logging
- `GET /healthz` and `GET /readyz`
- PostgreSQL persistence for channels, challenges, used nonces, and terminal tombstones
- Implemented `create_*`, `lock_*`, `compound_*`, `delete_commit`, `public_status`, and `decrypt_fetch`
- Native WebAuthn attestation + assertion verification
- `/api/ws/:uuid` channel sync compatibility for single-node self-host deployments
- Docker Compose + Caddy packaging under [`deploy/selfhost/`](../../deploy/selfhost/)

## Realtime Model

- WebSocket endpoint: `/api/ws/:uuid`
- Frontend behavior stays unchanged: WebSocket first, `/api/public/:uuid` polling fallback second
- Self-host realtime fan-out is in-memory and single-node
- Redis or another shared pub/sub layer is intentionally out of scope until scale-out is required

## Local Service Development

For the raw Go service flow:

```bash
cd services/selfhost-api
cp .env.example .env
# edit SELFHOST_API_DATABASE_URL / RP_ORIGIN if needed
```

Then run PostgreSQL, migrations, and the API:

```bash
docker run --name zerolink-selfhost-postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=local-dev-postgres-password \
  -e POSTGRES_DB=zerolink_selfhost \
  -p 5432:5432 \
  -d postgres:16-alpine

set -a
. ./.env
set +a

go run ./cmd/selfhost-migrate

go run ./cmd/selfhost-api
```

Use `SELFHOST_API_RP_ORIGIN=http://localhost:5173` when the frontend is served by local Vite preview/dev with `/api` proxying to the Go service.

## Local Self-Hosted Stack

For the packaged self-host stack, see [docs/SELF_HOSTED_DEPLOYMENT.md](../../docs/SELF_HOSTED_DEPLOYMENT.md).

That path runs:

- PostgreSQL
- Go self-host API
- Frontend static bundle
- Caddy reverse proxy on `http://localhost:8080`

## Validation

Without a local Go toolchain:

```bash
cd services/selfhost-api
docker run --rm \
  -v "$PWD:/app" \
  -w /app \
  golang:1.25 \
  /bin/bash -lc '/usr/local/go/bin/go test ./...'
```

With Docker Compose packaging:

```bash
cd ../..
cp deploy/selfhost/.env.example deploy/selfhost/.env
docker compose --profile storage \
  -f deploy/selfhost/docker-compose.yml \
  -f deploy/selfhost/docker-compose.build.yml \
  up --build
```
