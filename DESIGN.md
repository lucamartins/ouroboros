# Ouroboros — design

> A Claude Code plugin that learns from your sessions on its own: it saves memories and creates/refines skills without being asked, in the spirit of Nous Research's Hermes Agent, and shows on a local dashboard what it learned, how much that is being used and what it costs.

Status: v0.21.1 — every phase implemented (§13), plus the learning evaluation (§7.2), the v0.8 mechanism review (§7.4), the inbox reviewed in the conversation (§9.3), a dashboard that scales (§9.1: server-side paging and filters, the inbox grouped by project and file, page state in the URL, one project filter), a knowledge graph (§9.4, read-only, drawn with a vendored D3 subset since v0.13) and a session learning state shared by every review of a session (§6.5, v0.15) and one order of destinations for every path, with a home for preferences that matter for one topic or one kind of file (§7.5, v0.16), one instrument for the correction rate (§9.2, v0.17) and one project per repository in every table (§9.1, v0.18). Next: read that rate on real use (§7.4) before adding mechanisms. Design decisions are summarized in [§12](#12-decisions).

---

## 1. Problem

Claude Code already has places to store learning — per-project auto memory (`~/.claude/projects/<proj>/memory/`, `MEMORY.md` index), personal skills (`~/.claude/skills/`, hot-reloaded), `CLAUDE.md` — but **nothing writes to them proactively**:

- native auto memory saves little, only 4 types (user, feedback, project, reference), and by design skips procedures and debugging fixes — exactly what Hermes turns into skills;
- there is no review loop: nothing native reviews a session and creates/patches skills;
- result: the user repeats the same corrections across sessions.

Hermes solves this with (a) explicit save triggers in its prompt, (b) a periodic background review, (c) skills as "procedural memory" refined through targeted patches and (d) hard size limits that force consolidation. Ouroboros reproduces this as a plugin.

## 2. Principles

1. **Three separate layers**: *capture* (deterministic hooks, no LLM, cheap, metrics only) → *reflection* (an LLM decides what to learn, on a cadence) → *curation* (deterministic rules decide where to write, dedupe, enforce limits, keep a ledger).
2. **No guessing user intent with heuristics.** Hooks never try to classify prompts; judging what is worth learning is always done by a model with the conversation in front of it.
3. **Every transcript segment is reviewed exactly once, and no review starts from nothing**: a per-session cursor records how far reviews have gone, and the session's learning state (§6.5) carries over what earlier reviews saved, queued and left open.
4. **Everything reversible**: every write has an origin, a diff and an undo.
5. **Hard limits** (like Hermes): fixed context budget; consolidate at 80%.
6. **Measure before learning**: phase 1 only measures, so there is a baseline to prove value against.
7. **Learn only from trusted sources**: user turns and verified outcomes — never from tool-provided text (web pages, command output), to avoid poisoning via prompt injection.
8. **Zero dependencies**: Node ≥ 22.13 (built-in `node:sqlite`), no `npm install`, no build step. Same behavior on Windows, macOS and Linux. The one third-party file is a D3 subset vendored as a static browser module for the graph (§9.4); it is committed, served by our own server and never fetched at runtime.

## 3. Architecture

```
Claude Code session
 ├─ SessionStart ─► inject the learning protocol (+ pending notices)
 │
 ├─ CAPTURE (async hooks, no LLM, metrics only) ──────────► events.db (SQLite, WAL)
 │    UserPromptSubmit      turn counter
 │    PostToolUse(Failure)  tool calls; error → recovery (also inside subagents);
 │                          skill use; memory read; write to memory/skill (ledger)
 │    UserPromptExpansion   typed /skill (does not go through PostToolUse)
 │
 ├─ REFLECTION A — periodic in-loop review (Stop, synchronous)
 │    every N user turns, or after a turn that recovered from failures  →  {"decision":"block", reason}
 │    Claude reviews the segment since the last review with the `learn` skill
 │    and writes (Write/Edit); ends with a structured result line
 │
 ├─ SessionEnd (≤1.5 s) ─► enqueue session + spawn detached worker
 │
 └─ REFLECTION B — end-of-session background review (detached Node worker)
      only the unreviewed tail (cursor → end) → compact digest
      → `claude -p` (Haiku, JSON schema) → proposals
      → CURATOR (deterministic): dedupe vs inventory → create | patch | skip
      → routing → limits → write → ledger → notice in the next session

Dashboard (node, 127.0.0.1) ◄── events.db + scan of memories/skills + transcript usage
```

### 3.1 Where things live

| Content | Location | Why |
|---|---|---|
| Facts relevant in every session whatever the task (who the user is, how they work, OS/shell facts) | the user's global `~/.claude/CLAUDE.md`, as additions under the section they belong to (§3.2) | Claude Code already loads it in every session; one global file instead of two |
| Preferences valid on every project that matter for one topic | `~/.claude/skills/learned-prefs-<topic>/SKILL.md`, a personal skill only the model invokes (§7.5) | Loaded when the topic comes up, not in every session |
| Preferences valid on every project that matter for certain files | `~/.claude/rules/learned-<topic>.md`, a user rule with `paths` (§7.5) | Loaded with the files it is about |
| Advanced config (routing, limits) | `~/.ouroboros/config.json` | Structures `userConfig` doesn't express well |
| Telemetry + ledger | `${CLAUDE_PLUGIN_DATA}/events.db` | Plugin state; persists across updates |
| Project facts | native auto memory (`~/.claude/projects/<proj>/memory/*.md` + `MEMORY.md`), resolved as Claude Code does: one directory per repository (its worktrees and subfolders share it), honoring `autoMemoryDirectory` (local, project or user settings) and `CLAUDE_CODE_PROJECT_DIR_NAME`; `paths.memoryDirFor` is the only place that computes it | Cooperates with the native mechanism instead of competing |
| Generic learned skills | `~/.claude/skills/learned-<name>/SKILL.md` | Apply to every project; prefix marks the origin |
| Project learned skills | target from the routing map (e.g. `**/acme-*` → `~/src/acme-skills/skills`) or the repo's `.claude/skills/`, in the repository's **main checkout** even when the session runs in a worktree | Don't leak into other projects; a worktree is temporary |

Ouroboros never writes to a CLAUDE.md (global or project) without the user's approval, even when the user asked for that change in the session: the request is queued and the user confirms it in the inbox (§7.3, autonomy).

Every memory/skill Ouroboros creates carries in its frontmatter:

```yaml
metadata:
  origin: ouroboros
  id: lrn_01J...          # ledger key
  confidence: 0.6        # 0.3 tentative … 0.9 near-certain
  created: 2026-11-07
  trigger: periodic       # periodic | recovery | session_end | manual
```

### 3.2 Global facts

A fact valid on every project is proposed as an addition to the user's global `~/.claude/CLAUDE.md`, through the same path as any change to an existing file: the screen routes it there, the editor reads the whole file and places it under the section it belongs to (or finds it already covered), code validates the edit, and the change waits in the inbox for the user. When the user has no global CLAUDE.md, it is created with a title (edits anchor on text the file holds).

Until v0.11 these facts lived in `~/.ouroboros/user.md`, a "global profile" Ouroboros wrote without approval and injected at `SessionStart`. It was retired in v0.12: it was a second global file next to the CLAUDE.md the user already curates, it repeated rules written there (two sources that drift apart and cost tokens twice), and it needed its own budgets, consolidation and rendering. Global facts are few (about one a week), so approving each costs little. On the first `SessionStart` of v0.12, `scripts/migrate.mjs` turns the profile's bullets into proposals for the global CLAUDE.md (the evaluation drops what that file already says), archives the profile learnings and moves the file to `~/.ouroboros/archive/`.

## 4. Plugin components

```
ouroboros/
├── .claude-plugin/
│   ├── plugin.json            # manifest + userConfig
│   └── marketplace.json       # the repo is its own marketplace
├── hooks/hooks.json           # all hooks, exec form: node <dispatcher> <event>
├── scripts/
│   ├── hook.mjs               # single dispatcher (one process per event)
│   ├── config.mjs             # plugin options (userConfig)
│   ├── settings.mjs           # ~/.ouroboros/config.json: routing, limits, exclusions
│   ├── paths.mjs              # resolves native memory, skills, config
│   ├── db.mjs                 # schema + migrations (node:sqlite)
│   ├── migrate.mjs            # one-time migrations of user-level state
│   ├── transcript.mjs         # JSONL → compact digest for the reviewer; cursor handling
│   ├── review-worker.mjs      # reflection B (claude -p), backfill, maintenance runs
│   ├── rubric.mjs             # the learning rubric (§7.1)
│   ├── evaluate.mjs           # learning evaluation: screen → ground → edit → validate (§7.2)
│   ├── triage.mjs             # the screen
│   ├── knowledge.mjs          # index of what Claude already knows, owners map, grounding
│   ├── changesets.mjs         # one pending change per file; edit validation
│   ├── textdiff.mjs           # added text, insertion check, line-level revert
│   ├── curator.mjs            # dedupe, routing, limits, writing, ledger, undo
│   ├── maintenance.mjs        # daily decay and budget trimming
│   ├── inventory.mjs          # scan of memories, skills and CLAUDE.md files
│   ├── inbox.mjs              # what waits for the user and the decisions on it (dashboard + inbox skill)
│   ├── graph.mjs              # knowledge graph derived from the files and usage (dashboard)
│   └── eval.mjs               # scores the evaluation with the real model (synthetic, replay)
├── skills/
│   ├── learn/SKILL.md         # review script (periodic review and manual: /ouroboros:learn)
│   ├── inbox/SKILL.md         # goes through the inbox in the conversation, one entry at a time
│   ├── undo/SKILL.md          # reverts the last (or a given) write
│   ├── forget/SKILL.md        # archives a learning
│   ├── backfill/SKILL.md      # measures or learns from past sessions
│   └── dashboard/SKILL.md     # starts the dashboard and opens the browser
├── dashboard/
│   ├── server.mjs             # native http, 127.0.0.1, JSON API
│   ├── api.mjs, actions.mjs   # read routes, write actions
│   └── public/                # build-free HTML/CSS/JS; hand-rolled SVG charts; d3.min.js (vendored D3 subset, graph)
├── test/                      # node:test suites, fixtures, synthetic eval cases
└── DESIGN.md
```

No `bin/` folder (it blocks installation through claude.ai/Cowork). Every file in this repository is in English.

### 4.1 `userConfig`

| Key | Type | Default | Use |
|---|---|---|---|
| `learning` | boolean | `true` | Inject the protocol at `SessionStart` (off = measure only) |
| `autonomy` | string (`auto`/`hybrid`/`queue`) | `auto` | Write policy (§7.3) |
| `learning_language` | string (`en`/`pt-BR`/`auto`) | `en` | Language of learnings and notices written to the user's files (`auto` = the conversation's language); edits to existing files follow that file's language |
| `reviewer_model` | string | `haiku` | Background reviewer model |
| `inloop_review` | boolean | `true` | Toggles reflection A |
| `background_review` | boolean | `true` | Toggles reflection B |
| `review_every_turns` | number | `10` | User turns between in-loop reviews |
| `early_review_failures` | number | `2` | Failures on the same command or file, before it worked, that trigger an early in-session review (at most one every 5 turns) |
| `judge_model` | string | `haiku` | Model of the learning evaluation (screen and editor, §7.2); follows `reviewer_model` when unset |
| `monthly_budget_usd` | number | `5` | Cap on every model call Ouroboros makes (reviewer, evaluation, correction count), checked before each call; when reached, the work waits until next month |

### 4.2 `~/.ouroboros/config.json`

```json
{
  "routing": [
    { "match": "**/acme-*", "skillsDir": "~/src/acme-skills/skills", "linkInto": "~/.claude/skills" }
  ],
  "limits": {
    "memoryIndexLines": 150,
    "learnedSkills": 30,
    "skillDescriptionChars": 250,
    "consolidateAt": 0.8
  },
  "archiveAfterDaysUnused": 60,
  "excludeProjects": []
}
```

## 5. Capture (hooks)

All in **exec form** (`"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/hook.mjs", "<event>"]`) — no quoting/shell issues on Windows. Capture hooks run with `async: true` (never block the session) and **only measure**; they never decide what is worth learning. Recursion guard: if `OUROBOROS_REVIEWER=1` (the reviewer's own sessions), every hook exits immediately.

| Event | Matcher | Mode | What it does |
|---|---|---|---|
| `SessionStart` | `startup\|resume\|clear\|compact` | sync | Creates the session row; injects the protocol (§6.1) + pending reviewer notices ("📝 since the last session I learned: …"); sweeps orphaned queue and respawns the worker if needed |
| `UserPromptSubmit` | — | async | Increments the turn counter |
| `UserPromptExpansion` | — | async | Typed `/skill` → `skill_used` |
| `PostToolUse` | `Skill` | async | `skill_used` (+ bumps `uses` if it is a learned skill) |
| `PostToolUse` | `Read` | async | Read inside a memory directory → `memory_read` |
| `PostToolUse` | `Write\|Edit` | async | Write to a memory or skill file → a `memory_write`/`skill_write` event (it also sees what Claude saves on its own). An observation only: the ledger, and so undo, covers curator writes (§7) |
| `PostToolUse` | `*` | async | Counts tool calls (per turn); closes an error → success sequence on the same target **within one user turn** as `recovery`, tagged with `agent_id` when inside a subagent (a failure in one turn and a success turns later are two events, not a working path; v0.20) |
| `PostToolUseFailure` | `*` | async | `tool_fail` with target (normalized file/command) and `agent_id` |
| `Stop` | — | **sync** | Reads the previous review result from `last_assistant_message`; decides whether to trigger a review (§6.2) |
| `SessionEnd` | — | sync, < 300 ms | Enqueues and spawns `review-worker.mjs` detached (`spawn` with `detached`, `windowsHide`, `unref`) |

Latency target: sync hooks < 150 ms (dominated by Node startup); async ones don't count.

## 6. Reflection

### 6.1 Injected protocol (Hermes's "system prompt", as session context)

Injected by `SessionStart`, short (~600 characters), so the plugin is self-contained and shareable:

> Ouroboros is active. Without being asked, save when you learn: a user preference, a correction of your approach, a project convention, an environment fact. When the user explicitly asks you to remember something, save it right away. Create or patch a skill when: you worked out a reusable multi-step workflow; you found the working path after errors; the user corrected your approach. Prefer patching what exists over creating new. Don't save what is derivable from the code/CLAUDE.md or what is ephemeral. When you save, say so in one line: "📝 learned: …". Details: skill `ouroboros:learn`.

Explicit "remember that…" requests need no detection: the protocol makes Claude save them immediately.

### 6.2 Reflection A — periodic in-loop review (Stop)

The `Stop` hook returns `{"hookSpecificOutput":{"hookEventName":"Stop","additionalContext": <script>}}` — which keeps the conversation going under the same loop protections as `decision: "block"`, without a hook-error notice — when:

- `stop_hook_active` is false (prevents loops), **and**
- `inloop_review` is on, **and** either
  - `review_every_turns` user turns have passed since the last review, or
  - the turn that just ended found a working path after failures: a `recovery` event (the same command failed at least `early_review_failures` times, then worked, here or in a subagent), and no review was requested in the last 5 user turns. Recoveries of file tools (an `Edit` that needed three tries, a `Read` of a wrong path) are recorded but do not trigger it: retrying until an edit applies is mechanics (v0.20).

  Until v0.8.0 the early trigger was a *long turn* (≥ 15 tool calls). Measured on 49 real sessions (308 turns), 32% of turns are that long, and only about a third of those worked through repeated failures: during feature work the early review fired every other turn, re-reading the whole context each time, mostly with nothing new to learn. A long turn alone is not a learning signal; a recovery is (the strongest procedural one, best captured while the context is fresh). Long turns are still recorded as a metric. Note: capture hooks are asynchronous, so a recovery on the very last tool call of a turn may land after the Stop hook and wait for the next review.

The `reason` tells Claude to run the `learn` skill over **the segment since the last review only** (it names the turn range and, when present, the recorded `recovery` events, including those from subagents), to be brief, and to finish with the result line:

```
[ouroboros] reviewed=<turns> corrections=<n> learned=<n> patched=<n>
```

On the next `Stop`, the hook parses that line from `last_assistant_message`, records it in `reviews`, and advances the session's cursor to the transcript position of the review. If the line is missing (Claude skipped the review), the cursor does not move and the segment falls to reflection B.

Cost is measured from transcript `usage` between the request and the next `Stop`. Most of the input is a cache read; the output is usually short. Measured end to end: a review with one save read ~64k cached tokens and wrote 187 output tokens. The next request comes `review_every_turns` turns later even if Claude skipped this one (`turns_at_last_review` moves when the request is made, the cursor only when the result line arrives). Subagent stops and `stop_hook_active` stops never request a review.

### 6.3 Reflection B — end-of-session background review

1. **Trigger**: `SessionEnd` (or an orphaned queued session found at the next `SessionStart`).
2. **Scope**: only the **unreviewed tail** — from the session's cursor to the end. A tail with a single user turn is skipped only when nothing ties it to the rest of the session: no earlier review, no `recovery` since, no open observation (one last turn after a review is often the correction of what that review saw).
3. **Digest**: `transcript.mjs` reduces the tail to user turns, assistant text, tool names and errors. The prompt adds the `recovery` events recorded since the last review, here or inside subagents (never full subagent transcripts; workflow agents are excluded entirely), and the session's learning state (§6.5). A tail that starts mid-session opens with the last 3 user turns before the cursor and what the assistant said between them, marked EARLIER (context only: not counted, not learned from alone). The assistant text right before a user turn keeps its end as well as its start, since that is where the question the user answers usually is. A tail over ~80k characters is first shrunk (tool calls, then long assistant text) and then split into parts at user turns, each reviewed by its own call with the USER numbering continued; the results merge into one review. Nothing in the middle of a long session is dropped (past 8 parts, the oldest middle parts are skipped and the review says so).
4. **Inventory**: titles + descriptions of the existing memories/skills in scope (so the model picks `patch` over `create`).
5. **Call**: `claude -p --safe-mode --model <reviewer_model> --output-format json --json-schema <schema> --tools "" --no-session-persistence --max-budget-usd 0.5 --system-prompt <short>`, `cwd` at `${CLAUDE_PLUGIN_DATA}/reviewer`, `OUROBOROS_REVIEWER=1`. Isolation is essential: a plain `claude -p` loads the user's whole environment (MCP servers, plugins, skills, CLAUDE.md) and a trivial call measured **US$ 0.78**; with `--safe-mode` and a custom system prompt the same call costs **US$ 0.0003**, and real session reviews cost US$ 0.002–0.008. `--safe-mode` also disables hooks, so the reviewer can't trigger the plugin; `--no-session-persistence` keeps its transcripts out of the user's projects.
6. **Output**: `{corrections, items: [{kind: global|memory|skill, scope?, memory_type?, title, text?, description?, body?, confidence, evidence, repeats?}]}`. Every item is recorded in `candidates` and goes through the **learning evaluation** (§7.2) before anything is written or queued; the reviewer sees only names and descriptions of what exists, so it never writes edits itself. A `duplicate` reinforces the existing learning (+0.1 confidence, max 0.9). `repeats` means "the user had to repeat something already saved" → *miss* metric (§9). If the evaluation fails (model error, budget), nothing is written: the items wait in the queue and the next queue check evaluates them.
   **Anchored evidence** (v0.20): principle 7 is checked by code, not only asked of the model. An item's `evidence` must cite a user turn that exists in what was reviewed or, when recoveries were recorded, describe an observed outcome. An item anchored on nothing is never written on its own: it is evaluated like the rest and then waits for the user, whatever the autonomy.
7. **Notices**: created items become a notice; the next `SessionStart` shows it to the user (`systemMessage`) and tells Claude (context), then marks it delivered.
8. **Corrections** (v0.17): with learning on, the worker first runs the correction-rate instrument (§9.2): one corrections-only call over what the session added since it was last measured (`sessions.measure_cursor`), independent of the review cursor. It runs even when the learning tail is skipped, and a failure never stops the learning review. The learning review still counts corrections for its own use; they do not enter the rate.
9. **Cost**: `total_cost_usd` and tokens from the result go to `reviews`. If the month's total ≥ `monthly_budget_usd`, the worker doesn't run. Measured end to end: a 23-turn session tail produced 3 corrections and 4 well-formed memories for US$ 0.008.

With `learning` off the worker runs in `measure` mode instead. `/ouroboros:backfill` uses `measure` by default (past sessions are counted, never learned from); `/ouroboros:backfill learn` reviews them oldest first as if Ouroboros had been active and sends every proposal to the approval queue.

**Phase 1 mode (`measure`)**: the same worker runs over the whole session but only returns `corrections` and candidate learnings, which are recorded and never written. This produces the baseline. `/ouroboros:backfill` runs it over past transcripts (newest first, with a dry run and confirmation) so the baseline exists from day one instead of after 1–2 weeks.

### 6.4 `learn` skill script (used by A and manually)

- Quality filters (Claudeception + Hermes): **real discovery** (not just reading docs), **verified** (it worked), **reusable** ("would this help in 6 months?"), **not derivable** from code/CLAUDE.md, **not ephemeral**, **trusted source** (user turn or observed outcome).
- Count corrections: user turns that redirected the approach, explicit or implicit ("hmm, the test broke again", "I prefer the other way").
- Classify: fact → memory (native type `user|feedback|project|reference`; cross-project → an addition to the global CLAUDE.md); procedure → skill.
- Always check what exists first; prefer a targeted patch.
- Memory format identical to native auto memory (frontmatter `name/description/metadata.type` + a line in `MEMORY.md`), plus `metadata.origin/id/confidence`.
- End with the result line (§6.2).

### 6.5 Session learning state (v0.15)

A review used to see only its own segment. With the periodic review every N turns, the end-of-session reviewer almost always got a short tail out of context: a first line like "1. yes 2. no" answering a question before the cursor, no idea what the review ten turns earlier had saved, and so no way to tell a refinement from a new fact. A learning that spans the boundary (a correction at turn 9, confirmed working at turn 12) was judged twice with half the evidence each time.

The state is what carries over (`scripts/session-state.mjs`), per session, read by every review:

- **What earlier reviews did**: each save (from the ledger, by `session_id`), each proposal waiting, in conflict, dropped, suggested or rejected (from `candidates`), with a ref, the file and the text. Derived from tables that already exist; nothing is stored twice.
- **Open observations** (`observations` table): something worth keeping that was not settled when a review ran (not verified yet, said once). The in-session review records them through the `learn` skill's apply step (`"open"`, closed with `"resolve"`); every later review of the session sees them, and the session's last review closes them all.

How each review uses it:

- **Periodic review (A)**: the Stop request lists the state and tells Claude to patch what the session already saved instead of creating, and to pass unsettled things in `"open"`. `curator.mjs inventory --session` prints it too, which is what survives a compaction.
- **End-of-session review (B)**: the prompt carries the state; an item may set `"refines"` to a ref. A refinement the screen keeps goes to the editor of that file (§7.2), which folds it in, instead of becoming a second memory.

Kept on purpose: the cursor and the exactly-once rule (state, not re-reading, is what connects segments), and both triggers.

## 7. Curation and write policy

**Single writer.** Every Ouroboros write goes through `scripts/curator.mjs` (`apply`, `undo`, `forget`, `inventory`). In-loop, Claude calls it from the `learn` skill (proposals as JSON on stdin); in phase 3 the background worker calls the same `apply` in-process. Claude's own direct writes to memory files (native auto memory) are still observed by the capture hooks, but only curator writes carry a ledger entry and can be undone.

Proposal item: `{ op: create|patch, kind: global|memory|skill, scope, memory_type, section, project_dir, name, title, description, body, text, target, old, new, append, confidence }`. A `global` fact (and a `memory` with `scope: global`; `profile` is accepted as the pre-v0.12 name) becomes an `append` to the global CLAUDE.md under `section`, refused as `duplicate` when a line of that file already says it, merged when the same fact already waits for approval, and queued like any CLAUDE.md change. A patch targets a learning id, an absolute path of a memory, skill, rule file or CLAUDE.md, or a name, and either replaces an exact `old` fragment with `new` or replaces the `description` (memory patches also update the `MEMORY.md` line). Native skills and memories can be patched (refined) too; they are then tracked with `origin_session = 'native'` and don't count against the learned-skill budget. Routing rules may set `linkInto` to create a directory link (junction on Windows) so skills kept in a separate repo load from `~/.claude/skills`.

Duplicates are **not** merged automatically: the curator answers `duplicate` with the existing target and Claude re-submits a patch — the model merges, the curator guards.

Default: **`autonomy = auto`** (like Hermes). Consequences:

- A proposal that passes the filters is written directly; one-line notice in the session (A) or in the next session (B).
- **Undo is mandatory from the first write**: `/ouroboros:undo` and a dashboard button revert using the ledger diff. When the file changed after the write (the user's edits, another learning), undo reverts only the lines that write changed, located by a line diff with surrounding context, and keeps the rest; it refuses only when those very lines were edited since. Each applied changeset records its ledger batch, so the dashboard can undo one change exactly (Activity, Proposals, *Undo change*); what the user undoes joins the past rejections the screen sees.
- Low confidence (< 0.5) still goes in, but is the first to be archived if unused.
- `hybrid`/`queue` modes are there for users who want to approve first (the inbox, §9.1 and §9.3).

Curator steps (`curator.mjs`, deterministic):

1. **Validate** schema and size.
2. **Dedupe**: lexical similarity (trigrams, Jaccard ≥ 0.6) against the scope's inventory → turns `create` into `patch` or drops it.
3. **Route**: `global` scope → the global CLAUDE.md or `~/.claude/skills/learned-*`; `project` → the project's native memory or `routing[].skillsDir`; no rule → the repo's `.claude/skills/`.
4. **Limits**: a write that takes a budget past 80% is flagged, and the daily maintenance (`maintenance.mjs`, §7.3) trims it: it archives the weakest items (merging and shortening were planned and never built; they wait for the correction rate to show the loop's value). A write past 100% is refused as `over_budget` until something is consolidated.
5. **Write** atomically (temp file + rename) and record it in `writes` with the diff.
6. **Notice** queued for the next session.

### 7.1 The learning rubric

A healthy self-learning loop needs one, explicit definition of "worth remembering", applied the same way by every path that writes, for every user and project. It lives in `scripts/rubric.mjs` and is injected verbatim into the end-of-session reviewer, the knowledge check, and the `learn` skill (`test/rubric.test.mjs` fails if the skill drifts); the session protocol carries a one-line version. The nine rules:

1. **Behavior change** — would the assistant act differently next time without it? (drop default behavior, generic practice, preferences already configured, alternatives to guidance that already handles the case)
2. **Standing** — a rule the user stated as lasting, repeated, or a recorded decision; not a one-time request.
3. **Not derivable** — absent from code, config, tests, git history and docs.
4. **Verified** — worked or stated by the user; what the project executes (triggers, commands, parameters, config) is ground truth, comments are not, and an observed outcome beats a comment.
5. **Durable** — no status, to-dos, counts, timings, issue numbers, finished work.
6. **Owner** — add to the skill/rule/doc that owns the topic, else a project memory, else a global fact; never a second copy.
7. **Correct the stale** — ground truth or an explicit change of rule fixes the outdated text; a one-off request never overturns a standing rule.
8. **Fix at the source** — a workaround for a fixable defect (a generated file not ignored, a broken script, a missing config line) becomes a suggested fix for the user, not knowledge.
9. **Trusted, no secrets.**

These came from reviewing real proposals by hand, item by item, and turning every judgment into a rule. The rubric is project-agnostic; everything user- or project-specific comes from the indexed knowledge.

### 7.2 Learning evaluation

Every proposal from a Claude-less path (end-of-session reviewer, learning backfill, approval queue) is evaluated before it is written or queued (`scripts/evaluate.mjs`). A change to an existing file is written only when two independent judgments agree: the **screen** and the **editor**. A new memory or skill has no file for an editor to read: it is written when the reviewer proposed it, the screen kept it and the curator's checks (dedupe, budgets, approval rules) pass. A proposal the screen returns no verdict for is never written: it is screened once more and then waits for the user (v0.14.2; until then it was treated as kept).

**Why it is built this way.** During development, the first learning backfill (60 proposals from 30 past sessions) and two rounds of hand review showed where single-pass judgment fails: a third of the proposals were already documented; the same fact arrived in two languages, or aimed at two different owners; one-off requests looked like rules; and, most of all, a proposal judged from *excerpts* of a file can repeat what the rest of the file already says, contradict another line of it, or contradict the code. Each proposal was also resolved alone, so two learnings could make conflicting edits to the same file, and an edit computed on one day was applied blindly days later.

**Stages:**

1. **Screen** (`scripts/triage.mjs`, one isolated call per 12 proposals). Inputs: the rubric; BM25 excerpts of what Claude already knows (`scripts/knowledge.mjs`: global and project CLAUDE.md, `.claude/rules`, skill bodies **and their reference files**, memories); sources of truth (CI workflows, manifests, deploy config); past rejections; and the **owners map** (every skill and rule file with description, sections and reference files). Verdicts: `drop` (with a rubric reason), `merge`, `keep` (new item, rewritten), `route` (the topic has an owner file: return the owner and the knowledge as one self-contained *claim*; the screen never writes edits), `fix` (a fixable defect: becomes a **suggested fix**, nothing is learned). Any verdict can flag a **stale owner** a source of truth contradicts, which becomes a correction claim for that file — only when the flag cites a file that really is a source of truth (checked by code: it exists and is not a knowledge file); a user preference can never flag documentation as outdated. A final pass merges duplicates across batches *by fact, not by target*, so the same fact sent to two owners is kept once.
2. **Ground** (no model). Identifiers the claims name — code spans, paths, dotted names, CONSTANTS, camelCase, `--flags` — are looked up with `git grep` in the tracked code and config of the project's repos (markdown excluded). "Not found" is evidence too.
3. **Edit** (one isolated call per owner file). The editor reads the **whole file** (outline plus related blocks, verbatim, when it is over 40k chars), **every learning pending for that file** (the new ones and those already waiting in a changeset), the grounding, the rubric, and what **other** files say on the same topics: knowledge the assistant already reads (a learning another file covers is `covered`, never copied) and related sources of truth (project evidence). Per claim: `covered`, `contradicted` (by the project), `adds`, `corrects` (the file is wrong; shown by the project or by the user explicitly changing a rule — a one-time request never overturns a standing rule), `conflict` (with another claim or the file, unsettled). Then **one coherent set of edits**: exact `old` fragments copied from the file, replaced by `new`; additions anchored after the line where they belong, in the file's style and language; only `corrects` edits may remove text; text elsewhere in the file that says the opposite must be fixed in the same set. Disagreements are settled by project evidence, then recency.
4. **Validate** (`scripts/changesets.mjs`, code, never the model). Each edit applies only if its fragment occurs exactly once and it leaves the frontmatter and headings intact; the text it **adds** holds no secret (checked on the added text, not the whole file, so a file that already contains something secret-looking does not let a new secret through); the whole set grows the file by at most 6,000 chars; an edit that no `adds`/`corrects` learning justifies is dropped. An edit is an **addition** only when it is a pure insertion: the old fragment survives intact inside the new text. Anything else rewrites what the file says (even one word: "Run X" to "Never run X"), so it is a **correction** whatever the editor called it: it is marked `corrects`, may remove at most 800 chars, and waits for the user. Learnings whose edits all fail are dropped with the reason.

**Conflicts go to the user.** A learning the editor judges `conflict` is never dropped: it waits in the dashboard's *Conflicts — you decide* section (and the session-start notice says so). "It is a new rule" marks it `confirmed`; it then skips the screen and goes to its file's editor, which must write it (as a correction of what the file says). "Keep the current rule" rejects it, which also feeds the past-rejections index.

**Changesets.** The result is at most one pending **changeset per file**: the validated edits, the learnings they implement, and the hash of the text they were composed against. A new learning for that file recomposes the changeset with everything pending, so changes never conflict. Approval (dashboard, `approve`) re-applies the edits to the *current* file: if the file changed but the fragments still fit, the change lands on top of the newer version; otherwise the changeset goes **stale** and the next queue check composes it again. Rejecting one learning of a multi-learning changeset recomposes the rest without it. Applying goes through the curator's ledger, so `undo` works as for any write. New items (`keep`) still go through the curator's create path (dedupe, budgets, routing); a create that turns out to duplicate an existing memory or skill becomes a claim for that file, so the editor folds in only what is new.

**Patches Claude writes in session** (the `learn` skill, which reads the files itself) skip the screen and editor but not the validation: they pass the same `applyEdits` rules, and one that rewrites text (or replaces a description) is a correction that waits for the user even in `auto`. When they need approval they join the file's pending changeset if the edits still apply together; if not, the pending changeset goes stale with the new learning attached and the editor composes both (a file never has two pending changes).

**One evaluator at a time.** Sessions end in parallel, the daily maintenance runs on its own and the dashboard can ask for a check, so the evaluation is a **queue with a single consumer**. A review records its proposals as `pending` and calls `drainQueue`, which takes a lease in the database (`meta`, 30 min expiry for a crashed holder, renewed before each model call so a long drain never loses it while it runs) and evaluates until nothing waits, including what other processes queued meanwhile, then looks once more after releasing it. A process that finds the lease taken leaves its work for the holder. A live session's proposals are evaluated together, so its notice says what happened to them. Before a composed changeset is saved, the database is checked again: if the user approved or rejected a change to that file while the model was running, the composition is discarded and redone. A changeset is written under the write lock, and only if the file still holds the text its edits were applied to.

**Why the model writes the edits but code applies them.** A model rewriting whole files would silently lose content, drift in style and, edit after edit, degrade the text. A model is still the right author for *where* and *how* a fact belongs in a document, and for noticing that a line elsewhere now contradicts it. Exact-fragment edits keep both: the model decides and writes, the code guarantees what can change, the user sees a diff, and the ledger undoes it.

**Approval rules**: corrections, and any change to `.claude/rules` or CLAUDE.md, always wait for the user, whatever the autonomy. Two exceptions, both decided by code from the ledger and never by a proposal: a rule file Ouroboros created for learned preferences takes additions like any learned file (§7.5), and, since v0.21, **a memory Ouroboros wrote and nobody edited since may be refined without approval in `auto`** (`ownUntouched`: Ouroboros created the file, and its text is exactly the result of Ouroboros's own last write). The "any rewrite waits" rule exists to protect what a person wrote; a memory saved ten minutes earlier by the same loop is not that, and making the user approve each refinement of it was the repetitive manual step the session state (§6.5) had just made common. One hand edit and the file is the user's again; in `hybrid` and `queue` nothing changes; conflicts still go to the user; the ledger undoes it.

**The description follows the body** (v0.21). Edits could not touch the frontmatter, so a refined memory kept its old one-line `description` and its old line in `MEMORY.md`, the very line a rule acts through (§7.3). The editor may now return a new `description` for a memory whose body its edits change; it becomes a description edit (`applyEdits`: the only frontmatter value that may change, checked by comparing the rest of the frontmatter; always a correction), and applying it rewrites the `MEMORY.md` line in the same ledger batch.

**Measured** on the same 60 real proposals: 26 dropped, 1 merged, 4 suggested fixes, 6 new items and 10 changesets (17 learnings) waiting, among them 1 correction and 3 conflicts detected and handed to the user; US$ 0.09 per full pass. By hand review, about 4 of the ~23 survivors are debatable (v0.6: about 10 of 26). Known gap: a stale line elsewhere in an owner that no claim names is not noticed (e.g. a skill saying a page has no route guard after one was added); a periodic audit of owners against sources of truth is the next step.

**Run against the real model (v0.20.1).** Until v0.20 every mechanism added since v0.14 had only been tested with a stand-in model. Three runs, all in throwaway directories: the synthetic suite (15/15 with the destinations in the prompts); two end-of-session reviews of one real session, with Haiku and with Sonnet; and a controlled session with known right answers, reviewed in two parts, plus the same requests typed into a live session with the plugin loaded. In the controlled session all five outcomes were right: a project rule became a project memory, a commit preference was added to the existing commit skill, a code-review preference became `learned-prefs-code-review`, "always reply in Portuguese" waited as a change to the global CLAUDE.md, and the tail's exception to the deploy rule came back with `refines` and became a correction of that memory instead of a second one. What the runs showed that tests could not: the owner check's score threshold (above); the `learn` skill's heredoc tripping Claude Code's command check, and its grep of global files being blocked outside the working directory (the skill now uses `--file` and leaves global files to `has_owner`); the corrections instrument disagreeing between models on borderline turns (a question, a numbered answer); and, on the real session, Haiku not re-proposing an item the first review had dropped as unconfirmed although the tail confirmed it. The refinement then waited for approval and left the memory's `description` and `MEMORY.md` line with the old wording; both were addressed in v0.21 and confirmed on the same run.

**Simulated use (v0.21.1).** Eight sessions written to look like real work (two projects, one sandbox so knowledge accumulates: a correction with a derivable fact and a one-off, a session with nothing to learn, a web page telling the assistant to "remember" something plus a pasted key, a repeated correction with an exception added, a working path found after failures, the same rule in a second project, an explicit change of a written rule, a session in Portuguese), reviewed end to end by the real reviewer, screen and editor, and three live sessions with the plugin loaded. What held: nothing was learned from the web page, the key was never stored, the one-off and the derivable fact were dropped, the empty session produced nothing, preferences valid everywhere became topical skills at once, the rule change became a correction of CLAUDE.md that waits, the Portuguese session was saved in English, and the Stop request made Claude review in session, use the session state and close with the result line (46k cached tokens read, 91 written). What it exposed and v0.21.1 fixes: the editor could not tell which of two same-day sessions was later (claims carried a date, not a time) and called the user's own exception to a rule a conflict; a working path the user confirmed was dropped as "unverified" because an environment variable it names is not in tracked files (absence is evidence only about what files contain); a one-turn tail that was skipped still moved the cursor, so a session continued one turn at a time (resume, headless calls) was never reviewed; and the session-start notice repeated "CLAUDE.md (1 change)" per review without saying what waits. **Open, by design and worth revisiting:** in both paths a rule about one project is routed to that project's CLAUDE.md, whose additions always wait for approval. In the simulation the first project had four sessions' worth of rules in one pending change and nothing active, and the user had to repeat a correction that was sitting in the inbox.

**Measuring it.** `node scripts/eval.mjs --synthetic` runs the evaluation with the real model on a fake project with known right answers (`test/eval/synthetic.json`: covered, contradicted by code, stale owner, duplicates across owners, one-off, skill reference owner, fix at source, conflict pair, derivable, new memory, a one-time request against a standing rule) and prints a score (12/12, about US$ 0.01 per run). `--replay` re-evaluates the proposals the user approved or rejected, on a copy of the database, and reports agreement. Run both after changing the rubric or a prompt.

Dropped, merged and suggested items stay visible in the dashboard with their reason and can be restored. Learnings are written in `learning_language` (`en` by default, `pt-BR` or `auto`); edits to existing files follow that file's language.

### 7.3 Lifecycle

```
proposal ─► active (conf. 0.3–0.9) ─► reinforced (+0.1 per use) ─► kept (the user pins it: never archived automatically)
                     │
                     ├─► archived (60 days unused, or merged into another)
                     └─► reverted (user undo; counts as a negative signal for the reviewer)
```

Archive = move to `~/.ouroboros/archive/` (out of context), never delete.

How each transition happens (phase 4):

- **Reinforcement**: the first read of a learned memory or use of a learned skill in a session adds +0.1 (hooks); a background review that rediscovers an existing item adds +0.1. Cap 0.9. Confidence only matters for what maintenance may archive (below), so the dashboard does not ask the user to "confirm" a learning; it offers **Keep** instead (`learnings.pinned`): a kept learning is never archived for being unused or trimmed for budget. Keep is shown only on learnings maintenance could archive (memories and skills Ouroboros created), with the date it would happen; files Ouroboros only added to (a skill, rule or CLAUDE.md it did not create) are never archived and cannot be: `forget` refuses them, since archiving would remove the whole file, and their changes are undone one by one instead.
- **Merge on rediscovery**: when the background reviewer's item is a `duplicate` of a memory or skill file, it becomes a claim for that file and the editor (§7.2) folds in only what is new (usually nothing: `covered`).
- **Promotion**: a `feedback`/`user` memory similar to one already saved in *another* project becomes a proposed addition to the global CLAUDE.md instead of a copy.
- **Daily maintenance** (`review-worker.mjs --maintain`, started by `SessionStart` at most every 20 h, results shown as notices):
  - *decay* — archive Ouroboros memories/skills unused for `archiveAfterDaysUnused` days whose confidence is below 0.7 (native items, CLAUDE.md files included, are never touched). "Unused" means never read (a memory file) or invoked (a skill), which is a real signal only for what is looked up on demand. A `feedback` or `user` memory states a rule, and its line in `MEMORY.md`, loaded in every session of the project, already says it: Claude follows it without opening the file. Until v0.18 those rules, saved at the default confidence of 0.6, were archived after 60 days precisely when they worked. Since v0.19 they are exempt from decay (`maintenance.actsThroughIndex`) and count as used when a budget is trimmed;
  - *trim* — memory indexes and learned skills past `consolidateAt` archive their weakest items (`confidence × (1 + log2(1 + uses))`) down to 70%. Nothing is merged or shortened: consolidation is archiving, by code, with no model call.
- **Misses** (v0.19): when the end-of-session reviewer reports that the user had to repeat something already saved (`repeats`), the learning's `misses` goes up. It never lowers confidence (the user cares about it; what failed is the text). From the second miss on, one suggestion goes to the inbox to reword it so it says when it applies, or to move it to the file that owns the topic.
- **Autonomy** (`auto` | `hybrid` | `queue`): proposals from Claude (`actor: inloop`) or the reviewer (`background`) that need approval are stored as `queued` candidates with their full payload; A request Claude labels as the user's (`actor: requested`; the `learn` skill's `"actor": "manual"`) skips the autonomy setting only: corrections and changes to rule files or a CLAUDE.md still wait, because the label is Claude's own and must not be what lets them through (v0.14.2). Only a decision the user makes on an entry (inbox, dashboard: `actor: manual`, set in-process, never from a payload) is always written. `hybrid` writes facts with confidence ≥ 0.7 and queues skills and tentative items. Changes to existing files wait as changesets (§7.2), shown as diffs. Approve/Reject in the dashboard runs the stored proposal through the curator, or applies/rejects the changeset.
- **Exclusions**: hooks do nothing at all in projects matching `excludeProjects`.

### 7.4 Mechanism review (v0.8)

A full review of the technical mechanisms against the quality bar (a healthy, consistent loop for any user or project) found three that needed a redesign and nine defects. Each has a regression test (`test/v08.test.mjs` and the updated suites).

| Finding | Before | Now |
|---|---|---|
| Additions could change meaning | An "addition" was any edit removing at most one word, so "Run X" to "Never run X" was written without approval | Only a pure insertion is an addition; any rewrite is a correction (§7.2, Validate) |
| In-session patches were not validated | The `learn` skill's patches were written as given; only the model's own `corrects` flag made them wait | The same validator as the editor; a rewrite waits for the user |
| Parallel evaluations lost learnings | Two processes could compose the same file at once and supersede each other's changeset; an unfit in-session edit created a second pending changeset | Single-consumer queue with a lease; re-check before saving; one pending change per file |
| The profile lost hand edits | Every write re-rendered `user.md` from its bullets, dropping prose, extra sections and multi-line bullets | Writes touch only the bullet lines they change |
| Secrets could slip in | The check compared the whole file before and after, so a file that already looked like it had a secret let a new one through | The check runs on the added text |
| Undo was coarse | Undo refused when the file changed at all, and per-file learning ids made "undo this learning" revert whatever was last | Line-level revert among later edits; undo per changeset (batch) |
| Three memory-dir resolvers | Curator, knowledge index and reviewer inventory computed the project's memory directory differently; a worktree got its own | One resolver, as documented by Claude Code (repository, worktrees shared, `autoMemoryDirectory`) |
| Ancestor CLAUDE.md unseen | The screen did not see CLAUDE.md files above the working directory, which Claude Code loads | They are indexed |
| Long sessions lost their middle | A tail over 80k characters kept its start and end only | Reviewed in parts |
| Budget checked once | Only before the reviewer call; screening, editing and consolidation could run past it | Checked before every call; cost recorded per call |
| Notices crossed projects | A notice from project A was injected into the next session of any project | Delivered to the same project (maintenance notices anywhere) |
| Merges could vanish | A proposal merged into one the same pass dropped disappeared with it | A merge follows its chain: it shares the target's drop or fix verdict with the reason, or is kept when the target is not saved |

**Kept as is**, because they hold up: capture through exec-form async hooks with a recursion guard; the per-session cursor (each segment reviewed once); isolated `--safe-mode` model calls; screen, ground, editor and validate as separate stages; changesets per file re-applied to the current text on approval; the ledger; conflicts handed to the user; one rubric for every path.

**Measured, not changed**: Sonnet as the evaluation model scored the same as Haiku on the synthetic suite (12/12, then 15/15 with three cases taken from real mistakes) at about 15 times the cost, so Haiku stays the default and `judge_model` lets a user choose. The suite is close to saturated; new cases should come from real disagreements (`--replay`).

**Open question**: the loop's value is not yet shown by the correction-rate metric (§9.2) on a large enough sample. Measuring that comes ahead of new mechanisms.

### 7.5 Routing: where a learning belongs (v0.16)

Until v0.15 *where* was decided before anything checked it, and in three ways: in session Claude picked a `kind` from a table in the `learn` skill, the curator mapped it mechanically (anything global became a line for the global CLAUDE.md), and only the end-of-session path had a screen that knew the owners. So "remember that I prefer X", the most common explicit request, landed by default in the one destination that costs context in every session and always waits for approval, even when X was about commits and a commit skill existed.

**One order, everywhere** (`scripts/router.mjs`, `DESTINATIONS`, injected verbatim into the reviewer and the screen and kept in step with the `learn` skill by `test/router.test.mjs`), most specific first:

1. the skill, rule file or CLAUDE.md that already owns the topic (a patch);
2. a project memory, when the fact only holds in one project;
3. a preference valid everywhere that matters for certain files: a user rule with `paths`;
4. a preference valid everywhere that matters for one topic: a personal skill for that topic;
5. the global CLAUDE.md, only for what is relevant in every session whatever the task.

**A home for topical preferences** (kind `preference`, with `topic` and optional `paths`). Claude Code has no cross-project auto memory, a user rule without `paths` loads in every session like CLAUDE.md, and the only mechanism that loads by topic is a skill. So: with `paths`, the preference is a line in `~/.claude/rules/learned-<topic>.md` (frontmatter `paths`, loaded when Claude touches matching files); without, a line in `~/.claude/skills/learned-prefs-<topic>/SKILL.md` (`user-invocable: false`; its description says when it applies; counts against the learned-skill budget). Preferences on the same topic share one file: the first creates it, the next ones are additions, a repeated one is a `duplicate`. Both are files Ouroboros creates, so they follow the autonomy setting like any learned skill. A rule file is "written by people" only when a person wrote it: `needsApproval` exempts a rule file the ledger shows Ouroboros created (`ownFile`, set by code from `learnings`, never taken from a proposal); corrections still wait.

**The owner check in session.** The end-of-session path has the screen; in session nothing looked. Now `curator.mjs apply` (the CLI the `learn` skill runs) looks for skills, rule files and CLAUDE.md files that own a new item (`findOwners`), in two ways: by **topic** (a preference's `topic` is the name of a skill or rule file: "commits" → skill `commit`, which owns it even when no word is shared with what it says today), and by **content** (a passage shares at least half of the statement's distinct terms, three at least, so an unrelated file never blocks). The search engine only ranks the passages. v0.16 also required an absolute BM25 score, which depends on how much knowledge exists: the first run against the real model, on a setup with three files, found no owner for a line the commit skill already had, and a duplicate preference skill was created (fixed in v0.20.1). A hit answers `has_owner` with the file and the excerpt; Claude reads it and re-submits a patch, or the same item with `owner_checked` when the topic belongs elsewhere. Same pattern as `duplicate`: the model merges, the curator guards. User-level rules (`~/.claude/rules`) are indexed as knowledge, which they were not.

## 8. Data model (`events.db`)

```sql
sessions  (id, project, cwd, transcript_path, started_at, ended_at, turns, tool_calls,
           turns_at_last_review, review_cursor, queued, reviewed_at, is_reviewer)
events    (id, session_id, agent_id, ts, kind, payload_json)
          -- kind: turn | tool_call | tool_fail | recovery | long_turn
          --       | skill_used | memory_read | memory_write | review_requested | session_end
learnings (id, kind, scope, project, path, title, confidence, status,
           trigger, origin_session, created_at, updated_at, uses, last_used_at, pinned)
          -- status: active | archived | reverted
writes    (id, batch, learning_id, ts, op, actor, session_id, file, before, after, reverted_at, title, why)
          -- title/why: what the batch learned and where it came from (v0.8.2); the learn skill passes the session id
          -- op: create | patch | archive | revert ; actor: inloop | background | requested | manual | native
reviews   (id, session_id, mode, trigger, model, turns_reviewed, corrections, learned, patched,
           input_tokens, output_tokens, cache_tokens, cost_usd, ts)
          -- mode: inloop | background | measure | corrections | manual ; instrument: 'corrections' on the rows the correction rate counts
candidates (id, review_id, session_id, kind, title, summary, evidence, confidence, outcome, payload,
            note, claim, target, changeset_id, triaged_at, decided_at, quotes, ...)
          -- quotes: the user's own words in the turns the evidence cites ("USER #12"), JSON [{ n, text }]
          -- outcome: queued | created | patched | duplicate | dropped | merged | suggested
          --          | dismissed | rejected_by_user | over_budget | error
changesets (id, file, kind, base_hash, edits, corrects, status, note, cost_usd, created_at, decided_at, learning_id, batch)
          -- status: pending | applied | rejected | superseded | stale | reverted
notices   (id, ts, session_id, project, text, delivered_at)   -- project NULL: any session
observations (id, session_id, text, ts, closed_at)   -- noticed by a review, not settled yet (§6.5)
meta      (key, value)   -- markers and the evaluation lease (lease:evaluate)
```

Candidate outcomes added in v0.8: `pending` (recorded, not evaluated yet) and `undone` (applied, then undone by the user).

WAL + `busy_timeout` for concurrent sessions. Versioned migrations in `db.mjs`. The daily maintenance deletes capture events older than 400 days (more than any range the dashboard shows), except `skill_used` and `memory_read`, which back the all-time use counts. The ledger is never pruned: undo needs it.

## 9. Dashboard

`/ouroboros:dashboard` starts `node dashboard/server.mjs` on `127.0.0.1:4747` (configurable port) and opens the browser. Build-free HTML/JS, hand-rolled SVG charts, light/dark theme, English UI. The launcher reuses a running server (`dashboard.json` in the data dir) or starts a detached one that shuts down after 4 h idle. Reads are GET-only; writes go to `POST /api/action`, which requires the per-start token (served by `GET /api/token`, readable only by the page's own origin), a same-origin `Origin` and a JSON body. Every request passes a `Host` check (anti DNS-rebinding), and pages carry a strict CSP.

### 9.1 Screens

One page per question, in a sticky top bar; the Inbox carries a count of what waits for the user, and the dashboard opens on it whenever something does.

| Page | Question | Content |
|---|---|---|
| **Inbox** | What needs my decision? | Entries grouped by project, then by target file (new items without one by kind; suggested fixes together), in `inbox.mjs`'s order: conflicts (a learning vs a written rule: "it is a new rule" / "keep the current rule"), changes to files (one diff per file with the learnings behind it; approve, reject, remove one learning), new items, suggested fixes. A group shows its first 20 entries with "Load more"; bulk approve/reject per group and for the whole filter; "check against knowledge" |
| **Overview** | Is learning working? | Corrections per 100 turns before vs after learning with the delta, learned count, sessions using a learning, misses, month cost vs budget; trend charts with the "learning on" marker; recently learned |
| **Knowledge** | What does Claude know? | **Learned**: one row per thing learned (each ledger batch), not per file: what it says (the title the writer gave, or the first sentence it added), why (the evidence, or the learnings of an approved change), where, from which session and how, what it saved or changed (a diff that opens on click), how often the file was used; actions Undo (only that change, later edits stay), Archive (only what Ouroboros created), Keep; undone rows behind a toggle next to the filter. Then every skill (personal, project and plugin skills in collapsible groups), memory (grouped by project) and instruction file, sortable by name, uses, last use or date; and **Graph** (§9.4) |
| **Activity** | What happened? | Sessions, reviews (with cost), proposals and their outcome (filter by kind, outcome, period), what the knowledge check dropped (restorable), corrections; sortable by date; on a narrow screen each row is a labelled card |
| **System** | Is it healthy, how good is it, what does it cost? | Capture and reviewer status, month cost; learning quality (outcome counts, approval and undo rates, why proposals were dropped, warnings); cost per review; context budgets; failed reviews and errors |

The Inbox page and the `inbox` skill (§9.3) share `scripts/inbox.mjs`: the same entries, the same decisions. Every count of what waits (the Inbox badge, System, the SessionStart hint) uses one rule, `inboxCounts` in `hook.mjs`, the same as `inboxEntries`.

**Lists at scale (v0.10).** Nothing is cut silently. Every list route returns `{ rows, total }` and takes `limit` (50 by default), `offset`, `q` (a substring of the row's text, matched in SQL), `project` and, where they apply, `kind`, `outcome`, `days`, `sort` and `dir`; the page shows "Showing 50 of 1,240" with "Load more", and counts come from `total`. Grouped lists (the inbox, the inventory) return each group's total and first rows, and `group` pages through one group. Knowledge › Learned builds diffs only for the page it returns. Bulk decisions take a filter (`{ project }` or `{ group }`) and the count the user confirmed; the server resolves the filter to entries and decides nothing when the count no longer matches.

**Projects.** One key everywhere since v0.18 (`paths.projectIdFor`): until then the dashboard and auto memory used the repository while the hooks keyed sessions, proposals, changes and notices by the session's folder, so a notice or an inbox hint from a session in a worktree or a subfolder never reached a session in the main checkout, a project skill learned in a worktree was written into the worktree (and lost with it), and a change proposed for a worktree's CLAUDE.md went stale forever once the worktree was removed. Now sessions, candidates, changesets and notices carry the repository's key (old rows are re-keyed once at `SessionStart`, from the folder they recorded); knowledge files are read from, and written to, the main checkout (`paths.stableDir`); and a change waiting for a file that no longer exists is closed with that reason instead of retried. A project is a repository's main checkout (so its worktrees and subfolders count as one) or, outside git, the session's folder; it is named after that folder, `~` for the home folder, and names that collide show the path. A learning belongs to the repository its file lives in, else to its session's project. The `projects` route lists them, and one Project filter is shared by Inbox, Knowledge and Activity.

**Page state in the URL.** `#<page>[/<list or anchor>][?filters]`, e.g. `#knowledge/learned?q=deploy&project=…` or `#activity/proposals?kind=skill&outcome=dropped&days=90`: refresh, back and shared links restore the page. Inbox anchors (`#inbox/p-<project>`) scroll within the page. Typing in a filter is debounced and updates only the list (the field stays mounted; stale responses are dropped). After an action focus goes to the control that was used, or to the next entry; re-renders keep the scroll position and open sections, and the Overview refreshes every minute only when its data changed. A request that fails empties only its own section.

Visual system: warm neutrals with one blue accent (primary actions, selection, data; filled surfaces under white text use a deeper `--accent-fill` for 4.5:1 in both themes), system sans, light and dark from the same tokens; lists and tables over card grids, cards only for decisions; one stroke icon set drawn in `app.js`; status always pairs a color with a word.

### 9.2 Metrics (definitions)

| Metric | Definition |
|---|---|
| Correction rate | Σ `reviews.corrections` ÷ Σ `reviews.turns_reviewed` over the reviews of **one instrument** (`reviews.instrument = 'corrections'`), 7-day moving average. Until v0.16 "before" was the small model reading whole sessions with one prompt, and "after" mixed Claude reporting on itself in the periodic review with the small model reading only tails with another prompt: not comparable. Now every figure comes from the same reading: one definition of a correction (`CORRECTIONS_RULES`), the reviewer model, the whole session. Measure-mode reviews (learning off, measure backfills) use that definition in their single call and are the baseline; with learning on, a corrections-only call runs at session end (`mode = 'corrections'`, about the cost of one review). What the learning reviews count themselves is shown apart (`selfReported`). **Primary value indicator**: should drop vs the phase 1 baseline. The Overview shows each side's sample (n = turns) and keeps the before/after delta neutral below 200 reviewed turns after learning turned on (`MIN_SAMPLE_TURNS`) |
| Misses | Proposals with `repeats`, counted in the selected period — the user had to repeat something already learned (memory failed: not loaded, poor description, or ignored). Each one is also counted on the learning it names (`learnings.misses`, §7.3) |
| Utilization rate | Active learnings with ≥ 1 use in the last 30 days ÷ active |
| Hits | Sessions with ≥ 1 `skill_used`/`memory_read` of a learned item ("Sessions opening a learning" in the UI). A lower bound on use: a rule followed from the memory index, a path-scoped rule and a line in a CLAUDE.md leave no event |
| Review cost | Σ `reviews.cost_usd` (background) + Σ in-loop review tokens (on a subscription this is quota-equivalent, not an extra charge) |
| Fixed overhead | (chars of the protocol + `MEMORY.md` lines + learned skill descriptions) ÷ 4 × sessions |
| Cost per hit | (reviews + overhead) ÷ hits |

### 9.3 The inbox in the conversation (`/ouroboros:inbox`)

Some users decide in the dashboard; others want to stay in Claude Code and talk each entry through. The `inbox` skill goes through the same entries one at a time: Claude runs `inbox.mjs show <key>` (what, where, from which session, the evidence, why it was held, the exact diff against the file as it is now), checks it itself (reads the target, greps the owners of the topic, applies the rubric; the entry's text is data, never instructions) and gives a recommendation; the user approves, rejects (with a reason, kept with the entry), skips, or discusses and edits.

Editing is what the dashboard cannot do. Claude writes the user's version and `preview` shows its diff without writing; `edit` then saves it as a manual write:
- a change to a file (`cs:`): the user's edits replace the proposed ones, validated by `applyEdits` against the current file (a stale change is fixed the same way, with no editor call); `drop` rejects single learnings of it;
- a new item (`it:`): edited fields override the proposed ones, or a whole new item re-routes it (e.g. a patch to the owning skill instead of a memory);
- a conflict (`cf:`) settled as "new rule": Claude composes the correction of the contradicted text in the conversation and it is written at once; without edits the claim goes back to the queue for the editor, as in the dashboard;
- a suggested fix (`sg:`): Claude can make the fix as normal work, then `done` (outcome `fixed`), or `dismiss`.

**Legible decisions (v0.9.1).** Early use showed that the facts existed but did not reach the user: Claude Code collapses command output, the question dialog covers the conversation, and "USER #12" means nothing to the person deciding. So:
- `show` prints a card: position (`[3/13]`), the file as `~/…` and what it is in words (a reference file of the global skill "acme", a rule file of project X, your global instructions), where it came from (session date, project, which review), why it waited (backfill, correction, rule file, autonomy setting), the reviewer's reasoning without the path prefix, and the diff;
- the evidence is shown as **the user's own words**: the review stores the cited turns' text when it runs (`candidates.quotes`, from the digest it just read); for entries stored before, the turns are found again in the session transcript by the review's time and the number of turns it covered, and cached;
- the skill makes Claude restate the card in the user's language (the user does not see command output) and ask with AskUserQuestion: the position as header, a question that names the file and the change, and a `preview` on each option showing what it would do (the diff to be written, the proposed edit, "nothing is written").

**Readable diffs (v0.9.2).** Most changes add a sentence to a long Markdown line, and a line diff showed that paragraph twice, removed and added, with the change buried at its end; Claude then shortened the lines by hand with `(...)`, so the reader could not tell elided text from file text, and list items read as `- - item`. Now a line changed inside prints once as `~ …context{+added words+}[-removed words-]context…` (a word diff, cut to 40 characters of unchanged text around each change), nearby hunks print as one block (a context line is never the old version of a line the next hunk changes), and the skill makes Claude copy the printed diff verbatim, never hand-write or elide one, keep one kind of information per card field, and keep each option to this entry's decision (a related fix elsewhere is its own question afterwards).

Every decision goes through the curator, so it lands in the ledger and is undoable. SessionStart tells the user when entries wait for them (with the notices, otherwise at most once a day): "N waiting for your decision: /ouroboros:inbox (or the dashboard)".

### 9.4 Knowledge graph (Knowledge › Graph, v0.11)

What Claude knows, drawn as a graph: which skills point to which, which memories link to each other, what belongs to which project, what is used together, and what stands alone. Hermes Agent shows a memory graph; Claude Code's own auto memory already writes `[[name]]` links between memories, which nothing displayed before.

**Derived, never stored.** `scripts/graph.mjs` builds it on request from the same files the knowledge check reads (`knowledgeFiles` of every known project, minus sources of truth), every memory directory and the plugin skills, plus the usage events. No new table, no new file, nothing written. The `graph` API route caches it like the inventory (5 s).

| Nodes | Edges (strongest evidence first) |
|---|---|
| skills, their reference files, memories, CLAUDE.md files, rule files; one hub per project | **link** (`[[name]]` resolved in the memory's own folder first, or a relative markdown link to another node); **mention** (a file names a skill: a hyphenated or `plugin:` name as a whole token, a plain-word name only as code, a `/command` or next to "skill", since `deploy` or `run` as words mean something else); **contains** (a skill and its reference files); **used** (used or read in the same sessions, at least twice); **similar** (TF-IDF cosine ≥ 0.3, top 2 per item, only between items not otherwise related: a hint, drawn dashed); **belongs** (item → project) |

A `[[link]]` that resolves to nothing is reported as a **broken link** on its file. Items with no link, mention, containment or shared use are **unconnected** (candidates to link, merge or retire). Plugin skills appear only when used or named by a non-plugin file, unless the user asks for all of them. The Project filter keeps that project's items, what they relate to one edge away (so a global skill a project memory names stays) and its hub.

**Drawing (v0.13: D3).** Until v0.12 Ouroboros drew the graph with an in-house force layout; it worked but read as flat and static, and the camera and drag code was the costliest part to keep right. v0.13 vendors a D3 subset as `dashboard/public/d3.min.js` (d3-force, d3-zoom, d3-drag, d3-selection, d3-transition and d3-ease with their own dependencies, about 70 KB, ISC license in its header), imported by `app.js` as an ES module. It is served from our origin, so the strict CSP (`script-src 'self'`) and offline use are unchanged, and it lives at the top of `public/` so the server's code fingerprint sees it. To rebuild it: in a scratch folder, `npm i d3-force@3 d3-zoom@3 d3-drag@3 d3-selection@3 d3-transition@3 d3-ease@3 esbuild`, an entry file that re-exports the functions `app.js` imports, then `esbuild entry.js --bundle --format=esm --minify --legal-comments=none`, and prepend the header with the versions and the license.

The drawing is SVG styled by CSS (theme variables, classes for state), so everything except layout, camera and drag stays ours. The layout unfolds on screen from a tight spiral while the camera follows it until the user takes over; items pop in, and items Ouroboros wrote or changed breathe (a pulsing halo). Dragging an item keeps the layout warm, so its neighbors follow. d3-zoom owns pan, wheel and pinch; selecting an item (in the drawing or the panel) glides the view to it and its neighbors, and Fit glides back to everything. A dot grid moves with the view. Relations are drawn as slight curves (structure — project, contains — stays straight), links and mentions take the color of the item they start from, and the connections of the hovered or selected item flow from source to target. Skills are always labelled and the layout keeps room for their names; a name that would overlap a bigger or better connected item's waits for zoom, hover or selection; other items are named on zoom, hover or selection. Hovering or selecting dims everything except the item and its neighbors. Under `prefers-reduced-motion` the layout is computed at once and no transition or animation runs. Positions are kept while the page is open.

**Legible by default (v0.14).** Drawing everything (about a hundred items, half of them one skill's reference files) gave a hairball. The page now draws less than the data holds, and every cut can be undone:
- **Reference files fold into their skill.** A folded skill wears a dashed ring and the number of files it holds; their connections are drawn from the skill. Selecting the skill (or one of its files, from the panel or the search) redraws with that skill open and glides there; selecting something else folds it again. "Open every skill" opens them all (`refs=all`).
- **Projects are regions.** Each project gets a fixed place on an ellipse (by name, from the whole data, so filters do not move it); its items are pulled there and a soft circle around its hub, named on top, marks it. What applies everywhere sits in the middle. Projects whose items are all unconnected wait on an outer ring. An item its links pull far from its hub stays outside the region rather than stretching it.
- **Fewer lines.** "Similar" (a hint) and "Project" (the regions say it) are off by default (`off=none` turns every type on); a folded file's connections merge into one line per pair and type.
- **Unconnected items wait in the panel**, which says how many are not drawn and can draw them ("Unconnected items", `lonely=show`). Selecting one from the panel draws it.

A redraw (a filter, a skill opening or closing) keeps the view and every placed item's position, so only what changed moves.

The side panel is the accessible path through the same data: with nothing selected it summarizes, lists the unconnected items and broken links, and browses every item by kind; a selected item shows its path, description, use, broken links and its connections grouped by how they read from its side ("Links to", "Named by", "Contains", "Used together with"…), each a button to move there, plus a link to it in the Knowledge lists. Filters for kinds and edge types, the search (highlights matches; one match selects it) and the selection live in the URL (`#knowledge/graph?hide=memory&off=none&refs=all&lonely=show&sel=…`).

Phase 1 is read-only on purpose. Later, the same graph could drive behavior: write `[[links]]` when Ouroboros creates a memory, turn broken links into suggested fixes and unconnected unused items into decay candidates, and link sources of truth to their owners so a change in a source re-checks the owners (the known gap in §7.2). Those wait until the correction-rate metric shows the loop's value (§7.4).

## 10. Distribution

- Public GitHub repository (MIT) that is its own marketplace (`.claude-plugin/marketplace.json`).
- Install: `/plugin marketplace add lucamartins/ouroboros` → `/plugin install ouroboros@ouroboros`.
- `claude plugin validate --strict` in CI.
- On Windows the reviewer runs `claude.exe` when the PATH has one (the native install), else the CLI script behind npm's `claude.cmd` shim with the current Node: Node cannot spawn a `.cmd` without a shell, and a shell would mangle the JSON schema argument (`resolveClaude`; unit-tested, not yet exercised on a real Windows npm install).
- Declared requirement: Node ≥ 22.13 on PATH. `SessionStart` checks the version and, if missing, warns once and disables the hooks silently.

## 11. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Memory pollution (auto mode) | Quality filters, dedupe, hard limits with consolidation, archive on disuse, undo |
| Infinite `Stop` loop | `stop_hook_active`; turn-count cadence; cursor only advances on a completed review |
| Learning latency | A correction is learned at most N turns later, still in the same session; the transcript stays on disk, so compaction loses nothing for reflection B |
| Cost of reviews with nothing to learn | Cache-read input, short output; cadence configurable; visible on the Cost screen |
| Latency | Async capture; a single Node process per event; reflection B off the critical path |
| `SessionEnd` 1.5 s budget | Only enqueues and spawns a detached worker; orphaned queue reprocessed at the next `SessionStart` |
| Recursion (reviewer fires hooks) | `OUROBOROS_REVIEWER=1` disables everything; separate `cwd`; sessions flagged `is_reviewer` excluded from metrics |
| Prompt injection teaching the agent | Learn only from user turns and observed outcomes; tool text never becomes a literal learning |
| Cross-project leakage | Scope-based routing; `excludeProjects` |
| Sensitive data written | Secret filter (token/key/password patterns) on the text each write adds; dashboard bound to `127.0.0.1` only |
| Concurrent evaluations | One consumer at a time (database lease); compositions re-checked before saving; writes under the write lock with an expected base text |
| The user's hand edits lost | Edits are exact fragments re-applied to the current file; undo reverts only the lines its write changed |
| Skill listing budget (~1% of context) | Cap on learned-skill count and description length; metric on the Health screen |
| Reviewer cost | Haiku, unreviewed tail only, compact digest, monthly cap |

## 12. Decisions

| Decision | Choice |
|---|---|
| Name | `ouroboros` |
| Autonomy | Fully automatic (like Hermes); `hybrid`/`queue` available as options |
| Reflection | Periodic in-loop review every N turns (+ early after a turn that recovered from repeated failures, at most every 5 turns) and an end-of-session background review of the unreviewed tail |
| Context of a review | The session's learning state (what earlier reviews saved, queued, left open) goes to every review, and a tail gets the turns before its cursor as context; segments are still reviewed once (§6.5) |
| Correction rate | One instrument: a corrections-only reading of each whole session with one definition and one model; counts made by the learning reviews are shown apart (§9.2) |
| Prompt classification | None — no regex or per-prompt classifier; corrections are counted by the reviews |
| Where a learning goes | One order of destinations for every path: owner file, project memory, path-scoped user rule, topical preference skill, global CLAUDE.md last; in session the curator answers `has_owner` when a file already speaks about the topic (§7.5) |
| Global facts | Additions to the user's global `~/.claude/CLAUDE.md`, with approval; the separate `~/.ouroboros/user.md` profile was retired in v0.12 (§3.2) |
| Subagents | Full transcripts not reviewed; only `recovery` snippets captured inside subagents; workflow agents excluded |
| In-Claude-Code panel | Not needed |
| Skill destination | Automatic routing (global vs project, with a per-repo map) |
| Repository | Public on GitHub, MIT; every file in English |
| Runtime | Node ≥ 22.13, zero dependencies |
| Judging learnings | One rubric everywhere; screen + editor must both agree before an existing file is changed; a new item needs the screen and the curator; no verdict means nothing is written |
| Changes to existing files | One changeset per file, composed with every pending learning; the model writes exact-fragment edits, code validates and applies them; re-applied to the current file on approval |
| Refining its own memories | In `auto`, a memory Ouroboros created and nobody edited since is refined without approval, description and index line included; decided from the ledger (§7.2) |
| Additions vs corrections | Decided by code, not by the model's label: only a pure insertion is an addition; any rewrite is a correction and waits for the user, on both write paths |
| Reviewing the inbox | Two equal ways over one module (`inbox.mjs`): the dashboard, and `/ouroboros:inbox` in the conversation, one entry at a time, where the user can discuss and edit before approving |
| Dashboard at scale | Server-side paging and filters on every list, the inbox grouped by project then by file, bulk decisions by filter on the server, page state in the URL (v0.10) |
| Evaluation model | Haiku by default (`judge_model`): on the synthetic suite Sonnet scored the same at about 15 times the cost; revisit when the suite tells them apart |
| Knowledge graph | Derived on request from the files and usage, never stored; drawn with a D3 subset vendored into `dashboard/public/` (v0.13; the in-house layout before it looked flat and static, and its camera and drag code was costly to keep right). Vendored, not fetched: the CSP and offline use hold, and there is still no `npm install`. Legible by default (v0.14): reference files fold into their skill, projects are regions, "similar" and project lines and unconnected items are off until asked for. Read-only until the loop's value is measured (§9.4) |

## 13. Phases

| Phase | Deliverable | Done when |
|---|---|---|
| **1. Measure** | Full capture, `events.db`, `measure`-mode reviewer at session end, read-only dashboard (Overview, Inventory, Health) | 1–2 weeks of correction baseline; hooks with no noticeable latency |
| **2. Manual learning** | `learn` skill, curator, ledger, `undo`/`forget`, `user.md` + protocol at `SessionStart` | `/ouroboros:learn` writes, dedupes, routes and undoes correctly |
| **3. Self-learning** | Periodic in-loop review, background review of the tail, notices, Value and Cost screens | Correction rate drops vs baseline with cost under the cap |
| **4. Lifecycle and distribution** | Confidence/decay, automatic consolidation, merge on rediscovery, promotion, autonomy queue, dashboard actions (keep/undo/archive/approve/reject, token-protected), `excludeProjects`, CI (tests on Ubuntu, Windows and macOS; `validate --strict`), README | Someone else installs it from scratch on Windows and macOS |
| **v0.7 Evaluation** | Screen → ground → edit → validate; changesets per file with diffs in the dashboard; suggested fixes; skill reference files as owners; `eval.mjs` (synthetic + replay) | The same 60 real proposals give fewer, coherent changes, and the synthetic score holds |
| **v0.8 Mechanism review** | §7.4: insertion-only additions, one validator for both write paths, single-consumer evaluation queue, surgical profile writes, added-text secret check, line-level undo, one memory-dir resolver, ancestor CLAUDE.md files, long sessions in parts, budget guard on every call, notices per project, merges that must land; harder eval cases | 15/15 on the synthetic suite; every finding has a regression test |
| **v0.9 Inbox in the conversation** | `/ouroboros:inbox`: list, show, preview, approve, reject, edit, resolve, done/dismiss; the dashboard uses the same module; SessionStart says when entries wait | Each kind of entry can be decided and edited in the conversation, with a regression test |
| **v0.15 Session learning state** | §6.5: every review reads what the session's earlier reviews saved, queued and left open; open observations; tail context and end-preserving clipping; recoveries in the end-of-session prompt; refinements folded into the file they refine | A second review of a session patches what the first one saved, and a one-turn tail after a review is reviewed, each with a regression test |
| **v0.16 Routing** | §7.5: `DESTINATIONS` shared by the skill, the reviewer and the screen; kind `preference` (topical skill or path-scoped user rule, written without approval); `has_owner` for items saved in session; user rules indexed | "Remember that I prefer X" about a topic lands in that topic's file, or in its owner, not in the global CLAUDE.md |
| **v0.17 One instrument** | §9.2: `CORRECTIONS_RULES`, the corrections-only pass at session end, `reviews.instrument`, `sessions.measure_cursor`; the dashboard's rate, series and per-session counts read only instrument rows | Before and after are counted by the same reading, with a regression test |
| **v0.18 One project per repository** | `projectIdFor` in hooks, proposals, changes and notices, with a one-time re-key; project skills and knowledge files in the main checkout; changes to vanished files closed | A notice from a worktree session shows up in the next session of the repository, with a regression test |
| **v0.19 Use and decay** | Rules that act through the memory index are exempt from decay and count as used in trims; misses counted per learning, with one rewording suggestion from the second; honest labels for what "use" measures | A feedback memory never read is still there after 90 days, with a regression test |
| **v0.20 Signals and hygiene** | Recoveries within one turn, file-tool retries out of the early trigger, anchored evidence checked by code, lease renewal, the Windows command, event retention, `npm test` | Each with a regression test |
| **v0.21 Own memories** | `ownUntouched`; description edits; the `MEMORY.md` line follows in the same batch | The controlled session's hotfix exception lands in the saved memory with no approval, on the real model |
| **v0.11 Knowledge graph** | Knowledge › Graph (§9.4): nodes and edges derived from the files and usage, broken links and unconnected items, filters and selection in the URL, an accessible side panel; read-only | The graph of a real setup's knowledge is legible at a glance and every relation it draws can be traced to a file or an event |
| **v0.12 One global file** | §3.2: global facts go to `~/.claude/CLAUDE.md` through the editor and the inbox; `user.md`, its injection, budgets and consolidation removed; one-time migration of its bullets | Global facts land in the global CLAUDE.md after approval; a fact it already states is not proposed again |
| **v0.13 Graph drawing** | Knowledge › Graph drawn with a vendored D3 subset: the layout unfolds on screen, drag pulls neighbors along, animated camera on select and Fit, curved colored edges with flow on focus, halos and a pulse on what Ouroboros changed; reduced motion respected | The graph feels alive while staying legible, with the same CSP, offline use and no install step |
| **v0.14 Legible graph** | Reference files fold into their skill and open on selection; one region per project around the center; "similar" and project lines off by default; unconnected items listed, drawn on request; overlapping names wait for zoom; the view survives redraws | About forty items drawn instead of a hundred, grouped by project, each cut undoable from the filters or the panel |
