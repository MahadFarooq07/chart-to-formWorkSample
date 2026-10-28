# Cited form drafter

```
npm install
npm run draft -- --chart chart-A --form form/F-DEMO-01.json --out out/chart-A.draft.json
npm run grade:a     # 24/24, 0 safety fails, 0 grounding fails
npm test            # 30 tests, incl. charts A, T and V end to end under the provided grader
npm run check       # drafts and grades chart A plus my two trap charts T and V
npm run explain -- --chart chart-A --form form/F-DEMO-01.json --out out/chart-A.draft.json   # same output + why each blank is blank
```

Offline, deterministic, no dependencies beyond TypeScript. Node 20+. Output shape is exactly the kit's; `--explain` adds a `note` per field and prints a one-line summary.

## Approach
**The form class decides what is allowed; an extractor only runs where the class permits drafting.** `OPINION_PHYSICIAN` and `PHYSICIAN_ENTERED` return `NEEDS_PHYSICIAN` before any extraction (the opinion field still gets supporting quotes for the physician). Demographics read only `demographics.json`. An unknown class or field abstains.

**Each factual field has a small rule-based extractor that drafts only on a plain statement and abstains on anything else**, with a reason attached. Shared rules:
- Quotes are exact substrings: sentences are split by offset, so `0.45`, `x10^9/L`, `07:40` and numbered lists (`Impression: 1. Severe asthma`) stay whole.
- Negated, hedged ("possible", "?", "consider", "if") or third-party ("mother", "partner", "married to") statements never produce a value. Hedge checks run on date-masked text, so "May 20, 2024" is a date, not a hedge.
- Documents dated after the form date, undated, or with unreadable text are excluded.
- If the most recent statement is unclear, the field abstains. It does not fall back to an older, clearer one, because "most recent governs" also applies to doubt. The one exception: an older, more specific phrase ("severe eosinophilic asthma") is kept when the newer one is just its generic form ("asthma, stable").
- Zero and false are never the result of finding nothing.

**A final verifier re-checks every quote against its source and withdraws any draft that fails**, so a bug becomes a blank, not a wrong value. A crash in an extractor also abstains.

Field notes: eosinophils go by collection date (the first date after "collected/drawn/specimen"), and a later undated result blocks the draft. Steroid courses count one per document, only when that document attributes it to an asthma flare; topical, inhaled, planned, declined, chronic and "continuing/finishing" mentions are excluded, and a back-reference ("required prednisone in April") must match a dated course or the field abstains. Two new courses within 14 days, or a summary like "her third course this year", also abstain. Inhaled therapy replays lists, switches, starts, stops and "continues X" in date order and abstains on any inhaler mention it can't interpret, including an unknown brand carrying an ICS/LABA-style dose. A prior biologic needs an explicit start, stop, both dates and an outcome; planned, declined, ongoing, restarted or non-asthma biologics don't count. Smoking takes the newest explicit statement about the patient; pack-years and "previously 1 ppd" are history, not status.

## Testing
`chart-T/` and `chart-V/` are synthetic charts I wrote with different wording and new traps: a wrong DOB in a note, an ED course plus follow-ups that reference it ("Finishing prednisone today"), "acute asthma" instead of "exacerbation", wildfire smoke, a topical hydrocortisone course, newline and dot-leader med lists and lab tables, brand names (Xolair, Breo, Symbicort), written dates, `cells/uL` and `×10⁹/L`, a declined biologic, "for lack of response", a relapse to smoking, pack-years, a future-dated document. Caveat: I wrote them after the code, so they're regression checks, not blind tests. The unit tests focus on abstention: most plant a trap and assert a blank, not a value. I also ran ~60 one-line adversarial scenarios per field while developing; the ones that mattered became tests.

## What fails on messier charts
- **Vocabulary is closed.** A diagnosis phrased without "impression/diagnosis/assessment", an inhaler brand I don't list and that carries no dose pair, or a new steroid phrasing will abstain. That loses points but stays safe.
- **Negation is clause-level for smoking and diagnosis, sentence-level elsewhere.** Elsewhere a negation anywhere in the sentence blocks it, which errs toward blanks.
- **Duplicate courses are detected by time proximity**, not by matching drug and dose. A course dated inside a note counts as historical, not as its own event.
- Ambiguous numeric dates (06/07/2026), "last spring", non-English text, OCR noise and multi-column tables are deliberately not parsed.

## What I'd do next
1. A fixture corpus of phrasing variants per field, measuring abstention rate separately from error rate, so recall can be widened one rule at a time.
2. An optional `--llm` mode that only *proposes* candidates (value plus quote), each passed through the same verifier and class rules, so a model can widen recall but never bypass grounding.
3. A proper negation scope (NegEx-style) in place of sentence-level checks.
4. One medication timeline (start, stop, switch, dose) shared by the inhaler, steroid and biologic fields.
5. Surface the `--explain` reasons to the physician in the form UI, next to each blank.

## AI tools and hours
- **AI tools:** I used AI coding assistants (Claude via Replit Agent) heavily. They generated most of the implementation, the trap charts and the tests from my direction; I decided the rules (abstain over guess, most-recent-governs, class gating, the verifier), reviewed each extractor, and checked the traps against the grader. Where a generated rule drafted a value I wasn't sure of, I made it abstain instead.
- **Hours:** [YOUR ACTUAL HOURS]
