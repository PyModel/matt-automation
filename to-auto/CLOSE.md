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
pushes and marks ready only with the grants required by CORE.md.
Return ticket worktrees; report all `guarded_changes`, `grants`,
`dismissed_bugs`, waivers and stuck reasons. Include any `goal/bootstrap`
fast-forward needed, glossary delta, quarantine, dirty-checkout warning, and
`frontier` overlaps (`cross_run`, BUILD.md § Merge conflicts).

## 10. Retro

Run retro on the control plane's ledger, events, statuses and receipts, not
session logs. Write ranked proposals and budget used/cap to
`runs/<slug>/retro.md`; apply nothing. Run `node ROOT/scripts/goal.mjs tick <slug> 10`: one commit ticks 10, sets NOW to `stage: done` and moves the registry to `done`, then returns the run worktree. It requires a clean run worktree and the reviewed head.
Run `node ROOT/scripts/goal.mjs gc --delete-clean` per BOOTSTRAP.md § Kill
switch and GC; report `freedKB` and each `keep` reason (SKILL.md § Final report).
