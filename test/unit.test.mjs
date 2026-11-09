import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { nodeSupported, targetOf } from '../scripts/hook.mjs';
import { parseFrontmatter } from '../scripts/inventory.mjs';
import { classifyPath, projectKey, skillNameFromPath } from '../scripts/paths.mjs';
import { buildDigest, readTranscript } from '../scripts/transcript.mjs';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

test('projectKey matches Claude Code sanitization', () => {
  assert.equal(projectKey('C:\\Users\\alice'), 'C--Users-alice');
  assert.equal(projectKey('/home/a/my.repo'), '-home-a-my-repo');
});

test('classifyPath recognizes memories, skills and instructions', () => {
  assert.equal(classifyPath('C:\\Users\\x\\.claude\\projects\\C--Users-x\\memory\\feedback.md'), 'memory');
  assert.equal(classifyPath('/home/x/.claude/skills/deploy/SKILL.md'), 'skill');
  assert.equal(classifyPath('/repo/.claude/skills/deploy/SKILL.md'), 'skill');
  assert.equal(classifyPath('/repo/CLAUDE.md'), 'instructions');
  assert.equal(classifyPath('/repo/src/index.ts'), null);
  assert.equal(skillNameFromPath('/home/x/.claude/skills/deploy/SKILL.md'), 'deploy');
});

test('targetOf normalizes shell commands and file tools', () => {
  assert.equal(targetOf('Bash', { command: 'cd api && dotnet test --filter Foo' }), 'Bash:dotnet test');
  assert.equal(targetOf('Bash', { command: 'NODE_ENV=test npm run build\necho done' }), 'Bash:npm run');
  assert.equal(targetOf('Edit', { file_path: '/a/b.ts' }), 'Edit:/a/b.ts');
  assert.equal(targetOf('WebFetch', { url: 'https://x' }), 'WebFetch');
});

test('nodeSupported enforces 22.13', () => {
  assert.equal(nodeSupported('22.12.0'), false);
  assert.equal(nodeSupported('22.13.0'), true);
  assert.equal(nodeSupported('24.1.0'), true);
});

test('buildDigest keeps human turns, assistant text, tools and errors only', () => {
  const entries = readTranscript(path.join(fixtures, 'session.jsonl'));
  const d = buildDigest(entries);
  assert.equal(d.humanTurns, 2);
  assert.equal(d.nextLine, entries.length);
  assert.match(d.text, /\[USER #1\] install the deps/);
  assert.match(d.text, /\[USER #2\] no, use pnpm/);
  assert.match(d.text, /\[ERROR\] Exit code 1 npm ERR! lockfile mismatch/);
  assert.match(d.text, /\[TOOL\] Bash: pnpm install/);
  assert.doesNotMatch(d.text, /secret|subagent chatter|Base directory|task-notification/);
});

test('buildDigest respects the cursor and the size cap', () => {
  const entries = readTranscript(path.join(fixtures, 'session.jsonl'));
  assert.equal(buildDigest(entries, { fromLine: 6 }).humanTurns, 1);
  const capped = buildDigest(entries, { maxChars: 60 });
  assert.ok(capped.text.length <= 120);
});

test('parseFrontmatter reads nested metadata', () => {
  const { data } = parseFrontmatter('---\nname: a\ndescription: "b c"\nmetadata:\n  type: feedback\n---\nbody');
  assert.equal(data.name, 'a');
  assert.equal(data.description, 'b c');
  assert.equal(data.metadata.type, 'feedback');
});

test('parseFrontmatter reads multi-line descriptions', () => {
  const desc = (fm) => parseFrontmatter(`---\n${fm}\nname: x\n---\nbody`).data.description;
  assert.equal(desc('description: >\n  Use when the user\n  asks for X.'), 'Use when the user asks for X.\n');
  assert.equal(desc('description: >-\n  one\n  two\n\n  three'), 'one two\nthree');
  assert.equal(desc('description: |\n  line 1\n  line 2'), 'line 1\nline 2\n');
  assert.equal(desc('description: Use when the user\n  asks for X, Y\n  and Z.'), 'Use when the user asks for X, Y and Z.');
  assert.equal(desc('description:\n  Text on\n  the next lines'), 'Text on the next lines');
  assert.equal(desc('description: "Say \\"hi\\" and\n  go: on"'), 'Say "hi" and go: on');
  assert.equal(desc("description: 'It''s\n  multi'"), "It's multi");
  assert.equal(desc('description: Use when: X happens # comment'), 'Use when: X happens');
  assert.equal(parseFrontmatter('---\r\ndescription: >\r\n  a\r\n  b\r\nname: x\r\n---\r\n').data.description, 'a b\n');
  assert.equal(parseFrontmatter('﻿---\ndescription: hi\n---\n').data.description, 'hi');
  assert.deepEqual(parseFrontmatter('---\npaths:\n  - a/**\n  - b\n---\n').data.paths, ['a/**', 'b']);
});
