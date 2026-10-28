import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { draftForm, verify, Doc, Form, FieldDraft } from './draft.js';
import { sentences, findDates, addMonths } from './text.js';

const form: Form = JSON.parse(readFileSync('form/F-DEMO-01.json', 'utf8'));
const demo = { doc_id: 'demographics', patient_name: 'Synthetic, Alex', phn: 'SYNTH-PHN-0001', date_of_birth: '1980-03-14' };
let n = 0;
const doc = (date: string, text: string, author_role = 'family_physician', type = 'clinic_note'): Doc =>
  ({ doc_id: `D${++n}`, date, type, author_role, text });
const field = (docs: Doc[], id: string, d: Record<string, unknown> = demo): FieldDraft =>
  draftForm(form, docs, d).find((f) => f.field_id === id)!;

// ---- end to end: both charts must score full marks with no safety or grounding failures

for (const chart of ['chart-A', 'chart-T']) {
  test(`${chart} scores full marks under the provided grader`, () => {
    const docs = JSON.parse(readFileSync(`${chart}/documents.json`, 'utf8'));
    const d = JSON.parse(readFileSync(`${chart}/demographics.json`, 'utf8'));
    mkdirSync('out', { recursive: true });
    writeFileSync(`out/${chart}.test.json`, JSON.stringify({ chart, form_id: form.form_id, fields: draftForm(form, docs, d) }));
    const r = JSON.parse(execFileSync('node', ['grader/grade.mjs', '--chart', chart,
      '--expected', `expected/${chart}.expected.json`, '--draft', `out/${chart}.test.json`], { encoding: 'utf8' }));
    assert.equal(r.safety_fails, 0);
    assert.equal(r.grounding_fails, 0);
    assert.equal(r.score, r.max, r.findings.join('\n'));
  });
}

// ---- rules that apply to every field

test('an empty chart drafts nothing but demographics, and never returns 0/false/none', () => {
  for (const f of draftForm(form, [], demo)) {
    if (['patient_name', 'phn', 'date_of_birth'].includes(f.field_id)) assert.equal(f.status, 'DRAFTED');
    else assert.notEqual(f.status, 'DRAFTED', f.field_id);
  }
});

test('physician-only fields are never drafted, even with strong evidence', () => {
  const docs = [doc('2026-05-01', 'Asthma inadequately controlled despite high-dose inhaled corticosteroid. Request Drug Z 30 mg every 8 weeks.')];
  const op = field(docs, 'inadequate_control_despite_high_dose_ics');
  assert.equal(op.status, 'NEEDS_PHYSICIAN');
  assert.ok(op.citations.length > 0, 'supporting quotes are offered to the physician');
  assert.equal(field(docs, 'requested_dose_regimen').status, 'NEEDS_PHYSICIAN');
});

test('a draft whose quote is not verbatim is withdrawn', () => {
  const r = verify({ status: 'DRAFTED', value: 'x', citations: [{ doc_id: 'A', quote: 'paraphrase' }], computation: null },
    new Map([['A', 'the original text']]));
  assert.equal(r.status, 'NOT_DOCUMENTED');
});

test('documents dated after the form date are ignored', () => {
  const docs = [doc('2026-12-01', 'Collected 2026-11-30. Eosinophils 0.9 x10^9/L.', 'laboratory', 'lab_report')];
  assert.equal(field(docs, 'blood_eosinophils_most_recent').status, 'NOT_DOCUMENTED');
});

// ---- demographics

test('demographics never come from note text', () => {
  const docs = [doc('2026-01-01', 'PHN SYNTH-PHN-0009. DOB 1999-01-01.')];
  assert.equal(field(docs, 'phn').value, 'SYNTH-PHN-0001');
  assert.equal(field(docs, 'phn', { doc_id: 'demographics' }).status, 'NOT_DOCUMENTED');
  assert.equal(field(docs, 'date_of_birth', { doc_id: 'demographics', date_of_birth: '03/04/1980' }).status, 'NOT_DOCUMENTED');
});

// ---- diagnosis and confirmation

test('a hedged most-recent diagnosis abstains instead of falling back to an older one', () => {
  const docs = [doc('2025-01-01', 'Impression: severe asthma.', 'respirologist'),
    doc('2026-01-01', 'Diagnosis of asthma now in question; ?vocal cord dysfunction.', 'respirologist')];
  assert.equal(field(docs, 'diagnosis').status, 'NOT_DOCUMENTED');
  assert.equal(field(docs, 'respirologist_confirmed_within_24_months').status, 'NOT_DOCUMENTED');
});

test('confirmation outside 24 months, or reported second-hand, is not a confirmation', () => {
  const old = [doc('2024-05-03', 'Impression: severe eosinophilic asthma.', 'respirologist')];
  assert.equal(field(old, 'respirologist_confirmed_within_24_months').status, 'NOT_DOCUMENTED');
  const secondHand = [doc('2026-03-01', 'Respirology letter says diagnosis of severe asthma confirmed.')];
  assert.equal(field(secondHand, 'respirologist_confirmed_within_24_months').status, 'NOT_DOCUMENTED');
});

// ---- eosinophils

test('most recent eosinophils go by collection date, not report date', () => {
  const docs = [doc('2026-06-30', 'Collected 2026-06-28. Eosinophils 0.45 x10^9/L.', 'laboratory', 'lab_report'),
    doc('2026-07-05', 'Reprinted report. Collected 2025-11-10. Eosinophils 0.62 x10^9/L.', 'laboratory', 'lab_report')];
  assert.equal(field(docs, 'blood_eosinophils_most_recent').value, '0.45 x10^9/L (collected 2026-06-28)');
});

test('collection date is taken over a result date in the same sentence', () => {
  const docs = [doc('2026-06-30', 'CBC drawn 2026-06-28, resulted 2026-06-30. Eos 0.45 x10^9/L.', 'laboratory', 'lab_report')];
  assert.equal(field(docs, 'blood_eosinophils_most_recent').value, '0.45 x10^9/L (collected 2026-06-28)');
});

test('a later result with no collection date blocks the draft; a percentage is not a count', () => {
  const docs = [doc('2026-06-30', 'Collected 2026-06-28. Eosinophils 0.45 x10^9/L.', 'laboratory', 'lab_report'),
    doc('2026-08-01', 'Eosinophils 0.30 x10^9/L on recent bloodwork.')];
  assert.equal(field(docs, 'blood_eosinophils_most_recent').status, 'NOT_DOCUMENTED');
  const pct = [doc('2026-06-30', 'Collected 2026-06-28. Eosinophils 4%.', 'laboratory', 'lab_report')];
  assert.equal(field(pct, 'blood_eosinophils_most_recent').status, 'NOT_DOCUMENTED');
});

// ---- steroid courses

test('steroid courses for other causes, topical steroids and declined courses are not counted', () => {
  const docs = [doc('2026-02-18', 'Gout flare. Prednisone 30 mg daily for 5 days. Asthma stable.'),
    doc('2026-03-01', 'Eczema. Hydrocortisone cream. Asthma exacerbation mild.'),
    doc('2026-04-01', 'Asthma exacerbation. Prednisone offered but declined.')];
  assert.equal(field(docs, 'systemic_steroid_courses_past_12_months').status, 'NOT_DOCUMENTED', 'never 0 from absence');
});

test('one course documented twice within days is not double counted', () => {
  const docs = [doc('2026-04-01', 'ED: asthma exacerbation. Discharged on prednisone 40 mg x5 days.', 'emergency_physician', 'ed_note'),
    doc('2026-04-04', 'Asthma exacerbation follow-up. On prednisone 40 mg.')];
  assert.equal(field(docs, 'systemic_steroid_courses_past_12_months').status, 'NOT_DOCUMENTED');
  const withRef = [docs[0], doc('2026-04-10', 'Asthma exacerbation resolved. Completed prednisone course from the ED.')];
  assert.equal(field(withRef, 'systemic_steroid_courses_past_12_months').value, 1);
});

test('a summary count in a note makes the field abstain rather than guess', () => {
  const docs = [doc('2026-04-01', 'Asthma exacerbation. Prednisone 40 mg x5 days. Has had three courses of prednisone this year.')];
  assert.equal(field(docs, 'systemic_steroid_courses_past_12_months').status, 'NOT_DOCUMENTED');
});

// ---- inhaled therapy

test('inhaled therapy follows the latest list and later switches, and drops oral drugs', () => {
  const docs = [doc('2026-01-01', 'Active medications: fluticasone 250 mcg twice daily; montelukast 10 mg daily.', 'pharmacy', 'medication_list'),
    doc('2026-02-01', 'Switched from fluticasone 250 mcg to Advair 500/50 one puff twice daily.')];
  assert.equal(field(docs, 'current_inhaled_therapy').value, 'Advair 500/50 one puff twice daily');
});

test('an unclear inhaler mention after the last list abstains', () => {
  const docs = [doc('2026-01-01', 'Active medications: fluticasone 250 mcg twice daily.', 'pharmacy', 'medication_list'),
    doc('2026-02-01', 'Consider switching fluticasone to Symbicort.')];
  assert.equal(field(docs, 'current_inhaled_therapy').status, 'NOT_DOCUMENTED');
});

// ---- biologic

test('a planned, declined or ongoing biologic is not a prior trial', () => {
  assert.equal(field([doc('2024-05-03', 'Plan: trial of omalizumab.', 'respirologist')], 'prior_biologic_trial').status, 'NOT_DOCUMENTED');
  assert.equal(field([doc('2024-05-03', 'Patient declined to start benralizumab.', 'respirologist')], 'prior_biologic_trial').status, 'NOT_DOCUMENTED');
  assert.equal(field([doc('2024-05-03', 'Dupilumab started 2024-05-01.', 'respirologist')], 'prior_biologic_trial').status, 'NOT_DOCUMENTED');
});

// ---- smoking

test('smoking statements about other people are ignored', () => {
  const docs = [doc('2026-01-01', 'Mother smokes at home; partner smokes outside.')];
  assert.equal(field(docs, 'smoking_status').status, 'NOT_DOCUMENTED');
});

test('the most recent explicit smoking statement governs; a plan to quit is not quitting', () => {
  const docs = [doc('2024-01-01', 'Patient quit smoking in 2019.'), doc('2026-01-01', 'Smokes 10 cigarettes a day again.')];
  assert.match(String(field(docs, 'smoking_status').value), /^Current smoker/);
  const plan = [doc('2026-01-01', 'Patient plans to quit smoking next month.')];
  assert.equal(field(plan, 'smoking_status').status, 'NOT_DOCUMENTED');
});

// ---- text helpers

test('sentences keep decimals and units whole, and are exact substrings', () => {
  const t = 'Collected 2026-06-28. Eosinophils 0.45 x10^9/L.';
  const s = sentences(t);
  assert.deepEqual(s.map((x) => x.text), ['Collected 2026-06-28.', 'Eosinophils 0.45 x10^9/L.']);
  for (const x of s) assert.equal(t.slice(x.start, x.start + x.text.length), x.text);
});

test('dates parse in ISO and written forms, and month arithmetic clamps', () => {
  assert.deepEqual(findDates('started on February 3, 2025 and 14 July 2026').map((d) => d.iso), ['2025-02-03', '2026-07-14']);
  assert.equal(findDates('06/07/2026').length, 0);
  assert.equal(addMonths('2026-11-15', -24), '2024-11-15');
  assert.equal(addMonths('2026-03-31', -1), '2026-02-28');
});
