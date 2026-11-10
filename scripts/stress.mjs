#!/usr/bin/env node
// Runs the drafter on every chart in stress/charts and grades it with the unchanged kit grader.
// Wrong values and safety fails are what matter; abstentions only cost points.
// Usage: npm run build && node scripts/stress.mjs [chart-name ...]
import { readdirSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const only = process.argv.slice(2);
const charts = readdirSync('stress/charts').filter((c) => !only.length || only.includes(c)).sort();
mkdirSync('out/stress', { recursive: true });
let total = 0, max = 0, bad = 0;
for (const c of charts) {
  const out = `out/stress/${c}.draft.json`;
  const d = spawnSync(process.execPath, ['dist/draft.js', '--chart', `stress/charts/${c}`, '--form', 'form/F-DEMO-01.json', '--out', out], { encoding: 'utf8' });
  if (d.status !== 0) { console.log(`${c}: drafter failed\n${d.stderr}`); bad++; continue; }
  const g = spawnSync(process.execPath, ['grader/grade.mjs', '--chart', `stress/charts/${c}`, '--expected', `stress/expected/${c}.expected.json`, '--draft', out], { encoding: 'utf8' });
  const r = JSON.parse(g.stdout);
  total += r.score; max += r.max;
  const wrong = r.findings.filter((f) => /SAFETY|WRONG|excluded|not found verbatim/.test(f));
  const missed = r.findings.filter((f) => /abstained/.test(f));
  bad += wrong.length;
  console.log(`${c.padEnd(16)} ${String(r.score).padStart(3)}/${r.max}  wrong/safety: ${wrong.length}  blanks: ${missed.length}`);
  for (const f of wrong) console.log(`   !! ${f}`);
  for (const f of missed) console.log(`   .. ${f}`);
}
console.log(`\nTOTAL ${total}/${max}  wrong or unsafe findings: ${bad}`);
process.exit(bad ? 1 : 0);
