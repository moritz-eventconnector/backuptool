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
exec su-exec backuptool node dist/index.js
