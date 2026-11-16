---
name: claqe
description: CLAQE development loop. Reads CLAUDE.md, git state and docs/CLAQE_ROADMAP.md, picks the next approved task of the current milestone, implements, tests, reviews, commits locally and updates the roadmap, and continues until the milestone is done or a decision needs the user. Use only when the user types /claqe.
argument-hint: "[optional: focus, e.g. 'status', 'clips in D:\\phone', or a task name]"
disable-model-invocation: true
---

# /claqe — CLAQE development loop

You are the lead: the only session that edits code. Work through the **current approved milestone** in `docs/CLAQE_ROADMAP.md`, one verified subtask after another, without waiting for a new prompt between subtasks. Arguments (optional): $ARGUMENTS

## 1. Orient (always, briefly)

1. Read `CLAUDE.md` and `docs/CLAQE_ROADMAP.md`.
2. Run `git status --short`, `git branch --show-current`, `git log --oneline -5`, `git fetch -q origin` and `git status -sb`.
3. Stop and report if any of these hold: the branch is not `claude-development`; there are uncommitted changes you didn't make in this session (ask what to do with them); or the local branch is behind origin.
4. If the argument is `status`, report the roadmap status, the next task and anything blocked, then stop.

## 2. Pick the next task

- Take the first unchecked task of the milestone marked **Approved**. Use the argument as a hint if one was given.
- Skip tasks marked **[blocked]**. If the argument provides what a task was waiting for (for example the path to the user's phone clips), unblock and do it.
- No approved, unblocked task left? Report it and recommend the next milestone from the roadmap. **Do not start an unapproved milestone.**

## 3. Do the task

1. **Plan:** in 1–3 lines, say what and why. Read only the relevant files (CLAUDE.md).
2. **Research when useful:** use the `video-specialist` subagent for FFmpeg, WASM, codec, HDR or performance questions that need digging or measuring. Skip it for things you already know.
3. **Implement:** make focused changes and don't rewrite working code. Keep the minimal UX, current functionality and upload limits. No new major dependencies (ask first).
4. **Test:** run the relevant tests from `tests/` (`node --test <files>`; the real-render e2e files are slow, so pick the ones covering the change). Add or adjust tests for new behaviour or bugs found. Benchmark when render time or memory could change (`e2e/render-bench.mjs`, `e2e/tonemap-bench.mjs`) and compare with the numbers in the roadmap.
5. **Review:** read your own diff. For non-trivial changes (renderer, audio, security, anything user-visible), ask the `qa-reviewer` subagent to review the diff independently. Fix what it finds, or record why not.
6. **Commit locally:** stage named files only. Never stage `.dev.vars`, `.env*`, large media or personal footage. Use a clear message ending with the `Co-Authored-By` line.
7. **Update the roadmap:** tick the task, set the last verified commit and test results, and add findings, bugs or new subtasks. Commit that too (or include it in the task commit).
8. **Continue** with the next task of the same milestone.

Debugging rule: if the same failure survives 2 focused attempts, stop that task, record it in Known bugs, and move on or stop.

## 4. Stop and ask the user when

- the milestone is complete: then run the **full** suites (`cd tests && npm test`, `cd shotlist-api-dev && npm test`), record the results in the roadmap, and ask whether to push;
- a push is wanted (never push automatically, even to `claude-development`);
- something costs money (paid API or model calls, including the Worker's `/generate`), needs a new dependency, changes production, deployment, DNS or Cloudflare, or touches `main`;
- a product or UX decision isn't settled by the roadmap, or results contradict the plan;
- the task needs something only the user has (clips, music, devices, accounts).

## 5. Report (5 lines or fewer, per CLAUDE.md)

What was done (commits), test results, measurements, what's blocked or needs a decision, and the question if any.

## Hard rules (also enforced by `.claude/hooks/claqe-guard.mjs`)

Never merge into or push to `main`, force-push, deploy, change DNS or Cloudflare, call paid APIs without explicit approval, or read, print or commit credentials. Subagents are read-only, so only the lead edits files. Don't run benchmarks while a subagent runs tests.
