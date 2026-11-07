// Stand-in for `claude -p` in tests: reads the prompt and returns a canned result.
let prompt = '';
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  const ok = args.includes('--safe-mode') && args.includes('--json-schema') && prompt.includes('<digest>');
  process.stdout.write(JSON.stringify({
    type: 'result',
    is_error: !ok,
    result: ok ? '' : 'bad invocation',
    total_cost_usd: 0.0042,
    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 500 },
    structured_output: ok
      ? {
          corrections: [{ user_turn: 2, quote: 'no, use pnpm', kind: 'explicit' }],
          candidates: [{
            kind: 'memory', scope: 'project', memory_type: 'feedback', title: 'Use pnpm',
            summary: 'This repo uses pnpm, not npm.', evidence: 'USER #2', confidence: 0.8,
          }],
        }
      : undefined,
  }));
});
