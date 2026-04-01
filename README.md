# BackupTool

A self-hosted, encrypted backup orchestration system. Lightweight agents run on your machines, a central server manages everything, and a clean web UI gives you full visibility — all with no vendor lock-in.

Built on [Restic](https://restic.net/) and [Rclone](https://rclone.org/), inspired by [Pluton](https://usepluton.com/).

---

## Features

- **Cross-platform agents** — Linux, Windows, macOS (amd64 + arm64 single binaries)
- **Kubernetes agent** — backs up PVCs and namespace resources (Deployments, Secrets, ConfigMaps, etc.)
- **70+ storage backends** — S3, Backblaze B2, GCS, Azure Blob, SFTP, local, Rclone, Wasabi, MinIO
- **End-to-end encryption** — Restic AES-256 encryption before upload; credentials encrypted at rest (AES-256-GCM)
- **Incremental backups** — only changed data is transferred
- **Retention policies** — keep-last, daily, weekly, monthly, yearly
- **Real-time monitoring** — live progress, logs, agent status via WebSocket
- **SSO** — OIDC (Google, Azure AD, Okta, Keycloak), SAML 2.0, LDAP/Active Directory
- **Offline licensing** — Ed25519-signed license files, no phone-home required
- **mTLS agent authentication** — per-agent client certificates issued by built-in CA
- **Email notifications** — SMTP alerts on backup start, success, or failure
- **Audit log** — full trail of user actions
- **Role-based access** — admin, operator, viewer

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│              Web Browser (React UI)             │
└───────────────────┬─────────────────────────────┘
                    │ HTTPS + WebSocket
┌───────────────────▼─────────────────────────────┐
│          BackupTool Server (Node.js)            │
│  REST API · WebSocket · SQLite · PKI CA         │
└──────┬─────────────────────────────┬────────────┘
       │ mTLS + WebSocket            │ mTLS + WebSocket
┌──────▼────────┐           ┌────────▼──────────────┐
│  Agent        │           │  Kubernetes Agent      │
│ (Linux/Win/   │           │  (Go, in-cluster)      │
│  macOS)       │           │  Helm chart            │
└──────┬────────┘           └────────┬───────────────┘
       │ Restic                      │ Restic + kubectl export
┌──────▼────────────────────────────▼───────────────┐
│        Storage Backend (S3 / B2 / SFTP / …)       │
└────────────────────────────────────────────────────┘
```

---

## Quick Start — Docker Compose

**Requirements:** Docker 24+, Docker Compose v2

```bash
# 1. Clone the repository
git clone https://github.com/moritz-eventconnector/backuptool.git
cd backuptool

# 2. Copy and configure environment variables
cp docker/.env.example docker/.env
# Edit docker/.env — at minimum set MASTER_SECRET and COOKIE_SECRET:
#   MASTER_SECRET=$(openssl rand -hex 32)
#   COOKIE_SECRET=$(openssl rand -hex 32)

# 3. Start the server
docker compose -f docker/docker-compose.yml --env-file docker/.env up -d

# 4. Open http://localhost:3000 in your browser
# 5. Complete the first-time setup wizard (create admin user)
```

---

## Installation — Manual (Development)

**Requirements:** Node.js 22+, pnpm 9+, Go 1.23+

```bash
# Install dependencies
pnpm install

# Start server + web UI in development mode (with hot reload)
pnpm dev

# Server runs on http://localhost:3000
# Vite dev server runs on http://localhost:5173 (proxies API to server)
```

---

## Installing Agents

### Linux / macOS

Download the pre-built binary from the releases page, or build from source:

```bash
# Build for your current platform
make agent-linux-amd64    # Linux x86_64
make agent-linux-arm64    # Linux ARM64 (Raspberry Pi, etc.)
make agent-darwin-amd64   # macOS Intel
make agent-darwin-arm64   # macOS Apple Silicon

# The binary is written to binaries/agent-<os>-<arch>
```

**Run the agent:**

```bash
# 1. In the web UI: go to Agents → Generate Token
#    Copy the Agent ID and Registration Token

# 2. Register and start the agent
./agent-linux-amd64 \
  --server http://your-server:3000 \
  --agent-id <AGENT_ID> \
  --token <REGISTRATION_TOKEN> \
  --name "My Server"

# After registration, config is saved to ~/.backuptool-agent/agent.yaml
# On subsequent starts, just run:
./agent-linux-amd64 --server http://your-server:3000
```

**Run as a systemd service (Linux):**

```ini
# /etc/systemd/system/backuptool-agent.service
[Unit]
Description=BackupTool Agent
After=network.target

[Service]
ExecStart=/usr/local/bin/backuptool-agent --server http://your-server:3000
Restart=always
RestartSec=10
User=backuptool

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now backuptool-agent
```

### Windows

```powershell
# Download agent-windows-amd64.exe or build from source:
# make agent-windows-amd64

# Register and run
.\agent-windows-amd64.exe --server http://your-server:3000 --agent-id <ID> --token <TOKEN> --name "My PC"

# Run as a Windows Service (using NSSM or sc.exe):
nssm install BackupToolAgent "C:\backuptool\agent-windows-amd64.exe" "--server http://your-server:3000"
nssm start BackupToolAgent
```

---

## Installing the Kubernetes Agent

**Requirements:** Helm 3+, kubectl configured

```bash
# 1. Build the k8s-agent image and push to your registry
make k8s-agent
docker build -f docker/Dockerfile.k8s-agent -t your-registry/backuptool-k8s-agent:latest .
docker push your-registry/backuptool-k8s-agent:latest

# 2. In the web UI: go to Agents → Generate Token
#    Copy the Agent ID and Registration Token

# 3. Install via Helm
helm install backuptool-k8s-agent ./k8s-agent/helm \
  --namespace backuptool \
  --create-namespace \
  --set server.url=http://your-server:3000 \
  --set server.agentId=<AGENT_ID> \
  --set server.registrationToken=<REGISTRATION_TOKEN> \
  --set image.repository=your-registry/backuptool-k8s-agent \
  --set image.tag=latest

# 4. Verify the agent appears as online in the web UI
kubectl get pods -n backuptool
```

**Helm values reference** (`k8s-agent/helm/values.yaml`):

| Value | Default | Description |
|-------|---------|-------------|
| `server.url` | `""` | BackupTool server URL (required) |
| `server.agentId` | `""` | Agent ID from the web UI (required) |
| `server.registrationToken` | `""` | One-time registration token (required) |
| `namespace` | `""` | Limit backups to this namespace (empty = all) |
| `restic.bin` | `restic` | Path to restic binary |
| `rbac.create` | `true` | Create ClusterRole with read permissions |
| `resources.limits.memory` | `256Mi` | Container memory limit |

---

## Building All Binaries

```bash
# Build everything (all agent platforms + k8s-agent + licenser)
make build-all

# Individual targets
make agent-linux-amd64
make agent-linux-arm64
make agent-windows-amd64
make agent-darwin-amd64
make agent-darwin-arm64
make k8s-agent
make licenser
```

---

## Configuration

### Server Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `DATA_DIR` | `./data` | Directory for SQLite DB, PKI certs, etc. |
| `MASTER_SECRET` | *(required in prod)* | 32-byte secret for AES-256-GCM credential encryption |
| `COOKIE_SECRET` | *(required in prod)* | Secret for cookie signing |
| `CORS_ORIGIN` | `http://localhost:5173` | Allowed CORS origin |
| `LICENSE_PUBLIC_KEY` | — | Base64-encoded Ed25519 public key for license verification |

**SMTP (email notifications):**

| Variable | Description |
|----------|-------------|
| `SMTP_HOST` | SMTP server hostname |
| `SMTP_PORT` | SMTP port (default: 587) |
| `SMTP_USER` | SMTP username |
| `SMTP_PASS` | SMTP password |
| `SMTP_FROM` | From address |

**OIDC Single Sign-On:**

| Variable | Description |
|----------|-------------|
| `OIDC_ENABLED` | `true` to enable |
| `OIDC_ISSUER_URL` | IdP issuer URL (e.g. `https://accounts.google.com`) |
| `OIDC_CLIENT_ID` | OAuth2 client ID |
| `OIDC_CLIENT_SECRET` | OAuth2 client secret |
| `OIDC_REDIRECT_URI` | Callback URL (e.g. `https://backup.example.com/api/auth/sso/oidc/callback`) |
| `OIDC_NAME` | Display name shown on login page |

**SAML 2.0:**

| Variable | Description |
|----------|-------------|
| `SAML_ENABLED` | `true` to enable |
| `SAML_ENTRY_POINT` | IdP SSO URL |
| `SAML_ISSUER` | SP entity ID |
| `SAML_CERT` | IdP certificate (PEM, base64-encoded) |
| `SAML_CALLBACK_URL` | SP callback URL |

**LDAP / Active Directory:**

| Variable | Description |
|----------|-------------|
| `LDAP_ENABLED` | `true` to enable |
| `LDAP_URL` | LDAP server URL (e.g. `ldap://dc.example.com:389`) |
| `LDAP_BIND_DN` | Service account DN |
| `LDAP_BIND_CREDENTIALS` | Service account password |
| `LDAP_SEARCH_BASE` | Search base DN |
| `LDAP_SEARCH_FILTER` | Search filter (default: `(mail={{username}})`) |

---

## License Management

BackupTool uses offline Ed25519-signed licenses — no internet connection required for verification.

### Editions

| Feature | Community | Pro | Enterprise |
|---------|-----------|-----|------------|
| Agents | 1 | Unlimited | Unlimited |
| Storage backends | S3, local | All 70+ | All 70+ |
| SSO (OIDC) | — | ✓ | ✓ |
| SSO (SAML + LDAP) | — | — | ✓ |
| Kubernetes Agent | — | — | ✓ |
| Audit Log | — | ✓ | ✓ |
| Email Notifications | ✓ | ✓ | ✓ |

### Uploading a License

1. Go to **License** in the web UI
2. Paste your license JWT and click **Activate**

Or via API:
```bash
curl -X POST http://localhost:3000/api/license \
  -H "Content-Type: application/json" \
  -H "Cookie: access_token=<token>" \
  -d '{"license": "eyJhbGci..."}'
```

### Generating Licenses (Vendor Tool)

```bash
# Generate keypair (do this once; keep private key secure)
./binaries/licenser keygen --private-key ./keys/private.pem --public-key ./keys/public.pem

# Set the public key in server environment:
export LICENSE_PUBLIC_KEY=$(base64 -w0 ./keys/public.pem)

# Generate a Pro license for a customer
./binaries/licenser generate \
  --private-key ./keys/private.pem \
  --customer-id "cust_123" \
  --customer-name "Acme Corp" \
  --edition pro \
  --seats 20 \
  --features "sso,audit_log" \
  --expiry 2027-12-31 \
  --output acme-corp.license

# Verify a license file
./binaries/licenser verify --license acme-corp.license --public-key ./keys/public.pem
```

---

## Development

```bash
# Install dependencies
pnpm install

# Start everything in dev mode
pnpm dev

# Run database migrations
make db-migrate

# Generate migration files after schema changes
make db-generate

# Build Docker image
make docker-build

# Run with Docker Compose
make docker-up
make docker-down

# Lint + type-check
cd server && pnpm tsc --noEmit
cd web && pnpm tsc --noEmit
```

---

## Security

- **Passwords**: Argon2id (OWASP recommended)
- **JWT**: RS256 asymmetric signing, 15-minute access tokens with rotation
- **Agent auth**: mTLS mutual TLS — per-agent client certificates from built-in CA
- **Credentials at rest**: AES-256-GCM with PBKDF2 key derivation
- **Backup data**: Restic AES-256-CTR + Poly1305 (ChaCha20-Poly1305)
- **Licenses**: Ed25519 signatures (fully offline verification)
- **HTTP**: Helmet security headers, rate limiting, CORS, CSRF protection

---

## License

Apache-2.0 — see [LICENSE](LICENSE).
