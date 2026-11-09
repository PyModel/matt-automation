#!/bin/sh
# External trigger for `goal.mjs check --all`: a run that has left the pipeline never calls goal.mjs itself.
#   to-auto-watch.sh hook     SessionStart (compact) hook: print this repo's run problems into the session; always exit 0
#   to-auto-watch.sh notify   scheduled job: macOS notification naming each problem new since the last sweep; log every sweep
GOAL="$(cd "$(dirname "$0")" && pwd)/goal.mjs"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}"
. "$(cd "$(dirname "$0")" && pwd)/node-env.sh"
# stdout carries the problem lines; node's warnings and crashes go to their own file, so they never read as problems.
mkdir -p "$STATE"
out=$(node "$GOAL" check --all 2>>"$STATE/to-auto-watch.err")
rc=$?
# The same sweep names a skill link a harness lost (install.mjs --check), as rows of the same `<where> <name> <CODE>` shape.
# A sweep that could not run (no node, a crash with nothing on stdout) is a problem of its own, never "0 problem(s)".
[ "$rc" -le 1 ] || [ -n "$out" ] || out="$STATE to-auto-watch SWEEP_FAILED goal.mjs check --all exited $rc; see $STATE/to-auto-watch.err"
[ "$rc" -gt 1 ] || out=$(printf '%s\n%s' "$out" "$(node "$(dirname "$GOAL")/install.mjs" --check 2>>"$STATE/to-auto-watch.err")")

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
    # One line per sweep, the newest 1000 kept; the error file is bounded the same way.
    for f in "$log" "$STATE/to-auto-watch.err"; do
      [ ! -f "$f" ] || [ "$(wc -l < "$f")" -le 1000 ] || { tail -n 1000 "$f" > "$f.tmp" && mv "$f.tmp" "$f"; }
    done
    last="$STATE/to-auto-watch.last"
    # A problem's key is <state-dir> <slug> <CODE>; the message carries a STALE age that moves every sweep.
    # Only keys the last sweep lacked are news: a problem that clears, or another that appears, never re-announces an old one.
    new=$(printf '%s\n' "$out" | awk -v last="$last" 'BEGIN { while ((getline k < last) > 0) seen[k] } NF && !(($1 " " $2 " " $3) in seen)')
    keys=$(printf '%s\n' "$out" | awk 'NF { print $1, $2, $3 }')
    # A crashed sweep (exit 2+) saw no runs, so it keeps the last set beside its error and recovery is not news.
    [ "$rc" -le 1 ] || keys=$({ cat "$last" 2>/dev/null; printf '%s\n' "$keys"; } | awk 'NF && !seen[$0]++')
    seen=$(cat "$last" 2>/dev/null)
    printf '%s\n' "$keys" > "$last"
    if [ -n "$new" ]; then
      n=$(printf '%s\n' "$new" | grep -c .)
      open=$(printf '%s\n' "$out" | grep -c .)
      first=$(printf '%s\n' "$new" | head -1 | awk '{ $1 = ""; print substr($0, 2) }' | tr -d '\\"' | cut -c1-180)
      osascript -e "display notification \"$first\" with title \"to-auto: $n new run problem(s)\" subtitle \"goal.mjs check --all: $open open\"" ||
        printf '%s\n' "$seen" > "$last"   # not shown (no GUI session, notifications denied): still news next sweep
    fi
    exit 0
    ;;
  *)
    echo "usage: to-auto-watch.sh hook|notify" >&2
    exit 2
    ;;
esac
