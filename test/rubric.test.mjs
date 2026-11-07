// The rubric is the one definition of "worth remembering". Every place that judges
// learnings must carry it verbatim, so behavior stays consistent across paths.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { appendToSection, needsApproval } from '../scripts/curator.mjs';
import { RUBRIC_SHORT, RULES, rubricText } from '../scripts/rubric.mjs';
import { learnPrompt, measurePrompt } from '../scripts/review-worker.mjs';
import { triagePrompt } from '../scripts/triage.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the learn skill carries the rubric verbatim', () => {
  const skill = fs.readFileSync(path.join(root, 'skills', 'learn', 'SKILL.md'), 'utf8');
  const block = /<!-- rubric:start[^>]*-->\n([\s\S]*?)\n<!-- rubric:end -->/.exec(skill);
  assert.ok(block, 'rubric markers missing in skills/learn/SKILL.md');
  assert.equal(block[1], rubricText(), 'skills/learn/SKILL.md rubric is out of date: regenerate it from scripts/rubric.mjs');
});

test('reviewer and triage prompts include every rubric rule', () => {
  const prompts = [
    learnPrompt({ digest: 'x', inventory: 'y', lang: 'en' }),
    measurePrompt({ digest: 'x', inventory: 'y' }),
    triagePrompt({ batch: [{ id: 1, kind: 'memory', title: 't' }], others: [], excerpts: [], owners: [], lang: 'en' }),
  ];
  for (const p of prompts) for (const r of RULES) assert.ok(p.includes(r.test), `prompt lacks rule "${r.id}"`);
});

test('the session protocol carries the short rubric', async () => {
  const { PROTOCOL } = await import('../scripts/hook.mjs');
  assert.ok(PROTOCOL.includes(RUBRIC_SHORT));
});

test('appendToSection adds under a heading, under a bold topic, or at the end', () => {
  const md = '# T\n\n## Deploy\n\nZip with Python.\n\n## Tests\n\nRun them.\n';
  assert.equal(appendToSection(md, 'deploy', 'Use the script.'), '# T\n\n## Deploy\n\nZip with Python.\nUse the script.\n\n## Tests\n\nRun them.\n');
  const bullets = '- **Stripe**: keys per tenant.\n  more.\n- **Email**: Resend.\n';
  assert.equal(appendToSection(bullets, 'Stripe', 'Check webhooks first.'), '- **Stripe**: keys per tenant.\n  more.\n- Check webhooks first.\n- **Email**: Resend.\n');
  assert.equal(appendToSection('a\n', 'nowhere', 'b'), 'a\nb\n');
});

test('corrections and changes to rule files or CLAUDE.md always wait for approval', () => {
  const rule = path.join(root, 'x', '.claude', 'rules', 'billing.md');
  const claudeMd = path.join(root, 'x', 'CLAUDE.md');
  const skill = path.join(root, 'x', '.claude', 'skills', 'a', 'SKILL.md');
  assert.equal(needsApproval({ op: 'patch', target: rule, confidence: 0.9 }, 'background', 'auto'), true);
  assert.equal(needsApproval({ op: 'patch', target: claudeMd, confidence: 0.9 }, 'inloop', 'auto'), true);
  assert.equal(needsApproval({ op: 'patch', target: skill, corrects: true, confidence: 0.9 }, 'background', 'auto'), true);
  assert.equal(needsApproval({ op: 'patch', target: skill, confidence: 0.9 }, 'background', 'auto'), false);
  assert.equal(needsApproval({ op: 'patch', target: rule, corrects: true }, 'manual', 'queue'), false, 'explicit requests are written');
});
