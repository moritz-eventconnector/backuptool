#!/bin/sh
# Caddy entrypoint — writes a default Caddyfile if none exists, then starts
# Caddy with --watch so it automatically reloads when the server updates the config.

set -e

CADDY_DIR="/data/caddy"
CADDYFILE="${CADDY_DIR}/Caddyfile"

mkdir -p "${CADDY_DIR}"

# Write the default Caddyfile if it doesn't exist OR if it still contains
# the old HTTP-only default (so upgrades switch to HTTPS automatically).
if [ ! -f "${CADDYFILE}" ] || grep -q "tls internal" "${CADDYFILE}" 2>/dev/null; then
  cat > "${CADDYFILE}" <<'EOF'
# Default Caddyfile — configure domain & SSL in Settings → Proxy / SSL.
:80 {
    reverse_proxy server:3000
}
EOF
  echo "[caddy-entrypoint] Created default Caddyfile at ${CADDYFILE}"
fi

echo "[caddy-entrypoint] Starting Caddy (--watch mode)..."
exec caddy run --config "${CADDYFILE}" --watch
