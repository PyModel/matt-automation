# Documented pitfalls in the sub-skills, and the guard for each

Source: the docs pages in `mattpocock/skills` (`docs/engineering/*.md`, `.agents/invocation.md`, commit 3cca18b, 2026-09-04). Each row is a reported, unfixed behaviour; the guard is what `/to-goal` does about it.

| Skill | Pitfall | Guard |
|---|---|---|
| research | The background agent re-spawns another research agent (issue #530); one task cost ~450k tokens across three runs. | Brief the agent: "You are already the research subagent; do the reading yourself and spawn no further agents." Watch the task list; stop a duplicate. |
| research | No stopping criterion: goes too deep or misses the one detail. | One narrow question per call; the requirement it must answer is in the brief. |
| ask-matt | Reports user-invoked skills as "not installed" because the harness hides them from the skill list. | They are installed; load by path. The path table in SKILL.md is the authority. |
| ask-matt | Describes a skill from its one-line gloss, not its SKILL.md; once told the user to skip to-spec and undercounted the work. | Open the SKILL.md before acting on any load-bearing claim; never skip spec or tickets on the router's word. |
| grill-with-docs | Inside an orchestration layer the interview runs but `CONTEXT.md`/ADR writing silently does not. | Verify `CONTEXT.md` changed on disk before leaving stage 4. |
| grill-with-docs | Loads `grilling` without `domain-modeling` and produces a question dump with no paper trail. | Two Skill tool calls, one per skill; confirm both loaded. |
| grill-with-docs | Most decisions live only in the conversation; precise answers soften downstream. | Log every answer; re-read the spec against the log before publishing. |
| to-spec | `ready-for-agent` on the parent spec makes AFK agents build the whole spec in one run. | Strip the label after to-tickets. |
| to-spec | Does not link ADRs or search the tracker for duplicates. | Search the tracker and `tracker/` for overlapping work in stage 1. |
| to-spec / to-tickets | Clearing or compacting between them makes to-tickets re-fetch and truncate a large spec. | One unbroken window through stage 5; keep a local copy of the spec regardless of tracker. |
| to-tickets | Over-decomposition (twelve tickets for a three-line change) and horizontal one-layer tickets. | Demo-path line per ticket; merge any ticket that has none; 3–7 tickets by default. |
| to-tickets | Acceptance criteria that pass before any work is done, or that another ticket owns. | For each criterion name the observation that would show it false and confirm it fails at the base commit. |
| to-tickets | GitHub tickets not created as sub-issues; "Blocked by" written into the body (issues #554, #513). | `gh issue create --parent`, `--blocked-by`; body text only as fallback. |
| implement | Ends at the commit; never closes the ticket or ticks acceptance boxes, so the frontier never advances. | The orchestrator ticks boxes and sets status after each ticket returns. |
| implement | Several implements in one checkout corrupt each other (amend on another's commit, vanished stash); `refs/stash` is shared even across worktrees. | One worktree and branch per ticket, one per run; parallel only on disjoint file scopes; never stash. |
| implement | `#2` resolves against any visible numbered list. | Pass full paths or `owner/repo#n`; restate the ticket title before building. |
| implement | Commits to whatever branch is checked out; no PR mode. | Every commit lands on a `goal/<slug>-t<NN>` ticket branch inside its own worktree; the user's checkout is never touched. |
| tdd | Asks the user to pick a seam; refuses to write a test at an unconfirmed seam. | Seams are agreed in stage 4 and written into the spec's Testing Decisions; pass them in the ticket brief. |
| tdd | Writes the implementation before the test; writes browser tests first and loops on them. | Brief: red first; browser tests after the behaviour works. |
| tdd | Proposes work belonging to a sibling ticket. | Pass the spec path alongside the ticket; right-size tickets in stage 5. |
| code-review | Diffs `<fixed>...HEAD`, so uncommitted work is invisible. | Commit before every review. |
| code-review | Sub-agents rediscover the skill and fan out (50+ agents reported). | Add to both sub-agent briefs: "Do not invoke code-review or spawn additional agents; perform this review directly." |
| code-review | Name clash with Claude Code's built-in `/code-review`. | Call the Skill tool with the exact name listed in this harness; if the built-in answers, invoke `mattpocock-skills:code-review` explicitly. |
| all | A bug noticed while reading a file is parked as a comment or "known issue" and lost by the next context. | SKILL.md § Bugs found in flight: record in `bugs.md`, fix or ticket now, blocker otherwise; deferral markers are cited review findings. |
| code-review | Finds new leads every run; no convergence; findings are hypotheses. | One final pass; act only on findings with a cited rule or spec line; list the rest. |
| code-review | Same session reviewing its own diff is confirmation bias. | Per-ticket review runs in the ticket's subagent; the final pass runs from the orchestrator against the branch point. |
