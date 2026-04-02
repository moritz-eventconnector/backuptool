#!/bin/sh
# Caddy entrypoint — writes a default Caddyfile if none exists, then starts
# Caddy with --watch so it automatically reloads when the server updates the config.

set -e

CADDY_DIR="/data/caddy"
CADDYFILE="${CADDY_DIR}/Caddyfile"

mkdir -p "${CADDY_DIR}"

# Write a minimal fallback Caddyfile only if one does not exist yet.
# The BackupTool server will overwrite this with the real config once the
# admin saves proxy settings in the UI.
if [ ! -f "${CADDYFILE}" ]; then
  cat > "${CADDYFILE}" <<'EOF'
# Default Caddyfile — replace via Settings → Proxy / SSL in the BackupTool UI.
:80 {
    reverse_proxy server:3000 {
        header_up Host {host}
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}
    }
}
EOF
  echo "[caddy-entrypoint] Created default Caddyfile at ${CADDYFILE}"
fi

echo "[caddy-entrypoint] Starting Caddy (--watch mode)..."
exec caddy run --config "${CADDYFILE}" --watch
