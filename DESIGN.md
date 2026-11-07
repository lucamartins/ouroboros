# Ouroboros — design

> A Claude Code plugin that learns from your sessions on its own: it saves memories and creates/refines skills without being asked, in the spirit of Nous Research's Hermes Agent, and shows on a local dashboard what it learned, how much that is being used and what it costs.

Status: all four phases implemented (v0.4.0); next: real-world use, then a fresh install test on another machine. Owner decisions in [§12](#12-decisions).

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
3. **Every transcript segment is reviewed exactly once**: a per-session cursor records how far reviews have gone.
4. **Everything reversible**: every write has an origin, a diff and an undo.
5. **Hard limits** (like Hermes): fixed context budget; consolidate at 80%.
6. **Measure before learning**: phase 1 only measures, so there is a baseline to prove value against.
7. **Learn only from trusted sources**: user turns and verified outcomes — never from tool-provided text (web pages, command output), to avoid poisoning via prompt injection.
8. **Zero dependencies**: Node ≥ 22.13 (built-in `node:sqlite`), no `npm install`. Same behavior on Windows, macOS and Linux.

## 3. Architecture

```
Claude Code session
 ├─ SessionStart ─► inject user.md (global profile + environment) + learning protocol
 │
 ├─ CAPTURE (async hooks, no LLM, metrics only) ──────────► events.db (SQLite, WAL)
 │    UserPromptSubmit      turn counter
 │    PostToolUse(Failure)  tool calls; error → recovery (also inside subagents);
 │                          skill use; memory read; write to memory/skill (ledger)
 │    UserPromptExpansion   typed /skill (does not go through PostToolUse)
 │
 ├─ REFLECTION A — periodic in-loop review (Stop, synchronous)
 │    every N user turns, or after a long autonomous turn  →  {"decision":"block", reason}
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
| Global profile + environment notes | `~/.ouroboros/user.md` (two blocks, §3.2) | Survives uninstall/update; hand-editable; injected into every session |
| Advanced config (routing, limits) | `~/.ouroboros/config.json` | Structures `userConfig` doesn't express well |
| Telemetry + ledger | `${CLAUDE_PLUGIN_DATA}/events.db` | Plugin state; persists across updates |
| Project facts | native auto memory (`~/.claude/projects/<proj>/memory/*.md` + `MEMORY.md`), honoring `autoMemoryDirectory` | Cooperates with the native mechanism instead of competing |
| Generic learned skills | `~/.claude/skills/learned-<name>/SKILL.md` | Apply to every project; prefix marks the origin |
| Project learned skills | target from the routing map (e.g. `nisus-*` → `~/source/repos/nisus-skills/...`) or the repo's `.claude/skills/` | Don't leak into other projects |

The plugin never edits the user's `~/.claude/CLAUDE.md`.

Every memory/skill Ouroboros creates carries in its frontmatter:

```yaml
metadata:
  origin: ouroboros
  id: lrn_01J...          # ledger key
  confidence: 0.6        # 0.3 tentative … 0.9 near-certain
  created: 2026-11-07
  trigger: periodic       # periodic | long_turn | session_end | manual
```

### 3.2 `user.md`

One file, two blocks with separate budgets (Hermes keeps them as `USER.md` and `MEMORY.md`):

```markdown
## User
<!-- who the user is, preferences, how they like to work — ≤ 1,500 chars -->

## Environment & lessons
<!-- cross-project facts: OS/shell quirks, tool auth, toolchain facts — ≤ 2,000 chars -->
```

Project-specific facts never go here; they go to the project's native auto memory. Together the two blocks cost ~900 tokens per session.

## 4. Plugin components

```
ouroboros/
├── .claude-plugin/
│   ├── plugin.json            # manifest + userConfig
│   └── marketplace.json       # the repo is its own marketplace
├── hooks/hooks.json           # all hooks, exec form: node <dispatcher> <event>
├── scripts/
│   ├── hook.mjs               # single dispatcher (one process per event)
│   ├── db.mjs                 # schema + migrations (node:sqlite)
│   ├── transcript.mjs         # JSONL → compact digest for the reviewer; cursor handling
│   ├── review-worker.mjs      # reflection B (claude -p) + curator call
│   ├── curator.mjs            # dedupe, routing, limits, writing, ledger
│   └── paths.mjs              # resolves native memory, skills, config
├── skills/
│   ├── learn/SKILL.md         # review script (periodic review and manual: /ouroboros:learn)
│   ├── undo/SKILL.md          # reverts the last (or a given) write
│   ├── forget/SKILL.md        # archives a learning
│   └── dashboard/SKILL.md     # starts the dashboard and opens the browser
├── agents/curator.md          # cheap-model subagent for consolidation when a budget overflows
├── dashboard/
│   ├── server.mjs             # native http, 127.0.0.1, JSON API
│   └── public/                # build-free HTML/CSS/JS; hand-rolled SVG charts
└── DESIGN.md
```

No `bin/` folder (it blocks installation through claude.ai/Cowork). Every file in this repository is in English.

### 4.1 `userConfig`

| Key | Type | Default | Use |
|---|---|---|---|
| `learning` | boolean | `true` | Inject the protocol and `user.md` at `SessionStart` (off = measure only) |
| `autonomy` | string (`auto`/`hybrid`/`queue`) | `auto` | Write policy (§7) — phase 3 |
| `reviewer_model` | string | `haiku` | Background reviewer model |
| `inloop_review` | boolean | `true` | Toggles reflection A |
| `background_review` | boolean | `true` | Toggles reflection B |
| `review_every_turns` | number | `10` | User turns between in-loop reviews |
| `long_turn_tool_calls` | number | `15` | Tool calls in one turn that trigger an early review |
| `monthly_budget_usd` | number | `5` | Reviewer cap; when exceeded, reflection B pauses until next month |
| `language` | string | `auto` | Language of learnings and notices written to the user's files (`auto` = the conversation's language) |

### 4.2 `~/.ouroboros/config.json`

```json
{
  "routing": [
    { "match": "**/nisus-*", "skillsDir": "~/source/repos/nisus-skills/skills" }
  ],
  "limits": {
    "userBlockChars": 1500,
    "environmentBlockChars": 2000,
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
| `SessionStart` | `startup\|resume\|clear\|compact` | sync | Creates the session row; injects `user.md` + protocol (§6.1) + pending reviewer notices ("📝 since the last session I learned: …"); sweeps orphaned queue and respawns the worker if needed |
| `UserPromptSubmit` | — | async | Increments the turn counter |
| `UserPromptExpansion` | — | async | Typed `/skill` → `skill_used` |
| `PostToolUse` | `Skill` | async | `skill_used` (+ bumps `uses` if it is a learned skill) |
| `PostToolUse` | `Read` | async | Read inside a memory directory → `memory_read` |
| `PostToolUse` | `Write\|Edit` | async | Write to memory/skill → ledger by observation (also catches what Claude saves on its own) |
| `PostToolUse` | `*` | async | Counts tool calls (per turn); closes an error → success sequence on the same target as `recovery`, tagged with `agent_id` when inside a subagent |
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
  - the turn that just ended used ≥ `long_turn_tool_calls` tool calls.

The `reason` tells Claude to run the `learn` skill over **the segment since the last review only** (it names the turn range and, when present, the recorded `recovery` events, including those from subagents), to be brief, and to finish with the result line:

```
[ouroboros] reviewed=<turns> corrections=<n> learned=<n> patched=<n>
```

On the next `Stop`, the hook parses that line from `last_assistant_message`, records it in `reviews`, and advances the session's cursor to the transcript position of the review. If the line is missing (Claude skipped the review), the cursor does not move and the segment falls to reflection B.

Cost is measured from transcript `usage` between the request and the next `Stop`. Most of the input is a cache read; the output is usually short. Measured end to end: a review with one save read ~64k cached tokens and wrote 187 output tokens. The next request comes `review_every_turns` turns later even if Claude skipped this one (`turns_at_last_review` moves when the request is made, the cursor only when the result line arrives). Subagent stops and `stop_hook_active` stops never request a review.

### 6.3 Reflection B — end-of-session background review

1. **Trigger**: `SessionEnd` (or an orphaned queued session found at the next `SessionStart`).
2. **Scope**: only the **unreviewed tail** — from the session's cursor to the end. Skipped when the tail has < 2 user turns and no `recovery` events.
3. **Digest**: `transcript.mjs` reduces the tail to user turns, assistant text, tool names and errors; plus the `recovery` snippets recorded inside subagents (never full subagent transcripts; workflow agents are excluded entirely). Capped at ~20k tokens.
4. **Inventory**: titles + descriptions of the existing memories/skills in scope (so the model picks `patch` over `create`).
5. **Call**: `claude -p --safe-mode --model <reviewer_model> --output-format json --json-schema <schema> --tools "" --no-session-persistence --max-budget-usd 0.5 --system-prompt <short>`, `cwd` at `${CLAUDE_PLUGIN_DATA}/reviewer`, `OUROBOROS_REVIEWER=1`. Isolation is essential: a plain `claude -p` loads the user's whole environment (MCP servers, plugins, skills, CLAUDE.md) and a trivial call measured **US$ 0.78**; with `--safe-mode` and a custom system prompt the same call costs **US$ 0.0003**, and real session reviews cost US$ 0.002–0.008. `--safe-mode` also disables hooks, so the reviewer can't trigger the plugin; `--no-session-persistence` keeps its transcripts out of the user's projects.
6. **Output**: `{corrections, items: [{kind: profile|memory|skill, block?, scope?, memory_type?, title, text?, description?, body?, confidence, evidence, repeats?}]}`, applied through the curator as `create` items (the reviewer sees only names and descriptions of what exists, not contents, so it never patches). A `duplicate` answer reinforces the existing learning (+0.1 confidence, max 0.9). `repeats` means "the user had to repeat something already saved" → *miss* metric (§9). Every item is recorded in `candidates` with its curator `outcome`.
7. **Notices**: created items become a notice; the next `SessionStart` shows it to the user (`systemMessage`) and tells Claude (context), then marks it delivered.
8. **Cost**: `total_cost_usd` and tokens from the result go to `reviews`. If the month's total ≥ `monthly_budget_usd`, the worker doesn't run. Measured end to end: a 23-turn session tail produced 3 corrections and 4 well-formed memories for US$ 0.008.

With `learning` off the worker runs in `measure` mode instead. `/ouroboros:backfill` always uses `measure`: past sessions are counted, never learned from.

**Phase 1 mode (`measure`)**: the same worker runs over the whole session but only returns `corrections` and candidate learnings, which are recorded and never written. This produces the baseline. `/ouroboros:backfill` runs it over past transcripts (newest first, with a dry run and confirmation) so the baseline exists from day one instead of after 1–2 weeks.

### 6.4 `learn` skill script (used by A and manually)

- Quality filters (Claudeception + Hermes): **real discovery** (not just reading docs), **verified** (it worked), **reusable** ("would this help in 6 months?"), **not derivable** from code/CLAUDE.md, **not ephemeral**, **trusted source** (user turn or observed outcome).
- Count corrections: user turns that redirected the approach, explicit or implicit ("hmm, the test broke again", "I prefer the other way").
- Classify: fact → memory (native type `user|feedback|project|reference`; cross-project → the right block of `user.md`); procedure → skill.
- Always check what exists first; prefer a targeted patch.
- Memory format identical to native auto memory (frontmatter `name/description/metadata.type` + a line in `MEMORY.md`), plus `metadata.origin/id/confidence`.
- End with the result line (§6.2).

## 7. Curation and write policy

**Single writer.** Every Ouroboros write goes through `scripts/curator.mjs` (`apply`, `undo`, `forget`, `inventory`). In-loop, Claude calls it from the `learn` skill (proposals as JSON on stdin); in phase 3 the background worker calls the same `apply` in-process. Claude's own direct writes to memory files (native auto memory) are still observed by the capture hooks, but only curator writes carry a ledger entry and can be undone.

Proposal item: `{ op: create|patch, kind: profile|memory|skill, scope, memory_type, block, project_dir, name, title, description, body, text, target, old, new, confidence }`. A `memory` with `scope: global` becomes a `profile` fact (`user`/`feedback` → User block, otherwise Environment & lessons). A patch targets a learning id, an absolute memory/skill/profile path, or a name, and either replaces an exact `old` fragment with `new` or replaces the `description` (memory patches also update the `MEMORY.md` line). Native skills and memories can be patched (refined) too; they are then tracked with `origin_session = 'native'` and don't count against the learned-skill budget. Routing rules may set `linkInto` to create a directory link (junction on Windows) so skills kept in a separate repo load from `~/.claude/skills`, as the owner's `nisus-skills` setup does.

Duplicates are **not** merged automatically: the curator answers `duplicate` with the existing target and Claude re-submits a patch — the model merges, the curator guards.

Owner decision: **`autonomy = auto`** (like Hermes). Consequences:

- A proposal that passes the filters is written directly; one-line notice in the session (A) or in the next session (B).
- **Undo is mandatory from the first write**: `/ouroboros:undo` and a dashboard button revert using the ledger diff.
- Low confidence (< 0.5) still goes in, but is the first to be archived if unused.
- `hybrid`/`queue` modes are implemented as options for other users (queue in the dashboard).

Curator steps (`curator.mjs`, deterministic):

1. **Validate** schema and size.
2. **Dedupe**: lexical similarity (trigrams, Jaccard ≥ 0.6) against the scope's inventory → turns `create` into `patch` or drops it.
3. **Route**: `global` scope → a `user.md` block or `~/.claude/skills/learned-*`; `project` → the project's native memory or `routing[].skillsDir`; no rule → the repo's `.claude/skills/`.
4. **Limits**: if the write takes any budget past 80% → trigger consolidation (`curator` subagent: merges similar items, shortens, archives the lowest `confidence × uses`). Above 100%, the write only lands after consolidating.
5. **Write** atomically (temp file + rename) and record it in `writes` with the diff.
6. **Notice** queued for the next session.

### 7.00 The learning rubric

A healthy self-learning loop needs one, explicit definition of "worth remembering", applied the same way by every path that writes, for every user and project. It lives in `scripts/rubric.mjs` and is injected verbatim into the end-of-session reviewer, the knowledge check, and the `learn` skill (`test/rubric.test.mjs` fails if the skill drifts); the session protocol carries a one-line version. The eight rules:

1. **Behavior change** — would the assistant act differently next time without it? (drop default behavior, generic practice, preferences already configured, alternatives to guidance that already handles the case)
2. **Standing** — a rule the user stated as lasting, repeated, or a recorded decision; not a one-time request.
3. **Not derivable** — absent from code, config, tests, git history and docs.
4. **Verified** — worked or stated by the user; what the project executes (triggers, commands, parameters, config) is ground truth, comments are not, and an observed outcome beats a comment.
5. **Durable** — no status, to-dos, counts, timings, issue numbers, finished work.
6. **Owner** — add to the skill/rule/doc that owns the topic, else a project memory, else a global fact; never a second copy.
7. **Correct the stale** — ground truth or an explicit change of rule fixes the outdated text; a one-off request never overturns a standing rule.
8. **Trusted, no secrets.**

These came from reviewing real proposals by hand, item by item, and turning every judgment into a rule. The rubric is project-agnostic; everything user- or project-specific comes from the indexed knowledge.

### 7.0 Knowledge check (triage)

Lesson from the first learning backfill (60 proposals from 30 past sessions): about a third were already documented in the owner's skills, repo CLAUDE.md files or `.claude/rules`, several were the same lesson in two languages or two kinds, and a few were one-off instructions or finished work. The reviewer had only seen *names and descriptions* of memories and personal skills — never skill bodies, CLAUDE.md or rules.

So every proposal from Claude-less paths (end-of-session reviewer, learning backfill, approval queue) now goes through `scripts/triage.mjs` before it is written or queued:

1. `scripts/knowledge.mjs` indexes what Claude already knows for the project: global and project CLAUDE.md, `.claude/rules/*.md`, project and personal skill bodies, memories and the profile — for the session's directory and its direct child repos (worktrees skipped). Markdown is chunked by heading/paragraph and searched with BM25 (no dependencies; ~400 chunks index in ~15 ms).
2. One isolated call per batch of 12 proposals (`TRIAGE_SCHEMA`) sees each proposal with its top excerpts and the titles of all other proposals, and answers per proposal: **keep** (with a rewrite: right kind, human title, target language, no stale details), **drop** (covered / one-off / stale / derivable / low value, with the file that covers it), **merge** into another proposal, or **patch** an existing skill/memory/profile file (exact `old` fragment, verified before use; otherwise kept as new). Contradictions with existing knowledge are kept and flagged for the owner.
3. A final pass over everything kept (`DEDUPE_SCHEMA`) merges duplicates that landed in different batches.

Since the rubric, triage also gets: the **owners map** (every skill and rule file with its description and sections) so a learning goes to its owner even without shared words, with **append-to-section** patches that need no exact fragment; **sources of truth** (CI workflows, package manifests, deploy config) to verify claims; **past rejections** (proposals the user rejected or undid) so they are not proposed again; a **correct** verdict that fixes outdated knowledge. Changes to rule files and CLAUDE.md, and all corrections, always wait for approval. Extra clones and leftover copies of a repo are excluded from the index (they carry stale docs).

On the same 60 real proposals: 60 → 26 (7 new memories, 19 additions to the skills and rules that own the topic), US$ 0.06 per full pass. Known gap: when a proposal is dropped because a source of truth covers it, a stale owner elsewhere is not always corrected in the same pass.

Dropped and merged items stay visible in the dashboard with their reason and can be restored. Measured on the real queue: 60 → 39 (20 dropped, 1 merged, 8 turned into skill updates), about US$ 0.02–0.04 per pass. The in-session `learn` skill gets the same rule as an instruction: search the full text of CLAUDE.md, rules and skills before saving, and patch the skill that owns a procedure.

Learnings are written in `learning_language` (`en` by default, `pt-BR` or `auto`), so files on disk follow one language regardless of the conversation's.

### 7.1 Lifecycle

```
proposal ─► active (conf. 0.3–0.9) ─► reinforced (+0.1 per use; +0.2 if the user confirms)
                     │
                     ├─► archived (60 days unused, or merged into another)
                     └─► reverted (user undo; counts as a negative signal for the reviewer)
```

Archive = move to `~/.ouroboros/archive/` (out of context), never delete.

How each transition happens (phase 4):

- **Reinforcement**: the first read of a learned memory or use of a learned skill in a session adds +0.1 (hooks); a background review that rediscovers an existing item adds +0.1; **Confirm** in the dashboard adds +0.2. Cap 0.9.
- **Merge on rediscovery**: when the background reviewer's item is a `duplicate` of a memory or skill file, a second small call (`MERGE_SCHEMA`) decides `skip` or a `patch` that folds the new detail in (max 3 per review).
- **Promotion**: a `feedback`/`user` memory similar to one already saved in *another* project becomes a profile fact instead of a copy.
- **Daily maintenance** (`review-worker.mjs --maintain`, started by `SessionStart` at most every 20 h, results shown as notices):
  - *decay* — archive Ouroboros memories/skills unused for `archiveAfterDaysUnused` days whose confidence is below 0.7 (profile facts are always in context, so they never decay; native items are never touched);
  - *consolidate the profile* — a block past `consolidateAt` is rewritten by one isolated call (`CONSOLIDATE_SCHEMA`: merged bullets with their source ids) down to 70% of its budget; one ledger batch, so `undo` restores the old block and reactivates the merged facts (measured: 6 facts → 3, US$ 0.001);
  - *trim* — memory indexes and learned skills past `consolidateAt` archive their weakest items (`confidence × log2(1 + uses)`) down to 70%.
- **Autonomy** (`auto` | `hybrid` | `queue`): proposals from Claude (`actor: inloop`) or the reviewer (`background`) that need approval are stored as `queued` candidates with their full payload; explicit user requests (`actor: manual`) are always written. `hybrid` writes facts with confidence ≥ 0.7 and queues skills and tentative items. Approve/Reject in the dashboard runs the stored proposal through the curator.
- **Exclusions**: hooks do nothing at all in projects matching `excludeProjects`.

## 8. Data model (`events.db`)

```sql
sessions  (id, project, cwd, transcript_path, started_at, ended_at, turns, tool_calls,
           turns_at_last_review, review_cursor, queued, reviewed_at, is_reviewer)
events    (id, session_id, agent_id, ts, kind, payload_json)
          -- kind: turn | tool_call | tool_fail | recovery | long_turn
          --       | skill_used | memory_read | memory_write | review_requested | session_end
learnings (id, kind, scope, project, path, title, confidence, status,
           trigger, origin_session, created_at, updated_at, uses, last_used_at)
          -- status: active | archived | reverted
writes    (id, learning_id, ts, op, actor, session_id, diff)
          -- op: create | patch | archive | revert ; actor: inloop | background | manual | native
reviews   (id, session_id, mode, trigger, model, turns_reviewed, corrections, learned, patched,
           input_tokens, output_tokens, cache_tokens, cost_usd, ts)
          -- mode: inloop | background | measure | manual
```

WAL + `busy_timeout` for concurrent sessions. Versioned migrations in `db.mjs`.

## 9. Dashboard

`/ouroboros:dashboard` starts `node dashboard/server.mjs` on `127.0.0.1:4747` (configurable port) and opens the browser. Build-free HTML/JS, hand-rolled SVG charts, light/dark theme, English UI. The launcher reuses a running server (`dashboard.json` in the data dir) or starts a detached one that shuts down after 4 h idle. Reads are GET-only; writes go to `POST /api/action`, which requires the per-start token (served by `GET /api/token`, readable only by the page's own origin), a same-origin `Origin` and a JSON body. Every request passes a `Host` check (anti DNS-rebinding), and pages carry a strict CSP.

### 9.1 Screens

| Screen | Content |
|---|---|
| **Overview** | Weekly KPIs: new learnings, utilization rate, correction rate vs baseline, month cost vs cap; timeline of recent writes |
| **Inventory** | All memories/skills (learned and native), filter by scope/project/type/status; confidence, uses, last use; actions: view diff, edit, archive, undo |
| **Value** | Corrections per turn over time (marking when learning was enabled); *misses*; sessions with ≥ 1 learned item used |
| **Cost** | Reviews (USD/tokens per day, in-loop vs background), fixed context overhead; month projection |
| **Health** | Budget bars (`user.md` blocks, `MEMORY.md`, skill count, skill listing), stale items, suspected duplicates, hook/worker errors |

### 9.2 Metrics (definitions)

| Metric | Definition |
|---|---|
| Correction rate | Σ `reviews.corrections` ÷ Σ `reviews.turns_reviewed`, 7-day moving average. **Primary value indicator**: should drop vs the phase 1 baseline |
| Misses | Proposals with `duplicates_learning` — the user had to repeat something already learned (memory failed: not loaded, poor description, or ignored) |
| Utilization rate | Active learnings with ≥ 1 use in the last 30 days ÷ active |
| Hits | Sessions with ≥ 1 `skill_used`/`memory_read` of a learned item |
| Review cost | Σ `reviews.cost_usd` (background) + Σ in-loop review tokens (on a subscription this is quota-equivalent, not an extra charge) |
| Fixed overhead | (chars of `user.md` + protocol + `MEMORY.md` lines + learned skill descriptions) ÷ 4 × sessions |
| Cost per hit | (reviews + overhead) ÷ hits |

## 10. Distribution

- GitHub repository (private for now) that is its own marketplace (`.claude-plugin/marketplace.json`).
- Install: `/plugin marketplace add lucamartins/ouroboros` → `/plugin install ouroboros@ouroboros`.
- `claude plugin validate --strict` in CI.
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
| Sensitive data written | Secret filter (token/key/password patterns) before any write; dashboard bound to `127.0.0.1` only |
| Skill listing budget (~1% of context) | Cap on learned-skill count and description length; metric on the Health screen |
| Reviewer cost | Haiku, unreviewed tail only, compact digest, monthly cap |

## 12. Decisions

| Decision | Choice |
|---|---|
| Name | `ouroboros` |
| Autonomy | Fully automatic (like Hermes); `hybrid`/`queue` available as options |
| Reflection | Periodic in-loop review every N turns (+ early on long turns) and an end-of-session background review of the unreviewed tail |
| Prompt classification | None — no regex or per-prompt classifier; corrections are counted by the reviews |
| `user.md` | Two blocks in one file: `User` (≤ 1,500 chars) and `Environment & lessons` (≤ 2,000 chars) |
| Subagents | Full transcripts not reviewed; only `recovery` snippets captured inside subagents; workflow agents excluded |
| In-Claude-Code panel | Not needed |
| Skill destination | Automatic routing (global vs project, with a per-repo map) |
| Repository | Private GitHub for now; every file in English |
| Runtime | Node ≥ 22.13, zero dependencies |

## 13. Phases

| Phase | Deliverable | Done when |
|---|---|---|
| **1. Measure** | Full capture, `events.db`, `measure`-mode reviewer at session end, read-only dashboard (Overview, Inventory, Health) | 1–2 weeks of correction baseline; hooks with no noticeable latency |
| **2. Manual learning** | `learn` skill, curator, ledger, `undo`/`forget`, `user.md` + protocol at `SessionStart` | `/ouroboros:learn` writes, dedupes, routes and undoes correctly |
| **3. Self-learning** | Periodic in-loop review, background review of the tail, notices, Value and Cost screens | Correction rate drops vs baseline with cost under the cap |
| **4. Lifecycle and distribution** | Confidence/decay, automatic consolidation, merge on rediscovery, promotion, autonomy queue, dashboard actions (confirm/undo/archive/approve/reject, token-protected), `excludeProjects`, CI (tests on Ubuntu + Windows, macOS on demand; `validate --strict`), README | Someone else installs it from scratch on Windows and macOS |
