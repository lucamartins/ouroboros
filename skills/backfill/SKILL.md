---
name: backfill
description: Review past Claude Code sessions to build the Ouroboros baseline right away (counts corrections and lists what could have been learned; writes nothing).
disable-model-invocation: true
argument-hint: "[days=30] [limit=20]"
allowed-tools: Bash(node:*)
---

# Backfill the baseline from past sessions

Arguments: `$ARGUMENTS` (optional: number of days to look back, then the maximum number of sessions). Defaults: 30 days, 20 sessions.

1. Dry run first, to show what would be reviewed:

   ```bash
   node --no-warnings "${CLAUDE_PLUGIN_ROOT}/scripts/review-worker.mjs" --backfill --dry-run --days <days> --limit <limit> --data "${CLAUDE_PLUGIN_DATA}"
   ```

2. Tell the user how many sessions and user turns that is, and that each review is one isolated small-model call (typically well under US$ 0.01 per session with Haiku, capped by the plugin's monthly budget). Ask for confirmation.

3. On confirmation, run the same command without `--dry-run` (it can take a few minutes; run it in the background if it is long) and report the final line (reviews and total cost). Suggest opening `/ouroboros:dashboard`.
