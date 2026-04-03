/**
 * Agent install script + binary serving endpoints.
 *
 * GET /api/agents/install/:agentId/:token/install.sh  — dynamic bash script
 * GET /api/agents/install/:agentId/:token/install.ps1 — PowerShell script (Windows)
 * GET /api/agents/binary/:os/:arch                    — serve or redirect agent binary
 */
import { Router } from "express";
import type { Request, Response } from "express";
import path from "path";
import fs from "fs";
import { getDb } from "../db/index.js";
import { agents } from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { config } from "../config.js";
import { logger } from "../logger.js";

export const installRouter = Router();

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Derive the externally-reachable server URL from the request */
function serverUrl(req: Request): string {
  const proto = req.headers["x-forwarded-proto"] ?? req.protocol;
  const host = req.headers["x-forwarded-host"] ?? req.headers.host;
  return `${proto}://${host}`;
}

/** Validate that the agentId + token pair is still valid (not yet registered) */
function validateInstallToken(agentId: string, token: string): boolean {
  const db = getDb();
  const [agent] = db.select({ registrationToken: agents.registrationToken })
    .from(agents).where(eq(agents.id, agentId)).all();
  return !!agent && agent.registrationToken === token;
}

// ── GET /api/agents/binary/:os/:arch ─────────────────────────────────────────
// Serves a pre-built agent binary. Requires authenticated user (admin/operator).
// Looks in $DATA_DIR/binaries/ first, then redirects to RELEASES_BASE_URL.

installRouter.get("/binary/:os/:arch", requireAuth, requireRole("admin", "operator"), (req, res) => {
  serveBinary(req, res);
});

// ── GET /api/agents/install/:agentId/:token/binary/:os/:arch ─────────────────
// Token-authenticated binary download used by the install script on fresh machines
// (no session cookie available). Validates the agentId+token pair.

installRouter.get("/install/:agentId/:token/binary/:os/:arch", (req: Request, res: Response) => {
  const { agentId, token } = req.params;
  if (!validateInstallToken(agentId, token)) {
    res.status(401).json({ error: "Invalid or expired install token" });
    return;
  }
  serveBinary(req, res);
});

function serveBinary(req: Request, res: Response) {
  const { os, arch } = req.params;
  const validOS = ["linux", "darwin", "windows"];
  const validArch = ["amd64", "arm64"];
  if (!validOS.includes(os) || !validArch.includes(arch)) {
    res.status(400).json({ error: "Invalid os or arch parameter" });
    return;
  }

  const ext = os === "windows" ? ".exe" : "";
  const filename = `agent-${os}-${arch}${ext}`;
  const localPath = path.join(config.dataDir, "binaries", filename);

  if (fs.existsSync(localPath)) {
    res.download(localPath, filename);
    return;
  }

  if (config.releasesBaseUrl) {
    res.redirect(`${config.releasesBaseUrl}/${filename}`);
    return;
  }

  res.status(404).json({
    error: `Binary not found: ${filename}`,
    hint: [
      `Place pre-built binaries at: ${path.join(config.dataDir, "binaries", filename)}`,
      "Or set the RELEASES_BASE_URL environment variable to a base URL hosting the binaries.",
      "Build with: make agent-linux-amd64 (or the matching target for your platform).",
    ].join(" | "),
  });
}

// ── GET /api/agents/install/:agentId/:token/install.sh ───────────────────────
// Returns a fully self-contained bash install script for Linux and macOS.
// The :agentId/:token path segment acts as the authentication — no cookie/JWT needed
// so the script can be piped directly from curl on a fresh machine.

installRouter.get("/install/:agentId/:token/install.sh", (req: Request, res: Response) => {
  const { agentId, token } = req.params;

  if (!validateInstallToken(agentId, token)) {
    res.status(401).send("#!/usr/bin/env bash\necho 'Error: invalid or expired install token.' >&2; exit 1\n");
    return;
  }

  const srv = serverUrl(req);
  logger.info({ agentId }, "Serving bash install script");

  const script = `#!/usr/bin/env bash
# BackupTool Agent — automatic installer
# Generated for agent ${agentId}
# This script detects your platform, downloads the agent binary from your
# BackupTool server, registers the agent, and sets up a persistent service.
set -euo pipefail

SERVER="${srv}"
AGENT_ID="${agentId}"
TOKEN="${token}"
AGENT_NAME="\${HOSTNAME:-$(hostname)}"
INSTALL_DIR="/usr/local/bin"
BIN="$INSTALL_DIR/backuptool-agent"
DATA_DIR="/var/lib/backuptool-agent"
SERVICE_USER="backuptool"

# ── Detect platform ────────────────────────────────────────────────────────
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
RAW_ARCH=$(uname -m)
case "$RAW_ARCH" in
  x86_64|amd64)  ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *)
    echo "Unsupported architecture: $RAW_ARCH" >&2
    exit 1
    ;;
esac

if [ "$OS" != "linux" ] && [ "$OS" != "darwin" ]; then
  echo "Unsupported OS: $OS. Use install.ps1 for Windows." >&2
  exit 1
fi

# ── Check for root (Linux) ─────────────────────────────────────────────────
if [ "$OS" = "linux" ] && [ "$(id -u)" -ne 0 ]; then
  echo "Please run with sudo." >&2
  exit 1
fi

echo "BackupTool Agent installer"
echo "  Server : $SERVER"
echo "  OS/Arch: $OS/$ARCH"
echo ""

# ── Install restic if not present ─────────────────────────────────────────
if ! command -v restic &>/dev/null; then
  echo "Installing restic..."
  RESTIC_INSTALLED=0

  # Try package manager first
  if command -v apt-get &>/dev/null; then
    apt-get install -y restic 2>/dev/null && RESTIC_INSTALLED=1
  elif command -v yum &>/dev/null; then
    yum install -y restic 2>/dev/null && RESTIC_INSTALLED=1
  elif command -v dnf &>/dev/null; then
    dnf install -y restic 2>/dev/null && RESTIC_INSTALLED=1
  elif command -v brew &>/dev/null; then
    brew install restic 2>/dev/null && RESTIC_INSTALLED=1
  fi

  # Fallback: download directly from GitHub releases
  if [ "$RESTIC_INSTALLED" -eq 0 ]; then
    echo "  Package manager unavailable — downloading restic from GitHub..."
    RESTIC_VERSION=$(curl -fsSL https://api.github.com/repos/restic/restic/releases/latest 2>/dev/null | grep '"tag_name"' | sed 's/.*"v\\([^"]*\\)".*/\\1/' || echo "0.17.3")
    RESTIC_ARCH="$ARCH"
    RESTIC_URL="https://github.com/restic/restic/releases/download/v\${RESTIC_VERSION}/restic_\${RESTIC_VERSION}_\${OS}_\${RESTIC_ARCH}.bz2"
    TMP_BZ2=$(mktemp)
    if command -v curl &>/dev/null; then
      curl -fsSL -o "$TMP_BZ2" "$RESTIC_URL"
    else
      wget -qO "$TMP_BZ2" "$RESTIC_URL"
    fi
    bunzip2 -c "$TMP_BZ2" > /usr/local/bin/restic
    chmod +x /usr/local/bin/restic
    rm -f "$TMP_BZ2"
    RESTIC_INSTALLED=1
  fi

  if command -v restic &>/dev/null; then
    echo "  restic $(restic version | head -1) installed."
  else
    echo "  WARNING: Could not install restic. Please install it manually: https://restic.net" >&2
  fi
else
  echo "restic already installed: $(restic version | head -1)"
fi

# ── Download agent binary ──────────────────────────────────────────────────
echo "Downloading agent binary..."
BINARY_URL="$SERVER/api/agents/install/$AGENT_ID/$TOKEN/binary/$OS/$ARCH"
TMP=$(mktemp)
if command -v curl &>/dev/null; then
  curl -fsSL -o "$TMP" "$BINARY_URL"
elif command -v wget &>/dev/null; then
  wget -qO "$TMP" "$BINARY_URL"
else
  echo "Neither curl nor wget found. Please install one and retry." >&2
  exit 1
fi
chmod +x "$TMP"
mv "$TMP" "$BIN"
echo "  Installed to $BIN"

# ── Create data directory ──────────────────────────────────────────────────
mkdir -p "$DATA_DIR"

# ── Register agent with server ─────────────────────────────────────────────
echo "Registering agent..."
"$BIN" --server "$SERVER" \\
       --agent-id "$AGENT_ID" \\
       --token "$TOKEN" \\
       --name "$AGENT_NAME" \\
       --config "$DATA_DIR/agent.yaml"
echo "  Registration complete."

# ── Linux: create service user + systemd unit ─────────────────────────────
if [ "$OS" = "linux" ] && command -v systemctl &>/dev/null; then
  if ! id "$SERVICE_USER" &>/dev/null; then
    useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER" 2>/dev/null || true
  fi
  chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"

  cat > /etc/systemd/system/backuptool-agent.service <<EOF
[Unit]
Description=BackupTool Backup Agent
Documentation=$SERVER
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
ExecStart=$BIN --server $SERVER --config $DATA_DIR/agent.yaml
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=backuptool-agent
# Security hardening
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable backuptool-agent
  systemctl start backuptool-agent
  echo "  Systemd service 'backuptool-agent' enabled and started."
fi

# ── macOS: launchd plist ──────────────────────────────────────────────────
if [ "$OS" = "darwin" ]; then
  PLIST="/Library/LaunchDaemons/com.backuptool.agent.plist"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.backuptool.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BIN</string>
    <string>--server</string><string>$SERVER</string>
    <string>--config</string><string>$DATA_DIR/agent.yaml</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/var/log/backuptool-agent.log</string>
  <key>StandardErrorPath</key><string>/var/log/backuptool-agent.log</string>
</dict>
</plist>
EOF
  launchctl load "$PLIST"
  echo "  launchd service com.backuptool.agent loaded."
fi

echo ""
echo "Done! The BackupTool agent is running and connected to $SERVER."
echo "You can monitor it in the BackupTool web UI."
`;

  res.setHeader("Content-Type", "text/x-shellscript");
  res.setHeader("Content-Disposition", `inline; filename="install.sh"`);
  res.send(script);
});

// ── GET /api/agents/install/:agentId/:token/install.ps1 ──────────────────────
// PowerShell installer for Windows.

installRouter.get("/install/:agentId/:token/install.ps1", (req: Request, res: Response) => {
  const { agentId, token } = req.params;

  if (!validateInstallToken(agentId, token)) {
    res.status(401).send('Write-Error "Invalid or expired install token."; exit 1');
    return;
  }

  const srv = serverUrl(req);
  logger.info({ agentId }, "Serving PowerShell install script");

  const script = `# BackupTool Agent — Windows installer
# Run with: irm ${srv}/api/agents/install/${agentId}/${token}/install.ps1 | iex
#Requires -Version 5.1
$ErrorActionPreference = 'Stop'

$Server    = "${srv}"
$AgentId   = "${agentId}"
$Token     = "${token}"
$AgentName = $env:COMPUTERNAME
$InstallDir = "$env:ProgramFiles\\BackupTool"
$DataDir    = "$env:ProgramData\\BackupTool\\agent"
$BinPath    = "$InstallDir\\backuptool-agent.exe"

Write-Host "BackupTool Agent installer" -ForegroundColor Cyan
Write-Host "  Server: $Server"
Write-Host ""

# ── Download binary ────────────────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path $DataDir    | Out-Null

# ── Install restic if not present ─────────────────────────────────────────
if (-not (Get-Command restic -ErrorAction SilentlyContinue)) {
  Write-Host "Installing restic..."
  $ResticBin = "$InstallDir\\restic.exe"
  try {
    $latestJson = (Invoke-WebRequest -Uri "https://api.github.com/repos/restic/restic/releases/latest" -UseBasicParsing).Content | ConvertFrom-Json
    $ver = $latestJson.tag_name -replace '^v',''
    $resticUrl = "https://github.com/restic/restic/releases/download/v$ver/restic_\${ver}_windows_amd64.zip"
    $tmpZip = "$env:TEMP\\restic.zip"
    Invoke-WebRequest -Uri $resticUrl -OutFile $tmpZip -UseBasicParsing
    Expand-Archive -Path $tmpZip -DestinationPath "$env:TEMP\\restic_extract" -Force
    $extracted = Get-ChildItem "$env:TEMP\\restic_extract" -Filter "*.exe" | Select-Object -First 1
    Move-Item -Force $extracted.FullName $ResticBin
    Remove-Item $tmpZip -Force
    Remove-Item "$env:TEMP\\restic_extract" -Recurse -Force
    Write-Host "  restic installed to $ResticBin"
  } catch {
    Write-Host "  WARNING: Could not auto-install restic. Download from https://restic.net" -ForegroundColor Yellow
  }
} else {
  Write-Host "restic already installed."
}

$BinaryUrl = "$Server/api/agents/install/$AgentId/$Token/binary/windows/amd64"
Write-Host "Downloading agent binary..."
Invoke-WebRequest -Uri $BinaryUrl -OutFile $BinPath -UseBasicParsing
Write-Host "  Saved to $BinPath"

# ── Register agent ─────────────────────────────────────────────────────────
Write-Host "Registering agent..."
& $BinPath --server $Server --agent-id $AgentId --token $Token --name $AgentName --config "$DataDir\\agent.yaml"
Write-Host "  Registration complete."

# ── Install as Windows Service via sc.exe ──────────────────────────────────
$SvcName = "BackupToolAgent"
if (Get-Service -Name $SvcName -ErrorAction SilentlyContinue) {
  Stop-Service -Name $SvcName -Force -ErrorAction SilentlyContinue
  sc.exe delete $SvcName | Out-Null
}
sc.exe create $SvcName binPath= "\`"$BinPath\`" --server $Server --config \`"$DataDir\\agent.yaml\`"" start= auto DisplayName= "BackupTool Agent" | Out-Null
sc.exe description $SvcName "BackupTool backup agent — connects to $Server" | Out-Null
Start-Service -Name $SvcName
Write-Host "  Windows service '$SvcName' created and started."

Write-Host ""
Write-Host "Done! The BackupTool agent is running." -ForegroundColor Green
Write-Host "Monitor it at $Server"
`;

  res.setHeader("Content-Type", "text/plain");
  res.setHeader("Content-Disposition", `inline; filename="install.ps1"`);
  res.send(script);
});
