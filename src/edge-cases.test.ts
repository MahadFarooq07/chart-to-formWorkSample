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
for (const [name, id, docs] of traps) test(`abstains on ${name}`, () => {
  assert.equal(result(id, docs).status, 'NOT_DOCUMENTED');
});

test('duplicate document IDs cannot ambiguously ground a draft', () => {
  assert.equal(result('smoking_status', [doc('Patient never smoked.'), doc('Patient currently smokes.')]).status, 'NOT_DOCUMENTED');
});
test('invalid form date cannot enable unrestricted document dates', () => {
  assert.equal(result('smoking_status', [doc('Patient currently smokes.')], { ...form, form_date: 'invalid' }).status, 'NOT_DOCUMENTED');
});
test('unrelated newer notes do not erase an explicit smoking status', () => {
  const r = result('smoking_status', [doc('Patient never smoked.', 'R1', '2026-09-01'), doc('Mother smokes.', 'R2')]);
  assert.equal(r.status, 'DRAFTED');
  assert.match(String(r.value), /Never smoker/);
});

test('malformed input containers and duplicate field IDs fail explicitly', () => {
  assert.throws(() => draftForm(form, {} as Doc[], {}), /array/);
  assert.throws(() => draftForm(form, [], null as never), /object/);
  assert.throws(() => draftForm({ ...form, fields: [form.fields[0], form.fields[0]] }, [], {}), /uniquely/);
});
test('unusable chart identity preserves physician gating and demographics', () => {
  const fields = draftForm(form, [doc('Patient smokes.', 'demographics')], { phn: 'SYNTH-PHN-1234' });
  assert.equal(fields.find(f => f.field_id === 'phn')!.value, 'SYNTH-PHN-1234');
  assert.equal(fields.find(f => f.field_id === 'requested_dose_regimen')!.status, 'NEEDS_PHYSICIAN');
  assert.equal(fields.find(f => f.field_id === 'smoking_status')!.status, 'NOT_DOCUMENTED');
});
test('same-day conflict is independent of document order and ID ordering', () => {
  const docs = [doc('Patient never smoked.', 'Z'), doc('Patient currently smokes.', 'A')];
  for (const order of [docs, [...docs].reverse()]) assert.equal(result('smoking_status', order).status, 'NOT_DOCUMENTED');
});
test('CLI missing argument returns a concise failure and nonzero exit', () => {
  const r = spawnSync(process.execPath, ['dist/draft.js', '--chart', '--form', 'form/F-DEMO-01.json'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Draft failed: missing --chart/);
});

test('a relative named in the medication-list heading is not the patient', () => {
  for (const type of ['clinic_note', 'medication_list']) {
    const d = { ...doc('Mother medications: salbutamol 100 mcg as needed.'), type };
    assert.equal(result('current_inhaled_therapy', [d]).status, 'NOT_DOCUMENTED');
  }
});

test('social history after a pharmacy list does not erase the patient regimen', () => {
  for (const separator of ['\n', '. ']) {
    const d = { ...doc(`Active medications: salbutamol 100 mcg as needed${separator}Lives with wife and two kids.`), type: 'medication_list' };
    const r = result('current_inhaled_therapy', [d]);
    assert.equal(r.status, 'DRAFTED');
    assert.equal(r.value, 'salbutamol 100 mcg as needed');
    assert.deepEqual(r.citations, [{ doc_id: 'R1', quote: 'salbutamol 100 mcg as needed' }]);
  }
});

test('a relative medication item is never included in the patient regimen', () => {
  const d = { ...doc('Active medications: salbutamol 100 mcg as needed; mother uses Symbicort 200/6 mcg.'), type: 'medication_list' };
  assert.equal(result('current_inhaled_therapy', [d]).status, 'NOT_DOCUMENTED');
});

test('unrelated social history does not erase a dated patient lab', () => {
  const r = result('blood_eosinophils_most_recent', [doc('Lives with wife and two kids. Collected 2026-09-01. Eosinophils 0.45 x10^9/L.')]);
  assert.equal(r.status, 'DRAFTED');
  assert.equal(r.value, '0.45 x10^9/L (collected 2026-09-01)');
});

test('a below-detection result keeps its comparator and stays the most recent', () => {
  const docs = [doc('Collected 2026-03-01. Eosinophils 0.70 x10^9/L.', 'L1', '2026-03-03'), doc('Collected 2026-07-05. Eosinophils <0.10 x10^9/L.', 'L2', '2026-07-07')];
  assert.equal(result('blood_eosinophils_most_recent', docs).value, '<0.10 x10^9/L (collected 2026-07-05)');
});

test('"5 cigarettes/day" is a current smoking statement', () => {
  assert.match(String(result('smoking_status', [doc('Smoking status: current, 5 cigarettes/day.')]).value), /^Current smoker/);
});
