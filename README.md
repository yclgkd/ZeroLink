> **Language**: English | [中文](./README.zh.md)

# ZeroLink

> Zero-knowledge secure delivery: no accounts, end-to-end encrypted, sender-managed but never decryptable by the server.
> Share passwords, API tokens, recovery codes, private messages, or any sensitive content — securely.

**🌟 Live Demo**: [zerolink.dev](https://zerolink.dev)

## Overview

ZeroLink is a security-first secret sharing tool with the following features:

- **Zero-Knowledge Architecture**: The server never stores plaintext or any private keys
- **End-to-End Encryption**: Only the receiver can decrypt the content
- **Dual Creation Modes**: Quick Share (password) / Secure Share (Passkey)
- **WebAuthn Management**: Secure Share uses system/hardware keys for non-exportable management authority
- **TOFU Protection**: URL Fragment + Lock Challenge prevents race-condition lock hijacking
- **Ciphertext Length Protection**: Padding reduces length-based information leakage
- **Current Product Modes**: Quick Share / Secure Share only

## Core Flow

```
1. Sender → Create (Quick Share password mode / Secure Share Passkey mode)
          → Share link: /s/:uuid#k=<lock_secret>[&af=<sender_auth_fpr>]

2. Receiver → Lock (enter password → generate RSA keypair → store locally)
            → Display Safety Code (Emoji/Color)

3. Sender → Verify Safety Code (out-of-band)
          → Deliver (hybrid encryption + Padding → deliver ciphertext)

4. Receiver → Enter password → Decrypt and view
```

## Documentation

### Getting Started
- [Quick Start Guide](./docs/QUICK_START.md) - From zero to running dev environment
- [Deployment Guide](./docs/DEPLOYMENT.md) - Deploy to Cloudflare Workers manually
- [Self-Hosted Deployment Guide](./docs/SELF_HOSTED_DEPLOYMENT.md) - Run the published Docker Compose stack or local build override
- [Tech Stack Specification](./docs/TECH_STACK.md) - Complete tech stack and toolchain

### Design Documents
- [Full PRD v3.0](./docs/PRD.md) - Product Requirements Document
- [Architecture Overview](./docs/ARCHITECTURE.md) - Technical architecture and core protocols
- [Security Model](./docs/SECURITY.md) - Threat model and security guarantees

### Navigation
- [Documentation Index](./docs/INDEX.md) - Quick navigation for AI assistants and developers

## Tech Stack

### Frontend
- React 19 + Vite 7 + React Router
- Tailwind CSS v4 + shadcn/ui (based on Radix primitives)
- Zustand + Zod
- Web Crypto API (AES-GCM, RSA-OAEP, SHA-256)
- WebAuthn (FIDO2)
- Argon2id (KDF)

### Backend
- Cloudflare Workers + Durable Objects (free tier available, SQLite backend supported)
- Optional: Docker Compose self-hosted stack via published GHCR images or local build override

## Browser Compatibility

| Browser | Minimum Version | Release Date |
|---------|-----------------|--------------|
| Chrome / Edge | 93+ | September 2021 |
| Firefox | 92+ | September 2021 |
| Safari | 15.4+ | March 2022 |

**Notes**:
- WebAuthn (hardware keys) requires HTTPS; `localhost` works for local development
- Ed25519 signature verification: Chrome 113+ / Safari 16.4+ use native WebCrypto; older versions automatically fall back to pure JS implementation (`@noble/ed25519`)
- No polyfills provided; Internet Explorer is not supported

## Security Features

### v3.0 Current Focus

1. **Lock Secret (URL Fragment)**: Prevents preload crawlers from hijacking locks
2. **Padding (4KB blocks)**: Reduces ciphertext length-based information leakage
3. **Argon2id Enforced**: Receiver private key wrapping (250-500ms target duration)
4. **Dual Creation Modes**: Quick Share (password) / Secure Share (Passkey)
5. **Verifiable Release Chain**: Signed Manifest + runtime hash verification

### Security Guarantees

- Server zero-knowledge
- End-to-end confidentiality
- Update/destroy operations are unforgeable (WebAuthn or ECDSA)
- Replay/reorder/concurrent-overwrite resistant (DO atomicity)
- Minimal metadata leakage
- Frontend integrity verifiable (CSP + Signed Manifest)
- Secure Share management private key is non-exportable (WebAuthn); Quick Share admin key is encoded in the management link

## Deploy

ZeroLink supports two deployment paths:

- Cloudflare Workers manual deployment, documented in [Deployment Guide](./docs/DEPLOYMENT.md)
- Docker Compose self-hosting, documented in [Self-Hosted Deployment Guide](./docs/SELF_HOSTED_DEPLOYMENT.md)

### Cloudflare Deployment Prerequisites

- Cloudflare account (free plan is sufficient; Durable Objects free tier supported)
- Node.js >=22.22.0 · pnpm 9+ · Wrangler CLI 4+

For the full step-by-step process, see the [Deployment Guide](./docs/DEPLOYMENT.md). Self-hosting
with Docker Compose does not require the Cloudflare toolchain.

### Self-Hosted Quick Start

Use a released image tag so the downloaded Compose file and pulled images stay aligned:

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

The default stack pulls `${ZEROLINK_IMAGE_REPOSITORY:-ghcr.io/yclgkd}/zerolink-api` and
`${ZEROLINK_IMAGE_REPOSITORY:-ghcr.io/yclgkd}/zerolink-web`.
Set `ZEROLINK_IMAGE_REPOSITORY` in `.env` when consuming images from a fork or org mirror, or use
[Self-Hosted Deployment Guide](./docs/SELF_HOSTED_DEPLOYMENT.md) for the local build override.

---

## Quick Start (Local Dev)

```bash
git clone https://github.com/yclgkd/zerolink.git
cd zerolink
pnpm install
pnpm dev
```

## Contributing

We welcome contributions! Please read our [Contributing Guide](./CONTRIBUTING.md) before submitting a pull request.

## Security

ZeroLink is a security-focused project. If you discover a vulnerability, **please do not open a public issue**. See our [Security Policy](./SECURITY.md) for responsible disclosure instructions.

For the technical security model and threat analysis, see [Security Model](./docs/SECURITY.md).

## License

This project is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0). See [LICENSE](./LICENSE) for details.
