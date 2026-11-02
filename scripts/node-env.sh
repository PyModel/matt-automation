# Sourced by the launchd jobs (to-auto-watch.sh, pull-matt.sh): put nvm's default node first on PATH.
# launchd fixes PATH when the job loads, so a node version pinned there goes stale on the next nvm upgrade.
# Run nvm's default node (what the owner's shells run) when nvm is installed, else whatever node PATH has.
# An alias names a version prefix by whole components (24 is v24.x.y, 24.1 is v24.1.y, never v24.10); `system` keeps PATH's
# node; node, stable or an unknown alias falls back to the newest installed version.
nvm="${NVM_DIR:-$HOME/.nvm}" v=default i=0
while [ -f "$nvm/alias/$v" ] && [ "$i" -lt 10 ]; do v=$(cat "$nvm/alias/$v"); i=$((i + 1)); done
case "$v" in [0-9]*) v="v$v" ;; esac
newest() { for d in "$@"; do [ -d "$d" ] && printf '%s\n' "$d"; done | sort -V | tail -1; }
if [ "$v" != system ]; then
  bin=$(newest "$nvm/versions/node/$v/bin" "$nvm/versions/node/$v".*/bin)
  [ -n "$bin" ] || bin=$(newest "$nvm"/versions/node/v*/bin)
  [ -z "$bin" ] || PATH="$bin:$PATH"
fi
