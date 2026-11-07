---
name: undo
description: Revert an Ouroboros learning write (the last one, or a given learning id). Use when the user asks to undo, revert or discard something Ouroboros just learned or updated.
argument-hint: "[learning id, or empty for the last write]"
allowed-tools: Bash(node:*)
---

# Undo an Ouroboros write

Run, with `--id <lrn_…>` when `$ARGUMENTS` names a learning id, otherwise `--last`:

```bash
node --no-warnings "${CLAUDE_PLUGIN_ROOT}/scripts/curator.mjs" undo --data "${CLAUDE_PLUGIN_DATA}" --last
```

Report the result in one line (`↩ undone: <title>`). On `conflict`, the file changed after the write: show the file path and offer to edit it by hand or to archive the learning with `/ouroboros:forget`.
