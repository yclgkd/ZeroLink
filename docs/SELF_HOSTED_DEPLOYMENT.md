> **Language**: English | [中文](./SELF_HOSTED_DEPLOYMENT.zh.md)

# Self-Hosted Deployment Guide

This guide runs the published ZeroLink self-hosted stack from GitHub Container Registry (GHCR), with an opt-in local build override for developers who prefer compiling from source.

## What This Stack Includes

- `web`: Caddy serving the built frontend and reverse-proxying `/api/*`
- `api`: Go self-hosted API
- `db`: PostgreSQL
- `garage` *(optional, via `--profile storage`)*: S3-compatible object store for encrypted multipart file chunks
- `migrate`: one-shot migration job

## Realtime Behavior

- `/api/ws/:uuid` is implemented for single-node self-host runs
- The frontend still keeps its existing `/api/public/:uuid` polling fallback
- Horizontal scaling is intentionally out of scope for this package; there is no Redis/shared pub-sub layer yet

## Start The Stack

Choose a released ZeroLink version first so the downloaded Compose file and pulled images stay in sync:

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

The bundled `.env.example` defaults to `SELFHOST_API_FILE_STORAGE_BACKEND=s3`, which enables
multipart file delivery up to `512 MiB` with `4 MiB` encrypted chunks via the bundled Garage
container (started by the `storage` profile).

It also includes a development placeholder for `SELFHOST_API_COMMIT_TOKEN_SECRET`, which the
self-hosted API requires for commit-cookie binding and signed file upload/download tokens. Replace
that placeholder before exposing the stack to any non-local environment.

The default Compose file pulls these public images:

- `${ZEROLINK_IMAGE_REPOSITORY:-ghcr.io/yclgkd}/zerolink-api:${ZEROLINK_IMAGE_TAG:-latest}`
- `${ZEROLINK_IMAGE_REPOSITORY:-ghcr.io/yclgkd}/zerolink-web:${ZEROLINK_IMAGE_TAG:-latest}`

Set `ZEROLINK_IMAGE_TAG` in `.env` to pin a specific release instead of following `latest`, and set
`ZEROLINK_IMAGE_REPOSITORY` when consuming images published from a fork or org mirror.

## Local Build Override

If you want to build the images from the current source checkout instead of pulling GHCR artifacts:

```bash
git clone https://github.com/yclgkd/zerolink.git
cd zerolink/deploy/selfhost
cp .env.example .env
docker compose --profile storage -f docker-compose.yml -f docker-compose.build.yml up --build
```

`docker-compose.build.yml` restores the original local `build:` definitions for `migrate`, `api`,
and `web`, while keeping the default image-based stack unchanged for ordinary operators. The local
`web` override still rebuilds the frontend from source via `deploy/selfhost/frontend.build.Dockerfile`,
while published GHCR release images package the frontend `dist` produced earlier in CI via a
minimal self-host web build context.

Then open:

- App: `http://localhost:8080`
- Readiness: `http://localhost:8080/readyz`

## Environment Notes

- `SELFHOST_API_RP_ID=localhost`
- `SELFHOST_API_RP_ORIGIN=http://localhost:8080`
- `SELFHOST_NETWORK_SUBNET=172.30.0.0/24` controls the private Compose network subnet, and `SELFHOST_WEB_IP=172.30.0.2` controls the Caddy web container address. If the subnet overlaps an existing Docker or VPN network, choose another private subnet and update both values.
- `SELFHOST_API_TRUSTED_PROXY_CIDRS=172.30.0.2/32` trusts forwarded client IP and HTTPS headers only from Caddy. Keep this CIDR synchronized with `SELFHOST_WEB_IP`; otherwise forwarded client identity and secure-cookie detection will not work through the bundled proxy.
- `SELFHOST_API_COMMIT_TOKEN_SECRET` is required for commit-cookie binding and signed file upload/download tokens; generate a fresh 32-byte hex value with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` before any non-local deployment
- `ZEROLINK_IMAGE_REPOSITORY=ghcr.io/yclgkd` selects which GHCR namespace `migrate`, `api`, and `web` pull from
- `ZEROLINK_IMAGE_TAG=latest` selects the published image tag used by `migrate`, `api`, and `web`
- `SELFHOST_API_DATABASE_URL` already targets the Compose `db` service by default
- `SELFHOST_API_FILE_STORAGE_BACKEND=s3` enables multipart file delivery; when `SELFHOST_API_S3_PUBLIC_ENDPOINT` is set the browser uploads/downloads directly via S3 presigned URLs, otherwise the API proxies chunk bytes
- `SELFHOST_API_FILE_MAX_BYTES=536870912` sets the overall file ceiling, while `SELFHOST_API_FILE_MULTIPART_THRESHOLD_BYTES=2080760` remains capped by the historical inline envelope limit because the field is still part of the shared file-policy contract
- `SELFHOST_API_S3_*` configures the S3-compatible storage connection; when using the bundled Garage container, these already point at `garage:3900` and the default `zerolink-files` bucket

If you change the exposed hostname, update both `SELFHOST_API_RP_ID` and
`SELFHOST_API_RP_ORIGIN` before relying on WebAuthn flows. `SELFHOST_API_RP_ID` must be the
exact public hostname users see in the browser, without protocol or port.

WebAuthn requires `https://` on non-`localhost` origins. Plain `http://` works only for local
development on `localhost`.

## Storage Configuration

The self-hosted stack supports three storage modes:

- **`s3` + built-in Garage** (default): the bundled `.env.example` uses this mode with `docker compose --profile storage up -d`.
- **`s3` + external provider**: configure `SELFHOST_API_S3_*` to point at AWS S3, Cloudflare R2, Aliyun OSS, etc. Run `docker compose up -d` without the `storage` profile.
- **`inline`**: text-only mode, no object storage needed; new file uploads are unavailable.

### 1. Default Local Garage
The quickstart command above starts Garage automatically. If you are already running with the default setup:

```bash
docker compose --profile storage up -d
```

- **Credentials**: See `.env.example` for the Garage access key and secret key. **Change these before exposing the service**.
- **Application secret**: Set `SELFHOST_API_COMMIT_TOKEN_SECRET` to a fresh random 32-byte hex value before any non-local deployment.
- **Data Location**: Encrypted file parts reside in the `garage-data` volume on the host. Back up this volume along with `postgres-data` to preserve your state.
- Garage is optional. If you use an external S3 provider, just run `docker compose up -d` without the `storage` profile.

### 2. External S3-Compatible Cloud Storage
You can skip the Garage container entirely and connect the ZeroLink API directly to any S3-compatible object storage (e.g., AWS S3, Cloudflare R2, Aliyun OSS, Tencent COS) without code changes.

Set `SELFHOST_API_FILE_STORAGE_BACKEND=s3` and update the following variables in your `.env` file:
```env
SELFHOST_API_S3_ENDPOINT=s3.us-east-1.amazonaws.com
SELFHOST_API_S3_ACCESS_KEY=your_access_key
SELFHOST_API_S3_SECRET_KEY=your_secret_key
SELFHOST_API_S3_BUCKET=zerolink-files
SELFHOST_API_S3_USE_SSL=true
SELFHOST_API_S3_REGION=us-east-1
```
*Note: When using external storage, simply run `docker compose up -d` without `--profile storage`. The Garage container will not start, saving local resources.*

### 3. Text-Only `inline` Mode (Files Disabled)
If you do not want to run an object storage server at all (for example, on a Raspberry Pi), you can switch the API to `inline` storage backend mode. This does **not** restore legacy inline file storage; it disables new file uploads while keeping text shares available.

Set these variables in your `.env`:
```env
SELFHOST_API_FILE_STORAGE_BACKEND=inline
SELFHOST_API_FILE_MULTIPART_SUPPORTED=false  # Defaults to false for inline; explicit here in case your .env inherits true from .env.example
SELFHOST_API_FILE_MAX_BYTES=2080760
SELFHOST_API_FILE_MULTIPART_THRESHOLD_BYTES=2080760
```
When in `inline` mode:
- No object storage is needed.
- `multipartSupported` stays `false`, so new file uploads are rejected with `FILE_STORAGE_UNAVAILABLE`.
- Text payloads continue to use inline `cipherBundle` delivery stored in PostgreSQL-backed channel state.
- `SELFHOST_API_FILE_MAX_BYTES` and `SELFHOST_API_FILE_MULTIPART_THRESHOLD_BYTES` must still stay within the historical inline envelope limit because those fields remain part of the shared file-policy/config contract.

## Smoke Test

1. Start the stack with `docker compose --profile storage up -d` when using the bundled `.env.example`, or `docker compose up -d` only after switching `.env` to external S3 or `inline`.
2. Confirm `curl http://localhost:8080/readyz` returns `200`.
3. Confirm `curl http://localhost:8080/api/file_policy` reports `multipartSupported: true` when running with `SELFHOST_API_FILE_STORAGE_BACKEND=s3`.
4. Open `http://localhost:8080` in one browser window and create a Quick Share channel.
5. Open the generated share link in a second window or incognito session and complete lock.
6. Confirm the sender manage page auto-updates to `locked` without a manual refresh.
7. Deliver a secret from the manage page.
8. Confirm the receiver share page auto-updates to `delivered` and shows the decrypt panel.
9. Optional: deliver a file and confirm the receiver can still decrypt/download it; using a file larger than the configured chunk size (default `4 MiB`) exercises multi-chunk upload/download.

If WebSocket delivery is interrupted, the frontend will fall back to `/api/public/:uuid` polling automatically.

## Operational Notes

- Production tag releases package the same CI-built frontend `dist` that passed manifest generate/sign/verify, so published `zerolink-web` images now include the signed `Verified Release` bootstrap gate by default.
- The local source-build override still uses the default frontend build path from `deploy/selfhost/frontend.build.Dockerfile`; it does not enable the signed bootstrap gate unless you explicitly reproduce the signed release build flow.
- Production tag releases publish the GHCR images with multi-arch `linux/amd64` + `linux/arm64` manifests and Buildx provenance/SBOM attestations, so operators can trace a pulled image back to the release commit and GitHub Actions run.
- The realtime hub is process-local. Running multiple API replicas behind the same proxy will require a shared pub/sub layer.
- Compose stores PostgreSQL data in the `postgres-data` volume.
- When using the `storage` profile, Compose stores Garage object data in the `garage-data` volume.
- All new `payloadKind=file` deliveries use object storage via `/api/file/initiate`, `/api/file/complete`, and `fileRef` metadata. When `S3_PUBLIC_ENDPOINT` is set, chunk bytes go directly to S3 presigned URLs; when unset (e.g., Docker-internal Garage), chunk bytes are proxied through the API. `SELFHOST_API_FILE_MULTIPART_THRESHOLD_BYTES` remains a policy/config compatibility field; it no longer switches small files onto an inline file path. Only text payloads use inline `cipherBundle`.
- The API server does not set a global HTTP write timeout so that WebSocket connections are not killed mid-session. Per-write deadlines are enforced inside the realtime hub. If you add a Caddy `timeouts` block, do not set `write_timeout` — it will terminate long-lived WebSocket sessions through the reverse proxy.

## Stop The Stack

```bash
docker compose down
```

To remove local database state too:

```bash
docker compose down -v
```

`docker compose down -v` removes **both** named volumes in the default stack: `postgres-data` and
`garage-data`. That deletes database state and any encrypted multipart file chunks stored in Garage.
