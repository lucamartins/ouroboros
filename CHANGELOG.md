# Changelog

All notable changes to Ouroboros. Versions follow [semantic versioning](https://semver.org/) (pre-1.0: a minor version may change behavior). The reasoning behind each change is in [DESIGN.md](DESIGN.md).

## 0.22.0 — 2026-11-10

- Learn now, promote on approval. A rule about a project that belongs in its CLAUDE.md or a rule file still waits for your approval before that file changes, but Claude knows it from the next session: it is saved at once as a project memory. Approving writes the line and retires the memory; rejecting keeps the memory. Until now such rules did nothing until you opened the inbox, and you could find yourself repeating a correction that was waiting there.
- If that memory is refined before you decide (an exception, a correction), the change waiting for the file is updated too.
- The session-start notice says what was learned once, and no longer repeats everything that is waiting after each review.
- Not for corrections of what a file says, the global CLAUDE.md, or the `queue` setting: those wait as before.
- 0.22.1: the correction count no longer includes you changing your own mind or adding an exception to what you said; a planning or design conversation no longer leaves "lessons" as memories; having to repeat something already saved is now detected from your own words, not only when the reviewer notices; the dashboard inbox shows when a waiting change is already active as a project memory. `node scripts/eval.mjs --sessions` measures the session-reading prompts on cases from real mistakes.

## 0.21.0 — 2026-11-10

- In `auto`, Ouroboros refines a memory it wrote itself without asking, as long as you never edited that file: a later turn or session that extends or corrects it updates it directly (undoable). A file you touched by hand, anything you wrote, and every CLAUDE.md or rule file of yours still wait for approval; `hybrid` and `queue` are unchanged.
- When a memory is refined, its one-line description and its line in `MEMORY.md` are updated with it, so the rule Claude actually reads is the current one.
- 0.21.1: found by simulating real use. An exception you add to a rule in a later session the same day is no longer called a conflict; a working path you confirmed is no longer dropped because a variable it names is not in the repo; a session continued one turn at a time (resume, headless calls) is reviewed instead of skipped forever; the session-start notice says what is waiting and says it once.

## 0.20.0 — 2026-11-10

- Fewer needless early reviews: a "recovery" is now a command that failed and then worked within the same turn, and retrying an edit until it applies no longer triggers one.
- An end-of-session learning must point at something real: a turn of yours that was reviewed, or a recorded failure-then-success. One that points at nothing waits for your approval instead of being written, whatever the autonomy.
- Robustness: a long knowledge check keeps its lock while it runs; on Windows the reviewer also works when Claude Code was installed with npm; capture events older than 400 days are deleted (use counts and the undo ledger are kept).
- `npm test` runs the suite (a bare `node --test` hangs on the fixtures).
- 0.20.1: found by running against the real model. The check that tells Claude "a file already covers this" found nothing on small setups and let a duplicate preference skill through; it now also recognizes a skill or rule file named after the topic. The `learn` and `inbox` skills pass their JSON as a file, which no longer trips Claude Code's command check.

## 0.19.0 — 2026-11-10

- Rules saved as memories (how you want Claude to work) are no longer archived for "not being used". Claude follows them from their line in the memory index without opening the file, so they looked unused exactly when they worked. Facts and pointers looked up on demand, and skills, still decay when nothing reads or invokes them.
- When you have to repeat something that is already saved, that is counted on the learning (shown in Knowledge › Learned), and from the second time one suggestion in the inbox asks to reword it. It never makes the learning more likely to be archived.
- "Sessions using a learning" is now "Sessions opening a learning", with what it can and cannot see.

## 0.18.0 — 2026-11-10

- A repository is one project everywhere. What a session in a worktree or a subfolder learned (the notice at the next session start, the inbox hint) now reaches every session of that repository; before, it waited for a session in that exact folder.
- From a worktree, project skills are written to the repository's main checkout, and changes go to its CLAUDE.md and rule files, not to the worktree's temporary copies.
- A change waiting for a file that no longer exists is closed with that reason instead of staying in the inbox as stale.

## 0.17.0 — 2026-11-10

- The correction rate is counted the same way before and after learning: one corrections-only reading of each whole session, with one definition and one model. Until now "after" mixed Claude's own count in the periodic review with the end-of-session reviewer reading only the last turns, so the comparison with the baseline did not hold. Counts made by the learning reviews are shown apart on the Overview.
- With learning on, each session end makes one more small model call for this (about the cost of a review, within the monthly budget). Rates shown for sessions before this version reflect only measure-mode reviews.

## 0.16.0 — 2026-11-10

- One answer to "where does this belong?" for every path: the file that already owns the topic, then a project memory, then a preference file, and the global CLAUDE.md only for what matters in every session.
- New destination for preferences valid on every project: one about a topic ("commits", "code review") goes to a personal skill for that topic, loaded when the topic comes up; one about certain files goes to a rule loaded with those files. Both are written without approval, so "remember that I prefer X" no longer lands by default in the global CLAUDE.md and its approval step.
- When Claude saves something in session and a skill, rule file or CLAUDE.md already speaks about it, the curator answers with that file so Claude patches it instead of creating a second copy.
- Your own rules in `~/.claude/rules` are now part of what the knowledge check reads.

## 0.15.0 — 2026-11-10

- Reviews of a session no longer start from nothing. Each one is told what the earlier reviews of that session saved, queued or did not save, so it refines an earlier learning instead of repeating it: Claude patches the file in session, and an end-of-session item marked as a refinement is folded into the file it refines.
- Something noticed but not settled yet (not verified, said once) can be left open by a review and is picked up by the next one, instead of being saved early or lost at the boundary between reviews.
- The end-of-session review of a tail sees the turns just before it as context, the end of the message the user is answering, and the failures the session worked through; a single last turn after an earlier review is reviewed instead of skipped.

## 0.14.0 — 2026-11-08

- Knowledge graph legible by default: reference files fold into their skill and open on selection, each project is a region, "similar" and project lines are off until asked for, unconnected items wait in the side panel, overlapping names wait for zoom, and the view survives redraws.
- 0.14.2: nothing is written on a label or a silence. A request Claude marks as yours ("remember that…") still skips the autonomy setting, but a correction or a change to a CLAUDE.md or rule file now waits in the inbox like any other; and a proposal the knowledge check returns no verdict for is checked once more and then waits for you, instead of being saved as new.
- 0.14.1: multi-line skill and memory descriptions (`>`, `|`, continued or quoted over several lines) are read in full, so previews show them; patching such a description replaces the whole value.

## 0.13.0 — 2026-11-08

- The knowledge graph is drawn with a vendored D3 subset (force layout, zoom, drag): the layout unfolds on screen, the camera glides to a selection, connections flow on focus, and what Ouroboros changed pulses. `prefers-reduced-motion` is respected. Still no install step and the same strict CSP.

## 0.12.0 — 2026-11-08

- Facts valid on every project are proposed as additions to the global `~/.claude/CLAUDE.md`, placed under the section they belong to and approved in the inbox. The separate `~/.ouroboros/user.md` profile is retired; a one-time migration turns its bullets into proposals.

## 0.11.0 — 2026-11-08

- Knowledge › Graph: skills, reference files, memories, CLAUDE.md and rule files with their links, mentions and shared use; broken `[[links]]` and unconnected items; filters and selection in the URL; an accessible side panel.
- 0.11.1: a local plugin's skills are listed from its folder.

## 0.10.0 — 2026-11-08

- The dashboard scales: server-side paging, filters and search on every list, the inbox grouped by project and then by file, bulk decisions per group, one project filter, and page state in the URL.

## 0.9.0 — 2026-11-08

- `/ouroboros:inbox`: go through pending entries in the conversation, one at a time, and approve, reject, skip, or discuss and edit them before anything is written.
- 0.9.1: each entry is a card with the user's own words from the session and the diff in the question.
- 0.9.2: word-level diffs; cards are copied verbatim, never hand-written.

## 0.8.0 — 2026-11-08

Mechanism review:
- Only a pure insertion counts as an addition; any rewrite is a correction and waits for the user, on both write paths.
- One evaluator at a time (a lease in the database); one pending change per file.
- The secret check runs on the added text; undo reverts only the lines its write changed.
- One memory-directory resolver (worktrees share their repository's memory); ancestor CLAUDE.md files are indexed; long sessions are reviewed in parts; the budget is checked before every model call; notices stay in their project.
- 0.8.1: the early in-session review fires after a recovery from repeated failures instead of after any long turn.
- 0.8.2: Knowledge › Learned shows one row per thing learned, with what it changed and why; Keep replaces Confirm.

## 0.7.0 — 2026-11-07

- Learning evaluation in four stages: screen, ground against the code, edit (one coherent change per owner file), validate in code. Pending changes to a file form one changeset, shown as a diff and re-applied to the current file on approval. Suggested fixes for workarounds; skill reference files as owners; `scripts/eval.mjs` (synthetic suite and replay).
- 0.7.1–0.7.3: the editor applies the rubric and sees other owners and sources of truth; conflicts with a written rule go to the user instead of being dropped.
- 0.7.4: the dashboard is organized around decisions.

## 0.6.0 — 2026-11-07

- One learning rubric (`scripts/rubric.mjs`) applied by every path that saves anything; triage routes each learning to the file that owns its topic.

## 0.5.0 — 2026-11-07

- Knowledge check: proposals are screened against existing CLAUDE.md files, rules, skills and memories before they are written or queued.

## 0.4.0 — 2026-11-07

- Lifecycle: reinforcement on use, daily decay and consolidation, merge on rediscovery, promotion to global facts, autonomy modes (`auto`, `hybrid`, `queue`), dashboard actions protected by a per-start token, `excludeProjects`, CI.
- 0.4.1: `/ouroboros:backfill learn` reviews past sessions into the approval queue.

## 0.3.0 — 2026-11-07

- Self-learning: periodic in-session reviews, end-of-session background review of the unreviewed tail, notices at the next session start, value and cost screens.

## 0.2.0 — 2026-11-07

- Manual learning: the curator (deduplication, routing, budgets, ledger), `/ouroboros:learn`, `/ouroboros:undo`, `/ouroboros:forget`, and the learning protocol injected at session start.

## 0.1.0 — 2026-11-07

- Measurement: capture hooks, a measure-only end-of-session reviewer, `/ouroboros:backfill`, and a read-only local dashboard.
