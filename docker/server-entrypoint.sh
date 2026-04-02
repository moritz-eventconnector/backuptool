#!/bin/sh
# Entrypoint for the BackupTool server container.
#
# Runs as root briefly to fix ownership of the /data volume (Docker mounts
# named volumes as root:root), then drops to the backuptool service user
# before starting the Node.js process.
set -e

# su-exec is Alpine's lightweight equivalent of gosu — switches user without
# leaving a root parent process.
chown -R backuptool:backuptool /data

# Copy agent binaries to the shared data volume so the install endpoint can serve them.
mkdir -p /data/binaries
cp -u /app/agent-binaries/* /data/binaries/

exec su-exec backuptool node dist/index.js
