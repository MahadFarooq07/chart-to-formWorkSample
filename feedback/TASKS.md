# Tasks

Work for the next version. Rule for every task: **a blank is acceptable, a wrong value is not.** No change ships if it adds a wrong or unsafe value on any chart.

## Ground rules

- Kit files stay byte-identical: `grader/grade.mjs`, `form/F-DEMO-01.json`, `chart-A/*`, `expected/chart-A.expected.json`.
- Before every commit: `npm test` (all pass), `npm run check` (A, T, V at 24/24), `npm run stress` (0 wrong or unsafe).
- Keep the code small. Prefer one general rule over five phrase-specific ones. If a fix needs more than ~10 lines, question it first.

## 1. Find the held-back miss (highest value)

Paul's chart scored 22/24 with one blank. We don't know which field.

- [ ] For each field, write 2–3 phrasings of the *same* fact that chart A doesn't use, then run them with `--explain`. Start with `blood_eosinophils_most_recent`, since Paul singled out that rule.
- [ ] Any phrasing that blanks a clearly stated fact is a candidate. Fix only if the fix can't create a wrong value elsewhere.

## 2. Independent test charts

Every chart in `stress/` was written by someone who had seen the code, so none of them are blind.

- [ ] Get 3+ charts written from the kit README alone, by someone (or a fresh session) that has never seen `src/`. Add them as `stress/charts/D*`.
- [ ] Before fixing anything they expose, check the answer key itself; the author can be wrong too.

## 3. Known blanks (safe today, worth a look)

Each of these currently abstains. Only fix it if the rule stays simple.

| Field | Phrasing that blanks | Chart |
|---|---|---|
| Inhaled therapy | "Advair changed to Symbicort 200/6" (no "from") | C4-sneaky |
| Inhaled therapy | "high-dose ICS/LABA/LAMA" in a letter after the med list (class names read as drugs) | C3-one-letter |
| Inhaled therapy | Run-on dictation that also says "no ED visits" | B7-dictation |
| Prior biologic | Stop date in a separate sentence with no drug name ("Stopped 2025-04-01 due to…") | C4-sneaky |
| Smoking | "Quit smoking 2 weeks ago; using nicotine patch" | C4-sneaky |
| Eosinophils | Amended report alongside the original for the same collection date | B8 (now passing; re-check) |

## 4. Simplify

- [ ] `src/fields.ts` is the bulk of the code. List every regex vocabulary (drugs, verbs, hedges, third parties) in one place at the top.
- [ ] Remove any rule no test or chart exercises. Delete it, run everything, keep the deletion if nothing changes.
- [ ] Add a one-line comment above each field's extractor stating its rule in plain English.

## 5. README

- [ ] Add the AI tools section (which tools, what each did, what you decided and checked yourself). This was the one gap Paul flagged.
- [ ] Add the held-back result: 22/24 with 0 unsafe values, from Paul's run.
- [ ] Keep it to one page.

## 6. Be ready to explain it

If Prometheus reaches out again, or for any interview where this comes up:

- [ ] The eosinophil rule: collection date beats report date; an undated later result blocks the draft; a `<0.10` result keeps its comparator.
- [ ] Why the steroid count abstains (two courses within 14 days, summary counts, mixed indications).
- [ ] The final verifier: every quote is re-checked against its source, and a failed check withdraws the draft.
- [ ] Two bugs found by testing: "since age 6. Patient smokes" merging sentences (wrong smoking status), and `<0.10` being skipped (wrong lab value).
