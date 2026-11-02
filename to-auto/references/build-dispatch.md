# To-auto build dispatch

## Commands
- Pass absolute paths to `goal.mjs` when cwd is the target repo; relative `runs/<slug>/…` paths fail with ENOENT.
- `goal.mjs commit` takes files, not directories: glob them and check the exit with `&&`.
- zsh does not word-split unquoted variables: call goal.mjs via `g(){ node <path>/goal.mjs "$@"; }` and pass file lists as arrays (`"${rel[@]}"`).
- Read each `goal.mjs` result before writing a file from it; `no such file or directory: node …` means nothing ran. Never pipe it through `tail` first.
- Get worktrees only from `goal.mjs worktree get` or `goal.mjs prepare-ticket`; never `git worktree add`.
- Draft contracts with `goal.mjs prepare-ticket <feature> <NN>`, fill every `<fill: …>`, pass `goal.mjs contract`; build briefs only with `goal.mjs brief`.
- Land only with `goal.mjs merge <feature> <NN> --check <suite>`.
- If the isolation guard denies a write, reword and retry once; never route around it.
- Write other files with a quoted heredoc (`<<'EOF'`); then grep for one distinctive line of each snippet.

## Claims, before dispatch
- `test -e` every claimed path.
- Grep tests and generated outputs for each literal the change alters (enum lists, `len == N`, SQL LIMITs, navigation destinations); claim every hit.
- For a changed exported type, interface or constructor, claim every fake, stub and conformer under `tests/` that must change.
- For a type, signature or union change, typecheck the prototype on a scratch tree and claim every failing file.
- For a move or rename, claim every doc, ADR and README linking the old path.
- Grant paths a routed lead or deleted helper will force (composition root, shared test helper) before dispatch.
- Add a blocking edge for each overlap `goal.mjs frontier` reports, and where a ticket reads a type, signal or config another introduces.
- An amendment taking a path an in-flight ticket holds: record `+path (exclusive)` with the reason and block on the holder.

## Criteria, before dispatch
- Scope each grep criterion to the ticket's claimed files.
- `contract` does not probe criteria that count compiler or test output: compile the tests at base yourself, never with `-q`, and claim every file named plus fixtures they import. Brief "no `-q`" beside the command.
- Check each numeric floor against the product of the axes it enumerates.
- Red at base: run each bug probe at base, save failure lines under `runs/<slug>/notes/`, delete the probe, confirm `git status --porcelain` is clean. A pass or compile error is not red; quote the assertion line with its test count.
- Grep each new test name at base and print the hit count per name; a hit means its red is not new.
- A deletion ticket pins each behaviour the deleted code still provides, fallbacks included, with a criterion green at base.
- Grep every run-specific fact in the brief (paths, classes, `file:line`, counts) at base; re-derive counts by script. Re-check scout "open" items at base before ticketing.
- Device-gated criteria: probe the device (accel check, headless boot ≤ 60 s); on failure mark them `blocked: host` up front.

## Environment
- Payload dirs in pool worktrees (`node_modules`, `.cache`, build output) must be real directories: pre-clone with `cp -cR`, then `diff -rq` against the owner checkout.
- Probe nesting before fan-out. With no Agent tool, run flat: implementers review inline, the orchestrator reviews after merge, and reviewer briefs run agent-spawning skill passes inline.
- Carry helper scripts from the prior run's `notes/scripts/` into this run's `notes/`, `sed -i ''` every run value, and require `grep -n '<old-slug>\|pool/<old>/'` to print nothing.
- Copy the baseline's counting scope from the prior ledger `- baseline:` line.
- Write each Agent prompt to `runs/<slug>/notes/dispatch-<NN>.txt` before sending it.

## Briefs and returns
- Implementer briefs: one heredoc or file write per Bash call.
- Every brief forbids `git checkout`/`git switch` in the owner checkout; use `git show <sha>:<path>`.
- A design or explorer return must name every listed file read; re-dispatch one that skipped any.
- A subagent `BUG:` line is a hypothesis: trace the callee before recording it in `bugs.md`.
- After a claims-breach, amend with `goal.mjs claim`; SendMessage a resumable implementer, else rebuild with `goal.mjs brief` and append its first-pass leads.

## Quiet-machine hold
- For a peer needing an idle machine, write `<run>/HOLD` and tell it the dispatch and release times; extend only by telling it before release.
- Implementers `test -e <run>/HOLD` before each build or test command; while held they run git, grep, reads, edits, tests-only commits and the hold-safe gates (typecheck, comments check, gate tests). The full gate runs at stage 7.
- Bound the hold by its release time, not a poll count. Check `uptime` each turn; on low load or release, delete HOLD and SendMessage the next gates.
