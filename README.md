# Cited form drafter

```
npm install
npm run draft -- --chart chart-A --form form/F-DEMO-01.json --out out/chart-A.draft.json
npm run grade:a     # 24/24, 0 safety fails, 0 grounding fails
npm test            # 22 tests, incl. both charts end to end under the provided grader
npm run check       # drafts and grades chart A and my trap chart T
```

Offline, deterministic, no dependencies beyond TypeScript. Node 20+.

## Approach
**The form class decides what is allowed; an extractor only runs where the class permits drafting.** `OPINION_PHYSICIAN` and `PHYSICIAN_ENTERED` return `NEEDS_PHYSICIAN` before any extraction runs (the opinion field gets supporting quotes for the physician). Demographics read only `demographics.json`. An unknown class or field abstains.

**Each factual field has a small rule-based extractor that drafts only on a plain statement and abstains on anything else.** Shared rules:
- Quotes are exact substrings: sentences are split by offset, so `0.45` and `x10^9/L` stay whole.
- Negated, hedged ("possible", "?", "consider", "if") or third-party ("mother", "partner") statements never produce a value.
- Documents dated after the form date are excluded.
- If the most recent statement is unclear, the field abstains. It does not fall back to an older, clearer one, because "most recent governs" also applies to doubt.
- Zero is never the result of finding nothing.

**A final verifier re-checks every quote against its source and withdraws any draft that fails**, so a bug turns into a blank, not a wrong value. A crash in an extractor also abstains.

Field notes: eosinophils go by collection date (the first date after "collected/drawn"), and a later undated result blocks the draft. Steroid courses count one per document, only when that same document attributes it to an asthma exacerbation. Topical, inhaled, planned or declined steroids are excluded. Two "new" courses within 14 days, or a summary like "three courses this year", make the field abstain. Inhaled therapy replays lists, switches, starts and stops in date order, and abstains on any later inhaler mention it can't interpret. A prior biologic needs an explicit start, stop, both dates and an outcome; planned, declined or ongoing biologics don't count.

## Testing
`chart-T/` is a second synthetic chart I wrote with different wording and new traps: a wrong DOB in a note, an ED course plus a follow-up that references it, wildfire smoke, a topical hydrocortisone course, a newline-separated med list, a brand-name switch, a declined biologic, a relapse to smoking, a future-dated lab, written-out dates and `cells/uL`. Caveat: I wrote it after the code, so it's a regression check, not a blind test. The unit tests focus on abstention: each one plants a trap and asserts a blank, not a value.

## What fails on messier charts
- **Vocabulary is closed.** A diagnosis phrased without "impression/diagnosis/assessment", an unlisted inhaler brand, or a new steroid phrasing will abstain. That loses points but stays safe.
- **Negation is sentence-level.** "No wheeze; asthma exacerbation" is handled clause-by-clause only for smoking. Elsewhere, a negation anywhere in the sentence blocks it, which errs toward blanks.
- **Duplicate courses are detected by time proximity only**, not by matching drug and dose. Course dates stated inside a note, rather than the note's own date, aren't used.
- Free-text dates like "last spring" and numeric dates like 06/07/2026 are deliberately not parsed.
- Non-English text, OCR noise and tables are out of scope.

## What I'd do next
1. Collect real-world phrasing variants (synthetic) per field into a fixture corpus, and measure abstention rate separately from error rate.
2. Add an optional `--llm` mode that only *proposes* candidates (value plus quote), each one passed through the same verifier and class rules, so the model can widen recall but can never bypass grounding.
3. Use a proper negation scope (NegEx-style) instead of sentence-level checks.
4. Model medication events (start, stop, switch, dose) as one timeline shared by the inhaler, steroid and biologic fields.
5. Show the physician *why* a field abstained (for example "later undated eosinophil result in D11"), not just a blank.

## AI tools and hours
- **AI tools:** [Fill in honestly. For example: "Claude (Anthropic) generated most of the implementation, the trap chart and the tests from my direction; I reviewed the rules, checked traps against the grader, and ..."]
- **Hours:** [your actual time]
