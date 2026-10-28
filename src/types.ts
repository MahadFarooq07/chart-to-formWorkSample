export type Status = 'DRAFTED' | 'NEEDS_PHYSICIAN' | 'NOT_DOCUMENTED';
export interface Citation { doc_id: string; quote: string }
export interface Computation { rule: string; inputs: Citation[] }
export interface FieldDraft {
  field_id: string;
  status: Status;
  value: string | number | boolean | null;
  citations: Citation[];
  computation: Computation | null;
  /** Only present with --explain: why the field abstained (or what the physician should look at). */
  note?: string;
}
export interface Doc { doc_id: string; date: string; type: string; author_role: string; text: string }
export interface FormField { field_id: string; label: string; class: string; answer_type: string }
export interface Form { form_id: string; title: string; form_date: string; fields: FormField[] }
export type Demographics = Record<string, unknown>;

/** What every extractor sees: documents already filtered to valid dates on or before the form date. */
export interface Ctx {
  formDate: string | null;
  docs: Doc[]; // sorted oldest first
  demographics: Demographics;
}

/** Extractors return a partial draft; the caller fills field_id and verifies quotes. */
export type Result = Omit<FieldDraft, 'field_id'>;

/** A blank, with the reason it is blank. The reason is what a physician would want to know. */
export const notDocumented = (note = 'no explicit statement found in the chart'): Result =>
  ({ status: 'NOT_DOCUMENTED', value: null, citations: [], computation: null, note });
export const needsPhysician = (citations: Citation[] = [], note = 'physician-only field; never drafted'): Result =>
  ({ status: 'NEEDS_PHYSICIAN', value: null, citations, computation: null, note });
export const drafted = (value: FieldDraft['value'], citations: Citation[], computation: Computation | null = null): Result =>
  ({ status: 'DRAFTED', value, citations, computation });
