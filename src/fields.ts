// One extractor per field. Each one drafts only when the chart states the answer plainly,
// and returns NOT_DOCUMENTED (with the reason) on anything ambiguous.
// A blank costs nothing; a wrong value is the worst case.
import { Citation, Ctx, Doc, Result, drafted, notDocumented, needsPhysician } from './types.js';
import {
  THIRD_PARTY, addDays, addMonths, clauses, findDates, findMonths, isHedged, isNegated, maskDates,
  sentences, stripEnd, toIsoDate,
} from './text.js';

const cite = (doc: Doc, quote: string): Citation => ({ doc_id: doc.doc_id, quote });
const newestFirst = <T>(xs: T[]): T[] => [...xs].reverse();
const uniq = (cs: Citation[]): Citation[] => cs.filter((c, i) => cs.findIndex((o) => o.doc_id === c.doc_id && o.quote === c.quote) === i);

// ---------------------------------------------------------------- DEMOGRAPHIC

const DEMO_KEYS: Record<string, string[]> = {
  patient_name: ['patient_name', 'name', 'full_name', 'patient'],
  phn: ['phn', 'personal_health_number', 'health_number', 'health_card_number', 'hcn', 'mrn_phn'],
  date_of_birth: ['date_of_birth', 'dob', 'birth_date', 'birthdate'],
};
const LAST_KEYS = ['last_name', 'family_name', 'surname'];
const FIRST_KEYS = ['first_name', 'given_name', 'given_names'];

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
    const last = LAST_KEYS.map((k) => demoValue(ctx, k)).find(Boolean);
    const first = FIRST_KEYS.map((k) => demoValue(ctx, k)).find(Boolean);
    if (last && first) return drafted(`${last.value}, ${first.value}`, [last.cite, first.cite]);
  }
  for (const key of DEMO_KEYS[fieldId] ?? [fieldId]) {
    const hit = demoValue(ctx, key);
    if (!hit) continue;
    if (fieldId === 'date_of_birth') {
      const iso = toIsoDate(hit.value);
      if (iso) return drafted(iso, [hit.cite]);
      return notDocumented(`demographics ${key} "${hit.value}" is not an unambiguous calendar date`);
    }
    return drafted(hit.value, [hit.cite]);
  }
  return notDocumented(`no ${fieldId} in demographics.json (notes are never used for demographics)`);
}

// ---------------------------------------------------------------- DIAGNOSIS

const DX_KEYWORD = /\b(impression|diagnos(?:is|ed|es)|assessment|dx|confirm(?:ed|s)?|reconfirm(?:ed|s)?)\b/i;
const DX_DOUBT = /\b(reconsider\w*|revised|revisit\w*|in question|doubt\w*|uncertain|not confirmed|unconfirmed|mimic\w*|misdiagnos\w*|alternative diagnos\w*|rule out|r\/o)\b/i;
/** "asthma" followed by one of these is an event or a topic, not a diagnosis statement. */
const NOT_DX_FOLLOW = /^(exacerbation|flare|attack|action|review|follow|control|symptom|education|stable|inhaler|medication|meds|therapy|clinic|history|plan|management|visit|questionnaire|score|technique|nurse|educator|teaching)/i;
const DX_FILLER = new Set(['of', 'with', 'is', 'was', 'remains', 'confirmed', 'reconfirmed', 'established', 'as', 'for', 'a', 'an', 'the',
  'his', 'her', 'their', 'known', 'ongoing', 'be', 'to', 'and', 'that', 'this', 'likely', 'consistent']);
/** An impression that only reports status ("Impression: stable on current therapy") is not a new diagnosis. */
const DX_STATUS_ONLY = /\b(stable|controlled|improv\w*|unchanged|no change|well|symptomatic|continue\w*|technique|adheren\w*|follow|tolerat\w*|doing)\b/i;
/** Diagnoses that compete with asthma: a later impression naming one of these, without asthma, is a possible revision. */
const COMPETING_DX = /\b(copd|emphysema|vocal cord|vcd|bronchiectasis|interstitial|ild|heart failure|chf|sarcoid\w*|cystic fibrosis|abpa|tracheomalacia|dysfunctional breathing|hyperventilation)\b/i;
const SHORT_HEDGE = /^(\?|likely|probable|probably|possible|possibly|presumed|in question|to be confirmed|doubtful|unconfirmed|query|suspected|uncertain|unclear|equivocal)$/i;

interface DxHit { doc: Doc; sentence: string; phrase: string; doubtful: boolean }

/** The diagnosis phrase ending in "asthma" after a keyword, e.g. "severe eosinophilic asthma". */
function dxPhrase(after: string): { phrase: string; next: string } | null {
  const m = /asthma\b/i.exec(after);
  if (!m) return null;
  const seg = after.slice(0, m.index).split(/[:;,.()–—/]|\s-\s/).pop() ?? '';
  const words = seg.trim().split(/\s+/).filter((w) => /^[A-Za-z][A-Za-z'-]*$/.test(w));
  while (words.length && DX_FILLER.has(words[0].toLowerCase())) words.shift();
  const next = after.slice(m.index + m[0].length).trim();
  return { phrase: [...words.slice(-4), m[0]].join(' '), next };
}

/** Diagnostic statements about asthma, oldest first. */
function asthmaDiagnoses(docs: Doc[]): DxHit[] {
  const hits: DxHit[] = [];
  for (const doc of docs) {
    for (const s of sentences(doc.text)) {
      const kw = DX_KEYWORD.exec(s.text);
      if (!kw || !/asthma/i.test(s.text)) continue;
      const p = dxPhrase(s.text.slice(kw.index + kw[0].length));
      if (!p || NOT_DX_FOLLOW.test(p.next)) continue;
      // Doubt is judged on the clause holding the statement (plus a short trailing clause like ", likely").
      const asthmaAt = s.text.toLowerCase().indexOf('asthma', kw.index);
      const clauseStart = Math.max(s.text.lastIndexOf(';', kw.index), s.text.lastIndexOf(',', kw.index)) + 1;
      const tail = s.text.slice(asthmaAt);
      const endRel = tail.search(/[;,]/);
      let local = s.text.slice(clauseStart, endRel < 0 ? s.text.length : asthmaAt + endRel);
      if (endRel >= 0) {
        const following = stripEnd(tail.slice(endRel + 1).split(/[;,]/)[0]);
        if (SHORT_HEDGE.test(following)) local += ' ' + following;
      }
      const doubtful = isNegated(local) || isHedged(local) || THIRD_PARTY.test(local) || DX_DOUBT.test(s.text);
      hits.push({ doc, sentence: s.text, phrase: p.phrase, doubtful });
    }
  }
  return hits;
}

const isRespirologist = (d: Doc) =>
  /respirolog|pulmonolog|respiratory medicine|respiratory physician|chest physician|pneumolog/i.test(d.author_role) &&
  !/nurse|therapist|technolog|technician|student|clerk|assistant|educator/i.test(d.author_role);

export function diagnosis(ctx: Ctx): Result {
  const hits = asthmaDiagnoses(ctx.docs);
  if (!hits.length) return notDocumented('no sentence states an asthma diagnosis under impression/diagnosis/assessment');
  const latestDate = hits[hits.length - 1].doc.date;
  const latest = hits.filter((h) => h.doc.date === latestDate);
  const bad = latest.find((h) => h.doubtful);
  if (bad) return notDocumented(`the most recent diagnostic statement (${bad.doc.doc_id}) is hedged, negated or in question; an older clear one is not used because the most recent governs`);
  const phrases = new Set(latest.map((h) => h.phrase.toLowerCase()));
  if (phrases.size > 1) return notDocumented(`same-day diagnostic statements disagree (${[...phrases].join(' / ')})`);
  // A later specialist impression that names something else may mean the diagnosis changed.
  const changed = ctx.docs.find((d) => d.date > latestDate && sentences(d.text).some((s) =>
    DX_KEYWORD.test(s.text) && !/asthma/i.test(s.text) &&
    (isRespirologist(d) ? !DX_STATUS_ONLY.test(s.text) : COMPETING_DX.test(s.text))));
  if (changed) return notDocumented(`a later document (${changed.doc_id}) carries an impression that does not mention asthma; the diagnosis may have been revised`);

  // Most recent governs. An older, more specific phrase that ends in the newer one ("severe eosinophilic asthma"
  // vs a later "asthma") refines it; a different phrase is a change over time and stops the walk.
  let best = latest[latest.length - 1];
  const cites: Citation[] = [cite(best.doc, best.sentence)];
  for (const h of newestFirst(hits.filter((x) => x.doc.date < latestDate && !x.doubtful))) {
    const p = h.phrase.toLowerCase(), b = best.phrase.toLowerCase();
    if (p === b) { if (cites.length < 2) cites.push(cite(h.doc, h.sentence)); continue; }
    if (p.endsWith(' ' + b)) { best = h; cites.unshift(cite(h.doc, h.sentence)); continue; }
    break;
  }
  return drafted(best.phrase, uniq(cites).slice(0, 3));
}

export function respirologistConfirmed(ctx: Ctx, months = 24): Result {
  if (!ctx.formDate) return notDocumented('form date missing, so no window can be computed');
  const from = addMonths(ctx.formDate, -months);
  const resp = ctx.docs.filter(isRespirologist);
  if (!resp.length) return notDocumented('no document authored by a respirologist');
  const all = asthmaDiagnoses(resp);
  const hits = all.filter((h) => h.doc.date >= from);
  if (!hits.length) {
    return notDocumented(all.length
      ? `the only respirologist diagnosis statements (${all.map((h) => h.doc.doc_id + ' ' + h.doc.date).join(', ')}) are older than ${from}; absence inside the window is not "false"`
      : 'no respirologist document states an asthma diagnosis; absence is not "false"');
  }
  const latestDate = hits[hits.length - 1].doc.date;
  const latest = hits.filter((h) => h.doc.date === latestDate);
  const bad = latest.find((h) => h.doubtful);
  if (bad) return notDocumented(`the most recent respirologist statement in the window (${bad.doc.doc_id}) is hedged or in question`);
  const changed = resp.find((d) => d.date > latestDate && sentences(d.text).some((s) =>
    DX_KEYWORD.test(s.text) && !/asthma/i.test(s.text) && !DX_STATUS_ONLY.test(s.text)));
  if (changed) return notDocumented(`a later respirology document (${changed.doc_id}) carries an impression that does not mention asthma, so the confirmation may have been revised`);
  const inputs = latest.map((h) => cite(h.doc, h.sentence));
  return drafted(true, inputs, {
    rule: `true if a document authored by a respirologist, dated on or after ${from} (${months} months before the form date ${ctx.formDate}), states an asthma diagnosis without hedging or negation`,
    inputs,
  });
}

// ---------------------------------------------------------------- EOSINOPHILS

const UNIT = String.raw`(?:(?:x|×|\*)?\s*10\s*(?:\^|\*\*|E|e)?\s*9\s*\/\s*L|(?:x|×|\*)?\s*10⁹\s*\/\s*L|(?:x|×|\*)?\s*10\s*\(9\)\s*\/\s*L|(?:giga|G)\s*\/\s*L|(?:cells?\s*)?\/\s*(?:u|µ|μ|mc)L|cells?\s*\/\s*mm\s*3|(?:x|×|\*)?\s*10\s*(?:\^|\*\*|E|e)?\s*3\s*\/\s*(?:u|µ|μ|mc)L|K\s*\/\s*(?:u|µ|μ|mc)L)`;
const EOS = new RegExp(String.raw`\b(?:absolute\s+|abs\.?\s+|blood\s+|peripheral\s+|serum\s+)?eos(?:inophils?|\.)?(?:\s+count)?(?:\s*\(abs(?:olute)?\.?\))?(?:\s*[.…:=\-–]+\s*|\s+)?(?:was|were|of|is|at)?\s*(?:\d+(?:\.\d+)?\s*%\s*[,(]?\s*)?(\d+(?:\.\d+)?\s*${UNIT})`, 'i');
const NOT_BLOOD = /\b(sputum|bronchial|nasal|bal|lavage|tissue|biopsy|urine|csf|pleural)\b/i;
const COLLECTED = /\b(collected|collection(?:\s+date)?|specimen(?:\s+(?:collected|drawn|date|taken|obtained))?|sample(?:d|\s+(?:collected|drawn|date|taken|obtained))?|drawn|(?:blood|bloods|bloodwork|labs?)\s+(?:taken|done|from|obtained)|venipuncture|phlebotomy|date of (?:collection|specimen|draw|service))\b/i;

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
      if (NOT_BLOOD.test(s.text)) continue;
      const m = EOS.exec(s.text);
      if (m && (THIRD_PARTY.test(s.text) || isHedged(s.text) || isNegated(s.text)))
        return notDocumented(`${doc.doc_id}: eosinophil statement is uncertain, negated or has another subject`);
      if (m && collected && (collected > doc.date || (ctx.formDate && collected > ctx.formDate)))
        return notDocumented(`${doc.doc_id}: collection date is after the report or form date`);
      if (m) results.push({ doc, value: m[1].trim(), sentence: s.text, collected, collectedSentence });
    }
  }
  if (!results.length) return notDocumented('no blood eosinophil result with a unit found');
  const dated = results.filter((r) => r.collected).sort((a, b) => a.collected!.localeCompare(b.collected!));
  if (!dated.length) return notDocumented(`eosinophil results found (${results.map((r) => r.doc.doc_id).join(', ')}) but none with a stated collection date; the report date is not used`);
  const best = dated[dated.length - 1];
  // Two different results on the same collection date: can't pick one.
  const clash = dated.find((r) => r.collected === best.collected && r.value !== best.value);
  if (clash) return notDocumented(`two different results share the collection date ${best.collected} (${best.doc.doc_id}, ${clash.doc.doc_id})`);
  // A result with no collection date could be newer unless its report predates our best collection date.
  // A sentence naming only years before the best collection year ("0.5 in 2024") is older and can be ignored.
  const clearlyOlder = (r: EosResult) => {
    const years = [...r.sentence.matchAll(/\b(19|20)\d{2}\b/g)].map((m) => +m[0]);
    return years.length > 0 && years.every((y) => y < +best.collected!.slice(0, 4));
  };
  const blocker = results.find((r) => !r.collected && r.doc.date >= best.collected! && !clearlyOlder(r));
  if (blocker) return notDocumented(`a later eosinophil result in ${blocker.doc.doc_id} has no collection date, so it may be more recent than ${best.collected}`);
  const citations = [cite(best.doc, best.sentence)];
  if (best.collectedSentence !== best.sentence) citations.push(cite(best.doc, best.collectedSentence!));
  return drafted(`${best.value} (collected ${best.collected})`, citations);
}

// ---------------------------------------------------------------- SYSTEMIC STEROIDS

const SYSTEMIC = /\b(prednisone|pred|prednisolone|methylprednisolone|solu-?medrol|medrol|dexamethasone|decadron|deltasone|orapred|pediapred|hydrocortisone|solu-?cortef|oral (?:cortico)?steroids?|systemic (?:cortico)?steroids?|po steroids?|ocs|steroid (?:burst|taper|course)|(?:burst|course|taper) of (?:oral |systemic )?(?:cortico)?steroids?)\b/i;
/** Steroids that are usually local; with an asthma attribution they make the count unsafe rather than counting. */
const AMBIGUOUS_STEROID = /\b(betamethasone|triamcinolone|kenalog|celestone)\b/i;
const NOT_SYSTEMIC = /\b(cream|ointment|lotion|gel|topical|inhaled|inhaler|puffs?|nasal|nose|spray|eye ?drops?|ear ?drops?|drops|intra-?articular|joint injection|injected into|injection into|into (?:the )?(?:left |right )?\w+ (?:joint|knee|shoulder|hip|bursa)|enema|suppository|rectal)\b|\d+(?:\.\d+)?\s*%/i;
const NOT_GIVEN = /\b(no|not|declined|refused|held|withheld|avoid\w*|plan(?:ned|s)? to|recommend\w*|advised|consider\w*|if|rescue pack|to keep at home|in case|stand-?by|as needed|prn|action plan|would|could|may|might|should|offered|discussed|suggest\w*|unless|whether|allerg\w*|intoleran\w*)\b/i;
const HISTORICAL = /\b(previous(?:ly)?|prior|recent(?:ly)?|completed|complet(?:ing|es)|finish(?:ed|ing|es)|last (?:week|month|year|visit|time|spring|summer|fall|autumn|winter)|ago|history of|hx of|since|already|was on|had been on|has been on|currently on|still on|remains on|continues?|continuing|ongoing|taper(?:ing)? (?:down|off)|day \d+ of|on day|from (?:the )?(?:ed|er|emergency|hospital|walk-?in|urgent care)|earlier this (?:year|month)|in the (?:spring|summer|fall|autumn|winter)|chronic|maintenance|long-?term|baseline|home dose)\b/i;
const COUNT_WORD = String.raw`(?:\d+(?:st|nd|rd|th)?|one|two|three|four|five|six|second|third|fourth|fifth|several|multiple|frequent|repeated|numerous|another)`;
const AGGREGATE = new RegExp(String.raw`\b${COUNT_WORD}\s+(?:courses?|bursts?|rounds?|times|episodes)\b[^.]*\b(?:prednisone|pred|steroids?|corticosteroids?|ocs)\b|\b(?:prednisone|pred|steroids?|corticosteroids?|ocs)\b[^.]*\b${COUNT_WORD}\s+(?:courses?|bursts?|rounds?|times)\b`, 'i');
const ASTHMA_EXAC = /\b(asthma(?:tic)? (?:exacerbation|flare(?:-? ?up)?|attack|crisis)|(?:acute |severe |moderate |mild )?(?:exacerbation|flare(?:-? ?up)?) of (?:\w+ ){0,3}asthma|acute (?:severe )?asthma|status asthmaticus|asthma (?:worse|worsening|exacerbated)|worsening (?:of )?(?:\w+ )?asthma)\b/i;
const OTHER_INDICATION = /\b(gout|copd|emphysema|rash|dermatitis|eczema|arthritis|poison ivy|urticaria|hives|anaphylaxis|allergic reaction|sinusitis|bell'?s palsy|polymyalgia|croup|lupus|colitis|crohn'?s|vasculitis|ms relapse|pneumonia|bronchitis|sciatica|radiculopathy|nausea|chemotherapy|transplant|nephrotic|itp|sarcoid\w*|covid|pericarditis|thyroiditis|contact dermatitis|psoriasis)\b/i;

/** Index of the first sentence in the doc that attributes a flare to asthma, without negating it. */
function asthmaAttribution(sents: { text: string }[]): number {
  for (let i = 0; i < sents.length; i++) {
    const m = ASTHMA_EXAC.exec(sents[i].text);
    if (m && !isNegated(sents[i].text.slice(0, m.index)) && !isHedged(sents[i].text)) return i;
  }
  return -1;
}

/** A full or month-precision date in the sentence that is clearly earlier than the document's own date. */
function earlierDate(sentence: string, docDate: string): string | null {
  for (const d of findDates(sentence)) if (d.iso < addDays(docDate, -14)) return d.iso;
  for (const m of findMonths(sentence)) if (m.iso.slice(0, 7) < docDate.slice(0, 7)) return m.iso;
  return null;
}

export function steroidCourses(ctx: Ctx, months = 12): Result {
  if (!ctx.formDate) return notDocumented('form date missing, so no window can be computed');
  const from = addMonths(ctx.formDate, -months);
  const inWindow = ctx.docs.filter((d) => d.date >= from);
  const counted: { doc: Doc; steroid: string; attribution: string }[] = [];
  const historical: { doc: Doc; date: string | null; text: string }[] = [];

  for (const doc of inWindow) {
    // Another person in the steroid sentence, the sentence before it, or the flare sentence makes the subject ambiguous.
    // A social-history line elsewhere in the note ("Lives with wife") does not.
    const ss = sentences(doc.text);
    const si = ss.findIndex((s) => SYSTEMIC.test(s.text));
    if (si >= 0 && [ss[si], ss[si - 1], ...ss.filter((s) => ASTHMA_EXAC.test(s.text))].some((s) => s && THIRD_PARTY.test(s.text)))
      return notDocumented(`${doc.doc_id}: steroid mention has ambiguous patient attribution`);
    const agg = AGGREGATE.exec(doc.text);
    if (agg) return notDocumented(`${doc.doc_id} gives a summary count ("${stripEnd(agg[0])}") that cannot be reconciled with dated courses`);
    const sents = sentences(doc.text);
    const mentionIdx = sents.map((s, i) => i).filter((i) => SYSTEMIC.test(sents[i].text) && !NOT_SYSTEMIC.test(sents[i].text));
    const attrIdx = asthmaAttribution(sents);
    if (attrIdx >= 0 && sents.some((s) => AMBIGUOUS_STEROID.test(s.text) && !NOT_SYSTEMIC.test(s.text)))
      return notDocumented(`${doc.doc_id} pairs an asthma flare with a steroid whose route is unclear`);
    if (!mentionIdx.length) continue;
    const isNew = (i: number) => {
      const t = maskDates(sents[i].text);
      return !NOT_GIVEN.test(t) && !HISTORICAL.test(t) && !earlierDate(sents[i].text, doc.date);
    };
    const newIdx = mentionIdx.find(isNew);
    if (newIdx !== undefined) {
      if (attrIdx < 0) continue; // not attributed to an asthma flare by its own document (e.g. gout)
      const lo = Math.min(attrIdx, newIdx), hi = Math.max(attrIdx, newIdx);
      const span = sents.slice(lo, hi + 1).map((s) => s.text).join(' ');
      if (OTHER_INDICATION.test(span) || (attrIdx > newIdx && OTHER_INDICATION.test(doc.text)))
        return notDocumented(`${doc.doc_id} mentions an asthma flare and another steroid indication, so the course cannot be attributed safely`);
      counted.push({ doc, steroid: sents[newIdx].text, attribution: sents[attrIdx].text });
    } else if (attrIdx >= 0) {
      const ref = mentionIdx.find((i) => !NOT_GIVEN.test(maskDates(sents[i].text)));
      if (ref !== undefined) historical.push({ doc, date: earlierDate(sents[ref].text, doc.date), text: sents[ref].text });
    }
  }
  // Two "new" courses within 14 days are probably one course documented twice.
  for (let i = 1; i < counted.length; i++)
    if (counted[i - 1].doc.date >= addDays(counted[i].doc.date, -14))
      return notDocumented(`${counted[i - 1].doc.doc_id} and ${counted[i].doc.doc_id} both record a course within 14 days; one course or two cannot be told apart`);
  // A back-reference to a course is fine if it matches a counted one; otherwise it may be an undocumented course.
  for (const h of historical) {
    const matched = h.date
      ? counted.some((c) => c.doc.date >= addDays(h.date!, -21) && c.doc.date <= addDays(h.date!, 45))
      : counted.some((c) => c.doc.date <= h.doc.date && c.doc.date >= addDays(h.doc.date, -30));
    if (!matched) return notDocumented(`${h.doc.doc_id} refers to an earlier course ("${stripEnd(h.text)}") that no dated document in the window records`);
  }
  if (!counted.length) return notDocumented('no document in the window records a systemic steroid course attributed to an asthma flare; absence is not 0');

  const inputs = counted.flatMap((c) => c.steroid === c.attribution
    ? [cite(c.doc, c.steroid)] : [cite(c.doc, c.attribution), cite(c.doc, c.steroid)]);
  return drafted(counted.length, inputs, {
    rule: `count documents dated ${from} to ${ctx.formDate} (${months} months before the form date) that record a new systemic corticosteroid course and attribute it to an asthma exacerbation in the same document; one course per document; courses for other conditions, topical/inhaled steroids, planned or declined courses, and continuations of an already-counted course are excluded`,
    inputs,
  });
}

// ---------------------------------------------------------------- INHALED THERAPY

// brand or generic -> generic components
const INHALED: Record<string, string[]> = {
  fluticasone: ['fluticasone'], salmeterol: ['salmeterol'], budesonide: ['budesonide'], formoterol: ['formoterol'],
  beclomethasone: ['beclomethasone'], beclometasone: ['beclomethasone'], ciclesonide: ['ciclesonide'], mometasone: ['mometasone'],
  vilanterol: ['vilanterol'], umeclidinium: ['umeclidinium'], tiotropium: ['tiotropium'], salbutamol: ['salbutamol'],
  albuterol: ['salbutamol'], levalbuterol: ['salbutamol'], terbutaline: ['terbutaline'], ipratropium: ['ipratropium'],
  glycopyrronium: ['glycopyrronium'], glycopyrrolate: ['glycopyrronium'], indacaterol: ['indacaterol'], aclidinium: ['aclidinium'],
  olodaterol: ['olodaterol'], cromolyn: ['cromolyn'], nedocromil: ['nedocromil'],
  advair: ['fluticasone', 'salmeterol'], seretide: ['fluticasone', 'salmeterol'], wixela: ['fluticasone', 'salmeterol'],
  airduo: ['fluticasone', 'salmeterol'], symbicort: ['budesonide', 'formoterol'], breo: ['fluticasone', 'vilanterol'],
  relvar: ['fluticasone', 'vilanterol'], trelegy: ['fluticasone', 'umeclidinium', 'vilanterol'], flovent: ['fluticasone'],
  arnuity: ['fluticasone'], pulmicort: ['budesonide'], ventolin: ['salbutamol'], proair: ['salbutamol'], proventil: ['salbutamol'],
  airomir: ['salbutamol'], alvesco: ['ciclesonide'], asmanex: ['mometasone'], spiriva: ['tiotropium'], qvar: ['beclomethasone'],
  zenhale: ['mometasone', 'formoterol'], dulera: ['mometasone', 'formoterol'], bricanyl: ['terbutaline'], atrovent: ['ipratropium'],
  fostair: ['beclomethasone', 'formoterol'], foster: ['beclomethasone', 'formoterol'], breztri: ['budesonide', 'glycopyrronium', 'formoterol'],
  trixeo: ['budesonide', 'glycopyrronium', 'formoterol'], enerzair: ['mometasone', 'indacaterol', 'glycopyrronium'],
  atectura: ['mometasone', 'indacaterol'], anoro: ['umeclidinium', 'vilanterol'], incruse: ['umeclidinium'], oxeze: ['formoterol'],
  foradil: ['formoterol'], serevent: ['salmeterol'], onbrez: ['indacaterol'], seebri: ['glycopyrronium'], ultibro: ['indacaterol', 'glycopyrronium'],
  striverdi: ['olodaterol'], inspiolto: ['tiotropium', 'olodaterol'], stiolto: ['tiotropium', 'olodaterol'], airsupra: ['salbutamol', 'budesonide'],
  combivent: ['ipratropium', 'salbutamol'], duoneb: ['ipratropium', 'salbutamol'], 'ics/laba': ['ics/laba'],
};
const INHALED_RE = new RegExp(`\\b(${Object.keys(INHALED).map((k) => k.replace('/', '\\/')).join('|')})\\b`, 'gi');
/** Words that mean "some inhaler" when no known drug is named; such a sentence is unreadable, not ignorable. */
const UNKNOWN_INHALER = /\b(inhalers?|puffers?|mdi|dpi|hfa|turbuhaler|diskus|ellipta|respimat|aerosphere|breezhaler|genuair|nexthaler|spiromax|forspiro|nebuliz\w+|nebulis\w+|ics|laba|lama|saba|ics\/laba|corticosteroid inhaler|controller|reliever|rescue inhaler|puffs?|inhalations?)\b|\b\d+(?:\.\d+)?\/\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?\s*(?:mcg|µg|ug)?\b/i;

/** Identity of a drug mention, e.g. "fluticasone+salmeterol". Empty if not an inhaled drug. */
function drugKey(s: string): string {
  const parts = new Set<string>();
  for (const m of s.matchAll(INHALED_RE)) for (const g of INHALED[m[1].toLowerCase()]) parts.add(g);
  return [...parts].sort().join('+');
}

const LIST_HEADER = /\b(?:(?:current|active|home|discharge|regular|daily)\s+)?(?:meds|medications?|medication (?:list|reconciliation|review)|med rec|rx|prescriptions?|inhalers?|current (?:inhaled )?therapy)\s*:/i;
const INACTIVE = /\b(discontinued|stopped|held|on hold|expired|not taking|inactive|previous|past|completed|d\/c'?d?|cancelled|no longer)\b/i;
const SWITCH = /\b(?:switched|changed|stepped (?:up|down)|transitioned|moved|converted|escalated)\s+(?:from\s+)?(.+?)\s+to\s+(.+)$/i;
const START = /\b(?:started|start|starting|added|add|adding|initiated|initiate|began|begin|commenced|prescribed|new rx|new prescription)\s*(?:on\s+|for\s+)?[:\-]?\s*(.+)$/i;
const STOP = /\b(?:stopped|stop|discontinued|discontinue|d\/c|ceased|removed)\s+(.+)$/i;
const CONTINUE = /\b(continue[sd]?|continuing|remains? on|still on|stays? on|stay on|maintained? on|maintain|currently (?:on|taking|using)|is on|on\b|taking|using|uses|adheren\w+ (?:to|with)|compliant with|technique)\b/i;

/** The object of a verb runs to the next clause: "started X; continue Y" is about X. */
const firstClause = (s: string) => stripEnd(s.split(/;|,?\s+and\s+|,?\s+then\s+/)[0] ?? '');

function listItems(body: string): string[] {
  const sep = /;|\n/.test(body) ? /;|\n/ : /,(?![^(]*\))/;
  return body.split(sep).map(stripEnd).map((s) => s.trim()).filter(Boolean);
}

export function inhaledTherapy(ctx: Ctx): Result {
  let state: Map<string, Citation> | null = null; // drugKey -> item quote
  let unclear: string | null = null;
  const replaceWithList = (doc: Doc, body: string) => {
    state = new Map();
    unclear = null;
    for (let item of listItems(body)) {
      // "Dispensed/active: Breo ..." on the first line: drop a label that is not itself a drug.
      const lab = /^([^:\n]{1,40}):\s*(.+)$/.exec(item);
      if (lab && !drugKey(lab[1]) && !/\d/.test(lab[1])) item = lab[2].trim();
      const key = drugKey(item);
      if (key && (THIRD_PARTY.test(body) || isHedged(item) || isNegated(item) || /\b(plan(?:ned)?|recommend(?:ed)?|proposed|will)\b/i.test(item))) {
        unclear = `${doc.doc_id}: medication list is not an explicit current patient regimen`;
        continue;
      }
      if (!key && UNKNOWN_INHALER.test(item) && !INACTIVE.test(item)) { unclear = `${doc.doc_id} lists an inhaler I cannot identify ("${item}")`; continue; }
      if (key && !INACTIVE.test(item) && doc.text.includes(item)) state.set(key, cite(doc, item));
    }
  };
  // Dose-looking numbers only ("500/50", "2 puffs", "100 mcg"), so "3 times a week" is not read as a dose change.
  const numbersOf = (s: string) => [...s.matchAll(/\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)+|\d+(?:\.\d+)?(?=\s*(?:mcg|µg|ug|mg|ml|%|puffs?|inhalations?|actuations?)\b)/gi)].map((m) => m[0]);
  for (const doc of ctx.docs) {
    // A medication list document is the whole list: it replaces everything known before it.
    if (/medication_list|med_list|med_rec|pharmacy|medication_reconciliation/i.test(doc.type)) {
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
          while (i + 1 < sents.length && sents[i + 1].text.length <= 100 && (/\d/.test(sents[i + 1].text) || drugKey(sents[i + 1].text))) lines.push(sents[++i].text);
          body = lines.join('\n');
        }
        replaceWithList(doc, body);
        continue;
      }
      const key = drugKey(s.text);
      if (!key) {
        // "Switched to Fostair 200/6" with a brand I don't know: a change I can't read is a reason to abstain, not to ignore.
        const target = firstClause(SWITCH.exec(s.text)?.[2] ?? START.exec(s.text)?.[1] ?? STOP.exec(s.text)?.[1] ?? '');
        if (target && UNKNOWN_INHALER.test(target) && !isHedged(s.text) && !isNegated(s.text))
          unclear = `${doc.doc_id} changes an inhaler I cannot identify ("${stripEnd(s.text)}")`;
        continue;
      }
      if (THIRD_PARTY.test(s.text)) { unclear = `${doc.doc_id}: inhaler subject is ambiguous`; continue; }
      if (!state) state = new Map();
      if (isHedged(s.text) || isNegated(s.text)) { unclear = `${doc.doc_id} has a hedged or negated inhaler statement ("${stripEnd(s.text)}")`; continue; }
      const sw = SWITCH.exec(s.text);
      const start = START.exec(s.text);
      const stop = STOP.exec(s.text);
      if (sw && drugKey(sw[1]) && drugKey(firstClause(sw[2]))) {
        state.delete(drugKey(sw[1]));
        const item = firstClause(sw[2]);
        state.set(drugKey(item), cite(doc, item));
      } else if (stop && drugKey(firstClause(stop[1]))) {
        state.delete(drugKey(firstClause(stop[1])));
      } else if (start && drugKey(firstClause(start[1]))) {
        const item = firstClause(start[1]);
        state.set(drugKey(item), cite(doc, item));
      } else if (CONTINUE.test(s.text) && !sw && !stop) {
        // A statement that the patient is on a drug: consistent with the state if the numbers (doses) agree.
        const current = state.get(key);
        if (current) {
          const known = numbersOf(current.quote);
          if (numbersOf(s.text).some((n) => !known.includes(n))) unclear = `${doc.doc_id} mentions ${key} with different numbers than the last list ("${stripEnd(s.text)}")`;
        } else {
          const m = INHALED_RE.exec(s.text); INHALED_RE.lastIndex = 0;
          const item = stripEnd(s.text.slice(m!.index).replace(/\s+(?:with|and)\s+(?:good|poor|excellent)?\s*(?:adherence|technique|compliance)\b.*$/i, ''));
          state.set(key, cite(doc, item));
        }
      } else {
        unclear = `${doc.doc_id} mentions an inhaler in a way I cannot interpret ("${stripEnd(s.text)}")`;
      }
    }
  }
  if (!state) return notDocumented('no medication list or inhaler statement found');
  if (unclear) return notDocumented(unclear);
  const items = [...(state as Map<string, Citation>).values()];
  if (!items.length) return notDocumented('the latest medication information lists no inhaled asthma drug');
  if (items.some(c => !numbersOf(c.quote).length))
    return notDocumented('an inhaler is named without a documented dose');
  return drafted(items.map((c) => c.quote).join('; '), items);
}

// ---------------------------------------------------------------- PRIOR BIOLOGIC

const BIOLOGICS: Record<string, string> = {
  omalizumab: 'omalizumab', xolair: 'omalizumab', mepolizumab: 'mepolizumab', nucala: 'mepolizumab',
  benralizumab: 'benralizumab', fasenra: 'benralizumab', reslizumab: 'reslizumab', cinqair: 'reslizumab',
  dupilumab: 'dupilumab', dupixent: 'dupilumab', tezepelumab: 'tezepelumab', tezspire: 'tezepelumab',
};
const BIO_RE = new RegExp(`\\b(${Object.keys(BIOLOGICS).join('|')})\\b`, 'gi');
const START_VERB = /\b(started|initiated|commenced|began|begun|first dose|first injection|first given)\b/i;
const STOP_VERB = /\b(stopped|discontinued|ceased|halted|withdrawn|last dose)\b/i;
const VERB_BLOCKER = /\b(not|never|no|declined|refused|denied|plan(?:ned|s)?|will|would|may|might|consider\w*|if|awaiting|pending|unable to|should|could|to be|recommend\w*|suggest\w*|offer\w*|discuss\w*|approval|funding|application)\b[^.]*$/i;
const RANGE_BLOCKER = /\b(plan(?:ned|s)?|will|would|consider\w*|declined|refused|propos\w*|recommend\w*|if)\b/i;
const OUTCOME = /\b(?:due to|because of|owing to|secondary to|for|after|given|with|as a result of|following|citing)\s+((?:lack of|no |poor|inadequate|insufficient|minimal|partial|adverse|injection|side|intoleran|anaphyla|cost|coverage|insurance|patient|non-?respon|nonrespon|failure|ineffect|loss of|worsen|absent|limited|suboptimal|persistent|ongoing|continued|frequent|recurrent)[^.;]*)/i;
const OUTCOME_PHRASE = /\b(lack of (?:response|efficacy|benefit|effect|improvement)|no (?:response|improvement|benefit|effect|clinical benefit)|poor response|inadequate response|partial response|suboptimal response|non-?respon\w+|(?:did not|didn't|failed to) respond|ineffective|not effective|injection[- ]site reactions?|adverse (?:effects?|reactions?|events?)|side effects?|intoleran\w+|anaphyla\w+|allergic reaction|cost|lost coverage|coverage (?:denied|ended|lapsed)|insurance|patient (?:preference|choice|request)|non-?adheren\w+|pregnancy|remission|good response|worsening)\b/i;
const RESTART = /\b(restart\w*|resum\w*|re-?initiat\w*|re-?challeng\w*|re-?introduc\w*|back on)\b/i;
const NON_ASTHMA_INDICATION = /\b(atopic dermatitis|eczema|urticaria|hives|nasal polyps|crswnp|egpa|eosinophilic granulomatosis|hypereosinophilic|hes|esophagitis|eoe|copd|prurigo)\b/i;

interface BioTrial { drug: string; written: string; start?: string; stop?: string; outcome?: string; cites: Citation[]; started: boolean; stopped: boolean; restarted: boolean }

function verbDate(text: string, verb: RegExp, docDate: string): { found: boolean; blocked: boolean; date?: string } {
  const m = verb.exec(text);
  if (!m) return { found: false, blocked: false };
  const before = maskDates(text).slice(Math.max(0, m.index - 40), m.index);
  if (VERB_BLOCKER.test(before)) return { found: true, blocked: true };
  // The date must follow the verb closely ("started 2024-05-15", "stopped on May 1, 2024", "started today").
  const after = text.slice(m.index + m[0].length);
  if (/^\s*(?:on\s+)?today\b/i.test(after)) return { found: true, blocked: false, date: docDate };
  const d = findDates(after)[0];
  // "started omalizumab 2024-05-15" and "started (Xolair) on 2024-05-15" are still "started <date>".
  const between = d ? after.slice(0, d.index).replace(BIO_RE, '').replace(/\([^)]*\)/g, '') : '';
  let date = d && /^\s*(?:on\s+|in\s+|as of\s+)?\s*$/i.test(between) ? d.iso : undefined;
  // "Started Fasenra 30 mg q8w on 2025-03-01": drug, dose and interval may sit between verb and date,
  // but only when the sentence has a single date, so the date can't belong to something else.
  if (!date && d && findDates(text).length === 1 && new RegExp(BIO_RE.source, 'i').test(after.slice(0, d.index)) &&
    /^\s*(?:(?:\d+(?:\.\d+)?\s*(?:mg|mcg)|sc|subcut\w*|iv|q\d+w(?:ks?)?|every\s+\d+\s+weeks?|monthly)\s*)*(?:on\s+|as of\s+)?$/i.test(between)) date = d.iso;
  return { found: true, blocked: false, date };
}

function outcomeIn(text: string): string | undefined {
  const o = OUTCOME.exec(text);
  if (o) return stripEnd(o[1]);
  const p = OUTCOME_PHRASE.exec(text);
  return p ? p[0] : undefined;
}

export function priorBiologic(ctx: Ctx): Result {
  const trials = new Map<string, BioTrial>();
  for (const doc of ctx.docs) {
    for (const s of sentences(doc.text)) {
      // "Omalizumab stopped ...; patient declined mepolizumab": two drugs in one sentence are read clause by clause.
      const units = new Set([...s.text.matchAll(BIO_RE)].map((m) => BIOLOGICS[m[1].toLowerCase()])).size > 1
        ? s.text.split(/;/).map((c) => c.trim()).filter(Boolean) : [s.text];
      for (const text of units) {
        const mentions = [...text.matchAll(BIO_RE)];
        const drugs = new Set(mentions.map((m) => BIOLOGICS[m[1].toLowerCase()]));
        if (drugs.size !== 1) {
          if (drugs.size > 1) return notDocumented(`${doc.doc_id} names two biologics in one clause ("${stripEnd(text)}"); cannot assign dates safely`);
          continue;
        }
        if (THIRD_PARTY.test(text) || isHedged(text))
          return notDocumented(`${doc.doc_id}: biologic statement is uncertain or has another subject`);
        const drug = [...drugs][0];
        if (NON_ASTHMA_INDICATION.test(text) && !/asthma/i.test(text))
          return notDocumented(`${doc.doc_id} ties ${drug} to a non-asthma indication ("${stripEnd(text)}")`);
        const t = trials.get(drug) ?? { drug, written: mentions[0][1], cites: [], started: false, stopped: false, restarted: false };
        trials.set(drug, t);
        if (RESTART.test(text) && !isNegated(text) && !isHedged(text)) t.restarted = true;
        const st = verbDate(text, START_VERB, doc.date);
        const sp = verbDate(text, STOP_VERB, doc.date);
        if (!st.blocked && !sp.blocked && [st.date, sp.date, ...findDates(text).map(d => d.iso)].some(d => d && (d > doc.date || (ctx.formDate && d > ctx.formDate))))
          return notDocumented(`${doc.doc_id}: biologic dates are after the documenting note or form`);
        let used = false;
        if (!st.blocked && !sp.blocked) {
          if (st.found) { t.started = true; t.start = st.date ?? t.start; used = true; }
          if (sp.found) {
            t.stopped = true; t.stop = sp.date ?? t.stop; used = true;
            t.outcome = outcomeIn(text.slice(text.search(STOP_VERB))) ?? outcomeIn(text) ?? t.outcome;
          }
          // "omalizumab from 2024-05-15 to 2024-09-10": a dated range is a start and a stop.
          const ds = findDates(text);
          if (ds.length === 2 && /^\s*(?:to|until|through|till|–|-|—)\s*$/i.test(text.slice(ds[0].index + ds[0].raw.length, ds[1].index))
            && !RANGE_BLOCKER.test(maskDates(text))) {
            t.started = t.stopped = true; t.start = t.start ?? ds[0].iso; t.stop = t.stop ?? ds[1].iso; used = true;
            t.outcome = t.outcome ?? outcomeIn(text);
          }
        }
        if (used) t.cites.push(cite(doc, text));
      }
    }
  }
  const real = [...trials.values()].filter((t) => t.started || t.stopped);
  if (!real.length) {
    const seen = [...trials.values()].map((t) => t.drug);
    return notDocumented(seen.length
      ? `${seen.join(', ')} mentioned, but only as a plan, a refusal or without a start/stop statement; a plan is not a trial`
      : 'no biologic for asthma named in the chart');
  }
  // Every trial must be complete; an ongoing or half-documented one goes to the physician as a blank.
  for (const t of real) {
    if (t.restarted) return notDocumented(`${t.drug}: the chart says it was restarted or resumed, so it may be current rather than prior`);
    if (!t.started || !t.start) return notDocumented(`${t.drug}: no dated start statement`);
    if (!t.stopped || !t.stop) return notDocumented(`${t.drug}: no dated stop statement, so it may be ongoing`);
    if (!t.outcome) return notDocumented(`${t.drug}: stopped ${t.stop} but no stated reason or outcome`);
    if (t.start > t.stop) return notDocumented(`${t.drug}: stop date ${t.stop} precedes start date ${t.start}`);
  }
  const name = (t: BioTrial) => (t.written.toLowerCase() === t.drug ? t.drug : `${t.written} (${t.drug})`);
  const value = real.map((t) => `${name(t)}: started ${t.start}, stopped ${t.stop}, outcome: ${t.outcome}`).join('; ');
  return drafted(value, uniq(real.flatMap((t) => t.cites)));
}

// ---------------------------------------------------------------- SMOKING

const SMOKE_TOPIC = /smok|tobacco|cigarette|\bcigars?\b|pack[- ]?years?|\bppd\b|nicotine/i;
const OFF_TOPIC = /\b(cannabis|marijuana|weed|vap(?:e|es|ed|ing)|e-?cig\w*|wildfire|exposure|exposed|second-?hand|passive|smoke detector|smoky|smoke-?free|nicotine (?:gum|patch|replacement|lozenge)|nrt|hookah|shisha|chew(?:ing)? tobacco|smokeless)\b/i;
const PAST_CONTEXT = /\b(previous(?:ly)?|prior|used to|formerly|in the past|until (?:quitting|then)|before quitting|history of|hx of|for \d+ years)\b/i;
const NOT_STATUS = /\b(advised|counsel+ed|encouraged|encourage|discussed|recommended|cessation|plans?|planning|trying|tries|tried|wants?|wishes|considering|thinking|will|going to|unable to|attempt\w*|ask(?:ed)? about|interested in|motivated|offered|referred|contemplat\w*|goal|screen\w*)\b/i;
const PACK_YEARS = /\d+(?:\.\d+)?\s*(?:pack[- ]?years?|py)\b(?:\s+(?:history|hx))?/gi;
const NEVER = /\b(never smoked|never[- ]smoker|lifelong non-?smoker|has never used tobacco|never used tobacco|no (?:history|hx) of (?:smoking|tobacco)|no (?:smoking|tobacco) (?:history|hx)|smoking(?: status| history| hx)?\s*:\s*never|tobacco(?: use)?\s*:\s*never)\b/i;
const NON_SMOKER = /\b(non-?smoker|denies (?:any )?(?:current )?(?:smoking|tobacco)|does not smoke|doesn't smoke|not a smoker|no tobacco(?: use)?|no smoking|smoking(?: status)?\s*:\s*(?:no|none|nil|denies)|tobacco(?: use)?\s*:\s*(?:no|none|nil|denies))\b/i;
const FORMER = /\b(quit|stopped|ceased|gave up|discontinued)\s+(?:smoking|tobacco|cigarettes?)|\bquit\b(?:\s+\w+){0,3}?\s+(?:in\s+)?(?:19|20)\d{2}\b|\b(?:former|ex-?|previous|past|reformed)\s*smoker|smoking(?: status| history| hx)?\s*:\s*(?:former|ex|quit|stopped)|tobacco(?: use)?\s*:\s*(?:former|ex|quit)|remote (?:smoking|tobacco) history|\bno longer smokes|\bquit\s+(?:\d+\s+)?(?:years?|months?|weeks?|days?)\s+ago|\bquit\b(?:\s+\w+){0,2}\s+(?:last|this) (?:year|month|week|spring|summer|fall|winter)/i;
const CURRENT = /\b(current(?:ly)?\s+smok\w*|smokes\b|smoking\s+\d|active smoker|daily smoker|social smoker|occasional smoker|heavy smoker|light smoker|(?<!non-)(?<!non )(?<!ex-)(?<!ex )(?<!former )(?<!never )(?<!previous )(?<!past )(?<!reformed )smoker|smoking(?: status)?\s*:\s*(?:current|yes|daily|active)|tobacco(?: use)?\s*:\s*(?:current|yes|daily|active)|\d+\s+cigarettes?\s+(?:per|a|\/)\s*day|\d+(?:\.\d+)?\s*(?:packs?|ppd)\b|half a pack|packs? (?:per|a) day|continues to smoke|still smok\w+|resumed smoking|relapsed|smoking again|back to smoking|ongoing (?:smoking|tobacco))\b/i;
const SMOKE_THIRD_PARTY = /\b(married to|around smokers?|works? (?:with|around)|co-?workers?|colleagues?|visitors?|guests?|tenants?|smokers in the (?:home|house))\b/i;
const PATTERNS: [string, RegExp][] = [['Never smoker', NEVER], ['Non-smoker', NON_SMOKER], ['Former smoker', FORMER], ['Current smoker', CURRENT]];

export function smoking(ctx: Ctx): Result {
  const dates = [...new Set(ctx.docs.map(d => d.date))].sort().reverse();
  for (const date of dates) {
    const results = ctx.docs.filter(d => d.date === date).map(d => smokingDocument({ ...ctx, docs: [d] }));
    const relevant = results.filter(r => r.status === 'DRAFTED' || !r.note?.startsWith('no explicit statement'));
    if (!relevant.length) continue;
    if (relevant.some(r => r.status !== 'DRAFTED')) return notDocumented(`unclear smoking statement on ${date}`);
    const labels = new Set(relevant.map(r => String(r.value).split(':')[0]));
    if (labels.size !== 1) return notDocumented(`conflicting smoking statements on ${date}`);
    return drafted(relevant[0].value, uniq(relevant.flatMap(r => r.citations)));
  }
  return notDocumented('no explicit statement about this patient\'s own smoking');
}

function smokingDocument(ctx: Ctx): Result {
  for (const doc of newestFirst(ctx.docs)) {
    const found: { label: string; clause: string }[] = [];
    let unclear: string | null = null;
    for (const s of sentences(doc.text)) {
      if (!SMOKE_TOPIC.test(s.text)) continue;
      for (const c of clauses(s.text)) {
        // A conjunction does not introduce a new patient subject by itself.
        if (THIRD_PARTY.test(s.text) && !/\b(patient|he|she|they)\b/i.test(c)) continue;
        const core = c.replace(PACK_YEARS, ' '); // pack-years describe the past, not the status
        if (!SMOKE_TOPIC.test(core) || THIRD_PARTY.test(c) || OFF_TOPIC.test(c)) continue;
        if (NOT_STATUS.test(c)) continue;
        if (PAST_CONTEXT.test(c) && !FORMER.test(core) && !NEVER.test(core)) continue; // "previously 1 ppd": history, not status
        if (isHedged(c)) { unclear = `hedged statement in ${doc.doc_id} ("${c}")`; continue; }
        if (SMOKE_THIRD_PARTY.test(c)) continue;
        const hit = PATTERNS.find(([, re]) => re.test(core));
        if (!hit) { unclear = `${doc.doc_id} talks about the patient's smoking in a way I cannot classify ("${c}")`; continue; }
        // A negated clause that is not one of the explicit "does not smoke" forms is unsafe.
        if (isNegated(core) && hit[0] !== 'Never smoker' && hit[0] !== 'Non-smoker') { unclear = `negated smoking clause in ${doc.doc_id} ("${c}")`; continue; }
        found.push({ label: hit[0], clause: c });
      }
    }
    if (!found.length && !unclear) continue; // nothing explicit here; look at older documents
    const labels = new Set(found.map((f) => f.label));
    if (unclear) return notDocumented(`the most recent smoking statement is unclear: ${unclear}`);
    if (labels.size !== 1) return notDocumented(`${doc.doc_id} gives conflicting smoking statements (${[...labels].join(' / ')})`);
    return drafted(`${found[0].label}: ${found.map((f) => f.clause).join('; ')}`, found.map((f) => cite(doc, f.clause)));
  }
  return notDocumented('no explicit statement about this patient\'s own smoking; statements about relatives or exposure do not count');
}

// ---------------------------------------------------------------- PHYSICIAN-ONLY

/** Never drafted. Offer the physician the most recent statements about control on high-dose ICS. */
export function controlEvidence(ctx: Ctx): Result {
  const re = /\b(poorly controlled|uncontrolled|inadequately controlled|not (?:well )?controlled|suboptimal(?:ly)? control\w*|remains symptomatic|persistent symptoms|high-?dose (?:inhaled corticosteroid|ics)|despite (?:high-?dose|maximal|optimal)|act score|exacerbations? despite|well controlled)\b/i;
  const cites: Citation[] = [];
  for (const doc of newestFirst(ctx.docs))
    for (const s of sentences(doc.text)) if (re.test(s.text) && cites.length < 3) cites.push(cite(doc, s.text));
  return needsPhysician(cites, cites.length
    ? 'physician-only judgement; the cited sentences are the most recent statements about asthma control on inhaled corticosteroid'
    : 'physician-only judgement; no statement about asthma control found to cite');
}
