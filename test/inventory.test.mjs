// Plugin skills come from where Claude Code loads each plugin: a plugin from a local
// (`directory`) marketplace from that folder, not from the stale copy made at install.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ouroboros-inventory-'));
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
const plugins = path.join(tmp, 'claude', 'plugins');

function skill(dir, name) {
  fs.mkdirSync(path.join(dir, 'skills', name), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\n`);
}

test('a directory marketplace plugin lists the skills of its folder; others their install path', async () => {
  // Local marketplace: the repo has two skills, the copy made at install only one.
  const repo = path.join(tmp, 'repos', 'tool');
  fs.mkdirSync(path.join(repo, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'local', plugins: [{ name: 'tool', source: './' }] }));
  skill(repo, 'old');
  skill(repo, 'new');
  const stale = path.join(plugins, 'cache', 'local', 'tool', '0.1.0');
  skill(stale, 'old');
  // Remote marketplace: its install path is what loads.
  const remote = path.join(plugins, 'cache', 'remote', 'kit', '2.0.0');
  skill(remote, 'lint');
  fs.writeFileSync(path.join(plugins, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {
    'tool@local': [{ installPath: stale }],
    'kit@remote': [{ installPath: remote }],
  } }));
  fs.writeFileSync(path.join(plugins, 'known_marketplaces.json'), JSON.stringify({
    local: { source: { source: 'directory', path: repo }, installLocation: repo },
    remote: { source: { source: 'github', repo: 'someone/kit' }, installLocation: path.join(plugins, 'marketplaces', 'remote') },
  }));

  const { listPluginSkills } = await import('../scripts/inventory.mjs');
  const names = listPluginSkills().map((s) => s.name).sort();
  assert.deepEqual(names, ['kit:lint', 'tool:new', 'tool:old']);
  assert.ok(listPluginSkills().find((s) => s.name === 'tool:new').file.startsWith(repo));
});
