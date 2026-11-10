---
name: backfill
description: Process past Claude Code sessions with Ouroboros — measure them (baseline of corrections) or learn from them as if Ouroboros had been active (proposals go to the approval queue).
disable-model-invocation: true
argument-hint: "[measure|learn] [days=30] [limit=20]"
allowed-tools:
  - Bash(node --no-warnings *scripts/review-worker.mjs* *)
---

# Backfill past sessions

Arguments: `$ARGUMENTS` — first the mode (`measure`, the default, or `learn`), then days to look back (default 30), then the maximum number of sessions (default 20).

- **measure**: counts corrections and lists what could have been learned; writes nothing. Skips sessions already recorded.
- **learn**: reviews each session as if Ouroboros had been active, **oldest first**, and sends every proposal to the **approval queue** (similar proposals from different sessions are merged, the newest version wins). Corrections are not counted again. Skips sessions already learned from.

1. Dry run first (add `--learn` for learn mode):

   ```bash
   node --no-warnings "${CLAUDE_PLUGIN_ROOT}/scripts/review-worker.mjs" --backfill --dry-run --days <days> --limit <limit> --data "${CLAUDE_PLUGIN_DATA}"
   ```

2. Tell the user how many sessions and user turns that is, and that each session costs one isolated small-model call (two in measure mode: the correction count and what would have been learned; typically under US$ 0.01 each with Haiku, plus small merge calls in learn mode; capped by the plugin's monthly budget). Ask for confirmation.

3. On confirmation, run the same command without `--dry-run` (run it in the background if it is long) and report the final lines (calls, cost and, in learn mode, how many proposals are waiting). In learn mode, point the user to the inbox: `/ouroboros:inbox`, or the Inbox page of `/ouroboros:dashboard`.
