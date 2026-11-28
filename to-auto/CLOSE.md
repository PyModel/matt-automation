# Close: stages 8 to 10

Each stage is done per PIPELINE.md § Completion criteria per stage.

## 8. Final review

Brief a fresh reviewer with shell access: `review_base`, run branch, spec,
`GLOSSARY.md`, and ledger only. Load `code-review` by path and run both axes
against `review_base` and the spec (PITFALLS.md § code-review rows). Apply
`defensive-design` in Review mode to Tier 2/3 modules. Append LEDGER.md §
Subagent contract. Commit the report verbatim as `runs/<slug>/review.md`.

Send cited, authorized findings to one fixer. Log uncited leads and blockers.
Have an independent verifier check fixes against the new head and run the
suite; commit its report as `runs/<slug>/verify.md`. With no fixes, the initial
review and suite suffice. End each review report with:

```text
{ "verdict": "ship" | "no-ship", "head": "<full reviewed commit SHA>", "open": [<open findings>] }
```

In solo mode (CORE.md § Helpers), do both review axes and any re-verification
inline and label them self-review. If independent review is required, stop
with that blocker instead. The same suite, reports and gate apply.

`node ROOT/scripts/goal.mjs verdict <slug>` writes `final-verdict.json` from
the committed reports. One fix pass and targeted re-verification; if findings
remain, `goal.mjs stop <slug> "<open findings>"`. A changed head needs review
against the new snapshot before completion.

## 9. Hand back

Use `goal.mjs next`'s registered mode: `branch` leaves local commits;
`supervisor` runs `goal.mjs land <slug>` for the item-to-commit map; `pr`
pushes and marks the draft ready only under `push:<remote>` and `pr` grants
(CORE.md, Autonomous); the mode and the tracker configuration grant neither.
Return ticket worktrees. `node ROOT/scripts/goal.mjs handback <slug>` writes
`runs/<slug>/handback.md` from the run's state: branch and bases, verdict,
every guarded file changed and every grant with the owner's quoted words, the
pushes and PR writes the guard allowed, tickets not done with their reasons,
re-planned tickets, waived criteria, blockers, `bugs.md` entries closed as not
a bug, gates the owner's environment added and owner side tasks
(`goal.mjs event <slug> gate|side "<what>"` records each when it happens). The
owner judges whether the quoted words mean what the run took them to mean. Add
your judgment below its last line, never above it: any `goal/bootstrap`
fast-forward needed, glossary delta, quarantine, dirty-checkout warning, and
`frontier` overlaps (`cross_run`, BUILD.md § Merge conflicts). The tick of 9
refuses without the file, or when the run's state moved after it was written.

## 10. Retro

Run retro on the control plane's ledger, events, statuses and receipts, not
session logs. Write ranked proposals and budget used/cap to
`runs/<slug>/retro.md`; apply nothing. Run `node ROOT/scripts/goal.mjs tick <slug> 10`: one commit ticks 10, sets NOW to `stage: done` and moves the registry to `done`, then returns the run worktree. It requires a clean run worktree and the reviewed head.
Run `node ROOT/scripts/goal.mjs gc --delete-clean` per BOOTSTRAP.md § Kill
switch and GC; report `freedKB` and each `keep` reason (SKILL.md § Final report).
