# Ouroboros

Self-learning for Claude Code. Ouroboros reviews your sessions, turns what is worth keeping into memories and skills, and shows on a local dashboard what it learned, how much that is used, and what it costs — in the spirit of Nous Research's Hermes Agent.

> **Status: v0.4 — complete loop.** Each session starts with a short learning protocol and your global profile (`~/.ouroboros/user.md`). Every 10 turns (and after long autonomous turns) Claude briefly reviews the recent turns and saves what is worth keeping; when the session ends, a small isolated model call reviews whatever was not reviewed yet. Everything goes through one curator — deduplicated, routed, budgeted and undoable — and a daily maintenance pass archives what nobody uses and consolidates what grew too big. The local dashboard shows whether corrections are going down, what it costs, and lets you confirm, undo, archive or approve. See [DESIGN.md](DESIGN.md).

## Install

Requires Claude Code and Node.js ≥ 22.13 on `PATH`.

```
/plugin marketplace add lucamartins/ouroboros
/plugin install ouroboros@ouroboros
```

For a local checkout: `/plugin marketplace add /path/to/ouroboros`.

## Use

| Command | What it does |
|---|---|
| `/ouroboros:learn [focus]` | Saves what was learned (Claude also uses it on its own) |
| `/ouroboros:undo [id]` | Reverts the last (or a given) learning write |
| `/ouroboros:forget <match>` | Archives a learning so it stops loading |
| `/ouroboros:dashboard` | Opens the local dashboard (`http://127.0.0.1:4747`): overview, learnings (with confirm / undo / archive and the approval queue), value, cost, inventory, health |
| `/ouroboros:backfill [days] [limit]` | Reviews past sessions to build the baseline right away (asks before spending) |

Everything else is automatic: capture hooks record turns, tool calls, error → fix recoveries, skill uses and memory reads/writes; a background reviewer runs when a session ends.

### Where learnings go

| Learning | Destination |
|---|---|
| Who you are, preferences valid everywhere | `~/.ouroboros/user.md` → User |
| Cross-project facts (OS, shell, tool auth) | `~/.ouroboros/user.md` → Environment & lessons |
| Project facts and conventions | the project's auto-memory directory + `MEMORY.md` |
| Reusable procedures | `~/.claude/skills/learned-*`, or project skills routed by `~/.ouroboros/config.json` |

`~/.ouroboros/config.json` holds budgets and routing, e.g. send skills about `**/my-app-*` repos to a skills repo and link them into `~/.claude/skills`:

```json
{ "routing": [{ "match": "**/my-app-*", "skillsDir": "~/src/my-skills", "linkInto": "~/.claude/skills" }] }
```

## Lifecycle

- **Reinforcement:** each first use in a session, each rediscovery and each **Confirm** in the dashboard raises a learning's confidence.
- **One rubric:** every path that saves anything (in-session `learn`, end-of-session reviewer, knowledge check) applies the same nine rules — would it change behavior, is it a standing rule, is it not derivable, is it verified against what the project executes, will it last, does it go to the owner, does it correct stale knowledge, should the project be fixed instead, is it trusted. See `scripts/rubric.mjs`.
- **Knowledge check, in two independent steps:** a *screen* drops what your CLAUDE.md files, `.claude/rules`, skills (and their reference files) and memories already say, merges duplicates (even when aimed at different files), turns workarounds for fixable problems into **suggested fixes**, and sends each learning to the file that owns its topic. Then an *editor* reads that whole file, with every learning pending for it and what the project's code says about the names they mention, and writes one coherent change: it skips what is covered, rejects what the code contradicts, corrects outdated lines, and hands learnings that contradict a written rule to you, in a *Conflicts* section, to say whether it is a new rule or the current one stands. Code validates every edit before it is applied or queued: exact fragments, frontmatter and headings intact, no secret in what it adds, and only a pure insertion counts as an addition. Any edit that rewrites existing text, even one word, is a correction and waits for you, whether the background editor or Claude in your session wrote it.
- **One change per file:** pending changes to a file are always composed together, so two learnings never make conflicting edits. The dashboard shows each change as a diff with the learnings behind it; approving re-applies it to the current file, and removing one learning recomposes the rest. One process evaluates at a time (sessions that end together queue their proposals for it), so parallel sessions never overwrite each other's changes.
- **Merge:** when a review finds something already saved, the editor folds in only what is new.
- **Promotion:** a working rule saved in one project that shows up in another becomes a global profile fact.
- **Daily maintenance:** archives Ouroboros memories and skills unused for 60 days (unless confident), consolidates profile blocks past 80% of their budget, and trims memory indexes and learned skills over budget. You see what it did at the next session start.
- **Archive, never delete:** archived items move to `~/.ouroboros/archive/`; every change is undoable (`/ouroboros:undo` or the dashboard). If you edited the file since, undo reverts only the lines that change wrote and keeps your edits. Ouroboros only touches the bullets it manages in `~/.ouroboros/user.md`; anything else you write there stays.

`~/.ouroboros/config.json` also takes `excludeProjects` (globs, e.g. `["**/client-*"]`): Ouroboros does nothing at all in those directories.

## Options

Set when enabling the plugin, or later in `/config`:

| Option | Default | |
|---|---|---|
| `learning` | `true` | Learn from sessions (off = measure only) |
| `learning_language` | `en` | Language of saved learnings (`en`, `pt-BR` or `auto` = the conversation's) |
| `autonomy` | `auto` | `auto` writes right away; `hybrid` writes confident facts and queues skills and tentative items; `queue` holds everything for approval. Explicit "remember that…" requests are always written |
| `inloop_review` | `true` | Periodic in-session reviews |
| `review_every_turns` | `10` | User turns between in-session reviews |
| `background_review` | `true` | End-of-session review |
| `reviewer_model` | `haiku` | Model for background reviews |
| `judge_model` | `haiku` | Model of the knowledge check (screen and editor); `sonnet` costs about 15 times more and scored the same on the evaluation suite |
| `monthly_budget_usd` | `5` | Every Ouroboros model call (reviews, knowledge check, consolidation) stops for the month once this is spent |
| `long_turn_tool_calls` | `15` | Tool calls in one turn that trigger an early review |

## Cost and privacy

- Capture hooks make no model calls; they run in the background (~80 ms each) and never block a session.
- In-session reviews run inside your session: mostly cached input and a short answer (a few hundred output tokens).
- Each end-of-session review is one `claude -p --safe-mode` call with no tools, no MCP servers and no session persistence, over a compact digest of the session (typically well under US$ 0.01 with Haiku); a very long session is reviewed in a few parts rather than cut. On a subscription it counts against your plan's usage.
- All data stays on your machine: `~/.claude/plugins/data/<plugin-id>/events.db`. The dashboard binds to `127.0.0.1` only.

## Development

```
node --test "test/*.test.mjs"      # zero dependencies
claude plugin validate --strict .
claude --plugin-dir .              # try it without installing
node scripts/eval.mjs --synthetic  # score the knowledge check with the real model (~US$ 0.01)
node scripts/eval.mjs --replay     # agreement with what you approved/rejected (on a DB copy)
```

Run both evals before and after changing the rubric or a prompt.

## License

MIT
