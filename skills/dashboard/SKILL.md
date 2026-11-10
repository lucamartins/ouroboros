---
name: dashboard
description: Open the Ouroboros dashboard (local web page with what was learned, usage, value and cost). Use when the user asks to see the Ouroboros dashboard, learning stats, review cost or what Claude has been learning.
allowed-tools:
  - Bash(node --no-warnings *dashboard/server.mjs* *)
---

# Open the Ouroboros dashboard

Run this command (it starts the local server if needed, opens the browser and exits):

```bash
node --no-warnings "${CLAUDE_PLUGIN_ROOT}/dashboard/server.mjs" --data "${CLAUDE_PLUGIN_DATA}"
```

Reply with the URL it prints, in one line. If it fails, show the error output.
