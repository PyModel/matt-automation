#!/bin/sh
# Hourly job (pull-matt.plist): fast-forward the vendored Matt skills unless a to-auto run is live (matt.mjs pull).
. "$(cd "$(dirname "$0")" && pwd)/node-env.sh"
echo "$(date '+%F %T') $(node "$(cd "$(dirname "$0")" && pwd)/matt.mjs" pull 2>&1 | tr '\n' ' ')"
