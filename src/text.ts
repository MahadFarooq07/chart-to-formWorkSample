// Text helpers. Everything returned here is an exact substring of the source,
// so any quote built from it passes the verbatim check.

export interface Span { text: string; start: number }

/** Trim a span without losing its offset. */
function trimSpan(text: string, start: number): Span | null {
  const lead = text.length - text.trimStart().length;
  const t = text.trim();
  return t ? { text: t, start: start + lead } : null;
}

/**
 * Split into sentences at . ! ? followed by whitespace (so "0.45" and "x10^9/L" stay whole)
 * and at newlines. A list marker ("Impression: 1. Severe asthma") and dot leaders ("Eos .... 0.4")
 * are not boundaries. Abbreviations like "Dr." over-split, which only shortens a quote.
 */
export function sentences(text: string): Span[] {
  const out: Span[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    let endsSentence = '.!?'.includes(c) && (i + 1 === text.length || /\s/.test(text[i + 1]));
    if (endsSentence && c === '.') {
      const before = text.slice(start, i);
      const listMarker = /^\s*(?:\S.*:\s+)?\d{1,2}$/.test(before) && /^\s*[A-Za-z]/.test(text.slice(i + 1, i + 3));
      const dotLeader = text[i - 1] === '.';
      if (listMarker || dotLeader) endsSentence = false;
    }
    if (endsSentence || c === '\n') {
      const s = trimSpan(text.slice(start, endsSentence ? i + 1 : i), start);
      if (s) out.push(s);
      start = i + 1;
    }
  }
  const tail = trimSpan(text.slice(start), start);
  if (tail) out.push(tail);
  return out;
}

/** Split a sentence into clauses on ; , "but", "and", "while". Used where one sentence mixes subjects. */
export function clauses(sentence: string): string[] {
  return sentence
    .split(/;|,|\bbut\b|\band\b|\bwhile\b|\bwhereas\b/)
    .map((c) => c.trim().replace(/[.;,]+$/, '').trim())
    .filter((c) => c.length > 0 && sentence.includes(c));
}

/** Strip trailing sentence punctuation; result is still a substring. */
export function stripEnd(s: string): string {
  return s.trim().replace(/[.;,\s]+$/, '');
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const MON = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';

export interface FoundDate { iso: string; index: number; raw: string }

function pad(n: number): string { return String(n).padStart(2, '0'); }

function valid(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Full calendar dates only (day precision): 2026-06-28, 2026/06/28, June 28, 2026, 28 June 2026,
 * and numeric d/m/y or m/d/y only when one reading is impossible (28/06/2026). 06/07/2026 is ambiguous
 * and deliberately not parsed.
 */
export function findDates(text: string): FoundDate[] {
  const out: FoundDate[] = [];
  const push = (y: number, m: number, d: number, index: number, raw: string) => {
    if (valid(y, m, d)) out.push({ iso: `${y}-${pad(m)}-${pad(d)}`, index, raw });
  };
  for (const m of text.matchAll(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g)) push(+m[1], +m[2], +m[3], m.index!, m[0]);
  for (const m of text.matchAll(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/g)) {
    const a = +m[1], b = +m[2], y = +m[3];
    if (a > 12 && b <= 12) push(y, b, a, m.index!, m[0]);      // 28/06/2026
    else if (b > 12 && a <= 12) push(y, a, b, m.index!, m[0]); // 06/28/2026
  }
  for (const m of text.matchAll(new RegExp(`\\b${MON}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi')))
    push(+m[3], MONTHS[m[1].toLowerCase().slice(0, 3)], +m[2], m.index!, m[0]);
  for (const m of text.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MON},?\\s+(\\d{4})\\b`, 'gi')))
    push(+m[3], MONTHS[m[2].toLowerCase().slice(0, 3)], +m[1], m.index!, m[0]);
  return out.sort((a, b) => a.index - b.index);
}

/** Month-precision references ("January 2026", "Jan. 2026", "2026-01") as the first day of that month. */
export function findMonths(text: string): FoundDate[] {
  const out: FoundDate[] = [];
  for (const m of text.matchAll(new RegExp(`\\b${MON}\\s+(\\d{4})\\b`, 'gi')))
    out.push({ iso: `${m[2]}-${pad(MONTHS[m[1].toLowerCase().slice(0, 3)])}-01`, index: m.index!, raw: m[0] });
  for (const m of text.matchAll(/\b(\d{4})-(0[1-9]|1[0-2])\b(?!-\d)/g))
    out.push({ iso: `${m[1]}-${m[2]}-01`, index: m.index!, raw: m[0] });
  return out.sort((a, b) => a.index - b.index);
}

export function isIsoDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return !!m && valid(+m[1], +m[2], +m[3]);
}

/** Normalise a document date to ISO when it is written as one unambiguous calendar date. */
export function toIsoDate(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (isIsoDate(t)) return t;
  const d = findDates(t);
  return d.length === 1 && d[0].raw === t ? d[0].iso : null;
}

/** Shift an ISO date by whole months (clamped to month end). */
export function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${pad(nm)}-${pad(Math.min(d, last))}`;
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Replace calendar dates and month names with spaces (same length, so offsets hold).
 * Hedge and negation checks run on the masked text, so "May 20, 2024" is never read as the verb "may".
 */
export function maskDates(text: string): string {
  let out = text;
  for (const d of [...findDates(text), ...findMonths(text)])
    out = out.slice(0, d.index) + ' '.repeat(d.raw.length) + out.slice(d.index + d.raw.length);
  return out;
}

/** Negation or hedging anywhere in the text. Used to refuse uncertain statements. */
export const NEGATION = /\b(no|not|never|without|denies|denied|negative for|ruled? out|r\/o|rather than|instead of|nor)\b/i;
export const HEDGE = /\?|\b(possible|possibly|probable|probably|presumed|presumptive|suspect(?:ed)?|query|questionable|likely|unlikely|consider(?:ing|ed)?|if|may|might|could|would|vs\.?|versus|uncertain|unclear|in question|doubt(?:ful)?|differential|to be confirmed|pending|cannot exclude|unconfirmed|equivocal|borderline)\b/i;
export const THIRD_PARTY = /\b(mother|father|parents?|partner|spouse|wife|husband|roommates?|family|brother|sister|siblings?|son|daughter|household|friends?|co-?workers?|grand(?:mother|father|parent)s?|aunt|uncle|caregiver|lives? with|boyfriend|girlfriend|children|kids?|neighbou?rs?)\b/i;

export const isHedged = (s: string): boolean => HEDGE.test(maskDates(s));
export const isNegated = (s: string): boolean => NEGATION.test(maskDates(s));
