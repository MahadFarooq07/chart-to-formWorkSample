import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { draftForm, Doc, Form } from './draft.js';

const form: Form = JSON.parse(readFileSync('form/F-DEMO-01.json', 'utf8'));
const doc = (text: string, doc_id = 'R1', date = '2026-10-01'): Doc =>
  ({ text, doc_id, date, type: 'clinic_note', author_role: 'family_physician' });
const result = (id: string, docs: Doc[], f = form) => draftForm(f, docs, {}).find(x => x.field_id === id)!;

const traps: [string, string, Doc[]][] = [
  ['future collection', 'blood_eosinophils_most_recent', [doc('Collected 2027-01-01. Eosinophils 0.45 x10^9/L.')]],
  ['collection after report', 'blood_eosinophils_most_recent', [doc('Collected 2026-10-02. Eosinophils 0.45 x10^9/L.')]],
  ['hypothetical lab', 'blood_eosinophils_most_recent', [doc('Collected 2026-09-01. If eosinophils 0.45 x10^9/L, consider therapy.')]],
  ['relative lab', 'blood_eosinophils_most_recent', [doc('Collected 2026-09-01. Mother has eosinophils 0.45 x10^9/L.')]],
  ['relative biologic', 'prior_biologic_trial', [doc('Mother: omalizumab started 2024-05-15 and stopped 2024-09-10 due to lack of response.')]],
  ['future biologic', 'prior_biologic_trial', [doc('Omalizumab started 2027-05-15 and stopped 2027-09-10 due to lack of response.')]],
  ['relative steroid', 'systemic_steroid_courses_past_12_months', [doc('Mother has an asthma exacerbation. Prednisone 40 mg daily for 5 days.')]],
  ['relative inhaler', 'current_inhaled_therapy', [doc('Mother currently on salbutamol 100 mcg as needed.')]],
  ['planned medication list', 'current_inhaled_therapy', [doc('Medications: consider salbutamol 100 mcg as needed.')]],
  ['missing inhaler dose', 'current_inhaled_therapy', [doc('Current medications: salbutamol.')]],
  ['same-day smoking conflict', 'smoking_status', [doc('Patient never smoked.', 'R1'), doc('Patient currently smokes.', 'R2')]],
  ['inherited relative subject', 'smoking_status', [doc('Mother has asthma and smokes daily.')]],
];
for (const [name, id, docs] of traps) test(`review: abstains on ${name}`, () => {
  assert.equal(result(id, docs).status, 'NOT_DOCUMENTED');
});

test('review: duplicate document IDs cannot ambiguously ground a draft', () => {
  assert.equal(result('smoking_status', [doc('Patient never smoked.'), doc('Patient currently smokes.')]).status, 'NOT_DOCUMENTED');
});
test('review: invalid form date cannot enable unrestricted document dates', () => {
  assert.equal(result('smoking_status', [doc('Patient currently smokes.')], { ...form, form_date: 'invalid' }).status, 'NOT_DOCUMENTED');
});
test('review: unrelated newer notes do not erase an explicit smoking status', () => {
  const r = result('smoking_status', [doc('Patient never smoked.', 'R1', '2026-09-01'), doc('Mother smokes.', 'R2')]);
  assert.equal(r.status, 'DRAFTED');
  assert.match(String(r.value), /Never smoker/);
});

test('review: malformed input containers and duplicate field IDs fail explicitly', () => {
  assert.throws(() => draftForm(form, {} as Doc[], {}), /array/);
  assert.throws(() => draftForm(form, [], null as never), /object/);
  assert.throws(() => draftForm({ ...form, fields: [form.fields[0], form.fields[0]] }, [], {}), /uniquely/);
});
test('review: unusable chart identity preserves physician gating and demographics', () => {
  const fields = draftForm(form, [doc('Patient smokes.', 'demographics')], { phn: 'SYNTH-PHN-1234' });
  assert.equal(fields.find(f => f.field_id === 'phn')!.value, 'SYNTH-PHN-1234');
  assert.equal(fields.find(f => f.field_id === 'requested_dose_regimen')!.status, 'NEEDS_PHYSICIAN');
  assert.equal(fields.find(f => f.field_id === 'smoking_status')!.status, 'NOT_DOCUMENTED');
});
test('review: same-day conflict is independent of document order and ID ordering', () => {
  const docs = [doc('Patient never smoked.', 'Z'), doc('Patient currently smokes.', 'A')];
  for (const order of [docs, [...docs].reverse()]) assert.equal(result('smoking_status', order).status, 'NOT_DOCUMENTED');
});
test('review: CLI missing argument returns a concise failure and nonzero exit', () => {
  const r = spawnSync(process.execPath, ['dist/draft.js', '--chart', '--form', 'form/F-DEMO-01.json'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Draft failed: missing --chart/);
});
