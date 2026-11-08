# Changelog

All notable changes to Ouroboros. Versions follow [semantic versioning](https://semver.org/) (pre-1.0: a minor version may change behavior). The reasoning behind each change is in [DESIGN.md](DESIGN.md).

## 0.14.0 — 2026-11-08

- Knowledge graph legible by default: reference files fold into their skill and open on selection, each project is a region, "similar" and project lines are off until asked for, unconnected items wait in the side panel, overlapping names wait for zoom, and the view survives redraws.

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
