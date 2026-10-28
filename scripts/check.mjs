// Drafts and grades every chart that has an expected file. Exit code 1 if any chart loses a point.
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
let bad = false;
for (const f of readdirSync('expected').filter((f) => f.endsWith('.expected.json')).sort()) {
  const chart = f.replace('.expected.json', '');
  execFileSync('node', ['dist/draft.js', '--chart', chart, '--form', 'form/F-DEMO-01.json', '--out', `out/${chart}.draft.json`], { stdio: 'inherit' });
  const r = JSON.parse(execFileSync('node', ['grader/grade.mjs', '--chart', chart, '--expected', `expected/${f}`, '--draft', `out/${chart}.draft.json`], { encoding: 'utf8' }));
  console.log(`${chart}: ${r.score}/${r.max}  safety_fails=${r.safety_fails}  grounding_fails=${r.grounding_fails}`);
  for (const line of r.findings) console.log(`  - ${line}`);
  if (r.score !== r.max || r.safety_fails || r.grounding_fails) bad = true;
}
process.exit(bad ? 1 : 0);
