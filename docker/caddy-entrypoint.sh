#!/bin/sh
# Caddy entrypoint — writes a default Caddyfile if none exists, then starts
# Caddy with --watch so it automatically reloads when the server updates the config.

set -e

CADDY_DIR="/data/caddy"
CADDYFILE="${CADDY_DIR}/Caddyfile"

mkdir -p "${CADDY_DIR}"

# Write the default Caddyfile if it doesn't exist OR if it still contains
# the old HTTP-only default (so upgrades switch to HTTPS automatically).
if [ ! -f "${CADDYFILE}" ] || grep -q "^:80 {" "${CADDYFILE}" 2>/dev/null; then
  cat > "${CADDYFILE}" <<'EOF'
# Default Caddyfile — replace via Settings → Proxy / SSL in the BackupTool UI.
# Uses Caddy's internal CA to serve HTTPS immediately (self-signed).
# Browser will show a one-time security warning — this is expected.
# Configure a real domain + Let's Encrypt cert in the UI to remove it.

:80 {
    redir https://{host}{uri} 308
}

:443 {
    tls internal
    reverse_proxy server:3000
}
EOF
  echo "[caddy-entrypoint] Created default Caddyfile at ${CADDYFILE}"
fi

echo "[caddy-entrypoint] Starting Caddy (--watch mode)..."
exec caddy run --config "${CADDYFILE}" --watch
