> **Language**: English | [中文](./DEPLOYMENT.zh.md)

# ZeroLink Deployment Guide

For Docker Compose self-hosting, see [SELF_HOSTED_DEPLOYMENT.md](./SELF_HOSTED_DEPLOYMENT.md).

> This document covers the complete steps to deploy ZeroLink to Cloudflare.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Architecture Overview](#architecture-overview)
3. [Manual Deploy](#manual-deploy)
4. [Environment Variables](#environment-variables)
5. [Manifest Signing (Optional)](#manifest-signing-optional)
6. [Custom Domain](#custom-domain)
7. [CI/CD Automated Deployment](#cicd-automated-deployment)
8. [Troubleshooting](#troubleshooting)

---

## Prerequisites

| Requirement | Description | Minimum Version |
|-------------|-------------|-----------------|
| Cloudflare Account | Free plan is sufficient (supports Durable Objects free tier) | — |
| Node.js | JavaScript runtime | >=22.22.0 |
| pnpm | Package manager | 9.x |
| Wrangler CLI | Official Cloudflare deployment tool | 4.x |

> **Important**: Durable Objects now offer a **Free Tier**. This project uses the **SQLite backend**, which is supported on the free plan (100k daily requests).

Install Wrangler CLI:
```bash
npm install -g wrangler
```

---

## Architecture Overview

```
User Browser               Cloudflare Edge
────────────               ──────────────────────────────────
Frontend SPA    ──→        Worker (zerolink-api)
  + API requests                     │  ├─ run_worker_first = true
                                     │  ├─ Injects security response headers
                                     │  ├─ /api/* → Business logic + multipart coordination
                                     │  └─ Other paths → Workers Assets (static files)
                                     │
                                     │
                              Durable Object
                               (SecretVault)
                         [State machine / SQLite]
                                     │
                                     ▼
                              R2 FILE_BUCKET
                         (encrypted file chunks)
```

- **Cloudflare Worker**: Handles all requests (API + static files) and injects security response headers
- **Workers Assets**: Built-in static asset hosting within the Worker; static asset requests are free and unlimited
- **Durable Object**: Atomic state machine for each Secret (SQLite backend); stores inline ciphertext or typed multipart `fileRef` metadata
- **R2 FILE_BUCKET**: Stores encrypted multipart chunks for large file delivery; the Worker serves `/api/file/*` coordination routes around it

> **Architecture Note**: This project uses the **Workers Assets unified deployment** model, not
> Cloudflare Pages. Frontend build artifacts are deployed alongside the Worker via the `[assets]`
> binding in `wrangler.toml`. Security response headers are injected uniformly by the Worker code,
> eliminating the need for `_headers` / `_redirects` files.

---

## Manual Deploy

### Step 1: Clone the repository and install dependencies

```bash
git clone https://github.com/yclgkd/zerolink.git
cd zerolink
pnpm install --frozen-lockfile
```

### Step 2: Log in to Wrangler

```bash
npx wrangler login
```

### Step 3: Create the R2 bucket binding targets

Create the bucket(s) referenced by `packages/backend/wrangler.toml` before the first deploy.

```bash
# Production
npx wrangler r2 bucket create zerolink-files

# Staging (create this too if you deploy staging)
npx wrangler r2 bucket create zerolink-files-staging
```

`wrangler deploy` will fail if the configured bucket names do not already exist.

### Step 4: Choose the final access origin before setting secrets

Before you run `pnpm setup`, decide whether ZeroLink will be served from a custom domain or from a
`*.workers.dev` hostname. `RP_ID` and `RP_ORIGIN` must exactly match the final browser origin.

#### Option A: Custom domain

Replace the example `zerolink.dev` routes in `packages/backend/wrangler.toml` with your own domain
before deployment. If you also deploy staging, update the `[env.staging].routes` entries too.

```toml
routes = [
  { pattern = "example.com", zone_name = "example.com" },
  { pattern = "example.com/*", zone_name = "example.com" },
]
```

#### Option B: `*.workers.dev`

If you want to deploy without a custom domain, remove the `routes` block for the environment you
are deploying. Cloudflare will then serve the Worker from its default `*.workers.dev` hostname.

- `RP_ID` must be the final `worker-name.<your-workers-subdomain>.workers.dev` hostname.
- `RP_ORIGIN` must be the full `https://worker-name.<your-workers-subdomain>.workers.dev` origin.
- If you do not know that hostname yet, deploy once without routes, note the generated
  `*.workers.dev` URL, then rerun `pnpm setup` and deploy again.

### Step 5: Run the setup script

```bash
pnpm setup
```

The script interactively performs the following:
- Automatically generates and sets `COMMIT_TOKEN_SECRET`
- Prompts for `RP_ID` and `RP_ORIGIN`, setting them as Worker Secrets
- Lets you choose `production`, `staging`, or `both`

Enter the exact values from Step 4. If the deployed origin changes later, rerun `pnpm setup` and
update the secrets before relying on WebAuthn.

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

### Step 6: Build the frontend

```bash
pnpm --filter @zerolink/frontend build
# Build output is in packages/frontend/dist/
```

The default `pnpm build` output is a runnable but **unverified** frontend shell. It does not enable
the fail-closed `Verified Release` startup gate, making it suitable for local preview and unsigned
manual deployments.

### Step 7: Deploy

Choose the command for the environment you actually want to deploy:

```bash
cd packages/backend

# Production (top-level environment)
npx wrangler deploy --env=""

# Staging
npx wrangler deploy --env staging
```

A single command deploys both the Worker code and frontend static assets.

> **WebAuthn Note**:
> - `RP_ID` = your final hostname without protocol, e.g. `example.com`
> - `RP_ORIGIN` = your full final origin, e.g. `https://example.com`
> - If using `*.workers.dev`, set both values from the final
>   `worker-name.<your-workers-subdomain>.workers.dev` hostname
> - These two values must exactly match the actual access domain, otherwise WebAuthn authentication will fail

### Step 8: Verify deployment

```bash
cd packages/backend

# Production logs
npx wrangler tail --env=""

# Staging logs
npx wrangler tail --env staging

# Verify the Worker is reachable (replace with your actual origin)
curl -s https://<your-origin>/api/public/00000000-0000-0000-0000-000000000000 | head -c 200

# Verify file policy and multipart support
curl -s https://<your-origin>/api/file_policy
```

For the default Worker config, `/api/file_policy` should report `"multipartSupported": true`.

---

## Environment Variables

### Worker Runtime Variables (configured in Cloudflare Dashboard)

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `RP_ID` | Yes | WebAuthn Relying Party ID (domain, without protocol) | `zerolink.dev` |
| `RP_ORIGIN` | Yes | WebAuthn Origin (full URL) | `https://zerolink.dev` |
| `COMMIT_TOKEN_SECRET` | Yes | HMAC key for commit-cookie binding and multipart upload-session signing (random 32-byte hex) | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |

### Cloudflare Bindings (declared in `wrangler.toml`)

| Binding | Type | Description |
|---------|------|-------------|
| `SECRET_VAULT` | Durable Object | Channel lifecycle state machine |
| `ASSETS` | Workers Assets | Frontend static files |
| `FILE_BUCKET` | R2 bucket | Encrypted multipart file chunks |

`FILE_MULTIPART_SUPPORTED=true` is already enabled in `[vars]` for both production and staging in
`packages/backend/wrangler.toml`.

### CI/CD Secrets (GitHub Actions)

| Secret Name | Description |
|-------------|-------------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token with deploy access to Workers routes and the target R2 buckets |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID |
| `MANIFEST_SIGNING_KEY` | Ed25519 private key in PEM text form for manifest signing |
| `RELEASE_PLEASE_TOKEN` | GitHub PAT or GitHub App token, used to create Release PRs, tags, and GitHub Releases, and to ensure subsequent workflows are triggered correctly; if missing, the release-please workflow will fail at the pre-check step with a configuration hint |

### Creating a Cloudflare API Token

1. Log in to the [Cloudflare Dashboard](https://dash.cloudflare.com)
2. Go to **My Profile > API Tokens > Create Token**
3. Create a token that can deploy the Worker and access the target R2 bucket bindings
4. Copy the Token and save it to GitHub Secrets

For GitHub Actions deploys, ZeroLink expects a token equivalent to these permissions:
- Account: `Workers Scripts (edit)` and `Workers R2 Storage (edit)`
- Zone: `Workers Routes (edit)` for the deployment zone
- User token note: Cloudflare's Workers Builds docs also include `Account Settings (read)`, `User Details (read)`, and `Memberships (read)` on the automatically generated user token

ZeroLink's deploy preflight treats those write scopes as the source of truth. If the token can inspect itself through Cloudflare's token APIs, the workflow proves the scopes before the frontend build starts. If the token cannot call those introspection endpoints, the workflow degrades to best-effort Workers/Routes reachability checks plus a non-destructive R2 write probe, and logs a warning instead of blocking the deploy step up front.

The preflight reads the active environment's `routes` and `r2_buckets` directly from
`packages/backend/wrangler.toml`. If you rename the deployment zone or bucket bindings there, the
preflight follows those values automatically instead of assuming `zerolink.dev`.

If you use an account-owned token instead of a user token, grant the equivalent account and zone permissions above.

---

## Manifest Signing (Optional)

ZeroLink supports Ed25519 signing of frontend build artifacts for users to verify integrity. Only
builds that explicitly enable `VITE_RELEASE_VERIFICATION_REQUIRED=true` and also publish signed
artifacts will activate the fail-closed `Verified Release` startup check in the browser.

### Generate Key Pair

```bash
# Generate Ed25519 key using OpenSSL
openssl genpkey -algorithm ed25519 -out keys/manifest-signing.pem
openssl pkey -in keys/manifest-signing.pem -pubout -out keys/manifest-signing.pub

# Save the PEM text content directly as the GitHub Secret MANIFEST_SIGNING_KEY
cat keys/manifest-signing.pem
```

> The private key (`.pem`) is excluded in `.gitignore`. **Never commit it to git**.

### Local Signing Flow

```bash
# Build
VITE_RELEASE_VERIFICATION_REQUIRED=true pnpm --filter @zerolink/frontend build

# Generate manifest (records `entryAssetPath` and hashes only the stable runtime
# assets under `dist/assets/`; root-level files like `index.html` and `robots.txt`
# are not included in the signed set)
pnpm manifest:generate

# Sign manifest
MANIFEST_SIGNING_KEY="$(cat keys/manifest-signing.pem)" \
  pnpm manifest:sign

# Verify signature
pnpm manifest:verify
```

The caching strategy is controlled uniformly by the Worker code: SPA entry requests return
`Cache-Control: no-store`, while hashed `/assets/*` files use long-term immutable caching
(`public, max-age=31536000, immutable`). The signed manifest covers only the stable runtime
artifacts under `dist/assets/`, not root-level files like `index.html`. The generated
`manifest.json` records the entry bundle that should be executed (`entryAssetPath`); the
browser-side bootstrap verifies that the currently running entry asset matches the manifest. If
there is a mismatch, it first triggers a controlled refresh; if the mismatch persists, it
fail-closes and blocks execution.

---

## Custom Domain

If you are using a custom domain, configure routes in `wrangler.toml` so the Worker handles all
requests (API + static assets) for your domain. Replace the example domain below with your actual
zone:

```toml
routes = [
  { pattern = "example.com", zone_name = "example.com" },
  { pattern = "example.com/*", zone_name = "example.com" },
]
```

If you are using `*.workers.dev`, skip this section and leave the relevant `routes` block removed.

Or via the Cloudflare Dashboard: **Workers > <your-worker-name> > Settings > Domains & Routes > Add**

> **Note**: Two separate route entries are used — one for the bare root (`example.com`) and one for
> all sub-paths (`example.com/*`) — to ensure the root path `/` is matched correctly.

---

## CI/CD Automated Deployment

The project includes a standalone deployment workflow `.github/workflows/deploy.yml` that supports:
- Automatic staging deployment on `push` to `main` when workflow trigger conditions are met
- Automatic production deployment on `v*` tag push when workflow trigger conditions are met
- Automatic GHCR publication of self-hosted `zerolink-api` and `zerolink-web` images on `v*` tag push

Workflow execution order: `install > preflight cloudflare > build frontend > generate manifest > sign manifest > verify manifest > publish ghcr images (tag only) > wrangler deploy`

Before the frontend build starts, the workflow runs `pnpm deploy:preflight`. The script reads the
current environment's `routes` and `r2_buckets` from `packages/backend/wrangler.toml`, so renamed
zones or custom bucket names are validated without extra script edits. When Cloudflare allows token
introspection, the preflight verifies the current token is active, checks that it effectively
grants `Workers Scripts Write`, `Workers Routes Write` (only when routes are configured), and
`Workers R2 Storage Write`, and then confirms the required environment-specific R2 bucket exists.
Some account-owned deploy tokens cannot inspect their own policy details; in that case, the
preflight falls back to best-effort Workers/Routes reachability checks, an invalid-request R2 write
probe, and bucket existence, logs a warning, and leaves final route/script write-scope enforcement
to `wrangler deploy`.

A separate `.github/workflows/release-please.yml` workflow is responsible for generating or updating Release PRs on `main`. This workflow first pre-checks `RELEASE_PLEASE_TOKEN`, then runs the commit-pinned official `release-please` action. The current upstream action still declares `runs: node20`, so GitHub may show a Node 20 deprecation warning; ZeroLink does not work around this warning by installing npm packages at runtime, and will update the pin once the upstream action upgrades. After merging a Release PR, Release Please will:
- Update `version.txt` in the root directory
- Maintain the root `CHANGELOG.md`
- Create a new `v*` tag and GitHub Release
- Trigger the existing production deploy workflow via that tag, which also publishes the self-hosted GHCR images

Version source conventions:
- Production builds use the git tag as the sole release version source; `v1.2.3` is injected as `ZEROLINK_VERSION=1.2.3`
- Staging builds always inject `ZEROLINK_VERSION=0.0.0-dev+<short_sha>`, used to track deployment origin in the `Verified Release` card and `manifest.json`
- The `version` field in `packages/frontend/package.json` serves only as a fallback for local/un-injected environments and no longer represents the official release version

On production tags, the same workflow also publishes:

- `ghcr.io/<repository-owner>/zerolink-api:latest`
- `ghcr.io/<repository-owner>/zerolink-api:<tag-version>`
- `ghcr.io/<repository-owner>/zerolink-web:latest`
- `ghcr.io/<repository-owner>/zerolink-web:<tag-version>`

These images are pushed as multi-arch manifests for `linux/amd64` and `linux/arm64`, and Buildx
attaches provenance plus SBOM attestations. The workflow uses the repository `GITHUB_TOKEN` with
`packages: write`, so no additional GHCR secret is required for public package publishing. Operators
using the published self-host Compose files should download them from the same `v*` tag and set
`ZEROLINK_IMAGE_TAG` to that release version for reproducible pulls. If the workflow runs from a fork
or org mirror, set `ZEROLINK_IMAGE_REPOSITORY` in `.env` so Compose pulls from that repository's GHCR
namespace instead of the upstream default.

### Configuration Steps

1. Add all required Secrets in the GitHub repository under Settings > Secrets and variables > Actions
2. Push a `v*` tag to trigger automatic deployment and GHCR image publication:

```bash
git tag v1.0.0
git push origin v1.0.0
```

3. The current workflow does not have `workflow_dispatch`; to manually re-trigger, push the corresponding branch or tag again
4. In the GitHub repository under **Settings > Actions > General**, enable **Allow GitHub Actions to create and approve pull requests**
5. Use `RELEASE_PLEASE_TOKEN` (PAT or GitHub App token); do not fall back to the default `GITHUB_TOKEN`, otherwise PRs/tags created by Release Please will not trigger subsequent workflows by default
6. If `release-please.yml` fails with a `Missing RELEASE_PLEASE_TOKEN` annotation, add the secret as described above and re-run the workflow
7. If GitHub shows a Node 20 deprecation warning for this workflow, it is an upstream runtime warning from the official action, not a ZeroLink script error; the pin will be updated after the upstream action upgrades

### Release Please Commit Conventions

Under ZeroLink's current commitlint constraints, use `feat` / `fix` as releasable commit types. The repository reserves `security:` as a valid Conventional Commit type, but it **will not** automatically trigger a release.

To include security fixes in automatic version releases, use:

```text
fix(security): ...
feat(security): ...
```

Do not rely on bare `security:` commits to trigger a Release PR.

### Overriding the Release Version in Manual Builds

If you are manually generating signed release artifacts **with the verification gate enabled** outside of GitHub Actions, and want the version number in `manifest.json` to match an external release version, you can explicitly inject `ZEROLINK_VERSION`:

```bash
ZEROLINK_VERSION=1.0.0 VITE_RELEASE_VERIFICATION_REQUIRED=true \
  pnpm --filter @zerolink/frontend build
ZEROLINK_VERSION=1.0.0 pnpm manifest:generate
```

When this environment variable is not set, the manifest falls back to the version in `packages/frontend/package.json`.

---

## Troubleshooting

### Worker Returns `INTERNAL_ERROR` (DO Constructor Failure)

**Symptom**: All API requests return `{"ok":false,"code":"INTERNAL_ERROR"}`, and `wrangler tail` logs show:
```
Error: COMMIT_TOKEN_SECRET environment variable is missing or empty
  at new SecretVault (...)
```

**Solution**: Required Secrets are missing from the Cloudflare Dashboard. Check and add the following:
- `COMMIT_TOKEN_SECRET` (most commonly missed)
- `RP_ID`
- `RP_ORIGIN`

```bash
cd packages/backend

# View currently configured secrets for production
npx wrangler secret list --name zerolink-api

# View currently configured secrets for staging
npx wrangler secret list --name zerolink-api-staging

# Add a missing production secret (using COMMIT_TOKEN_SECRET as an example)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" | \
  npx wrangler secret put COMMIT_TOKEN_SECRET

# Add a missing staging secret
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" | \
  npx wrangler secret put COMMIT_TOKEN_SECRET --name zerolink-api-staging
```

> These three variables are validated at Worker startup; if any one is missing, the Durable Object constructor will fail and all requests will return 500.

---

### WebAuthn Authentication Failure

**Symptom**: Unable to create or verify passkeys

**Solution**:
- Verify that `RP_ID` exactly matches the access domain (without `https://`)
- Verify that `RP_ORIGIN` exactly matches the browser's Origin (including `https://`)
- WebAuthn does not support non-HTTPS domains other than `localhost`

### Durable Object Migration Failure

**Symptom**: Worker returns 500 errors with DO-related errors in logs

**Solution**:
```bash
cd packages/backend

# View production logs
npx wrangler tail --env=""

# View staging logs
npx wrangler tail --env staging

# Verify that the migrations configuration in wrangler.toml is correct
cat wrangler.toml
```

### Build Failure

```bash
# Clean cache and rebuild
rm -rf packages/*/dist
pnpm install --frozen-lockfile
pnpm build
```

### Static Asset 404

**Symptom**: Frontend page loads but JS/CSS and other assets return 404

**Solution**:
- Verify that the `packages/frontend/dist/` directory exists and contains build artifacts (run `pnpm --filter @zerolink/frontend build` first)
- Verify that `[assets] directory = "../frontend/dist"` in `wrangler.toml` is correct relative to `packages/backend/`
- `wrangler deploy` must be run after the frontend build is complete

---

## Related Docs

- [Quick Start Guide](./QUICK_START.md) - Local development environment setup
- [Tech Stack](./TECH_STACK.md) - Complete technology stack reference
- [Architecture Overview](./ARCHITECTURE.md) - System design
- [Security Model](./SECURITY.md) - Threat model and security guarantees

---

**Last Updated**: 2026-03-17
