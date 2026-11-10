# Handoff: cited form drafter

Everything needed to pick this project up cold: what it is, how it works, where it stands, and what to do next.

Last updated: November 9, 2026

---

## 1. The short version

- **What it is:** a TypeScript CLI that reads a synthetic patient chart and drafts a medical form. Every value it fills is backed by a verbatim quote from the chart; anything it can't support, it leaves blank on purpose.
- **Why it exists:** it was the paid work sample for Prometheus Health Systems' Software Engineering Co-op (Jan to Apr 2027).
- **How it did:** 24/24 on the supplied chart; **22/24 with zero unsafe values on Prometheus's held-back chart**; described as "among the strongest we received".
- **Outcome:** the interview didn't happen (scheduling), and the role went to another candidate on Nov 9, 2026. Paul Theron (founder) asked to keep the details on file for future terms.
- **State of the code:** ahead of what was submitted. 88 tests pass, 0 wrong values on 13 mock charts. The next work is in section 9.

---

## 2. Background

### The company

**Prometheus Health Systems Inc.** is a physician-founded startup piloting with BC clinics. Its product, **Prometheus Codex**, drafts insurance and government medical forms from a patient's chart. Every factual field cites its source, judgment calls are left to the physician, and the physician reviews and signs.

### The role

| | |
|---|---|
| Title | Software Engineering Co-op: Clinical Forms Platform |
| Term | January to April 2027, 16 weeks |
| Pay | $25/hour |
| Location | Remote from Ontario, a few hours of Pacific-time overlap |
| Work | Onboard new forms (field mapping, drafting rules, tests, filled samples); build v1 of a Chrome (MV3) extension that sends chart documents to Codex |
| Stack | TypeScript, Node, PostgreSQL |
| Contact | Dr. Paul Theron, Founder and CEO, info@prometheushealthsystems.com |

### Timeline

| Date (2026) | Event |
|---|---|
| Oct 26 | Cold email to Paul (via the Venture for Canada posting) |
| Oct 27 | Paul replies: ApplyAgents "is close to something we're building"; sends the kit, two-hour cap, due Nov 1 |
| Oct 28 | Submitted (54 tests, chart A 24/24) |
| Oct 28 | Paul's results: held-back chart 22/24, no unsafe values; asks for the AI tools section; proposes a 45-minute interview including a walk-through of "the eosinophil rule" |
| Oct 29 | AI tools sent by email; interview booked for Nov 3, 10:30 ET |
| Nov 1 | Asked to move the interview to late the following week |
| Nov 2 | Paul asks for times that week (he was finalizing interviews) |
| Nov 3 | Stepped back from the round |
| Nov 9 | Role offered to another candidate; Paul asks to keep details on file |

---

## 3. The task (from the kit)

**Input:** a fictional form plus a synthetic chart.
**Output:** one JSON draft. Every form field gets one status:

| Status | Meaning |
|---|---|
| `DRAFTED` | A value plus at least one verbatim quote from the chart |
| `NEEDS_PHYSICIAN` | Only the physician may fill this; never drafted |
| `NOT_DOCUMENTED` | The chart doesn't support a value; left blank on purpose |

### The form: `F-DEMO-01`

A fictional Special Authority request for "Drug Z" (severe asthma). Form date **2026-11-15**. Twelve fields:

| Field | Class | What it needs |
|---|---|---|
| `patient_name` | DEMOGRAPHIC | Last, First |
| `phn` | DEMOGRAPHIC | Personal Health Number |
| `date_of_birth` | DEMOGRAPHIC | YYYY-MM-DD |
| `diagnosis` | FACTUAL_CITED | The asthma diagnosis; most recent statement governs |
| `respirologist_confirmed_within_24_months` | COMPUTED_CITED | Boolean |
| `blood_eosinophils_most_recent` | VERBATIM_DATED | Value as written, with unit and collection date |
| `systemic_steroid_courses_past_12_months` | COMPUTED_CITED | Integer, asthma courses only |
| `current_inhaled_therapy` | FACTUAL_CITED | Drug and dose |
| `prior_biologic_trial` | FACTUAL_CITED | Drug, start, stop, outcome |
| `smoking_status` | SENSITIVE_EXPLICIT_ONLY | Only from an explicit statement about this patient |
| `inadequate_control_despite_high_dose_ics` | OPINION_PHYSICIAN | Never fill |
| `requested_dose_regimen` | PHYSICIAN_ENTERED | Never fill |

### Class rules

| Class | Rule |
|---|---|
| DEMOGRAPHIC | Only from `demographics.json`, never from notes. Cite `doc_id: "demographics"`, quote `"key: value"`. |
| FACTUAL_CITED | A fact a dated document states. Most recent document governs. |
| VERBATIM_DATED | Copy exactly, with unit and **collection** date (not report date). |
| COMPUTED_CITED | Compute in code; fill `computation` with the rule and cited inputs. Count only events the document itself attributes to the right cause. |
| SENSITIVE_EXPLICIT_ONLY | Explicit statement about this patient only. |
| OPINION_PHYSICIAN / PHYSICIAN_ENTERED | Never fill. |

Global rules: quotes must match character for character; never infer from absence (no `0`, `false` or "none" because nothing was found); abstain when unsure; default mode runs offline with no API key.

### Scoring (the supplied grader)

| Outcome | Points |
|---|---|
| Correct value, grounded citation | +2 |
| Correct value, bad or missing citation | +1 |
| Honest blank | 0 |
| Wrong value | -2 |
| Drafting a physician-only field, or drafting where the answer is NOT_DOCUMENTED | -3 (safety fail) |

They also run the code unchanged on a held-back chart with different wording and different traps. **This is why the whole design favours blanks over guesses.**

### The traps in chart A

| Trap | Correct handling |
|---|---|
| A wrong PHN in note A11 | Demographics come only from `demographics.json` |
| A prednisone course for gout (A07) | Not asthma, so not counted |
| An asthma course on 2025-10-30 (A04) | Outside the 12-month window |
| A reprinted lab (A10) with a newer report date but older collection date | Most recent is 0.45, collected 2026-06-28 |
| Montelukast; old fluticasone 250 | Oral / superseded; current is fluticasone/salmeterol 500/50 |
| "Mother still smokes" | About the mother; patient quit in 2019 |
| A 2024 respirologist diagnosis | Outside 24 months; the 2026-01-20 reconfirmation counts |
| "Plan: trial of omalizumab" | A plan, not a trial; the real trial is in A03 |

---

## 4. Running it

```sh
npm ci
npm test          # 88 tests
npm run check     # drafts and grades charts A, T, V (each must be 24/24)
npm run stress    # grades the 13 mock charts; exits 1 on any wrong value
npm run draft -- --chart chart-A --form form/F-DEMO-01.json --out out/chart-A.draft.json
npm run explain -- --chart chart-A --form form/F-DEMO-01.json --out out/chart-A.draft.json
```

`--explain` adds a `note` to every field saying why it was drafted or left blank. Default output (no flag) matches the kit's schema exactly. Node 20+.

---

## 5. Repo layout

```
src/
  draft.ts            CLI, input validation, class gate, final verifier
  fields.ts           one extractor per field (all the rules live here)
  text.ts             sentence splitting, date parsing, hedge/negation/third-party patterns
  types.ts            shared types and result constructors
  draft.test.ts       core tests: rules, traps, charts end to end
  edge-cases.test.ts  malformed input, ID collisions, conflicts, relatives
  fixtures.test.ts    reference fixtures B and C plus targeted checks
  stress.test.ts      runs every stress chart; fails on any wrong value
scripts/
  check.mjs           grade every chart that has an expected file
  stress.mjs          grade every stress chart, print !! (wrong) vs .. (blank)
chart-A/              KIT: supplied chart
chart-T/, chart-V/    extra trap charts written for this project
expected/             KIT: chart-A answers; plus T and V answers
fixtures/             reference charts B and C, each with expected.json
stress/charts/        13 mock charts (B1-B8, C1-C4, X-hand)
stress/expected/      their answer keys
form/                 KIT: F-DEMO-01.json
grader/               KIT: grade.mjs
feedback/             submission results and task list
```

**KIT files must stay byte-identical to the original kit:** `grader/grade.mjs`, `form/F-DEMO-01.json`, `chart-A/*`, `expected/chart-A.expected.json`. They were accidentally edited twice during development; always diff them against the original kit before shipping.

---

## 6. How it works

### Pipeline (`src/draft.ts`)

1. **Validate input.** Malformed form, documents or demographics throw. An invalid form date, or duplicate or reserved document IDs, makes every factual field abstain (citations would be ambiguous).
2. **Filter documents.** Keep documents with a valid date on or before the form date, sorted oldest first. Future-dated and undated documents are dropped.
3. **Class gate.** The field's class decides what may happen *before* any extraction:
   - `PHYSICIAN_ENTERED`: always `NEEDS_PHYSICIAN`.
   - `OPINION_PHYSICIAN`: always `NEEDS_PHYSICIAN`, with supporting quotes offered to the physician.
   - `DEMOGRAPHIC`: read only from demographics.
   - Factual classes: run the field's extractor; an unknown field or class abstains.
4. **Extract.** Each extractor drafts only on a plain statement and returns `NOT_DOCUMENTED` with a reason otherwise. A crash also abstains.
5. **Verify (last line of defence).** Every draft is re-checked: the value matches the answer type; every quote appears verbatim in its source; the citation source fits the class (demographics only for demographic fields); computed fields carry a rule and inputs. Any failure withdraws the draft to `NOT_DOCUMENTED`. A bug becomes a blank, never a wrong value.

### Shared text rules (`src/text.ts`)

- Sentences are split by character offset, so every quote is an exact substring. Decimals and units (`0.45`, `x10^9/L`) stay whole. A small number before a period ("age 6.") is a sentence boundary unless it's a list marker after a colon ("Impression: 1.").
- Dates parse in ISO, `June 28, 2026` and `28 June 2026` forms. Ambiguous numeric dates (`06/07/2026`) are deliberately not parsed.
- Negation, hedging ("possible", "?", "consider", "if") and third-party words ("mother", "partner", "sister") block a statement from producing a value.

### Field rules (`src/fields.ts`)

| Field | Drafts when | Abstains when |
|---|---|---|
| Demographics | Key present in demographics (supports `last_name`/`first_name` split, DOB normalised to ISO) | Missing, empty, or ambiguous date format |
| Diagnosis | Most recent diagnostic statement (impression, diagnosis, assessment, dx, confirmed) names asthma | Latest statement is hedged, negated, about a relative, or a competing diagnosis appears later. Encounter diagnoses ("Dx: acute exacerbation of asthma") are not the condition |
| Respirologist confirmed | A respirologist-authored document within 24 months states the asthma diagnosis | None found (never returns `false` from absence), or the latest one is hedged |
| Eosinophils | Most recent result by **collection** date (the first date after "collected/drawn/specimen"); keeps comparators like `<0.10` | A later result with no collection date; two values on the same collection date; sputum or other non-blood samples are ignored; a relative's result is skipped |
| Steroid courses | Count of documents in the 12-month window that record a new systemic course *and* attribute it to an asthma flare in the same document | Planned, declined or unfilled courses are excluded; topical, inhaled and joint injections excluded; other indications (gout, eczema) excluded; a summary count ("three courses this year") or two courses within 14 days abstains; zero found abstains |
| Inhaled therapy | Replays medication lists, switches, starts, stops and dose changes in date order; the latest full list replaces earlier state | An inhaler mention after the last list that can't be interpreted; an inhaler without a dose; nasal and oral drugs never count |
| Prior biologic | Each trial has an explicit start and stop (with dates) and an outcome | Planned, declined, ongoing, restarted, or for a non-asthma indication (e.g. dupilumab for eczema) |
| Smoking | The most recent explicit statement about this patient (never, former with quit year, current) | Statements about others, cannabis or vaping, advice or plans ("plans to quit"), or conflicting statements on the same day |
| Control (opinion) | Never drafted; offers up to 3 recent supporting quotes | n/a |

---

## 7. Testing

| Suite | What it proves |
|---|---|
| `npm test` (88) | Rules, traps and edge cases; charts A, T, V at 24/24; fixtures B and C at 24/24; every stress chart has **zero wrong values** (blanks allowed) |
| `npm run check` | Charts A, T and V each 24/24 under the kit grader |
| `npm run stress` | 13 mock charts: 302/312, 0 wrong or unsafe. `!!` lines are bugs, `..` lines are safe blanks |

### Mock charts

| Chart | Tests |
|---|---|
| B1-shorthand | SOAP notes, abbreviations ("D/C on pred", "d/c'd"), ED encounter diagnosis, bullet med list, window boundary |
| B2-letters | Narrative letters, written dates, Xolair, split first/last name, chronic steroid for another condition |
| B3-sparse | Almost nothing documented; every factual field must be blank |
| B4-recency | Dose increase, newer lower lab, relapse then quit, single-dose dexamethasone |
| B5-tables | Lab and med tables, problem list, a letter repeating dated courses, cannabis, PHN typo in a lab |
| B6-attribution | Biologic for eczema, sister's lab, sputum eosinophils, knee injection, wrong specialist, future ED note |
| B7-dictation | Lowercase run-on dictation, "pulmonologist" role |
| B8-boundaries | Amended lab, events one day outside windows, unfamiliar inhaler brand |
| C1-discharge | Discharge summary, walk-in note, nasal spray in med list |
| C2-ongoing | Ongoing biologic, unprescribed steroid, `<0.10` lab result |
| C3-one-letter | Everything in one consult letter, wrong PHN in header |
| C4-sneaky | Unfilled prescription, back-reference, "changed to", quit 2 weeks ago |
| X-hand | Mixed phrasings, brand/generic biologic, dot-leader lab table |

**Caveat:** every mock chart was written by someone who had seen the code, so they're regression tests, not blind tests. Prometheus's held-back chart is the only true blind result (22/24).

---

## 8. History

### Versions

| Version | Key change |
|---|---|
| v1 | Rule-based extractors, class gate, quote verifier, chart T; 22 tests |
| v2 | `--explain`, chart V, broader parsing (dot-leader labs, more date forms) |
| v3 | Fixed sentence merge on trailing numbers; biologic dates after the dose |
| v4 | Input validation, impossible-date checks, third-party checks narrowed to the relevant sentence |
| v5 (submitted, 54 tests) | Relatives in med-list headings; social history no longer wipes a med list |
| current (88 tests) | Stress pack; fixes for `<0.10`, encounter diagnoses, "asthma flared", quit year, "first dose given", "d/c'd", relative's lab |

### Bugs that produced wrong values (all fixed, all tested)

These are the important ones: each would have cost -2 on the grader.

1. **"Brother has had asthma since age 6. Patient smokes 10 cigarettes a day."** The "6." looked like a list number, so the two sentences merged, the whole thing was discarded as being about the brother, and the output fell back to an older note: **"Former smoker" for a current smoker.**
2. **`Eosinophils <0.10 x10^9/L`.** The `<` wasn't recognised, so the result was skipped and an older 0.70 was reported as most recent.
3. **"Dx: acute exacerbation of asthma"** (ED note) was reported as the patient's diagnosis instead of "severe eosinophilic asthma".
4. **"Her asthma flared again"** wasn't recognised as an asthma flare, so the steroid count came out 1 instead of 2.
5. **"ex-smoker, quit 2015"** dropped the quit year; chart A's own answer key requires it.

---

## 9. What's next

Rule for every change: **a blank is acceptable, a wrong value is not.** Run `npm test`, `npm run check` and `npm run stress` before every commit.

1. **Find the held-back miss.** Paul didn't say which field blanked. Start with eosinophils (he singled out that rule). Write new phrasings of the same facts, run with `--explain`, fix only what can't create a wrong value elsewhere.
2. **Get blind test charts.** Have someone who has never seen `src/` write 3+ charts from the kit README alone. Add them as `stress/charts/D*`. Check their answer keys before fixing anything.
3. **Known safe blanks** (fix only if the rule stays simple):
   - "Advair changed to Symbicort 200/6" (no "from"), C4
   - "high-dose ICS/LABA/LAMA" in a letter after the med list, C3
   - run-on dictation containing "no ED visits", B7
   - a biologic stop date in a sentence without the drug name, C4
   - "Quit smoking 2 weeks ago; using nicotine patch", C4
4. **Simplify `fields.ts`** (669 lines). Gather vocabularies at the top, delete rules nothing exercises, add a plain-English rule comment above each extractor.
5. **README.** Add the AI tools section (Paul's one flagged gap) and the held-back result. Keep it to one page.

---

## 10. Gotchas

- **Kit files.** Never edit `grader/grade.mjs`, `form/`, `chart-A/` or `expected/chart-A.expected.json`.
- **Node 22.** The kit's original test script (`node --test dist/`) fails on Node 22; this repo lists test files explicitly.
- **Line endings.** Some zips came back with Windows (CRLF) line endings. Normalise to LF before diffing.
- **Repo URL.** GitHub moved the repo to `MahadFarooq07/chart-to-formWorkSample` (capital letters). Update any old remotes.
- **Commits.** Authored as Mahad Farooq, with no co-author or attribution trailers.
- **Synthetic data only.** No real patient data, ever.
