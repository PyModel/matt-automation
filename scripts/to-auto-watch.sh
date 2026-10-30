#!/bin/sh
# External trigger for `goal.mjs check --all`: a run that has left the pipeline never calls goal.mjs itself.
#   to-auto-watch.sh hook     SessionStart (compact) hook: print this repo's run problems into the session; always exit 0
#   to-auto-watch.sh notify   scheduled job: macOS notification naming each problem new since the last sweep; log every sweep
GOAL="$(cd "$(dirname "$0")" && pwd)/goal.mjs"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}"
# launchd fixes PATH when the job loads, so a node version pinned there goes stale on the next nvm upgrade.
# Run nvm's default node (what the owner's shells run) when nvm is installed, else whatever node PATH has.
nvm="${NVM_DIR:-$HOME/.nvm}" v=default i=0
while [ -f "$nvm/alias/$v" ] && [ "$i" -lt 10 ]; do v=$(cat "$nvm/alias/$v"); i=$((i + 1)); done
case "$v" in [0-9]*) v="v$v" ;; esac
newest() { for d in "$@"; do [ -d "$d" ] && printf '%s\n' "$d"; done | sort -V | tail -1; }
bin=$(newest "$nvm/versions/node/$v"*/bin)
[ -n "$bin" ] || bin=$(newest "$nvm"/versions/node/v*/bin)
[ -z "$bin" ] || PATH="$bin:$PATH"
out=$(node "$GOAL" check --all 2>&1)
rc=$?

case "$1" in
  hook)
    dir=$(GOAL="$GOAL" node -e "import(process.env.GOAL).then((m) => console.log(m.stateDir(process.cwd()))).catch(() => {})" 2>/dev/null)
    [ -n "$dir" ] || exit 0
    mine=$(printf '%s\n' "$out" | grep -F "$dir " || true)
    [ -n "$mine" ] || exit 0
    echo "to-auto check: a run in this repo is off the pipeline. Reconcile NOW with the registry or stop the run before continuing (goal.mjs check <slug>):"
    printf '%s\n' "$mine"
    exit 0
    ;;
  notify)
    mkdir -p "$STATE"
    log="$STATE/to-auto-watch.log"
    printf '%s %s\n' "$(date '+%F %T')" "$(printf '%s' "$out" | grep -c . || true) problem(s)" >> "$log"
    # One line per sweep: past 2000 lines keep the newest 1000, so the log stays bounded.
    [ "$(wc -l < "$log")" -le 2000 ] || { tail -n 1000 "$log" > "$log.tmp" && mv "$log.tmp" "$log"; }
    last="$STATE/to-auto-watch.last"
    # A problem's key is <state-dir> <slug> <CODE>; the message carries a STALE age that moves every sweep.
    # Only keys the last sweep lacked are news: a problem that clears, or another that appears, never re-announces an old one.
    new=$(printf '%s\n' "$out" | awk -v last="$last" 'BEGIN { while ((getline k < last) > 0) seen[k] } NF && !(($1 " " $2 " " $3) in seen)')
    keys=$(printf '%s\n' "$out" | awk 'NF { print $1, $2, $3 }')
    # A crashed sweep (exit 2+) saw no runs, so it keeps the last set beside its error and recovery is not news.
    [ "$rc" -le 1 ] || keys=$({ cat "$last" 2>/dev/null; printf '%s\n' "$keys"; } | awk 'NF && !seen[$0]++')
    printf '%s\n' "$keys" > "$last"
    if [ -n "$new" ]; then
      n=$(printf '%s\n' "$new" | grep -c .)
      open=$(printf '%s\n' "$out" | grep -c .)
      first=$(printf '%s\n' "$new" | head -1 | awk '{ $1 = ""; print substr($0, 2) }' | tr -d '\\"' | cut -c1-180)
      osascript -e "display notification \"$first\" with title \"to-auto: $n new run problem(s)\" subtitle \"goal.mjs check --all: $open open\""
    fi
    exit 0
    ;;
  *)
    echo "usage: to-auto-watch.sh hook|notify" >&2
    exit 2
    ;;
esac
