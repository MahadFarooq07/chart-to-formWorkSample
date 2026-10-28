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
 * and at newlines. Abbreviations like "Dr." over-split, which only shortens a quote.
 */
export function sentences(text: string): Span[] {
  const out: Span[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const endsSentence = '.!?'.includes(c) && (i + 1 === text.length || /\s/.test(text[i + 1]));
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

/** Split a sentence into clauses on ; , and "but". Used where one sentence mixes subjects. */
export function clauses(sentence: string): string[] {
  return sentence
    .split(/;|,|\bbut\b/)
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
 * Full calendar dates only (day precision): 2026-06-28, 2026/06/28, June 28, 2026, 28 June 2026.
 * Ambiguous numeric forms like 06/07/2026 are deliberately not parsed.
 */
export function findDates(text: string): FoundDate[] {
  const out: FoundDate[] = [];
  const push = (y: number, m: number, d: number, index: number, raw: string) => {
    if (valid(y, m, d)) out.push({ iso: `${y}-${pad(m)}-${pad(d)}`, index, raw });
  };
  for (const m of text.matchAll(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/g)) push(+m[1], +m[2], +m[3], m.index!, m[0]);
  for (const m of text.matchAll(new RegExp(`\\b${MON}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi')))
    push(+m[3], MONTHS[m[1].toLowerCase().slice(0, 3)], +m[2], m.index!, m[0]);
  for (const m of text.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MON},?\\s+(\\d{4})\\b`, 'gi')))
    push(+m[3], MONTHS[m[2].toLowerCase().slice(0, 3)], +m[1], m.index!, m[0]);
  return out.sort((a, b) => a.index - b.index);
}

export function isIsoDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return !!m && valid(+m[1], +m[2], +m[3]);
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

/** Negation or hedging anywhere in the text. Used to refuse uncertain statements. */
export const NEGATION = /\b(no|not|never|without|denies|denied|negative for|ruled? out|r\/o|rather than|instead of)\b/i;
export const HEDGE = /\?|\b(possible|possibly|probable|probably|suspect(?:ed)?|query|questionable|likely|unlikely|consider(?:ing|ed)?|if|may|might|could|would|vs\.?|versus|uncertain|unclear|in question|doubt(?:ful)?|differential|to be confirmed|pending)\b/i;
export const THIRD_PARTY = /\b(mother|father|parents?|partner|spouse|wife|husband|roommates?|family|brother|sister|siblings?|son|daughter|household|friends?|co-?workers?|grand(?:mother|father|parent)s?|aunt|uncle)\b/i;
