# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: the repository's **Security** tab → **Report a vulnerability**. Do not open a public issue for them.

Include what an attacker can do, the steps to reproduce, and the version (`.claude-plugin/plugin.json`).

Only the latest release is supported; fixes land on `main` and in the next version.

## Security model

What Ouroboros relies on, so a report can say which part fails:

- **Everything stays local.** Data lives in `events.db` under the plugin's data directory; the only network traffic is the isolated `claude -p --safe-mode` calls the reviewer and the knowledge check make, with no tools, no MCP servers and no session persistence.
- **The dashboard binds to `127.0.0.1` only.** Every request passes a `Host` check (against DNS rebinding); pages carry a strict CSP (`script-src 'self'`, no third-party origins). Writes go to `POST /api/action`, which requires a per-start token, a same-origin `Origin` and a JSON body.
- **Learning only from trusted sources.** Learnings come from user turns and observed outcomes, never from text that tools or web pages returned, to limit prompt injection into what Claude remembers. Entries in the inbox are treated as data, not instructions.
- **No secrets written.** Text a write adds is checked for token, key and password patterns and refused when it matches.
- **Every write is reversible.** Each change is recorded in a ledger with its diff and can be undone; archived items are moved, never deleted.
- **Hooks never run a shell.** They use exec form (`node <script> <event>`), and the reviewer's own sessions disable every hook (`OUROBOROS_REVIEWER=1`).
