# Ouroboros

Self-learning for Claude Code. Ouroboros reviews your sessions, turns what is worth keeping into memories and skills, and shows on a local dashboard what it learned, how much that is used, and what it costs — in the spirit of Nous Research's Hermes Agent.

> **Status: phase 2 — learning on request.** Each session starts with a short learning protocol and your global profile (`~/.ouroboros/user.md`), so Claude saves preferences, corrections, conventions and procedures through `/ouroboros:learn` — deduplicated, routed, budgeted and undoable. After each session, a small isolated model call counts corrections and lists what could have been learned, to measure progress against the baseline. Automatic periodic reviews arrive in phase 3. See [DESIGN.md](DESIGN.md).

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
| `/ouroboros:dashboard` | Opens the local dashboard (`http://127.0.0.1:4747`) |
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

## Options

Set when enabling the plugin, or later in `/config`:

| Option | Default | |
|---|---|---|
| `learning` | `true` | Inject the learning protocol and your profile into sessions |
| `measure_review` | `true` | End-of-session measurement review |
| `reviewer_model` | `haiku` | Model for background reviews |
| `monthly_budget_usd` | `5` | Background reviews stop for the month once this is spent |
| `long_turn_tool_calls` | `15` | Tool calls that mark a long autonomous turn |

## Cost and privacy

- Capture hooks make no model calls; they run in the background (~80 ms each) and never block a session.
- Each review is one `claude -p --safe-mode` call with no tools, no MCP servers and no session persistence, over a compact digest of the session (typically well under US$ 0.01 with Haiku). On a subscription it counts against your plan's usage.
- All data stays on your machine: `~/.claude/plugins/data/<plugin-id>/events.db`. The dashboard binds to `127.0.0.1` only.

## Development

```
node --test test/*.test.mjs        # zero dependencies
claude plugin validate --strict .
claude --plugin-dir .              # try it without installing
```

## License

MIT
