// Codex co-op work sample: cited form drafter. Offline, deterministic, rule-based.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Citation, Ctx, Demographics, Doc, FieldDraft, Form, FormField, Result, needsPhysician, notDocumented } from './types.js';
import { isIsoDate } from './text.js';
import * as F from './fields.js';

export * from './types.js';

/** Field-specific extractors. A field we have no extractor for abstains. */
const EXTRACTORS: Record<string, (ctx: Ctx) => Result> = {
  diagnosis: F.diagnosis,
  respirologist_confirmed_within_24_months: (c) => F.respirologistConfirmed(c, 24),
  blood_eosinophils_most_recent: F.eosinophils,
  systemic_steroid_courses_past_12_months: (c) => F.steroidCourses(c, 12),
  current_inhaled_therapy: F.inhaledTherapy,
  prior_biologic_trial: F.priorBiologic,
  smoking_status: F.smoking,
  inadequate_control_despite_high_dose_ics: F.controlEvidence,
};

/** The class decides what is allowed; the extractor only runs where the class permits drafting. */
function draftField(field: FormField, ctx: Ctx): Result {
  switch (field.class) {
    case 'PHYSICIAN_ENTERED':
      return needsPhysician();
    case 'OPINION_PHYSICIAN': {
      const r = EXTRACTORS[field.field_id]?.(ctx);
      return needsPhysician(r?.citations ?? []); // never DRAFTED, whatever the extractor says
    }
    case 'DEMOGRAPHIC':
      return F.demographic(ctx, field.field_id);
    case 'FACTUAL_CITED':
    case 'VERBATIM_DATED':
    case 'COMPUTED_CITED':
    case 'SENSITIVE_EXPLICIT_ONLY': {
      const r = EXTRACTORS[field.field_id]?.(ctx) ?? notDocumented();
      if (r.status === 'NEEDS_PHYSICIAN') return notDocumented();
      if (field.class === 'COMPUTED_CITED' && r.status === 'DRAFTED' && !r.computation) return notDocumented();
      return r;
    }
    default:
      return notDocumented(); // unknown class: abstain
  }
}

/** Same rendering the grader uses for the demographics pseudo-document. */
export function demographicsText(demo: Demographics): string {
  return Object.entries(demo).filter(([k]) => k !== 'doc_id').map(([k, v]) => `${k}: ${v}`).join('\n');
}

/** Last line of defence: a draft whose quotes are not verbatim in their source is withdrawn. */
export function verify(r: Result, textOf: Map<string, string>): Result {
  const ok = (c: Citation) => typeof c.quote === 'string' && c.quote.trim() !== '' && !!textOf.get(c.doc_id)?.includes(c.quote);
  const all = [...r.citations, ...(r.computation?.inputs ?? [])];
  if (r.status === 'DRAFTED') {
    if (!r.citations.length || !all.every(ok)) return notDocumented();
    if (r.value === null || r.value === '') return notDocumented();
    return r;
  }
  return { ...r, value: null, citations: r.citations.filter(ok), computation: null };
}

export function draftForm(form: Form, docs: Doc[], demographics: Demographics): FieldDraft[] {
  const formDate = isIsoDate(form.form_date) ? form.form_date : null;
  // Undated or future-dated documents can't take part in "most recent" or window logic, so they're excluded.
  const usable = docs
    .filter((d) => isIsoDate(d.date) && (!formDate || d.date <= formDate) && typeof d.text === 'string')
    .sort((a, b) => a.date.localeCompare(b.date) || a.doc_id.localeCompare(b.doc_id));
  const ctx: Ctx = { formDate, docs: usable, demographics };
  const textOf = new Map<string, string>(docs.map((d) => [d.doc_id, d.text]));
  textOf.set('demographics', demographicsText(demographics));

  return form.fields.map((field) => {
    let r: Result;
    try { r = draftField(field, ctx); } catch { r = notDocumented(); } // a crash abstains, never guesses
    return { field_id: field.field_id, ...verify(r, textOf) };
  });
}

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || !process.argv[i + 1]) throw new Error(`missing --${name}`);
  return process.argv[i + 1];
}

function main(): void {
  const chartDir = arg('chart');
  const form: Form = JSON.parse(readFileSync(arg('form'), 'utf8'));
  const docs: Doc[] = JSON.parse(readFileSync(join(chartDir, 'documents.json'), 'utf8'));
  const demographics: Demographics = JSON.parse(readFileSync(join(chartDir, 'demographics.json'), 'utf8'));
  const fields = draftForm(form, docs, demographics);
  const out = arg('out');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ chart: chartDir, form_id: form.form_id, fields }, null, 2));
}

if (process.argv[1]?.endsWith('draft.js')) main();
