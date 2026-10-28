import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { draftForm, verify, Doc, Form, FieldDraft } from './draft.js';
import { sentences, findDates, addMonths, maskDates, isHedged } from './text.js';

const form: Form = JSON.parse(readFileSync('form/F-DEMO-01.json', 'utf8'));
const demo = { doc_id: 'demographics', patient_name: 'Synthetic, Alex', phn: 'SYNTH-PHN-0001', date_of_birth: '1980-03-14' };
let n = 0;
const doc = (date: string, text: string, author_role = 'family_physician', type = 'clinic_note'): Doc =>
  ({ doc_id: `D${++n}`, date, type, author_role, text });
const field = (docs: Doc[], id: string, d: Record<string, unknown> = demo): FieldDraft =>
  draftForm(form, docs, d).find((f) => f.field_id === id)!;
const resp = (date: string, text: string) => doc(date, text, 'respirologist', 'consult_letter');
const lab = (date: string, text: string) => doc(date, text, 'laboratory', 'lab_report');

// ---- end to end: every chart must score full marks with no safety or grounding failures

for (const chart of ['chart-A', 'chart-T', 'chart-V']) {
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

test('documents dated after the form date, undated or with unreadable text are ignored', () => {
  const docs = [lab('2026-12-01', 'Collected 2026-11-30. Eosinophils 0.9 x10^9/L.')];
  assert.equal(field(docs, 'blood_eosinophils_most_recent').status, 'NOT_DOCUMENTED');
  const junk = [{ doc_id: 'J1', date: 'unknown', type: 'x', author_role: 'y', text: 'Patient quit smoking in 2019.' },
    { doc_id: 'J2', date: '2026-01-01', type: 'x', author_role: 'y', text: null as unknown as string }];
  assert.equal(field(junk, 'smoking_status').status, 'NOT_DOCUMENTED');
});

test('the default output has no note; --explain adds the reason for every blank', () => {
  const plain = draftForm(form, [], demo);
  assert.ok(plain.every((f) => !('note' in f)));
  const explained = draftForm(form, [], demo, { explain: true });
  for (const f of explained) if (f.status !== 'DRAFTED') assert.match(f.note ?? '', /\S/, f.field_id);
});

// ---- demographics

test('demographics never come from note text', () => {
  const docs = [doc('2026-01-01', 'PHN SYNTH-PHN-0009. DOB 1999-01-01.')];
  assert.equal(field(docs, 'phn').value, 'SYNTH-PHN-0001');
  assert.equal(field(docs, 'phn', { doc_id: 'demographics' }).status, 'NOT_DOCUMENTED');
  assert.equal(field(docs, 'date_of_birth', { doc_id: 'demographics', date_of_birth: '03/04/1980' }).status, 'NOT_DOCUMENTED');
  assert.equal(field(docs, 'date_of_birth', { doc_id: 'demographics', date_of_birth: '14/03/1980' }).value, '1980-03-14');
  assert.equal(field(docs, 'patient_name', { doc_id: 'demographics', last_name: 'Synthetic', first_name: 'Alex' }).value, 'Synthetic, Alex');
});

// ---- diagnosis and confirmation

test('a hedged most-recent diagnosis abstains instead of falling back to an older one', () => {
  const docs = [resp('2025-01-01', 'Impression: severe asthma.'),
    resp('2026-01-01', 'Diagnosis of asthma now in question; ?vocal cord dysfunction.')];
  assert.equal(field(docs, 'diagnosis').status, 'NOT_DOCUMENTED');
  assert.equal(field(docs, 'respirologist_confirmed_within_24_months').status, 'NOT_DOCUMENTED');
});

test('confirmation outside 24 months, or reported second-hand, or by a respiratory therapist, is not a confirmation', () => {
  assert.equal(field([resp('2024-05-03', 'Impression: severe eosinophilic asthma.')], 'respirologist_confirmed_within_24_months').status, 'NOT_DOCUMENTED');
  assert.equal(field([doc('2026-03-01', 'Respirology letter says diagnosis of severe asthma confirmed.')], 'respirologist_confirmed_within_24_months').status, 'NOT_DOCUMENTED');
  assert.equal(field([doc('2026-03-01', 'Assessment: severe asthma.', 'respiratory_therapist')], 'respirologist_confirmed_within_24_months').status, 'NOT_DOCUMENTED');
});

test('a later generic "asthma" does not erase the specific diagnosis, but a different one or a competing one does', () => {
  const specific = resp('2025-01-20', 'Impression: severe eosinophilic asthma.');
  assert.equal(field([specific, doc('2026-06-01', 'Assessment: asthma, stable.')], 'diagnosis').value, 'severe eosinophilic asthma');
  assert.equal(field([specific, doc('2026-06-01', 'Assessment: asthma exacerbation.')], 'diagnosis').value, 'severe eosinophilic asthma');
  assert.equal(field([specific, resp('2026-06-01', 'Impression: mild intermittent asthma.')], 'diagnosis').value, 'mild intermittent asthma');
  assert.equal(field([specific, resp('2026-06-01', 'Impression: vocal cord dysfunction.')], 'diagnosis').status, 'NOT_DOCUMENTED');
  assert.equal(field([specific, doc('2026-06-01', 'Assessment: COPD, GOLD B.')], 'diagnosis').status, 'NOT_DOCUMENTED');
});

test('numbered impressions, "Diagnosis confirmed:" and a May date are read correctly', () => {
  assert.equal(field([resp('2026-05-03', 'Impression: 1. Severe eosinophilic asthma. 2. Allergic rhinitis.')], 'diagnosis').value, 'Severe eosinophilic asthma');
  assert.equal(field([resp('2026-05-03', 'Diagnosis confirmed: severe eosinophilic asthma, on repeat spirometry.')], 'diagnosis').value, 'severe eosinophilic asthma');
  assert.equal(field([resp('2026-05-03', 'Impression: severe eosinophilic asthma, consider biologic. Seen May 3, 2026.')], 'respirologist_confirmed_within_24_months').value, true);
});

// ---- eosinophils

test('most recent eosinophils go by collection date, not report date', () => {
  const docs = [lab('2026-06-30', 'Collected 2026-06-28. Eosinophils 0.45 x10^9/L.'),
    lab('2026-07-05', 'Reprinted report. Collected 2025-11-10. Eosinophils 0.62 x10^9/L.')];
  assert.equal(field(docs, 'blood_eosinophils_most_recent').value, '0.45 x10^9/L (collected 2026-06-28)');
});

test('collection date is taken over a result date; unit variants and dot leaders are read', () => {
  assert.equal(field([lab('2026-06-30', 'CBC drawn 2026-06-28, resulted 2026-06-30. Eos 0.45 x10^9/L.')], 'blood_eosinophils_most_recent').value, '0.45 x10^9/L (collected 2026-06-28)');
  assert.equal(field([lab('2026-06-30', 'Collected 28/06/2026. Eosinophils 4% (0.45 ×10⁹/L).')], 'blood_eosinophils_most_recent').value, '0.45 ×10⁹/L (collected 2026-06-28)');
  assert.equal(field([lab('2026-06-30', 'Specimen collected: 2026-06-28 07:40. Reported: 2026-06-30.\nEosinophils ....... 450 cells/uL')], 'blood_eosinophils_most_recent').value, '450 cells/uL (collected 2026-06-28)');
});

test('a later result with no collection date blocks the draft; a percentage is not a count; no collection date at all abstains', () => {
  const docs = [lab('2026-06-30', 'Collected 2026-06-28. Eosinophils 0.45 x10^9/L.'), doc('2026-08-01', 'Eosinophils 0.30 x10^9/L on recent bloodwork.')];
  assert.equal(field(docs, 'blood_eosinophils_most_recent').status, 'NOT_DOCUMENTED');
  assert.equal(field([lab('2026-06-30', 'Collected 2026-06-28. Eosinophils 4%.')], 'blood_eosinophils_most_recent').status, 'NOT_DOCUMENTED');
  assert.equal(field([lab('2026-06-30', 'Eosinophils 0.45 x10^9/L.')], 'blood_eosinophils_most_recent').status, 'NOT_DOCUMENTED');
});

// ---- steroid courses

test('steroid courses for other causes, topical steroids and declined courses are not counted', () => {
  const docs = [doc('2026-02-18', 'Gout flare. Prednisone 30 mg daily for 5 days. Asthma stable.'),
    doc('2026-03-01', 'Eczema. Hydrocortisone cream. Asthma exacerbation mild.'),
    doc('2026-04-01', 'Asthma exacerbation. Prednisone offered but declined.'),
    doc('2026-04-20', 'Asthma exacerbation resolved. Prednisone 50 mg x5 days to keep at home in case of future flare.')];
  assert.equal(field(docs, 'systemic_steroid_courses_past_12_months').status, 'NOT_DOCUMENTED', 'never 0 from absence');
});

test('one course documented twice is not double counted; a continuation or back-reference is matched to it', () => {
  const ed = doc('2026-04-01', 'ED: asthma exacerbation. Discharged on prednisone 40 mg x5 days.', 'emergency_physician', 'ed_note');
  assert.equal(field([ed, doc('2026-04-04', 'Asthma exacerbation follow-up. On prednisone 40 mg.')], 'systemic_steroid_courses_past_12_months').status, 'NOT_DOCUMENTED');
  assert.equal(field([ed, doc('2026-04-04', 'Asthma exacerbation improving. Finishing prednisone today.')], 'systemic_steroid_courses_past_12_months').value, 1);
  assert.equal(field([ed, doc('2026-04-10', 'Asthma exacerbation resolved. Completed prednisone course from the ED.')], 'systemic_steroid_courses_past_12_months').value, 1);
  assert.equal(field([ed, resp('2026-06-20', 'She required prednisone for an asthma exacerbation in April 2026.')], 'systemic_steroid_courses_past_12_months').value, 1);
});

test('"acute asthma" and "pred" count; a summary count, an ordinal, or an unmatched back-reference abstain', () => {
  const ed = doc('2025-11-20', 'Presented with acute asthma. Discharged on pred 50 mg daily for 5 days.', 'emergency_physician', 'ed_note');
  assert.equal(field([ed], 'systemic_steroid_courses_past_12_months').value, 1);
  assert.equal(field([doc('2026-04-01', 'Asthma exacerbation. Prednisone 40 mg x5 days. Has had three courses of prednisone this year.')], 'systemic_steroid_courses_past_12_months').status, 'NOT_DOCUMENTED');
  assert.equal(field([doc('2026-04-01', 'Asthma exacerbation. Prednisone 40 mg x5 days. This is her third course of prednisone this year.')], 'systemic_steroid_courses_past_12_months').status, 'NOT_DOCUMENTED');
  assert.equal(field([resp('2026-06-20', 'She required prednisone for an asthma exacerbation in April 2026.')], 'systemic_steroid_courses_past_12_months').status, 'NOT_DOCUMENTED');
});

// ---- inhaled therapy

test('inhaled therapy follows the latest list and later switches, and drops oral drugs', () => {
  const docs = [doc('2026-01-01', 'Active medications: fluticasone 250 mcg twice daily; montelukast 10 mg daily.', 'pharmacy', 'medication_list'),
    doc('2026-02-01', 'Switched from fluticasone 250 mcg to Advair 500/50 one puff twice daily.')];
  assert.equal(field(docs, 'current_inhaled_therapy').value, 'Advair 500/50 one puff twice daily');
});

test('a "continues X" statement confirms the list; a different dose, an unknown brand or an unclear mention abstains', () => {
  const list = doc('2026-01-01', 'Active medications: Advair 500/50 one puff BID; salbutamol 100 mcg prn.', 'pharmacy', 'medication_list');
  assert.equal(field([list, doc('2026-02-01', 'Continues Advair 500/50 one puff BID with good technique. Using salbutamol 3 times a week.')], 'current_inhaled_therapy').value, 'Advair 500/50 one puff BID; salbutamol 100 mcg prn');
  assert.equal(field([list, doc('2026-02-01', 'Advair 250/50 one puff BID.')], 'current_inhaled_therapy').status, 'NOT_DOCUMENTED');
  assert.equal(field([list, doc('2026-02-01', 'Switched Advair to Airflusal Forspiro 500/50 one inhalation BID.')], 'current_inhaled_therapy').status, 'NOT_DOCUMENTED');
  assert.equal(field([list, doc('2026-02-01', 'Consider switching Advair to Symbicort.')], 'current_inhaled_therapy').status, 'NOT_DOCUMENTED');
  assert.equal(field([list, doc('2026-02-01', 'Started Airflusal 500/50 one inhalation BID.')], 'current_inhaled_therapy').status, 'NOT_DOCUMENTED');
});

test('a medication list on its own lines with a label is read item by item', () => {
  const docs = [doc('2026-02-01', 'Medications:\nSymbicort two puffs twice daily\nVentolin as needed\nMontelukast 10 mg daily')];
  // The requested field includes drug AND dose; Ventolin's dose is absent.
  assert.equal(field(docs, 'current_inhaled_therapy').status, 'NOT_DOCUMENTED');
  const complete = [doc('2026-02-01', 'Medications:\nSymbicort 200/6 mcg two puffs twice daily\nVentolin 100 mcg as needed\nMontelukast 10 mg daily')];
  assert.equal(field(complete, 'current_inhaled_therapy').value, 'Symbicort 200/6 mcg two puffs twice daily; Ventolin 100 mcg as needed');
  const pharm = [doc('2026-03-01', 'Dispensed/active: Breo Ellipta 200/25 mcg, 1 inhalation once daily\nprednisone 50 mg (completed 2026-02-13)', 'pharmacy', 'medication_list')];
  assert.equal(field(pharm, 'current_inhaled_therapy').value, 'Breo Ellipta 200/25 mcg, 1 inhalation once daily');
});

// ---- biologic

test('a planned, declined, ongoing, restarted or non-asthma biologic is not a prior trial', () => {
  assert.equal(field([resp('2024-05-03', 'Plan: trial of omalizumab.')], 'prior_biologic_trial').status, 'NOT_DOCUMENTED');
  assert.equal(field([resp('2024-05-03', 'Patient declined to start benralizumab.')], 'prior_biologic_trial').status, 'NOT_DOCUMENTED');
  assert.equal(field([resp('2024-05-03', 'Dupilumab started 2024-05-01.')], 'prior_biologic_trial').status, 'NOT_DOCUMENTED');
  assert.equal(field([resp('2026-05-15', 'Mepolizumab started 2025-02-03, discontinued 2025-08-20 after remission; restarted 2026-01-10.')], 'prior_biologic_trial').status, 'NOT_DOCUMENTED');
  assert.equal(field([doc('2024-05-15', 'Dupilumab started 2024-01-01 for atopic dermatitis and stopped 2024-04-01 due to conjunctivitis.', 'dermatologist')], 'prior_biologic_trial').status, 'NOT_DOCUMENTED');
  assert.equal(field([resp('2026-05-15', 'Mepolizumab started 2025-05-01 and stopped 2026-01-01.')], 'prior_biologic_trial').status, 'NOT_DOCUMENTED', 'no outcome');
});

test('written dates, brand names, "for lack of response", "today", ranges and two-drug sentences are read', () => {
  const v = (docs: Doc[]) => String(field(docs, 'prior_biologic_trial').value);
  assert.equal(v([resp('2024-12-18', 'Xolair was started on May 20, 2024 and discontinued on December 10, 2024 for lack of response.')]),
    'Xolair (omalizumab): started 2024-05-20, stopped 2024-12-10, outcome: lack of response');
  assert.equal(v([resp('2024-05-15', 'Omalizumab started today.'), resp('2024-09-10', 'Omalizumab stopped today due to lack of response.')]),
    'omalizumab: started 2024-05-15, stopped 2024-09-10, outcome: lack of response');
  assert.match(v([resp('2024-09-20', 'Trial of omalizumab from 2024-05-15 to 2024-09-10, stopped for lack of efficacy.')]), /started 2024-05-15, stopped 2024-09-10, outcome: lack of efficacy/);
  assert.match(v([resp('2024-05-15', 'Started omalizumab 2024-05-15.'), resp('2024-09-20', 'Omalizumab stopped 2024-09-10 due to lack of response; patient declined mepolizumab.')]), /^omalizumab: started 2024-05-15/);
});

// ---- smoking

test('smoking statements about other people, exposure or counselling are ignored', () => {
  assert.equal(field([doc('2026-01-01', 'Mother smokes at home; partner smokes outside.')], 'smoking_status').status, 'NOT_DOCUMENTED');
  assert.equal(field([doc('2026-01-01', 'Married to a smoker. Asthma flare triggered by wildfire smoke.')], 'smoking_status').status, 'NOT_DOCUMENTED');
  assert.equal(field([doc('2026-01-01', 'Smoking cessation counselling provided.')], 'smoking_status').status, 'NOT_DOCUMENTED');
});

test('the most recent explicit smoking statement governs; a plan to quit is not quitting; pack-years are history', () => {
  const docs = [doc('2024-01-01', 'Patient quit smoking in 2019.'), doc('2026-01-01', 'Smokes 10 cigarettes a day again.')];
  assert.match(String(field(docs, 'smoking_status').value), /^Current smoker/);
  assert.equal(field([doc('2026-01-01', 'Patient plans to quit smoking next month.')], 'smoking_status').status, 'NOT_DOCUMENTED');
  assert.match(String(field([doc('2026-01-01', 'Quit smoking 2 months ago; previously 1 ppd for 20 years.')], 'smoking_status').value), /^Former smoker/);
  assert.match(String(field([doc('2026-01-01', 'Patient reports she quit smoking in January 2026 after 15 pack-years; husband still smokes.')], 'smoking_status').value), /^Former smoker: Patient reports she quit smoking in January 2026/);
  assert.match(String(field([doc('2026-01-01', 'Lives with a smoker. Non-smoker herself.')], 'smoking_status').value), /^Non-smoker/);
  assert.match(String(field([doc('2026-01-01', 'No smoking history. Occasional cannabis.')], 'smoking_status').value), /^Never smoker/);
});

// ---- text helpers

test('sentences keep decimals, units, list markers and times whole, and are exact substrings', () => {
  const t = 'Collected 2026-06-28 07:40. Impression: 1. Severe asthma. Eosinophils 0.45 x10^9/L.';
  const s = sentences(t);
  assert.deepEqual(s.map((x) => x.text), ['Collected 2026-06-28 07:40.', 'Impression: 1. Severe asthma.', 'Eosinophils 0.45 x10^9/L.']);
  for (const x of s) assert.equal(t.slice(x.start, x.start + x.text.length), x.text);
});

test('dates parse in ISO, written and unambiguous numeric forms; month arithmetic clamps; "May" the month is not a hedge', () => {
  assert.deepEqual(findDates('started on February 3, 2025, 14 July 2026 and 28/06/2026').map((d) => d.iso), ['2025-02-03', '2026-07-14', '2026-06-28']);
  assert.equal(findDates('06/07/2026').length, 0);
  assert.equal(addMonths('2026-11-15', -24), '2024-11-15');
  assert.equal(addMonths('2026-03-31', -1), '2026-02-28');
  assert.equal(maskDates('on May 20, 2024 and').length, 'on May 20, 2024 and'.length);
  assert.equal(isHedged('Xolair was started on May 20, 2024'), false);
  assert.equal(isHedged('Xolair may be started'), true);
});

// ---- regressions found in blind testing

test('a sentence ending in a small number is still a sentence boundary ("since age 6. Patient smokes")', () => {
  const docs = [doc('2024-01-01', 'Patient quit smoking in 2019.'),
    doc('2026-06-01', 'Brother has had asthma since age 6. Patient smokes 10 cigarettes a day.')];
  assert.match(String(field(docs, 'smoking_status').value), /^Current smoker/);
  assert.deepEqual(sentences('Impression: 1. Severe asthma. 2. GERD.').map((s) => s.text), ['Impression: 1. Severe asthma.', '2. GERD.']);
});

test('a biologic start date may follow the drug, dose and interval', () => {
  const docs = [doc('2025-03-01', 'Started Fasenra 30 mg q8w on 2025-03-01.', 'respirologist'),
    doc('2025-10-01', 'Benralizumab stopped 2025-09-15 owing to persistent exacerbations.', 'respirologist')];
  const v = String(field(docs, 'prior_biologic_trial').value);
  assert.match(v, /2025-03-01/);
  assert.match(v, /2025-09-15/);
  assert.match(v, /persistent exacerbations/);
});

test('a social-history line elsewhere in the note does not block a steroid course', () => {
  const docs = [doc('2026-04-01', 'Lives with wife and two kids. Asthma exacerbation after a cold. Prednisone 40 mg daily for 5 days.')];
  assert.equal(field(docs, 'systemic_steroid_courses_past_12_months').value, 1);
});
