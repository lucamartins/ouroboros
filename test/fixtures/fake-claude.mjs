// Stand-in for `claude -p` in tests: reads the prompt and returns a canned result
// shaped by the requested JSON schema (measure, learn, screen, edit or consolidate).
let prompt = '';
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  const schema = args[args.indexOf('--json-schema') + 1] || '';
  const ok = args.includes('--safe-mode') && args.includes('--json-schema');
  const corrections = [{ user_turn: 2, quote: 'no, use pnpm', kind: 'explicit' }];
  let structured;
  if (schema.includes('"edits"')) {
    // Editor: a claim whose first line is already in the file is covered; CONTRADICT ->
    // contradicted; "FIX:<old>=><new>" -> corrects; anything else is added after the
    // file's last line, all additions in one edit.
    const file = /<file>\n([\s\S]*?)\n<\/file>/.exec(prompt)?.[1] || '';
    const claims = [...prompt.matchAll(/<claim id="(\d+)"[^>]*>\n([\s\S]*?)\n<\/claim>/g)].map((m) => ({ id: Number(m[1]), text: m[2].split('\nevidence:')[0].trim() }));
    const status = [];
    const edits = [];
    const adds = [];
    for (const c of claims) {
      const first = c.text.split('\n')[0].trim();
      const fix = /FIX:(.+?)=>(.+)$/.exec(first);
      if (fix) {
        status.push({ id: c.id, status: 'corrects', reason: 'outdated' });
        edits.push({ old: fix[1], new: fix[2], claims: [c.id] });
      } else if (first.includes('CONTRADICT')) status.push({ id: c.id, status: 'contradicted', reason: 'the code says otherwise' });
      else if (file.includes(first)) status.push({ id: c.id, status: 'covered', reason: 'already there' });
      else { status.push({ id: c.id, status: 'adds', reason: 'new detail' }); adds.push(c); }
    }
    const last = file.split('\n').filter((l) => l.trim() && !l.startsWith('---')).pop();
    if (adds.length && last) edits.push({ old: last, new: `${last}\n${adds.map((c) => c.text.split('\n')[0].trim()).join('\n')}`, claims: adds.map((c) => c.id) });
    structured = { claims: status, edits };
  } else if (schema.includes('"verdicts"')) {
    // Screen: DROPME -> covered, MERGEME -> merged into the first proposal,
    // ROUTEME:<file> -> routed to that owner, FIXME -> a fix suggestion, else keep.
    const props = [...prompt.matchAll(/<proposal id="(\d+)">([\s\S]*?)<\/proposal>/g)].map((m) => ({ id: Number(m[1]), text: m[2] }));
    structured = {
      verdicts: props.map((p) => (p.text.includes('DROPME')
        ? { id: p.id, verdict: 'drop', drop_kind: 'covered', reason: 'already documented', covered_by: 'CLAUDE.md' }
        : p.text.includes('ROUTEME:')
          ? { id: p.id, verdict: 'route', reason: 'owner exists', rule: 'owner', owner: /ROUTEME:(\S+)/.exec(p.text)[1],
              claim: /CLAIM:(.+)/.exec(p.text)?.[1].trim() || 'Use the deploy script.' }
        : p.text.includes('FIXME')
          ? { id: p.id, verdict: 'fix', reason: 'fixable', rule: 'fix-at-source', fix: 'Add the generated file to .gitignore.' }
        : p.text.includes('MERGEME')
          ? { id: p.id, verdict: 'merge', merge_into: props[0].id, reason: 'same rule' }
          : { id: p.id, verdict: 'keep', reason: 'new' })),
    };
  } else if (schema.includes('"groups"')) {
    structured = { groups: [] };
  } else if (schema.includes('"bullets"')) {
    // Consolidation: merge the first two bullets, keep the rest.
    const bullets = [...prompt.matchAll(/^- \[(lrn_[a-z0-9]+)\] (.*)$/gm)].map((m) => ({ id: m[1], text: m[2] }));
    structured = {
      bullets: [
        { text: `${bullets[0].text} / ${bullets[1].text}`.slice(0, 120), sources: [bullets[0].id, bullets[1].id] },
        ...bullets.slice(2).map((b) => ({ text: b.text, sources: [b.id] })),
      ],
    };
  } else if (!schema.includes('"candidates"')) {
    structured = {
      corrections,
      items: [
        { kind: 'memory', memory_type: 'feedback', title: 'Use pnpm', description: 'This repo uses pnpm, not npm',
          body: 'Use pnpm.\n\n**Why:** lockfile.', confidence: 0.8, evidence: 'USER #2' },
        { kind: 'profile', block: 'environment', title: 'Shell', text: 'Hooks run under Git Bash on Windows', confidence: 0.6, evidence: 'USER #1' },
      ],
    };
  } else {
    structured = {
      corrections,
      candidates: [{
        kind: 'memory', scope: 'project', memory_type: 'feedback', title: 'Use pnpm',
        summary: 'This repo uses pnpm, not npm.', evidence: 'USER #2', confidence: 0.8,
      }],
    };
  }
  const valid = ok && (schema.includes('"bullets"') || schema.includes('"edits"') || schema.includes('"verdicts"') || schema.includes('"groups"') || prompt.includes('<digest>'));
  process.stdout.write(JSON.stringify({
    type: 'result',
    is_error: !valid,
    result: valid ? '' : 'bad invocation',
    total_cost_usd: 0.0042,
    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 500 },
    structured_output: valid ? structured : undefined,
  }));
});
