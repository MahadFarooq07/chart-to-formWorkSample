// One extractor per field. Each one drafts only when the chart states the answer plainly,
// and returns NOT_DOCUMENTED on anything ambiguous. A blank costs nothing; a wrong value is the worst case.
import { Citation, Ctx, Doc, Result, drafted, notDocumented, needsPhysician } from './types.js';
import {
  HEDGE, NEGATION, THIRD_PARTY, addMonths, clauses, findDates, isIsoDate, sentences, stripEnd,
} from './text.js';

const cite = (doc: Doc, quote: string): Citation => ({ doc_id: doc.doc_id, quote });
const newestFirst = (docs: Doc[]) => [...docs].reverse();

// ---------------------------------------------------------------- DEMOGRAPHIC

const DEMO_KEYS: Record<string, string[]> = {
  patient_name: ['patient_name', 'name', 'full_name'],
  phn: ['phn', 'personal_health_number', 'health_number'],
  date_of_birth: ['date_of_birth', 'dob', 'birth_date'],
};

/** Quote format matches how the grader renders demographics: "key: value". */
function demoValue(ctx: Ctx, key: string): { value: string; cite: Citation } | null {
  const v = ctx.demographics[key];
  if (v === null || v === undefined || typeof v === 'object') return null;
  const s = String(v).trim();
  if (!s) return null;
  return { value: s, cite: { doc_id: 'demographics', quote: `${key}: ${String(v)}` } };
}

export function demographic(ctx: Ctx, fieldId: string): Result {
  if (fieldId === 'patient_name') {
    const last = demoValue(ctx, 'last_name');
    const first = demoValue(ctx, 'first_name');
    if (last && first) return drafted(`${last.value}, ${first.value}`, [last.cite, first.cite]);
  }
  for (const key of DEMO_KEYS[fieldId] ?? [fieldId]) {
    const hit = demoValue(ctx, key);
    if (!hit) continue;
    if (fieldId === 'date_of_birth') {
      if (isIsoDate(hit.value)) return drafted(hit.value, [hit.cite]);
      const dates = findDates(hit.value);
      if (dates.length === 1 && dates[0].raw === hit.value) return drafted(dates[0].iso, [hit.cite]);
      return notDocumented(); // unparseable or ambiguous (e.g. 03/04/1980)
    }
    return drafted(hit.value, [hit.cite]);
  }
  return notDocumented();
}

// ---------------------------------------------------------------- DIAGNOSIS

const DX_KEYWORD = /\b(impression|diagnos(?:is|ed|es)|assessment|dx)\b/i;
const DX_DOUBT = /\b(reconsider\w*|revised|in question|doubt\w*|uncertain|not confirmed|mimic\w*)\b/i;

interface DxHit { doc: Doc; sentence: string; phrase: string | null; doubtful: boolean }

/** Diagnostic statements about asthma, with the phrase (e.g. "severe eosinophilic asthma"). */
function asthmaDiagnoses(docs: Doc[]): DxHit[] {
  const hits: DxHit[] = [];
  for (const doc of docs) {
    for (const s of sentences(doc.text)) {
      const kw = DX_KEYWORD.exec(s.text);
      if (!kw || !/asthma/i.test(s.text)) continue;
      const after = s.text.slice(kw.index + kw[0].length);
      const m = /^\s*(?:[:\-–]|of|with|is|was|remains)?\s*(?:an?\s+|the\s+)?((?:[A-Za-z-]+\s+){0,4}?asthma)\b/i.exec(after);
      const doubtful = NEGATION.test(s.text) || HEDGE.test(s.text) || DX_DOUBT.test(s.text) || THIRD_PARTY.test(s.text);
      hits.push({ doc, sentence: s.text, phrase: m ? m[1].trim() : null, doubtful });
    }
  }
  return hits;
}

const isRespirologist = (d: Doc) => /respirolog|pulmonolog|respiratory medicine|chest physician/i.test(d.author_role);

export function diagnosis(ctx: Ctx): Result {
  const hits = asthmaDiagnoses(ctx.docs);
  if (!hits.length) return notDocumented();
  const latestDate = hits[hits.length - 1].doc.date;
  // A later specialist impression that doesn't mention asthma may have changed the diagnosis.
  const laterOtherDx = ctx.docs.some((d) => d.date > latestDate && isRespirologist(d) &&
    sentences(d.text).some((s) => DX_KEYWORD.test(s.text) && !/asthma/i.test(s.text)));
  if (laterOtherDx) return notDocumented();
  const latest = hits.filter((h) => h.doc.date === latestDate);
  if (latest.some((h) => h.doubtful || !h.phrase)) return notDocumented();
  const phrases = new Set(latest.map((h) => h.phrase!.toLowerCase()));
  if (phrases.size > 1) return notDocumented(); // same-day disagreement
  return drafted(latest[0].phrase!, latest.map((h) => cite(h.doc, h.sentence)));
}

export function respirologistConfirmed(ctx: Ctx, months = 24): Result {
  if (!ctx.formDate) return notDocumented();
  const from = addMonths(ctx.formDate, -months);
  const hits = asthmaDiagnoses(ctx.docs.filter(isRespirologist)).filter((h) => h.doc.date >= from);
  if (!hits.length) return notDocumented(); // absence of a confirmation is not "false"
  const latestDate = hits[hits.length - 1].doc.date;
  const latest = hits.filter((h) => h.doc.date === latestDate);
  if (latest.some((h) => h.doubtful)) return notDocumented();
  const inputs = latest.map((h) => cite(h.doc, h.sentence));
  return drafted(true, inputs, {
    rule: `true if a document authored by a respirologist, dated on or after ${from} (${months} months before the form date ${ctx.formDate}), states an asthma diagnosis without hedging or negation`,
    inputs,
  });
}

// ---------------------------------------------------------------- EOSINOPHILS

const EOS = /\b(?:blood\s+)?eos(?:inophils?)?(?:\s+count)?(?:\s*\(abs(?:olute)?\))?\s*(?:[:=]|was|of|is)?\s*(\d+(?:\.\d+)?\s*(?:(?:x|×|\*)\s*10\s*(?:\^|\*\*)?\s*9\s*\/\s*L|10\s*\^\s*9\s*\/\s*L|(?:cells\s*)?\/\s*(?:u|µ|μ|mc)L|cells\/mm3))/i;
const COLLECTED = /\b(collected|collection(?:\s+date)?|specimen\s+(?:collected|drawn)|drawn)\b/i;

interface EosResult { doc: Doc; value: string; sentence: string; collected: string | null; collectedSentence: string | null }

export function eosinophils(ctx: Ctx): Result {
  const results: EosResult[] = [];
  for (const doc of ctx.docs) {
    const sents = sentences(doc.text);
    const collDates = new Map<string, string>(); // iso -> sentence
    for (const s of sents) {
      const k = COLLECTED.exec(s.text);
      if (!k) continue;
      // The collection date is the first date after the keyword; later ones are report/result dates.
      const d = findDates(s.text).find((x) => x.index > k.index);
      if (d) collDates.set(d.iso, s.text);
    }
    const [collected, collectedSentence] = collDates.size === 1 ? [...collDates.entries()][0] : [null, null];
    for (const s of sents) {
      if (/sputum|bronchial|nasal/i.test(s.text)) continue;
      const m = EOS.exec(s.text);
      if (m) results.push({ doc, value: m[1].trim(), sentence: s.text, collected, collectedSentence });
    }
  }
  const dated = results.filter((r) => r.collected).sort((a, b) => a.collected!.localeCompare(b.collected!));
  if (!dated.length) return notDocumented();
  const best = dated[dated.length - 1];
  // Two different results on the same collection date: can't pick one.
  if (dated.some((r) => r.collected === best.collected && r.value !== best.value)) return notDocumented();
  // A result with no collection date could be newer unless its report predates our best collection date.
  // A sentence naming only years before the best collection year ("0.5 in 2024") is older and can be ignored.
  const clearlyOlder = (r: EosResult) => {
    const years = [...r.sentence.matchAll(/\b(19|20)\d{2}\b/g)].map((m) => +m[0]);
    return years.length > 0 && years.every((y) => y < +best.collected!.slice(0, 4));
  };
  if (results.some((r) => !r.collected && r.doc.date >= best.collected! && !clearlyOlder(r))) return notDocumented();
  const citations = [cite(best.doc, best.sentence)];
  if (best.collectedSentence !== best.sentence) citations.push(cite(best.doc, best.collectedSentence!));
  return drafted(`${best.value} (collected ${best.collected})`, citations);
}

// ---------------------------------------------------------------- SYSTEMIC STEROIDS

const SYSTEMIC = /\b(prednisone|prednisolone|methylprednisolone|solu-?medrol|medrol|dexamethasone|hydrocortisone|oral (?:cortico)?steroids?|systemic (?:cortico)?steroids?|steroid burst|burst of (?:oral )?steroids?)\b/i;
const NOT_SYSTEMIC = /\b(cream|ointment|topical|inhaled|inhaler|nasal|eye drops?|intra-?articular|joint injection)\b/i;
const NOT_GIVEN = /\b(no|not|declined|refused|held|withheld|avoid\w*|plan(?:ned|s)? to|recommend\w*|advised|consider\w*|if|rescue pack|to keep at home|would|could|may|might)\b/i;
const HISTORICAL = /\b(previous(?:ly)?|prior|recent(?:ly)?|completed|finished|last (?:week|month|year)|ago|history of|since|already|was on|from (?:the )?(?:ed|er|emergency|hospital|walk-?in))\b/i;
const AGGREGATE = /\b(\d+|one|two|three|four|five|six|several|multiple)\s+(?:courses?|bursts?|rounds?)\s+of\s+(?:oral\s+|systemic\s+)?(?:prednisone|steroids?|corticosteroids?)/i;
const ASTHMA_EXAC = /\b(asthma (?:exacerbation|flare(?:-up)?|attack)|exacerbation of (?:his |her |their )?asthma|asthma (?:worse|worsening))\b/i;
const OTHER_INDICATION = /\b(gout|copd|emphysema|rash|dermatitis|eczema|arthritis|poison ivy|urticaria|hives|anaphylaxis|allergic reaction|sinusitis|bell'?s palsy|polymyalgia|croup|lupus|colitis|crohn'?s|vasculitis|ms relapse)\b/i;

/** Sentence in the doc that attributes a flare to asthma, without negating it. */
function asthmaAttribution(doc: Doc): string | null {
  for (const s of sentences(doc.text)) {
    const m = ASTHMA_EXAC.exec(s.text);
    if (m && !NEGATION.test(s.text.slice(0, m.index)) && !HEDGE.test(s.text)) return s.text;
  }
  return null;
}

export function steroidCourses(ctx: Ctx, months = 12): Result {
  if (!ctx.formDate) return notDocumented();
  const from = addMonths(ctx.formDate, -months);
  const inWindow = ctx.docs.filter((d) => d.date >= from);
  const counted: { doc: Doc; steroid: string; attribution: string }[] = [];
  const historical: Doc[] = [];

  for (const doc of inWindow) {
    if (AGGREGATE.test(doc.text)) return notDocumented(); // a summary count we can't reconcile safely
    const mentions = sentences(doc.text).filter((s) => SYSTEMIC.test(s.text) && !NOT_SYSTEMIC.test(s.text));
    if (!mentions.length) continue;
    const newCourse = mentions.find((s) => !NOT_GIVEN.test(s.text) && !HISTORICAL.test(s.text));
    const attribution = asthmaAttribution(doc);
    const other = OTHER_INDICATION.test(doc.text);
    if (newCourse) {
      if (!attribution) continue;          // not attributed to asthma by its own document (e.g. gout)
      if (other) return notDocumented();   // asthma and another steroid indication in one doc: ambiguous
      counted.push({ doc, steroid: newCourse.text, attribution });
    } else if (mentions.some((s) => HISTORICAL.test(s.text) && !NOT_GIVEN.test(s.text)) && attribution) {
      historical.push(doc);
    }
  }
  // Two "new" courses within 14 days are probably one course documented twice.
  for (let i = 1; i < counted.length; i++)
    if (counted[i - 1].doc.date >= addDays(counted[i].doc.date, -14)) return notDocumented();
  // A back-reference to a course is fine if it follows a counted one; otherwise it may be an undocumented course.
  for (const h of historical)
    if (!counted.some((c) => c.doc.date <= h.date && c.doc.date >= addDays(h.date, -30))) return notDocumented();
  if (!counted.length) return notDocumented(); // never 0 from absence

  const inputs = counted.flatMap((c) => c.steroid === c.attribution
    ? [cite(c.doc, c.steroid)] : [cite(c.doc, c.attribution), cite(c.doc, c.steroid)]);
  return drafted(counted.length, inputs, {
    rule: `count documents dated ${from} to ${ctx.formDate} (${months} months before the form date) that record a new systemic corticosteroid course and attribute it to an asthma exacerbation in the same document; one course per document; courses for other conditions, topical/inhaled steroids, and planned or declined courses are excluded`,
    inputs,
  });
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- INHALED THERAPY

// brand or generic -> generic components
const INHALED: Record<string, string[]> = {
  fluticasone: ['fluticasone'], salmeterol: ['salmeterol'], budesonide: ['budesonide'], formoterol: ['formoterol'],
  beclomethasone: ['beclomethasone'], ciclesonide: ['ciclesonide'], mometasone: ['mometasone'], vilanterol: ['vilanterol'],
  umeclidinium: ['umeclidinium'], tiotropium: ['tiotropium'], salbutamol: ['salbutamol'], albuterol: ['salbutamol'],
  terbutaline: ['terbutaline'], ipratropium: ['ipratropium'], glycopyrronium: ['glycopyrronium'], indacaterol: ['indacaterol'],
  advair: ['fluticasone', 'salmeterol'], symbicort: ['budesonide', 'formoterol'], breo: ['fluticasone', 'vilanterol'],
  trelegy: ['fluticasone', 'umeclidinium', 'vilanterol'], flovent: ['fluticasone'], pulmicort: ['budesonide'],
  ventolin: ['salbutamol'], alvesco: ['ciclesonide'], asmanex: ['mometasone'], spiriva: ['tiotropium'],
  qvar: ['beclomethasone'], zenhale: ['mometasone', 'formoterol'], bricanyl: ['terbutaline'], atrovent: ['ipratropium'],
};
const INHALED_RE = new RegExp(`\\b(${Object.keys(INHALED).join('|')})\\b`, 'gi');

/** Identity of a drug mention, e.g. "fluticasone+salmeterol". Empty if not an inhaled drug. */
function drugKey(s: string): string {
  const parts = new Set<string>();
  for (const m of s.matchAll(INHALED_RE)) for (const g of INHALED[m[1].toLowerCase()]) parts.add(g);
  return [...parts].sort().join('+');
}

const LIST_HEADER = /\b(?:current|active)\s+(?:meds|medications)\s*:|\bmedications?\s*:|\bmeds\s*:/i;
const INACTIVE = /\b(discontinued|stopped|held|on hold|expired|not taking|inactive|previous|past)\b/i;

function listItems(body: string): string[] {
  const sep = /;|\n/.test(body) ? /;|\n/ : /,(?![^(]*\))/;
  return body.split(sep).map(stripEnd).map((s) => s.trim()).filter(Boolean);
}

export function inhaledTherapy(ctx: Ctx): Result {
  let state: Map<string, Citation> | null = null; // drugKey -> item quote
  let uncertain = false;
  const replaceWithList = (doc: Doc, body: string) => {
    state = new Map();
    uncertain = false;
    for (const item of listItems(body)) {
      const key = drugKey(item);
      if (key && !INACTIVE.test(item) && doc.text.includes(item)) state.set(key, cite(doc, item));
    }
  };
  for (const doc of ctx.docs) {
    // A medication list document is the whole list: it replaces everything known before it.
    if (/medication_list|med_list|pharmacy/i.test(doc.type)) {
      const h = LIST_HEADER.exec(doc.text);
      replaceWithList(doc, h ? doc.text.slice(h.index + h[0].length) : doc.text);
      continue;
    }
    const sents = sentences(doc.text);
    for (let i = 0; i < sents.length; i++) {
      const s = sents[i];
      const header = LIST_HEADER.exec(s.text);
      if (header) {
        let body = s.text.slice(header.index + header[0].length);
        // "Medications:" on its own line: the list is the following lines that look like doses.
        if (!body.trim()) {
          const lines: string[] = [];
          while (i + 1 < sents.length && /\d/.test(sents[i + 1].text)) lines.push(sents[++i].text);
          body = lines.join('\n');
        }
        replaceWithList(doc, body);
        continue;
      }
      if (!drugKey(s.text)) continue;
      if (!state) state = new Map();
      if (HEDGE.test(s.text) || NEGATION.test(s.text)) { uncertain = true; continue; }
      const sw = /\b(?:switched|changed|stepped (?:up|down)|transitioned)\s+(?:from\s+)?(.+?)\s+to\s+(.+)$/i.exec(s.text);
      const start = /\b(?:started|start|added|add|initiated|began)\s+(?:on\s+)?(.+)$/i.exec(s.text);
      const stop = /\b(?:stopped|stop|discontinued|discontinue|d\/c)\s+(.+)$/i.exec(s.text);
      if (sw && drugKey(sw[1]) && drugKey(sw[2])) {
        state.delete(drugKey(sw[1]));
        const item = stripEnd(sw[2]);
        state.set(drugKey(item), cite(doc, item));
      } else if (stop && drugKey(stop[1])) {
        state.delete(drugKey(stop[1]));
      } else if (start && drugKey(start[1])) {
        const item = stripEnd(start[1]);
        state.set(drugKey(item), cite(doc, item));
      } else {
        uncertain = true; // an inhaled-drug mention we can't interpret after the last full list
      }
    }
  }
  if (!state || !state.size || uncertain) return notDocumented();
  const items = [...state.values()];
  return drafted(items.map((c) => c.quote).join('; '), items);
}

// ---------------------------------------------------------------- PRIOR BIOLOGIC

const BIOLOGICS: Record<string, string> = {
  omalizumab: 'omalizumab', xolair: 'omalizumab', mepolizumab: 'mepolizumab', nucala: 'mepolizumab',
  benralizumab: 'benralizumab', fasenra: 'benralizumab', reslizumab: 'reslizumab', cinqair: 'reslizumab',
  dupilumab: 'dupilumab', dupixent: 'dupilumab', tezepelumab: 'tezepelumab', tezspire: 'tezepelumab',
};
const BIO_RE = new RegExp(`\\b(${Object.keys(BIOLOGICS).join('|')})\\b`, 'gi');
const START_VERB = /\b(started|initiated|commenced|began|first dose)\b/i;
const STOP_VERB = /\b(stopped|discontinued|ceased|halted)\b/i;
const VERB_BLOCKER = /\b(not|never|no|declined|refused|denied|plan(?:ned|s)?|will|would|may|might|consider\w*|if|awaiting|pending|unable to)\b[^.]*$/i;
const OUTCOME = /\b(?:due to|because of|owing to|secondary to)\s+([^.;]+)/i;

interface BioTrial { drug: string; start?: string; stop?: string; outcome?: string; cites: Citation[]; started: boolean; stopped: boolean }

function verbDate(text: string, verb: RegExp): { found: boolean; blocked: boolean; date?: string } {
  const m = verb.exec(text);
  if (!m) return { found: false, blocked: false };
  const before = text.slice(Math.max(0, m.index - 40), m.index);
  if (VERB_BLOCKER.test(before)) return { found: true, blocked: true };
  // The date must follow the verb closely ("started 2024-05-15", "stopped on May 1, 2024").
  const after = text.slice(m.index + m[0].length);
  const d = findDates(after)[0];
  const date = d && /^\s*(?:on\s+|in\s+)?$/i.test(after.slice(0, d.index)) ? d.iso : undefined;
  return { found: true, blocked: false, date };
}

export function priorBiologic(ctx: Ctx): Result {
  const trials = new Map<string, BioTrial>();
  for (const doc of ctx.docs) {
    for (const s of sentences(doc.text)) {
      const drugs = new Set([...s.text.matchAll(BIO_RE)].map((m) => BIOLOGICS[m[1].toLowerCase()]));
      if (drugs.size !== 1) { if (drugs.size > 1) return notDocumented(); continue; }
      const drug = [...drugs][0];
      const t = trials.get(drug) ?? { drug, cites: [], started: false, stopped: false };
      trials.set(drug, t);
      const st = verbDate(s.text, START_VERB);
      const sp = verbDate(s.text, STOP_VERB);
      if (st.blocked || sp.blocked) continue; // planned / declined: not a trial
      let used = false;
      if (st.found) { t.started = true; t.start = st.date ?? t.start; used = true; }
      if (sp.found) {
        t.stopped = true; t.stop = sp.date ?? t.stop; used = true;
        const o = OUTCOME.exec(s.text.slice(s.text.search(STOP_VERB)));
        if (o) t.outcome = stripEnd(o[1]);
      }
      if (used) t.cites.push(cite(doc, s.text));
    }
  }
  const real = [...trials.values()].filter((t) => t.started || t.stopped);
  if (!real.length) return notDocumented();
  // Every trial must be complete; an ongoing or half-documented one goes to the physician as a blank.
  if (real.some((t) => !t.started || !t.stopped || !t.start || !t.stop || !t.outcome || t.start > t.stop)) return notDocumented();
  const value = real.map((t) => `${t.drug}: started ${t.start}, stopped ${t.stop}, outcome: ${t.outcome}`).join('; ');
  return drafted(value, real.flatMap((t) => t.cites));
}

// ---------------------------------------------------------------- SMOKING

const SMOKE_TOPIC = /smok|tobacco|cigarette|pack[- ]?years?/i;
const OFF_TOPIC = /\b(cannabis|marijuana|vap(?:e|es|ing)|e-?cig\w*|wildfire|exposure|exposed|second-?hand)\b/i;
const NOT_STATUS = /\b(advised|counsel+ed|encouraged|discussed|recommended|cessation program|plans?|planning|trying|tries|wants?|considering|thinking|will|going to|unable to|attempt\w*|ask(?:ed)? about)\b/i;
const PATTERNS: [string, RegExp][] = [
  ['Never smoker', /\b(never smoked|never[- ]smoker|non-?smoker|has never used tobacco|smoking status\s*:\s*never)\b/i],
  ['Former smoker', /\b(quit|stopped|ceased|gave up)\s+(?:smoking|tobacco|cigarettes)\b|\b(former|ex-?|previous|past)\s*smoker\b|smoking status\s*:\s*(?:former|ex)/i],
  ['Does not smoke', /\bdenies\s+(?:smoking|tobacco)/i],
  ['Current smoker', /\b(current(?:ly)?\s+smok\w*|smokes\b|active smoker|smoking status\s*:\s*current|\d+\s+cigarettes?\s+(?:per|a)\s+day|\d+\s*(?:packs?|ppd))/i],
];

export function smoking(ctx: Ctx): Result {
  for (const doc of newestFirst(ctx.docs)) {
    const found: { label: string; clause: string }[] = [];
    let unclear = false;
    for (const s of sentences(doc.text)) {
      if (!SMOKE_TOPIC.test(s.text)) continue;
      for (const c of clauses(s.text)) {
        if (!SMOKE_TOPIC.test(c) || THIRD_PARTY.test(c) || OFF_TOPIC.test(c)) continue;
        if (NOT_STATUS.test(c)) continue;
        if (HEDGE.test(c)) { unclear = true; continue; }
        const hit = PATTERNS.find(([, re]) => re.test(c));
        if (hit) found.push({ label: hit[0], clause: c });
        else unclear = true; // talks about the patient's smoking in a way we can't classify
      }
    }
    if (!found.length && !unclear) continue; // nothing explicit here; look at older documents
    const labels = new Set(found.map((f) => f.label));
    if (unclear || labels.size !== 1) return notDocumented(); // the most recent statement is unclear or conflicting
    return drafted(`${found[0].label}: ${found.map((f) => f.clause).join('; ')}`, found.map((f) => cite(doc, f.clause)));
  }
  return notDocumented();
}

// ---------------------------------------------------------------- PHYSICIAN-ONLY

/** Never drafted. Offer the physician the most recent statements about control on high-dose ICS. */
export function controlEvidence(ctx: Ctx): Result {
  const re = /\b(poorly controlled|uncontrolled|inadequately controlled|not (?:well )?controlled|remains symptomatic|high-dose inhaled corticosteroid)\b/i;
  const cites: Citation[] = [];
  for (const doc of newestFirst(ctx.docs))
    for (const s of sentences(doc.text)) if (re.test(s.text) && cites.length < 3) cites.push(cite(doc, s.text));
  return needsPhysician(cites);
}
