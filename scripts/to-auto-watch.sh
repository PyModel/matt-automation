#!/bin/sh
# External trigger for `goal.mjs check --all`: a run that has left the pipeline never calls goal.mjs itself.
#   to-auto-watch.sh hook     SessionStart (compact) hook: print this repo's run problems into the session; always exit 0
#   to-auto-watch.sh notify   scheduled job: macOS notification when the set of problems changes; log every sweep
GOAL="$(cd "$(dirname "$0")" && pwd)/goal.mjs"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}"
out=$(node "$GOAL" check --all 2>&1)

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
    printf '%s %s\n' "$(date '+%F %T')" "$(printf '%s' "$out" | grep -c . || true) problem(s)" >> "$STATE/to-auto-watch.log"
    last="$STATE/to-auto-watch.last"
    if [ "$out" != "$(cat "$last" 2>/dev/null)" ]; then
      printf '%s' "$out" > "$last"
      if [ -n "$out" ]; then
        n=$(printf '%s\n' "$out" | grep -c .)
        first=$(printf '%s\n' "$out" | head -1 | awk '{ $1 = ""; print substr($0, 2) }' | tr -d '"\\' | cut -c1-180)
        osascript -e "display notification \"$first\" with title \"to-auto: $n run problem(s)\" subtitle \"goal.mjs check --all\""
      fi
    fi
    exit 0
    ;;
  *)
    echo "usage: to-auto-watch.sh hook|notify" >&2
    exit 2
    ;;
esac
