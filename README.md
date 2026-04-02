# BackupTool

A self-hosted, encrypted backup orchestration system. Lightweight agents run on your machines, a central server manages everything, and a clean web UI gives you full visibility — all with no vendor lock-in.

Built on [Restic](https://restic.net/) and [Rclone](https://rclone.org/).

---

## Features

- **Cross-platform agents** — Linux, Windows, macOS (amd64 + arm64 single binaries)
- **Kubernetes agent** — backs up PVCs and namespace resources (Deployments, Secrets, ConfigMaps, etc.)
- **70+ storage backends** — S3, Backblaze B2, GCS, Azure Blob, SFTP, local, Wasabi, MinIO, and all Rclone-supported backends
- **End-to-end encryption** — Restic AES-256 encryption before upload; credentials encrypted at rest (AES-256-GCM)
- **Incremental backups** — only changed data is transferred
- **WORM / immutable backups** — S3 Object Lock support to make snapshots tamper-proof
- **Retention policies** — keep-last, daily, weekly, monthly, yearly
- **Auto-discovery** — agents automatically detect 20+ services (PostgreSQL, MySQL, MongoDB, Docker volumes, Kubernetes, etc.) and suggest backup paths
- **Real-time monitoring** — live progress, logs, agent status via WebSocket
- **SSO** — OIDC (Google, Azure AD, Okta, Keycloak), SAML 2.0, LDAP/Active Directory — configured via UI, no restart required
- **Webhook notifications** — Slack, Discord, ntfy, or any HTTP endpoint
- **Email notifications** — SMTP alerts on backup start, success, or failure
- **First-time setup wizard** — guided onboarding after installation
- **UI-managed configuration** — all settings (SMTP, SSO, server name, …) are stored in the database and editable via the web UI
- **Offline licensing** — Ed25519-signed license files, no phone-home required
- **mTLS agent authentication** — per-agent client certificates issued by built-in CA
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

### 1. Clone the repository

```bash
git clone https://github.com/moritz-eventconnector/backuptool.git
cd backuptool
```

### 2. Configure environment variables

```bash
cp docker/.env.example docker/.env
```

Open `docker/.env` and set at minimum:

```env
# Required — generate with: openssl rand -hex 32
MASTER_SECRET=change_me_use_openssl_rand_hex_32

# Optional — defaults shown
PORT=3000
DATA_DIR=/data
```

> **`MASTER_SECRET`** is the only truly required variable. It protects all encrypted values in the database (SSO secrets, SMTP passwords, destination credentials). **Keep it safe and back it up** — losing it makes encrypted data unrecoverable.

### 3. Start the server

```bash
docker compose -f docker/docker-compose.yml --env-file docker/.env up -d
```

### 4. Open the web UI

Navigate to **http://localhost:3000** (or your server's IP/hostname).

You will be prompted to:
1. **Create an admin account** — name, email, password (min. 12 characters)
2. **Complete the setup wizard** — server name, SMTP, SSO, and install your first agent

That's it. All further configuration is done through the UI.

---

## Installation — Manual / Development

**Requirements:** Node.js 22+, pnpm 9+, Go 1.23+

```bash
# Install dependencies
pnpm install

# Start server + web UI in development mode (hot reload)
pnpm dev
# Server:  http://localhost:3000
# Web UI:  http://localhost:5173
```

To build for production:

```bash
pnpm build        # builds server (tsc) + web UI (vite)
pnpm start        # starts the compiled server (serves web UI from web/dist)
```

---

## Installing Agents

### One-line install (recommended)

After completing the setup wizard, go to **Agents → Add Agent**, enter a name, and copy the generated install command. It looks like:

```bash
curl -fsSL https://your-server/api/agents/install.sh | sudo bash -s -- --token <TOKEN>
```

The script detects your OS/arch, downloads the correct binary, registers the agent, and installs it as a systemd service (Linux) or Windows Service automatically.

### Manual install — Linux / macOS

```bash
# Build for your platform
make agent-linux-amd64    # Linux x86_64
make agent-linux-arm64    # Linux ARM64 (Raspberry Pi, AWS Graviton, …)
make agent-darwin-amd64   # macOS Intel
make agent-darwin-arm64   # macOS Apple Silicon
# Binary written to: binaries/agent-<os>-<arch>

# 1. Generate a token in the web UI: Agents → Add Agent
# 2. Register the agent (first run only)
./agent-linux-amd64 \
  --server http://your-server:3000 \
  --token <REGISTRATION_TOKEN> \
  --name "web-01"

# Config is saved to /etc/backuptool-agent/agent.yaml
# On subsequent starts:
./agent-linux-amd64
```

**Run as a systemd service:**

```bash
# Copy binary
sudo cp binaries/agent-linux-amd64 /usr/local/bin/backuptool-agent
sudo chmod +x /usr/local/bin/backuptool-agent

# Create service file
sudo tee /etc/systemd/system/backuptool-agent.service > /dev/null <<EOF
[Unit]
Description=BackupTool Agent
After=network.target

[Service]
ExecStart=/usr/local/bin/backuptool-agent
Restart=always
RestartSec=10
User=root

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now backuptool-agent
sudo systemctl status backuptool-agent
```

### Manual install — Windows

```powershell
# Build (requires Go on the build machine):
make agent-windows-amd64
# Binary: binaries/agent-windows-amd64.exe

# 1. Generate a token in the web UI: Agents → Add Agent
# 2. Register:
.\agent-windows-amd64.exe --server http://your-server:3000 --token <TOKEN> --name "win-srv-01"

# Install as a Windows Service using NSSM (https://nssm.cc):
nssm install BackupToolAgent "C:\backuptool\agent-windows-amd64.exe"
nssm start BackupToolAgent
```

### Agent auto-discovery

When an agent first connects, it scans the host and reports discovered services to the server. Go to **Agents → (select agent) → Discovered Services** to review what was found and create backup jobs from the suggestions.

Detected automatically:
- PostgreSQL, MySQL / MariaDB, MongoDB, Redis, InfluxDB, CockroachDB
- Docker volumes and Compose project data directories
- Kubernetes (in-cluster): PVCs, etcd
- Home directories, `/etc`, `/var/lib`, `/opt`
- Application data: GitLab, Nextcloud, Gitea, Forgejo, Immich, Vaultwarden, Grafana, Prometheus, Elasticsearch, Meilisearch, Keycloak, Authentik

---

## Installing the Kubernetes Agent

**Requirements:** Helm 3+, kubectl configured against the target cluster

```bash
# 1. Build and push the image
docker build -f docker/Dockerfile.k8s-agent -t your-registry/backuptool-k8s-agent:latest .
docker push your-registry/backuptool-k8s-agent:latest

# 2. Generate a token in the web UI: Agents → Add Agent

# 3. Install via Helm
helm install backuptool-k8s-agent ./k8s-agent/helm \
  --namespace backuptool \
  --create-namespace \
  --set server.url=http://your-server:3000 \
  --set server.registrationToken=<TOKEN> \
  --set image.repository=your-registry/backuptool-k8s-agent \
  --set image.tag=latest

# 4. Check the agent appears as "online" in the web UI
kubectl get pods -n backuptool
```

**Helm values reference:**

| Value | Default | Description |
|-------|---------|-------------|
| `server.url` | `""` | BackupTool server URL (required) |
| `server.registrationToken` | `""` | One-time registration token from the UI |
| `image.repository` | `""` | Your registry image path |
| `image.tag` | `latest` | Image tag |
| `namespace` | `""` | Limit to a single namespace (empty = all) |
| `rbac.create` | `true` | Create ClusterRole with read permissions |
| `resources.limits.memory` | `256Mi` | Container memory limit |

---

## Configuration

### Bootstrap environment variables

Only these four variables need to be set as environment variables. Everything else is configured in the web UI.

| Variable | Default | Description |
|----------|---------|-------------|
| `MASTER_SECRET` | *(required in prod)* | 32-byte hex secret — encrypts all credentials in the DB. Generate with `openssl rand -hex 32`. |
| `DATA_DIR` | `./data` | Directory for SQLite database, PKI certs, and uploads |
| `PORT` | `3000` | HTTP listen port |
| `DB_PATH` | `$DATA_DIR/backuptool.db` | Override SQLite file path |

> In development without `MASTER_SECRET` set, a fixed development key is used. **Always set this in production.**

### In-UI configuration (Settings page)

Everything else is configured in **Settings** and stored encrypted in the database:

| Section | What you configure |
|---------|-------------------|
| **General** | Server name, public URL, restic/rclone binary paths |
| **Email** | SMTP host/port/credentials, recipients, notification triggers |
| **Webhooks** | Slack / Discord / ntfy / generic HTTP endpoint, triggers |
| **SSO** | OIDC, SAML 2.0, LDAP/AD — edit and enable without restarting |
| **Users** | Create/delete users, assign roles |

---

## SSO Configuration

SSO providers are configured in **Settings → SSO / Auth**. No restart is required — changes take effect immediately.

### OIDC (Google, Azure AD, Okta, Keycloak)

1. Create an OAuth2 application in your identity provider
2. Set the redirect/callback URI to `https://your-server/api/auth/sso/oidc/callback`
3. In **Settings → SSO → OIDC**: enter Issuer URL, Client ID, Client Secret → Save

Login URL: `https://your-server/api/auth/sso/oidc/login`

### LDAP / Active Directory

1. Create a service account with read access to your directory
2. In **Settings → SSO → LDAP**: enter server URL, bind DN, password, search base → Save

Login URL: `https://your-server/api/auth/sso/ldap/login`  
Search filter default: `(mail={{username}})` — use `(sAMAccountName={{username}})` for Active Directory

### SAML 2.0

1. Register BackupTool as a Service Provider in your IdP
2. In **Settings → SSO → SAML**: enter Entry Point URL, Issuer, IdP certificate → Save

> SSO credentials (client secrets, bind passwords, certificates) are stored AES-256-GCM encrypted in the database.

---

## Webhook Notifications

Configure in **Settings → Webhooks**. Supported providers:

| Provider | URL format |
|----------|-----------|
| **Slack** | `https://hooks.slack.com/services/T…/B…/…` |
| **Discord** | `https://discord.com/api/webhooks/…` |
| **ntfy** | `https://ntfy.sh/my-topic` |
| **Generic HTTP** | Any URL — receives a JSON body with event details |

Triggers: job started, job succeeded, job failed (configurable independently).

---

## WORM / Immutable Backups

Enable per backup job in **Jobs → (edit job) → WORM**. Requires an S3-compatible destination with Object Lock enabled.

When enabled, each snapshot is locked with S3 Object Lock COMPLIANCE mode for the configured retention period. Locked snapshots cannot be deleted — not even by the backup tool itself or the storage account owner.

**Setup on AWS S3:**
1. Create a bucket with Object Lock enabled (must be done at bucket creation)
2. Create a destination in BackupTool pointing to this bucket
3. Enable WORM on the job and set a retention period in days

---

## License Management

### Editions

| Feature | Community | Pro | Enterprise |
|---------|-----------|-----|------------|
| Agents | 1 | Unlimited | Unlimited |
| Storage backends | S3, local | All 70+ | All 70+ |
| SSO (OIDC) | — | ✓ | ✓ |
| SSO (SAML + LDAP) | — | — | ✓ |
| Kubernetes Agent | — | — | ✓ |
| Webhook notifications | ✓ | ✓ | ✓ |
| Email notifications | ✓ | ✓ | ✓ |
| WORM backups | — | ✓ | ✓ |

### Uploading a license

Go to **License** in the web UI → paste the license JWT → **Activate**.

### Generating licenses (vendor tool)

```bash
# Generate a keypair once; keep the private key secure
./binaries/licenser keygen --private-key ./keys/private.pem --public-key ./keys/public.pem

# Set the public key in the server environment:
export LICENSE_PUBLIC_KEY=$(base64 -w0 ./keys/public.pem)

# Issue a Pro license
./binaries/licenser generate \
  --private-key ./keys/private.pem \
  --customer-id "cust_123" \
  --customer-name "Acme Corp" \
  --edition pro \
  --seats 20 \
  --expiry 2027-12-31 \
  --output acme-corp.license

# Verify a license file
./binaries/licenser verify --license acme-corp.license --public-key ./keys/public.pem
```

---

## Building from Source

```bash
# All binaries (all agent platforms + k8s-agent + licenser)
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

## Development

```bash
# Install all dependencies
pnpm install

# Start server + frontend in watch mode
pnpm dev

# Type-check only (no emit)
cd server && npx tsc --noEmit
cd web    && npx tsc --noEmit

# Build production artifacts
pnpm build

# Docker
make docker-build
make docker-up
make docker-down
```

---

## Security

| Area | Implementation |
|------|---------------|
| Passwords | Argon2id (OWASP recommended parameters) |
| JWT | RS256 asymmetric, 15-min access tokens with silent refresh |
| Agent auth | mTLS — per-agent client certificates from built-in CA |
| Credentials at rest | AES-256-GCM with PBKDF2 key derivation from `MASTER_SECRET` |
| Backup data | Restic AES-256-CTR + Poly1305 |
| SSO secrets | AES-256-GCM encrypted in SQLite |
| Licenses | Ed25519 offline signatures |
| HTTP hardening | Helmet CSP, rate limiting, CORS, CSRF cookies |

---

## License

Apache-2.0 — see [LICENSE](LICENSE).
