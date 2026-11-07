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
- **Merge:** when a review finds something already saved, new details are folded into the existing note instead of creating a copy.
- **Promotion:** a working rule saved in one project that shows up in another becomes a global profile fact.
- **Daily maintenance:** archives Ouroboros memories and skills unused for 60 days (unless confident), consolidates profile blocks past 80% of their budget, and trims memory indexes and learned skills over budget. You see what it did at the next session start.
- **Archive, never delete:** archived items move to `~/.ouroboros/archive/`; every change is undoable (`/ouroboros:undo` or the dashboard).

`~/.ouroboros/config.json` also takes `excludeProjects` (globs, e.g. `["**/client-*"]`): Ouroboros does nothing at all in those directories.

## Options

Set when enabling the plugin, or later in `/config`:

| Option | Default | |
|---|---|---|
| `learning` | `true` | Learn from sessions (off = measure only) |
| `autonomy` | `auto` | `auto` writes right away; `hybrid` writes confident facts and queues skills and tentative items; `queue` holds everything for approval. Explicit "remember that…" requests are always written |
| `inloop_review` | `true` | Periodic in-session reviews |
| `review_every_turns` | `10` | User turns between in-session reviews |
| `background_review` | `true` | End-of-session review |
| `reviewer_model` | `haiku` | Model for background reviews |
| `monthly_budget_usd` | `5` | Background reviews stop for the month once this is spent |
| `long_turn_tool_calls` | `15` | Tool calls in one turn that trigger an early review |

## Cost and privacy

- Capture hooks make no model calls; they run in the background (~80 ms each) and never block a session.
- In-session reviews run inside your session: mostly cached input and a short answer (a few hundred output tokens).
- Each end-of-session review is one `claude -p --safe-mode` call with no tools, no MCP servers and no session persistence, over a compact digest of the session (typically well under US$ 0.01 with Haiku). On a subscription it counts against your plan's usage.
- All data stays on your machine: `~/.claude/plugins/data/<plugin-id>/events.db`. The dashboard binds to `127.0.0.1` only.

## Development

```
node --test "test/*.test.mjs"      # zero dependencies
claude plugin validate --strict .
claude --plugin-dir .              # try it without installing
```

## License

MIT
