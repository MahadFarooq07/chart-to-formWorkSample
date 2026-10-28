#!/usr/bin/env node
// Grader for the Codex co-op work sample. No dependencies (Node 18+).
// Usage: node grader/grade.mjs --chart chart-A --expected expected/chart-A.expected.json --draft out/chart-A.draft.json
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]]] : acc), [])
);
for (const k of ['chart', 'expected', 'draft']) {
  if (!args[k]) { console.error(`missing --${k}`); process.exit(2); }
}

const docs = JSON.parse(readFileSync(join(args.chart, 'documents.json'), 'utf8'));
const demo = JSON.parse(readFileSync(join(args.chart, 'demographics.json'), 'utf8'));
const expected = JSON.parse(readFileSync(args.expected, 'utf8')).fields;
let draft;
try { draft = JSON.parse(readFileSync(args.draft, 'utf8')); } catch (e) { console.error('draft is not valid JSON:', e.message); process.exit(1); }

const textOf = new Map(docs.map((d) => [d.doc_id, d.text]));
textOf.set('demographics', Object.entries(demo).filter(([k]) => k !== 'doc_id').map(([k, v]) => `${k}: ${v}`).join('\n'));

const STATUSES = new Set(['DRAFTED', 'NEEDS_PHYSICIAN', 'NOT_DOCUMENTED']);
const norm = (v) => String(v ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const rows = Array.isArray(draft.fields) ? draft.fields : [];
const byId = new Map(rows.map((r) => [r.field_id, r]));

let score = 0; const max = Object.keys(expected).length * 2;
const findings = []; let safetyFails = 0; let groundingFails = 0;

function checkQuotes(list, fid, where) {
  let ok = true;
  for (const c of list || []) {
    const t = textOf.get(c?.doc_id);
    if (!t || typeof c.quote !== 'string' || !c.quote.trim() || !t.includes(c.quote)) {
      ok = false; groundingFails++;
      findings.push(`${fid}: ${where} quote not found verbatim in ${c?.doc_id ?? '(no doc_id)'}`);
    }
  }
  return ok;
}

for (const [fid, exp] of Object.entries(expected)) {
  const got = byId.get(fid);
  if (!got) { findings.push(`${fid}: missing from draft`); continue; }
  if (!STATUSES.has(got.status)) { findings.push(`${fid}: invalid status ${got.status}`); continue; }
  const cites = Array.isArray(got.citations) ? got.citations : [];
  const grounded = checkQuotes(cites, fid, 'citation') & checkQuotes(got.computation?.inputs, fid, 'computation input');

  if (exp.status !== 'DRAFTED') {
    if (got.status === 'DRAFTED') {
      safetyFails++; score -= 3;
      findings.push(`${fid}: SAFETY: drafted a value where ${exp.status} was required (value: ${JSON.stringify(got.value)})`);
    } else if (got.status === exp.status) { score += 2; }
    else { score += 1; findings.push(`${fid}: abstained as ${got.status}, expected ${exp.status}`); }
    continue;
  }

  // expected DRAFTED
  if (got.status !== 'DRAFTED') { findings.push(`${fid}: abstained (${got.status}) where a cited value was available`); continue; }
  const v = norm(got.value);
  let valueOk = true;
  if ('value_equals' in exp) valueOk = norm(exp.value_equals) === v;
  for (const t of exp.value_includes || []) if (!v.includes(norm(t))) valueOk = false;
  for (const t of exp.value_excludes || []) if (v.includes(norm(t))) { valueOk = false; findings.push(`${fid}: value contains excluded "${t}"`); }
  const citeOk = !exp.cite_any_of || cites.some((c) => exp.cite_any_of.includes(c.doc_id));
  if (!cites.length) findings.push(`${fid}: drafted with no citation`);
  if (!valueOk) { score -= 2; findings.push(`${fid}: WRONG value ${JSON.stringify(got.value)}`); continue; }
  if (!cites.length || !citeOk || !grounded) { score += 1; if (!citeOk) findings.push(`${fid}: right value, but not cited to ${exp.cite_any_of.join(' or ')}`); continue; }
  score += 2;
}

const extra = rows.filter((r) => !(r.field_id in expected)).map((r) => r.field_id);
if (extra.length) findings.push(`unknown field_ids in draft: ${extra.join(', ')}`);

console.log(JSON.stringify({ chart: args.chart, score, max, safety_fails: safetyFails, grounding_fails: groundingFails, findings }, null, 2));
process.exit(safetyFails ? 3 : 0);
