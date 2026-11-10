import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { draftForm, verify, Form, Doc, Result } from './draft.js';
const form: Form = JSON.parse(readFileSync('form/F-DEMO-01.json', 'utf8'));
const doc = (text: string, date = '2026-09-01', doc_id = 'G1', author_role = 'family_physician'): Doc => ({ text, date, doc_id, author_role, type: 'clinic_note' });
const field = (id: string, docs: Doc[]) => draftForm(form, docs, {}).find(f => f.field_id === id)!;

for (const chart of ['reference-B', 'reference-C']) test(`reference fixture ${chart}: full grade with grounded values`, () => {
  const dir = `fixtures/${chart}`;
  const docs = JSON.parse(readFileSync(`${dir}/documents.json`, 'utf8'));
  const demographics = JSON.parse(readFileSync(`${dir}/demographics.json`, 'utf8'));
  mkdirSync('out', { recursive: true });
  const out = `out/${chart}.test.json`;
  writeFileSync(out, JSON.stringify({ chart, form_id: form.form_id, fields: draftForm(form, docs, demographics) }));
  const r = JSON.parse(execFileSync(process.execPath, ['grader/grade.mjs', '--chart', dir, '--expected', `${dir}/expected.json`, '--draft', out], { encoding: 'utf8' }));
  assert.equal(r.score, r.max, r.findings.join('\n'));
  assert.equal(r.safety_fails, 0);
  assert.equal(r.grounding_fails, 0);
});

test('old inline confirmation cannot be renewed by the letter date', () => {
  const r = field('respirologist_confirmed_within_24_months', [doc('Diagnosis of severe asthma was confirmed on 2023-01-10.', '2026-09-01', 'G1', 'respirologist')]);
  assert.equal(r.status, 'NOT_DOCUMENTED');
});
test('valid inline confirmation stays drafted and a future event does not', () => {
  for (const [date, expected] of [['2026-03-01', 'DRAFTED'], ['2027-03-01', 'NOT_DOCUMENTED']]) {
    assert.equal(field('respirologist_confirmed_within_24_months', [doc(`Diagnosis of severe asthma confirmed on ${date}.`, '2026-09-01', 'G1', 'respirologist')]).status, expected);
  }
});
test('stopping all inhalers invalidates an older active list', () => {
  const r = field('current_inhaled_therapy', [doc('Active medications: Symbicort 200/6 mcg 2 puffs twice daily.', '2026-01-01', 'G1'), doc('Patient has stopped all inhalers since June.', '2026-09-01', 'G2')]);
  assert.equal(r.status, 'NOT_DOCUMENTED');
});
test('a new documented regimen can follow an all-inhalers stop', () => {
  const r = field('current_inhaled_therapy', [doc('Patient stopped all inhalers.', '2026-01-01', 'G1'), doc('Started Symbicort 200/6 mcg 2 puffs twice daily.', '2026-09-01', 'G2')]);
  assert.equal(r.status, 'DRAFTED');
});
test('nasal corticosteroid is excluded from the asthma inhaler list', () => {
  const r = field('current_inhaled_therapy', [doc('Active medications: fluticasone/salmeterol 500/50 mcg one inhalation twice daily; fluticasone propionate nasal spray 50 mcg two sprays each nostril daily.')]);
  assert.equal(r.status, 'DRAFTED');
  assert.doesNotMatch(String(r.value), /nasal|nostril/);
  assert.equal(field('current_inhaled_therapy', [doc('Medications: fluticasone propionate nasal spray 50 mcg daily.')]).status, 'NOT_DOCUMENTED');
});

test('verifier enforces field types, source classes and computation evidence', () => {
  const texts = new Map([['G1', 'explicit evidence'], ['demographics', 'phn: SYNTH-1']]);
  const r: Result = { status: 'DRAFTED', value: 'true', citations: [{ doc_id: 'G1', quote: 'explicit evidence' }], computation: null };
  const f = form.fields.find(f => f.field_id === 'respirologist_confirmed_within_24_months')!;
  assert.equal(verify(r, texts, f).status, 'NOT_DOCUMENTED');
  assert.equal(verify({ ...r, value: true, computation: { rule: 'test', inputs: [] } }, texts, f).status, 'NOT_DOCUMENTED');
  const phn = form.fields.find(f => f.field_id === 'phn')!;
  assert.equal(verify(r, texts, phn).status, 'NOT_DOCUMENTED');
  assert.equal(verify({ ...r, citations: [{ doc_id: 'demographics', quote: 'phn: SYNTH-1' }] }, texts, form.fields.find(f => f.field_id === 'diagnosis')!).status, 'NOT_DOCUMENTED');
  assert.equal(verify(r, texts, form.fields.find(f => f.field_id === 'requested_dose_regimen')!).status, 'NEEDS_PHYSICIAN');
});
test('an explicit continuing discharge course is not a second new course', () => {
  const docs = [doc('Asthma exacerbation. Prednisone 40 mg daily for 5 days.', '2026-03-05', 'G1'), doc('Admitted 2026-03-05 with asthma exacerbation; treated with prednisone, course to finish 2026-03-10.', '2026-03-08', 'G2')];
  assert.equal(field('systemic_steroid_courses_past_12_months', docs).value, 1);
  assert.equal(field('systemic_steroid_courses_past_12_months', [docs[1]]).status, 'NOT_DOCUMENTED');
});
