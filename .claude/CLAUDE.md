# Ouroboros

Claude Code plugin that learns from sessions on its own (memories + skills) with a local dashboard. The full design is in `DESIGN.md`; read it before changing behavior, and update it when a decision changes.

- **Every file in this repository is in English** — code, comments, docs, skills, commit messages and dashboard UI, whatever language the conversation is in.
- Runtime: Node ≥ 22.13, zero dependencies (`node:sqlite`, `node:http`). No `npm install`, no build step.
- Must work on Windows, macOS and Linux: hooks use exec form (`node <script> <args>`), never shell-specific syntax.
- Never write plugin state under `${CLAUDE_PLUGIN_ROOT}` (it changes on update); use `${CLAUDE_PLUGIN_DATA}` or `~/.ouroboros/`.
- Plugin names must not start with `claude-`; validate with `claude plugin validate --strict`.
- Every user-visible change (fix or feature) ships its release in the same PR: bump `version` in `.claude-plugin/plugin.json`, the `Status: vX.Y.Z` line at the top of `DESIGN.md`, and add a `CHANGELOG.md` entry (a minor gets its own `## X.Y.0 — <date>` section; a patch is a `- X.Y.Z: …` bullet under its minor's section).
