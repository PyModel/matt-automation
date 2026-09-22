<p align="center">
  <img src="assets/banner.svg" alt="matt-automations: Matt Pocock's skills driven end to end, autonomously, in a loop" width="100%">
</p>

<p align="center">
  <a href="https://github.com/PyModel/matt-automation/actions/workflows/test.yml"><img alt="tests" src="https://github.com/PyModel/matt-automation/actions/workflows/test.yml/badge.svg"></a>
  <a href="https://github.com/mattpocock/skills"><img alt="Matt skills pinned" src="https://img.shields.io/badge/matt%20skills-pinned%20c55ee46-a78bfa?logo=git&logoColor=white"></a>
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A520-339933?logo=nodedotjs&logoColor=white">
  <img alt="harness" src="https://img.shields.io/badge/harness-any-22d3ee">
  <img alt="model" src="https://img.shields.io/badge/model-any-f472b6">
  <img alt="dependencies" src="https://img.shields.io/badge/dependencies-0-34d399">
</p>

<p align="center">
  Give it an objective, walk away, come back to reviewed commits on a branch.<br>
  Every run is routed by <code>ask-matt</code>, then driven through Matt's own skills with no human in the loop.
</p>

---

## ✨ What's inside

| | Path | What it does |
|---|---|---|
| 🎯 | [`to-goal/`](to-goal/SKILL.md) | The pipeline: **ask-matt → on-ramp → research → grill → spec → tickets → build → review → retro**. |
| 🐛 | [`to-bug/`](to-bug/SKILL.md) | `to-goal` with the route pinned to `diagnosing-bugs` and the bug fast path armed. |
| 🌱 | [`to-new/`](to-new/SKILL.md) | `to-goal` for a greenfield repo, package, service, or skill. |
| 🛰️ | [`to-orc/`](to-orc/SKILL.md) | Delegation-only orchestrator: pi workers on any model, gated evidence, a raw-JSON verdict. |
| 📌 | `vendor/mattpocock-skills/` | Upstream Matt skills as a git submodule, pinned to one commit. |
| 🔗 | `matt/<name>` | Committed symlinks into the submodule: the only place runs load Matt skills from. |
| ⚙️ | [`scripts/`](scripts) | `matt.mjs` resolves and checks skills; `goal.mjs` owns resumption, tickets, claims, and locks. |

## 🚀 Quick start

```sh
git clone --recurse-submodules git@github.com:PyModel/matt-automation.git
cd matt-automation
node scripts/matt.mjs check        # prints "ok"
```

Symlink `to-goal`, `to-bug`, `to-new` and `to-orc` into your harness's skills directory (for example `~/.agents/skills/` or `~/.claude/skills/`), then:

```text
/to-goal add rate limiting to the public API
/loop /to-goal add rate limiting to the public API   # or any recurring runner
```

A run also needs four installed skills: `kun`, `research-stack`, `defensive-design`, `zero-tech-debt`. They are found in `$AGENT_SKILL_HOMES` (path-separated), else `~/.claude/skills` and `~/.agents/skills`; `check` names any that are missing.

## 🔁 How a run works

1. **Route.** Stage `00` runs the wiring check and reads `ask-matt`; `to-goal/FLOWS.md` adds only the autonomy rules on top of its map.
2. **Resume anywhere.** Every invocation, first run or fiftieth loop tick, asks `goal.mjs next <slug>` where it stands. A ticked stage whose artifact is missing is not trusted.
3. **Build in parallel.** Tickets carry file claims; `goal.mjs take` hands out the frontier under a lock, and each ticket runs in its own worktree.
4. **Halt cleanly.** Every stop, yours or the run's own, goes through `goal.mjs stop`; `goal.mjs resume` picks up after you fix the cause.

## 🧰 Commands

```sh
node scripts/matt.mjs resolve ask-matt   # SKILL.md path a run loads
node scripts/matt.mjs check              # wiring + installed skills; prints pin and drift
node scripts/matt.mjs link               # regenerate matt/ after the pin moves
node scripts/goal.mjs next <slug>        # where a run resumes
node scripts/goal.mjs frontier <feature> # ticket grammar, frontier, overlapping claims
npm test                                 # unit tests · to-orc selftest · adversarial audit
```

## 📌 Bumping the Matt pin

```sh
git -C vendor/mattpocock-skills fetch && git -C vendor/mattpocock-skills checkout origin/main
node scripts/matt.mjs link && node scripts/matt.mjs check
```

A failing `check` means an upstream skill is new or renamed: give it a row in [`to-goal/INTEGRATION.md`](to-goal/INTEGRATION.md) (what the pipeline does with it, or `not used` and why), re-read [`to-goal/PITFALLS.md`](to-goal/PITFALLS.md), and commit the submodule, `matt/` and docs together.
