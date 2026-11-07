# Ouroboros

Self-learning for Claude Code. Ouroboros reviews your sessions, turns what is worth keeping into memories and skills, and shows on a local dashboard what it learned, how much that is used, and what it costs — in the spirit of Nous Research's Hermes Agent.

> **Status: phase 1 — measuring.** The plugin records session activity and, after each session, runs a small isolated model call that counts your corrections and lists what *could* have been learned. Nothing is written to your memories or skills yet. This builds the baseline the learning phases have to beat. See [DESIGN.md](DESIGN.md) for the full design and roadmap.

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
| `/ouroboros:dashboard` | Opens the local dashboard (`http://127.0.0.1:4747`) |
| `/ouroboros:backfill [days] [limit]` | Reviews past sessions to build the baseline right away (asks before spending) |

Everything else is automatic: capture hooks record turns, tool calls, error → fix recoveries, skill uses and memory reads/writes; a background reviewer runs when a session ends.

## Options

Set when enabling the plugin, or later in `/config`:

| Option | Default | |
|---|---|---|
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
