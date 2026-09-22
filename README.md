# matt-automations

Autonomous drivers for [Matt Pocock's skills](https://github.com/mattpocock/skills). They route every objective through `ask-matt`, then run the Matt skills end to end without a human in the loop.

| Path | What it is |
|---|---|
| `to-goal/` | The pipeline: route (ask-matt) → on-ramp → research → grill → spec → tickets → build → review → retro. |
| `to-bug/`, `to-new/` | `to-goal` with the route pinned to a bug fix or a greenfield target. |
| `to-orc/` | A separate delegation-only orchestrator: pi workers on any model the run names. It does not use the Matt skills. |
| `vendor/mattpocock-skills/` | Upstream Matt skills as a git submodule, pinned to one commit. |
| `matt/<name>` | Committed symlinks into the submodule: the only place the automations load Matt skills from. |
| `scripts/matt.mjs` | Resolves skills, regenerates `matt/`, and checks the wiring. |
| `scripts/goal.mjs` | The mechanical half of a run: where it resumes, the ticket frontier and claims, control-plane locks and commits. |

## Setup

```sh
git clone --recurse-submodules <this repo>   # or: git submodule update --init
node scripts/matt.mjs check                  # must print "ok"
```

Besides the vendored Matt skills, a run needs four installed skills: `kun`, `research-stack`, `defensive-design`, and `zero-tech-debt`. `resolve` and `check` look for them in `$MATT_SKILL_HOMES` (path-separated) when set, else in `~/.claude/skills` and `~/.agents/skills`. `check` names any that are missing; `check --vendored` checks only this repo's own wiring (what CI runs).

Install the automations by symlinking `to-goal`, `to-bug`, `to-new` (and `to-orc`) into each harness's skills directory (for example `~/.agents/skills/` and `~/.claude/skills/`). Nothing is tied to one harness or model. The Matt skills do not need to be installed for the automations to work: `to-goal` loads them from `matt/` by path.

## Commands

```sh
node scripts/matt.mjs resolve ask-matt   # SKILL.md path the automations load
node scripts/matt.mjs check              # nonzero on any wiring drift; prints pin + installed-copy drift
node scripts/matt.mjs link               # regenerate matt/ after the pin moves
node scripts/goal.mjs next <slug>        # where a /to-goal run resumes (what every loop tick asks)
node scripts/goal.mjs frontier <feature> # ticket grammar, frontier, overlapping claims
npm test                                 # unit tests, to-orc selftest, adversarial audit
```

## Bumping the Matt pin

```sh
git -C vendor/mattpocock-skills fetch && git -C vendor/mattpocock-skills checkout origin/main
node scripts/matt.mjs link && node scripts/matt.mjs check
```

When `check` fails, a new or renamed upstream skill needs a row in `to-goal/INTEGRATION.md`: either what the pipeline does with it, or `not used` and why. Then re-read the upstream docs against `to-goal/PITFALLS.md` and commit the submodule, the `matt/` links, and the doc changes together.
