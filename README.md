# Cited form drafter

Offline, deterministic TypeScript CLI for the supplied synthetic form; Node 20+.

```sh
npm ci
npm test
npm run grade:a
npm run check
npm run stress
npm run draft -- --chart chart-A --form form/F-DEMO-01.json --out out/chart-A.draft.json
```

Add `--explain` to the draft command for abstention reasons. Default output follows the supplied schema. Grading commands regenerate drafts.

**Approach.** I chose field-class gates and conservative rules: physician-only fields stay `NEEDS_PHYSICIAN`, demographics come only from the demographics file, and unsupported facts become `NOT_DOCUMENTED`. The rules use collection dates for labs, replay medication changes, and compute steroid counts from attributed events. Quotes preserve source characters. The final verifier checks citations and computation inputs, but matching a quote does not prove its meaning supports the answer. Drafting runs without a network or API key.

**Tests.** The suite has 88 passing tests, including charts A, T and V, each scoring 24/24 with zero reported safety or grounding failures. It covers sentence boundaries after numbers, biologic dose/date wording, uncertain or third-party evidence, impossible dates, same-day smoking conflicts, missing inhaler doses and malformed inputs. Medication-list checks preserve subject information in headings and exclude unrelated social-history sentences. These are regression results, not proof of hidden-chart performance. The supplied form, chart A, expected answers and grader are unchanged.

**Reference checks.** Both reference fixtures in `fixtures/` score 24/24 and run in `npm test`. Additional checks cover explicit confirmation dates, nasal-route exclusion, stopping/restarting inhalers, continuing discharge courses, answer types and citation-source boundaries.

**Mock charts.** Thirteen mock charts in `stress/` score 302/312 with zero wrong, unsafe or ungrounded findings; every lost point is a blank, not a wrong value. `npm test` fails on any wrong value but allows blanks. These charts informed fixes, so they are regression fixtures, not blind validation. Run `npm run stress` to reproduce the scores.

**Limitations and next steps.** Regex vocabulary, subject attribution and negation scope are incomplete. Same-day medication ordering, historical diagnosis specificity and steroid-course deduplication remain heuristic. Conservative checks sometimes discard valid evidence; missing chart events cannot be recovered. Next steps would be independent fixtures, explicit subject and temporal models, and separate measurement of wrong answers and abstentions.
