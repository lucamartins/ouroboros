---
name: forget
description: Archive something Ouroboros learned (a profile fact, memory or skill) so it stops loading into sessions. Use when the user says a learning is wrong, outdated or unwanted.
argument-hint: "<learning id, name or words from its title>"
allowed-tools: Bash(node:*)
---

# Forget an Ouroboros learning

```bash
node --no-warnings "${CLAUDE_PLUGIN_ROOT}/scripts/curator.mjs" forget --data "${CLAUDE_PLUGIN_DATA}" --match "$ARGUMENTS"
```

- `archived` → confirm in one line (`🗑 archived: <title>`); it was moved to `~/.ouroboros/archive/` and can be restored with `/ouroboros:undo`.
- `ambiguous` → list the matches (id, kind, title) and ask which one.
- `not_found` → say so; it only archives items Ouroboros created or patched.
