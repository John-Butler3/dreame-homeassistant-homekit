#!/usr/bin/with-contenv bashio
# Entry point for the Home Assistant add-on.
# Options are read by the app itself from /data/options.json.
set -e
mkdir -p /data/matter
export DMV_OPTIONS_FILE=/data/options.json
export DMV_HA_URL="http://supervisor/core"
export DMV_WEB_PORT="8099"
exec node /app/dist/main.js
