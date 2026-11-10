---
name: undo
description: Revert an Ouroboros learning write (the last one, or a given learning id). Use when the user asks to undo, revert or discard something Ouroboros just learned or updated.
argument-hint: "[learning id, or empty for the last write]"
allowed-tools:
  - Bash(node --no-warnings *scripts/curator.mjs* *)
---

# Undo an Ouroboros write

Run, with `--id <lrn_…>` when `$ARGUMENTS` names a learning id, otherwise `--last`:

```bash
node --no-warnings "${CLAUDE_PLUGIN_ROOT}/scripts/curator.mjs" undo --data "${CLAUDE_PLUGIN_DATA}" --last
```

Report the result in one line (`↩ undone: <title>`). If the file was edited after the write, undo reverts only the lines that write changed and keeps the other edits. On `conflict`, those very lines were edited since: show the file path and offer to edit it by hand or to archive the learning with `/ouroboros:forget`.
