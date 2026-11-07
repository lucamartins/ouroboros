# Ouroboros — design

> A Claude Code plugin that learns from your sessions on its own: it saves memories and creates/refines skills without being asked, in the spirit of Nous Research's Hermes Agent, and shows on a local dashboard what it learned, how much that is being used and what it costs.

Status: **design** (no code yet). Owner decisions in [§12](#12-decisions).

---

## 1. Problem

Claude Code already has places to store learning — per-project auto memory (`~/.claude/projects/<proj>/memory/`, `MEMORY.md` index), personal skills (`~/.claude/skills/`, hot-reloaded), `CLAUDE.md` — but **nothing writes to them proactively**:

- native auto memory saves little, only 4 types (user, feedback, project, reference), and by design skips procedures and debugging fixes — exactly what Hermes turns into skills;
- there is no review loop: nothing native reviews a session and creates/patches skills;
- result: the user repeats the same corrections across sessions.

Hermes solves this with (a) explicit save triggers in its prompt, (b) a background review after each turn, (c) skills as "procedural memory" refined through targeted patches and (d) hard size limits that force consolidation. Ouroboros reproduces this as a plugin.

## 2. Principles

1. **Three separate layers**: *capture* (deterministic hooks, no LLM, cheap) → *reflection* (an LLM decides what to learn) → *curation* (deterministic rules decide where to write, dedupe, enforce limits, keep a ledger). Cost and quality are controllable at each layer.
2. **No LLM on the session's critical path**, except the review nudge at high-signal moments.
3. **Everything reversible**: every write has an origin, a diff and an undo.
4. **Hard limits** (like Hermes): fixed context budget; consolidate at 80%.
5. **Measure before learning**: phase 1 only measures, so there is a baseline to prove value against.
6. **Learn only from trusted sources**: user turns and verified outcomes — never from tool-provided text (web pages, command output), to avoid poisoning via prompt injection.
7. **Zero dependencies**: Node ≥ 22.13 (built-in `node:sqlite`), no `npm install`. Same behavior on Windows, macOS and Linux.

## 3. Architecture

```
Claude Code session
 ├─ SessionStart ─► inject user.md (global profile) + learning protocol (triggers)
 │
 ├─ CAPTURE (async hooks, no LLM) ────────────────────────► events.db (SQLite, WAL)
 │    UserPromptSubmit      correction / "remember, always, never, from now on"
 │    PostToolUse(Failure)  error → recovery; skill use; memory read;
 │                          write to memory/skill (ledger by observation)
 │    UserPromptExpansion   typed /skill (does not go through PostToolUse)
 │    PreCompact            mark session for review
 │
 ├─ REFLECTION A — in-loop (Stop, synchronous)
 │    high signal + cooldown ok + !stop_hook_active  →  {"decision":"block", reason: script}
 │    Claude itself reviews the turn with the `learn` skill and writes (Write/Edit)
 │
 ├─ SessionEnd (≤1.5 s) ─► enqueue session + spawn detached worker
 │
 └─ REFLECTION B — background (detached Node worker)
      transcript → compact digest → `claude -p` (Haiku, JSON schema) → proposals
      → CURATOR (deterministic): dedupe vs inventory → create | patch | skip
      → routing → limits → write → ledger → notice in the next session

Dashboard (node, 127.0.0.1) ◄── events.db + scan of memories/skills + transcript usage
```

### 3.1 Where things live

| Content | Location | Why |
|---|---|---|
| Global user profile (Hermes `USER.md` equivalent) | `~/.ouroboros/user.md` | Survives uninstall/update; hand-editable; injected into every session |
| Advanced config (routing, limits) | `~/.ouroboros/config.json` | Structures `userConfig` doesn't express well |
| Telemetry + ledger | `${CLAUDE_PLUGIN_DATA}/events.db` | Plugin state; persists across updates |
| Project facts | native auto memory (`~/.claude/projects/<proj>/memory/*.md` + `MEMORY.md`), honoring `autoMemoryDirectory` | Cooperates with the native mechanism instead of competing |
| Generic learned skills | `~/.claude/skills/learned-<name>/SKILL.md` | Apply to every project; prefix marks the origin |
| Project learned skills | target from the routing map (e.g. `nisus-*` → `~/source/repos/nisus-skills/...`) or the repo's `.claude/skills/` | Don't leak into other projects |

Every memory/skill Ouroboros creates carries in its frontmatter:

```yaml
metadata:
  origin: ouroboros
  id: lrn_01J...          # ledger key
  confidence: 0.6        # 0.3 tentative … 0.9 near-certain
  created: 2026-11-07
  trigger: correction     # correction | remember | recovery | long_task | repetition | review
```

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
│   ├── signals.mjs            # correction / remember-request detection (PT/EN regex)
│   ├── transcript.mjs         # JSONL → compact digest for the reviewer
│   ├── review-worker.mjs      # reflection B (claude -p) + curator call
│   ├── curator.mjs            # dedupe, routing, limits, writing, ledger
│   └── paths.mjs              # resolves native memory, skills, config
├── skills/
│   ├── learn/SKILL.md         # review script (nudge and manual: /ouroboros:learn)
│   ├── undo/SKILL.md          # reverts the last (or a given) write
│   ├── forget/SKILL.md        # archives a learning
│   └── dashboard/SKILL.md     # starts the dashboard and opens the browser
├── agents/curator.md          # cheap-model subagent for consolidation when a budget overflows
├── dashboard/
│   ├── server.mjs             # native http, 127.0.0.1, JSON API
│   └── public/                # build-free HTML/CSS/JS; hand-rolled SVG charts
└── DESIGN.md
```

No `bin/` folder (it blocks installation through claude.ai/Cowork).

### 4.1 `userConfig`

| Key | Type | Default | Use |
|---|---|---|---|
| `autonomy` | string (`auto`/`hybrid`/`queue`) | `auto` | Write policy (§7) |
| `reviewer_model` | string | `haiku` | Background reviewer model |
| `background_review` | boolean | `true` | Toggles reflection B |
| `inloop_nudge` | boolean | `true` | Toggles reflection A |
| `nudge_cooldown_min` | number | `20` | Minimum interval between nudges per session |
| `monthly_budget_usd` | number | `5` | Reviewer cap; when exceeded, reflection B pauses until next month |
| `language` | string | `pt-BR` | Language of learnings and notices |

### 4.2 `~/.ouroboros/config.json`

```json
{
  "routing": [
    { "match": "**/nisus-*", "skillsDir": "~/source/repos/nisus-skills/skills" }
  ],
  "limits": {
    "userProfileChars": 1500,
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

All in **exec form** (`"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/hook.mjs", "<event>"]`) — no quoting/shell issues on Windows. Logging-only hooks run with `async: true` (never block the session). Recursion guard: if `OUROBOROS_REVIEWER=1` (the reviewer's own sessions), every hook exits immediately.

| Event | Matcher | Mode | What it does |
|---|---|---|---|
| `SessionStart` | `startup\|resume\|clear\|compact` | sync | Creates the session row; injects `user.md` + protocol (§6.1) + pending reviewer notices ("📝 since the last session I learned: …"); sweeps orphaned queue and respawns the worker if needed |
| `UserPromptSubmit` | — | async | Counts the prompt; `signals.mjs` detects correction/remember-request → event with excerpt |
| `UserPromptExpansion` | — | async | Typed `/skill` → `skill_used` |
| `PostToolUse` | `Skill` | async | `skill_used` (+ bumps `uses` if it is a learned skill) |
| `PostToolUse` | `Read` | async | Read inside a memory directory → `memory_read` |
| `PostToolUse` | `Write\|Edit` | async | Write to memory/skill → ledger by observation (also catches what Claude saves on its own) |
| `PostToolUse` | `*` | async | Counts tool calls; closes an error → success sequence on the same target as `recovery` |
| `PostToolUseFailure` | `*` | async | `tool_fail` with target (normalized file/command) |
| `PreCompact` | `manual\|auto` | async | Marks the session `needs_review` |
| `Stop` | — | **sync** | Decides the nudge (§6.2) |
| `SessionEnd` | — | sync, < 300 ms | Enqueues and spawns `review-worker.mjs` detached (`spawn` with `detached`, `windowsHide`, `unref`) |

Latency target: sync hooks < 150 ms (dominated by Node startup); async ones don't count.

## 6. Reflection

### 6.1 Injected protocol (Hermes's "system prompt", as session context)

Injected by `SessionStart`, short (~600 characters), instead of editing the user's `CLAUDE.md` — so the plugin is self-contained and shareable:

> Ouroboros is active. Without being asked, save when you learn: a user preference, a correction of your approach, a project convention, an environment fact. Create or patch a skill when: you worked out a reusable multi-step workflow; you found the working path after errors; the user corrected your approach. Prefer patching what exists over creating new. Don't save what is derivable from the code/CLAUDE.md or what is ephemeral. When you save, say so in one line: "📝 learned: …". Details: skill `ouroboros:learn`.

### 6.2 Reflection A — in-loop nudge (Stop)

Returns `{"decision":"block","reason": <script>}` only if **all** hold:

- `stop_hook_active` is false (prevents loops);
- `nudge_cooldown_min` has passed since the session's last nudge;
- there was a **high signal** since the last nudge: `correction`, `remember`, `recovery`, or ≥ 5 tool calls in a completed task (Hermes's heuristic);
- Claude has not already written anything since the signal (ledger by observation).

The `reason` quotes the concrete signals ("the user corrected: 'no, use pnpm'"; "3 failures in `dotnet test` followed by success") and tells Claude to run the `learn` skill briefly, ending with "nothing to learn" if nothing passes the filters. Cost is measured from transcript `usage` between the nudge and the next `Stop`.

### 6.3 Reflection B — background reviewer

1. **Trigger**: `SessionEnd` (or an orphaned `needs_review` session found at the next `SessionStart`). Skips sessions with < 3 prompts or already fully covered by nudges.
2. **Digest**: `transcript.mjs` reduces the JSONL to user turns, assistant text, tool names, errors and flagged events; capped at ~20k tokens.
3. **Inventory**: titles + descriptions of the existing memories/skills in scope (so the model picks `patch` over `create`).
4. **Call**: `claude -p --model <reviewer_model> --output-format json` with an output JSON schema, no tools, `cwd` at `${CLAUDE_PLUGIN_DATA}/reviewer` (so the reviewer's transcripts don't pollute the user's projects), `OUROBOROS_REVIEWER=1`.
5. **Output**: list of proposals `{kind, scope, op: create|patch, target?, title, body | patch, confidence, trigger, evidence, duplicates_learning?}`. `duplicates_learning` means "the user had to repeat something already learned" → *miss* metric (§9).
6. **Cost**: `total_cost_usd` and tokens from the result go to `reviews`. If the month's total ≥ `monthly_budget_usd`, the worker doesn't run.

### 6.4 `learn` skill script (used by A and manually)

- Quality filters (Claudeception + Hermes): **real discovery** (not just reading docs), **verified** (it worked), **reusable** ("would this help in 6 months?"), **not derivable** from code/CLAUDE.md, **not ephemeral**, **trusted source** (user turn or observed outcome).
- Classify: fact → memory (native type `user|feedback|project|reference`; global profile → `user.md`); procedure → skill.
- Always check what exists first; prefer a targeted patch.
- Memory format identical to native auto memory (frontmatter `name/description/metadata.type` + a line in `MEMORY.md`), plus `metadata.origin/id/confidence`.

## 7. Curation and write policy

Owner decision: **`autonomy = auto`** (like Hermes). Consequences:

- A proposal that passes the filters is written directly; one-line notice in the session (A) or in the next session (B).
- **Undo is mandatory from the first write**: `/ouroboros:undo` and a dashboard button revert using the ledger diff.
- Low confidence (< 0.5) still goes in, but is the first to be archived if unused.
- `hybrid`/`queue` modes are implemented as options for other users (queue in the dashboard).

Curator steps (`curator.mjs`, deterministic):

1. **Validate** schema and size.
2. **Dedupe**: lexical similarity (trigrams, Jaccard ≥ 0.6) against the scope's inventory → turns `create` into `patch` or drops it.
3. **Route**: `global` scope → `user.md` or `~/.claude/skills/learned-*`; `project` → the project's native memory or `routing[].skillsDir`; no rule → the repo's `.claude/skills/`.
4. **Limits**: if the write takes any budget past 80% → trigger consolidation (`curator` subagent: merges similar items, shortens, archives the lowest `confidence × uses`). Above 100%, the write only lands after consolidating.
5. **Write** atomically (temp file + rename) and record it in `writes` with the diff.
6. **Notice** queued for the next session.

### 7.1 Lifecycle

```
proposal ─► active (conf. 0.3–0.9) ─► reinforced (+0.1 per use; +0.2 if the user confirms)
                     │
                     ├─► archived (60 days unused, or merged into another)
                     └─► reverted (user undo; counts as a negative signal for the reviewer)
```

Archive = move to `~/.ouroboros/archive/` (out of context), never delete.

## 8. Data model (`events.db`)

```sql
sessions  (id, project, cwd, started_at, ended_at, prompts, tool_calls,
           needs_review, reviewed_at, is_reviewer)
events    (id, session_id, ts, kind, payload_json)
          -- kind: prompt | correction | remember | tool_fail | recovery | long_task
          --       | skill_used | memory_read | nudge | compact | session_end
learnings (id, kind, scope, project, path, title, confidence, status,
           trigger, origin_session, created_at, updated_at, uses, last_used_at)
          -- status: active | archived | reverted
writes    (id, learning_id, ts, op, actor, session_id, diff)
          -- op: create | patch | archive | revert ; actor: inloop | background | manual | native
reviews   (id, session_id, mode, model, input_tokens, output_tokens,
           cache_tokens, cost_usd, proposals, applied, ts)
nudges    (id, session_id, ts, signals_json, outcome, tokens)
```

WAL + `busy_timeout` for concurrent sessions. Versioned migrations in `db.mjs`.

## 9. Dashboard

`/ouroboros:dashboard` starts `node dashboard/server.mjs` on `127.0.0.1:4747` (configurable port) and opens the browser. Build-free HTML/JS, hand-rolled SVG charts, light/dark theme. The local API is protected by a token generated at startup (so another browser page can't call the endpoints). UI text localized (pt-BR default + en).

### 9.1 Screens

| Screen | Content |
|---|---|
| **Overview** | Weekly KPIs: new learnings, utilization rate, correction rate vs baseline, month cost vs cap; timeline of recent writes |
| **Inventory** | All memories/skills (learned and native), filter by scope/project/type/status; confidence, uses, last use; actions: view diff, edit, archive, undo |
| **Value** | Corrections per session over time (marking when learning was enabled); *misses*; sessions with ≥ 1 learned item used |
| **Cost** | Reviewer (USD and tokens per day), nudges (tokens), fixed context overhead; month projection |
| **Health** | Budget bars (user.md, MEMORY.md, skill count, skill listing), stale items, suspected duplicates, hook/worker errors |

### 9.2 Metrics (definitions)

| Metric | Definition |
|---|---|
| Correction rate | `correction` ÷ prompts, 7-day moving average. **Primary value indicator**: should drop vs baseline |
| Misses | Proposals with `duplicates_learning` — the user had to repeat something already learned (memory failed: not loaded, poor description, or ignored) |
| Utilization rate | Active learnings with ≥ 1 use in the last 30 days ÷ active |
| Hits | Sessions with ≥ 1 `skill_used`/`memory_read` of a learned item |
| Reviewer cost | Σ `reviews.cost_usd` (on a subscription this is quota-equivalent, not an extra charge) |
| Nudge cost | Σ assistant tokens between a nudge and the following `Stop` |
| Fixed overhead | (chars of `user.md` + protocol + `MEMORY.md` lines + learned skill descriptions) ÷ 4 × sessions |
| Cost per hit | (reviewer + nudge + overhead) ÷ hits |

## 10. Distribution

- GitHub repository (private for now) that is its own marketplace (`.claude-plugin/marketplace.json`).
- Install: `/plugin marketplace add lucamartins/ouroboros` → `/plugin install ouroboros@ouroboros`.
- `claude plugin validate --strict` in CI.
- Declared requirement: Node ≥ 22.13 on PATH. `SessionStart` checks the version and, if missing, warns once and disables the hooks silently.

## 11. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Memory pollution (auto mode) | Quality filters, dedupe, hard limits with consolidation, archive on disuse, undo |
| Infinite `Stop` loop | `stop_hook_active`, cooldown, max N nudges per session |
| Latency | Async capture; a single Node process per event; LLM off the critical path |
| `SessionEnd` 1.5 s budget | Only enqueues and spawns a detached worker; orphaned queue reprocessed at the next `SessionStart` |
| Recursion (reviewer fires hooks) | `OUROBOROS_REVIEWER=1` disables everything; separate `cwd`; sessions flagged `is_reviewer` excluded from metrics |
| Prompt injection teaching the agent | Learn only from user turns and observed outcomes; tool text never becomes a literal learning |
| Cross-project leakage | Scope-based routing; `excludeProjects` |
| Sensitive data written | Secret filter (token/key/password patterns) before any write; dashboard bound to `127.0.0.1` only |
| Skill listing budget (~1% of context) | Cap on learned-skill count and description length; metric on the Health screen |
| Reviewer cost | Haiku, compact transcript digest, monthly cap, skip short sessions or ones already covered by nudges |

## 12. Decisions

| Decision | Choice |
|---|---|
| Name | `ouroboros` |
| Autonomy | Fully automatic (like Hermes); `hybrid`/`queue` available as options |
| Reflection | Both: `Stop` nudge on high signal + background reviewer (Haiku) |
| Skill destination | Automatic routing (global vs project, with a per-repo map) |
| Repository | Private GitHub for now |
| Runtime | Node ≥ 22.13, zero dependencies |
| Language | Code, docs and skills in English; learnings, notices and dashboard UI localized (pt-BR default + en) |

## 13. Phases

| Phase | Deliverable | Done when |
|---|---|---|
| **1. Measure** | Full capture, `events.db`, read-only dashboard (Overview, Inventory, Health) | 1–2 weeks of correction/miss baseline; hooks with no noticeable latency |
| **2. Manual learning** | `learn` skill, curator, ledger, `undo`/`forget`, `user.md` + protocol at `SessionStart` | `/ouroboros:learn` writes, dedupes, routes and undoes correctly |
| **3. Self-learning** | `Stop` nudge, background worker, notices, Value and Cost screens | Correction rate drops vs baseline with cost under the cap |
| **4. Lifecycle and distribution** | Confidence/decay, automatic consolidation, dashboard actions, marketplace, `validate --strict` in CI, README | Someone else installs it from scratch on Windows and macOS |

## 14. Open questions

1. Is PT/EN correction regex enough, or is an optional Haiku classifier worth it (extra cost per prompt)?
2. Should `user.md` be only a profile (like Hermes's `USER.md`) or also global agent notes (like Hermes's `MEMORY.md`)? Initial proposal: two blocks in the same file with separate budgets.
3. Should the reviewer also read subagent/workflow sessions, or only the main session?
4. An in-Claude-Code panel (mod/status line with "📝 3 learnings this session") in addition to the web dashboard?
