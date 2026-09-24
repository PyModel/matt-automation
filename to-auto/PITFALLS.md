# Documented pitfalls in the sub-skills, and the guard for each

Source: the docs pages in `mattpocock/skills` (`docs/engineering/*.md`, `.agents/invocation.md`), read at commit 3cca18b (2026-09-04). The docs now live in `ROOT/vendor/mattpocock-skills/docs/`; re-read them against this table whenever the submodule pin moves. Each row is a reported, unfixed behaviour; the guard is what `/to-auto` does about it. Brief text in quotes is pasted verbatim.

| Skill | Pitfall | Guard |
|---|---|---|
| research | The background agent re-spawns another research agent (issue #530); one task cost ~450k tokens across three runs. | Brief: "You are already the research subagent; do the reading yourself and spawn no further agents." Watch the task list; stop a duplicate. |
| research | No stopping criterion: goes too deep or misses the one detail. | One narrow question per call; the requirement it must answer is in the brief. |
| ask-matt | Reports user-invoked skills as "not installed" because the harness hides them from the skill list. | Every skill is loaded by path through `matt.mjs resolve`; `matt.mjs check` in stage 00 proves each one is linked. |
| ask-matt | Describes a skill from its one-line gloss, not its SKILL.md; once told the user to skip to-spec and undercounted the work. | Open the SKILL.md before acting on any load-bearing claim; never skip spec or tickets on the router's word. |
| grill-with-docs | Inside an orchestration layer the interview runs but `CONTEXT.md`/ADR writing silently does not. | Verify `CONTEXT.md` changed on disk before leaving stage 4. |
| grill-with-docs | Loads `grilling` without `domain-modeling` and produces a question dump with no paper trail. | Resolve and read both files; confirm both loaded. |
| grill-with-docs | Most decisions live only in the conversation; precise answers soften downstream. | Log every answer; PLAN.md 5b reconciles the spec against the log. |
| to-spec | `ready-for-agent` on the parent spec makes AFK agents build the whole spec in one run. | PLAN.md stage 6 strips it. |
| to-spec | Does not link ADRs or search the tracker for duplicates. | PLAN.md stage 1 searches the tracker and `tracker/` for overlapping work. |
| to-spec / to-tickets | Clearing or compacting between them makes to-tickets re-fetch and truncate a large spec. | LEDGER.md § Compaction and context pressure; PLAN.md stage 5 writes the working copy. |
| to-tickets | Over-decomposition (twelve tickets for a three-line change) and horizontal one-layer tickets. | PLAN.md stage 6: demo path per ticket, 3–7 by default. |
| to-tickets | Acceptance criteria that pass before any work is done, or that another ticket owns. | PLAN.md 6b gate. |
| to-tickets | GitHub tickets not created as sub-issues; "Blocked by" written into the body (issues #554, #513). | PIPELINE.md § Tracker rules (`--parent`, `--blocked-by`). |
| implement | Ends at the commit; never closes the ticket or ticks acceptance boxes, so the frontier never advances. | BUILD.md § Bindings step 6. |
| implement | Several implements in one checkout corrupt each other (amend on another's commit, vanished stash); `refs/stash` is shared even across worktrees. | PIPELINE.md § Isolation. |
| implement | `#2` resolves against any visible numbered list. | Full paths (PIPELINE.md § Tracker rules); the brief restates the ticket title. |
| implement | Commits to whatever branch is checked out; no PR mode. | PIPELINE.md § Isolation: ticket branch in its own worktree. |
| tdd | Asks the user to pick a seam; refuses to write a test at an unconfirmed seam. | Seams agreed in PLAN.md stage 4 and passed in every ticket brief. |
| tdd | Writes the implementation before the test; writes browser tests first and loops on them. | BUILD.md implementer brief, rule 2. |
| tdd | Proposes work belonging to a sibling ticket. | The brief carries the spec path alongside the ticket and the ticket's claims. |
| code-review | Diffs `<fixed>...HEAD`, so uncommitted work is invisible. | Commit before every review. |
| code-review | Sub-agents rediscover the skill and fan out (50+ agents reported). | Add to both sub-agent briefs: "Do not invoke code-review or spawn additional agents; perform this review directly." |
| code-review | Name clash with Claude Code's built-in `/code-review`. | Load it by path from the pin (`matt.mjs resolve code-review`), which reaches Matt's skill whatever the harness ships. |
| code-review | Finds new leads every run; no convergence; findings are hypotheses. | CLOSE.md stage 8: one pass; act only on cited findings. |
| code-review | Same session reviewing its own diff is confirmation bias. | Per-ticket review over the whole `<ticket-base>...HEAD`; the final pass in a fresh subagent (CLOSE.md stage 8). |
| all | A bug noticed while reading a file is parked as a comment or "known issue" and lost by the next context. | BUILD.md § Bugs found in flight. |
