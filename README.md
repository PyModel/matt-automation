# matt-automations

Autonomous drivers for [Matt Pocock's skills](https://github.com/mattpocock/skills). They route every objective through `ask-matt`, then run the Matt skills end to end without a human in the loop.

| Path | What it is |
|---|---|
| `to-goal/` | The pipeline: route (ask-matt) → on-ramp → research → grill → spec → tickets → build → review → retro. |
| `to-bug/`, `to-new/` | `to-goal` with the route pinned to a bug fix or a greenfield target. |
| `to-orc/` | A separate delegation-only orchestrator that dispatches pi workers. It does not use the Matt skills. |
| `vendor/mattpocock-skills/` | Upstream Matt skills as a git submodule, pinned to one commit. |
| `matt/<name>` | Committed symlinks into the submodule: the only place the automations load Matt skills from. |
| `scripts/matt.mjs` | Resolves skills, regenerates `matt/`, and checks the wiring. |

## Setup

```sh
git clone --recurse-submodules <this repo>   # or: git submodule update --init
node scripts/matt.mjs check                  # must print "ok"
```

Install the automations by symlinking `to-goal`, `to-bug`, and `to-new` into `~/.agents/skills/` (and `~/.claude/skills/`). The Matt skills do not need to be installed for the automations to work: `to-goal` loads them from `matt/` by path.

## Commands

```sh
node scripts/matt.mjs resolve ask-matt   # SKILL.md path the automations load
node scripts/matt.mjs check              # nonzero on any wiring drift; prints pin + installed-copy drift
node scripts/matt.mjs link               # regenerate matt/ after the pin moves
node --test scripts/matt.test.mjs
```

## Bumping the Matt pin

```sh
git -C vendor/mattpocock-skills fetch && git -C vendor/mattpocock-skills checkout origin/main
node scripts/matt.mjs link && node scripts/matt.mjs check
```

When `check` fails, a new or renamed upstream skill needs a row in `to-goal/INTEGRATION.md`: either what the pipeline does with it, or `not used` and why. Then re-read the upstream docs against `to-goal/PITFALLS.md` and commit the submodule, the `matt/` links, and the doc changes together.
