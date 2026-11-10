import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { draftForm, Form, Doc } from './draft.js';

const form: Form = JSON.parse(readFileSync('form/F-DEMO-01.json', 'utf8'));
for (const chart of readdirSync('stress/charts')) {
  test(`mock chart ${chart}: no wrong, unsafe or ungrounded values`, () => {
    const dir = `stress/charts/${chart}`;
    const docs = JSON.parse(readFileSync(`${dir}/documents.json`, 'utf8'));
    const demo = JSON.parse(readFileSync(`${dir}/demographics.json`, 'utf8'));
    mkdirSync('out/stress', { recursive: true });
    const out = `out/stress/${chart}.test.json`;
    writeFileSync(out, JSON.stringify({ chart, form_id: form.form_id, fields: draftForm(form, docs, demo) }));
    const r = JSON.parse(execFileSync(process.execPath, ['grader/grade.mjs', '--chart', dir, '--expected', `stress/expected/${chart}.expected.json`, '--draft', out], { encoding: 'utf8' }));
    assert.equal(r.safety_fails, 0);
    assert.equal(r.grounding_fails, 0);
    // Blanks cost a point but are safe; anything else (wrong value, excluded text, missing citation) fails.
    const bad = r.findings.filter((f: string) => !/abstained \(NOT_DOCUMENTED\) where a cited value was available/.test(f));
    assert.deepEqual(bad, []);
  });
}
const doc = (text: string, date = '2026-09-01', doc_id = 'S1'): Doc => ({ text, date, doc_id, type: 'clinic_note', author_role: 'family_physician' });
const field = (id: string, docs: Doc[]) => draftForm(form, docs, {}).find(f => f.field_id === id)!;

test('an unmarked conflicting lab must still abstain', () => {
  const r = field('blood_eosinophils_most_recent', [doc('Collected 2026-08-01. Eosinophils 0.5 x10^9/L.', '2026-08-02', 'S1'), doc('Collected 2026-08-01. Eosinophils 0.05 x10^9/L.', '2026-08-03', 'S2')]);
  assert.equal(r.status, 'NOT_DOCUMENTED');
});
test('correcting a different analyte does not resolve eosinophil conflict', () => {
  const r = field('blood_eosinophils_most_recent', [doc('Collected 2026-08-01. Eosinophils 0.5 x10^9/L.', '2026-08-02', 'S1'), doc('Collected 2026-08-01. Eosinophils 0.05 x10^9/L. Sodium corrected.', '2026-08-03', 'S2')]);
  assert.equal(r.status, 'NOT_DOCUMENTED');
});
test('planned first injection is not completed treatment', () => {
  const r = field('prior_biologic_trial', [doc('Plan: first omalizumab injection on March 1, 2026. Omalizumab stopped 2026-05-01 due to lack of response.')]);
  assert.equal(r.status, 'NOT_DOCUMENTED');
});
test('infection alone does not establish an asthma steroid course', () => {
  assert.equal(field('systemic_steroid_courses_past_12_months', [doc('COVID-19. Prednisone 40 mg daily for 5 days.')]).status, 'NOT_DOCUMENTED');
});
test('a hedged dose increase never becomes current therapy', () => {
  assert.equal(field('current_inhaled_therapy', [doc('Consider Advair increased to 500/50 one inhalation twice daily.')]).status, 'NOT_DOCUMENTED');
});
test('dose update excludes the old dose while retaining its full citation', () => {
  const text = 'Advair increased from 250/50 to 500/50 one inhalation twice daily.';
  const r = field('current_inhaled_therapy', [doc(text)]);
  assert.equal(r.status, 'DRAFTED');
  assert.match(String(r.value), /500\/50/);
  assert.doesNotMatch(String(r.value), /250\/50/);
  assert.equal(r.citations[0].quote, text.slice(0, -1));
});
test('quitting a job is not a smoking-status update', () => {
  const r = field('smoking_status', [doc('Patient currently smokes. Quit job in 2015.')]);
  assert.equal(r.status, 'DRAFTED');
  assert.match(String(r.value), /^Current smoker/);
  assert.doesNotMatch(String(r.value), /2015/);
});

test('asthma has flared still requires an attributed steroid course', () => {
  assert.equal(field('systemic_steroid_courses_past_12_months', [doc('Asthma has flared after a cold. Prednisone 40 mg daily for 5 days.')]).value, 1);
  assert.equal(field('systemic_steroid_courses_past_12_months', [doc('Asthma has not flared. Prednisone 40 mg daily for gout.')]).status, 'NOT_DOCUMENTED');
});
test('first infusion administered and discontinuation shorthand', () => {
  const r = field('prior_biologic_trial', [doc('Reslizumab first infusion administered 2026-01-01. Reslizumab d/c 2026-04-01 due to lack of response.')]);
  assert.equal(r.status, 'DRAFTED');
  assert.match(String(r.value), /started 2026-01-01, stopped 2026-04-01/);
});
test('planned or unrelated first infusion cannot establish a biologic start', () => {
  for (const text of ['Reslizumab plan: first infusion administered 2026-01-01.', 'Reslizumab discussed. First saline infusion 2026-01-01.']) {
    assert.equal(field('prior_biologic_trial', [doc(`${text} Reslizumab d/c 2026-04-01 due to lack of response.`)]).status, 'NOT_DOCUMENTED');
  }
});
