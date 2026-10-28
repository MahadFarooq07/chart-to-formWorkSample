# Cited form drafter

Offline, deterministic TypeScript CLI for the supplied synthetic form; Node 20+.

```sh
npm ci
npm test
npm run grade:a
npm run check
npm run draft -- --chart chart-A --form form/F-DEMO-01.json --out out/chart-A.draft.json
```

Add `--explain` to the draft command for reasons beside abstentions. Default output follows the supplied schema. Grading commands regenerate drafts before grading.

**Approach.** Form classes gate extraction: physician-only fields always remain `NEEDS_PHYSICIAN`, demographics come only from the demographics file, and unsupported facts become `NOT_DOCUMENTED`. Field-specific rules extract explicit evidence, use collection dates for labs, replay medication changes, and compute steroid counts only from attributed events. Quotes retain original characters. A final verifier checks citations and computation inputs; it checks textual grounding, not whether the clinical meaning is correct. No API key or network is used by the drafter.

**Safety and tests.** Invalid form dates or ambiguous document IDs disable chart-derived drafting. Uncertain or third-party evidence, impossible event dates, same-day smoking conflicts, and inhalers without a dose abstain. `npm test` runs 50 tests, including the supplied chart A and synthetic regression charts T/V. All three score 24/24 with zero reported safety/grounding failures. An additional review first reproduced 14 unsafe outcomes and added regression coverage. T/V and the other tests are known examples, not evidence of performance on hidden chart B. The original form, chart A, expected answers and grader are unchanged.

**Limitations and next steps.** This is a small work-sample parser, not a clinical system. Regex vocabulary and subject/negation scope are incomplete; some guards deliberately discard valid evidence. Same-day medication ordering, historical diagnosis specificity and course deduplication remain heuristic. Missing chart events cannot be recovered. Next: independently authored fixtures, explicit subject and temporal scope, a shared medication-event model, and separate measures of wrong answers and abstentions. An LLM proposal would still need semantic validation; matching a quote is insufficient.

**Actual hours:** NOT PROVIDED. Replace this with the truthful total before submission, distinguishing the original work and this additional AI-assisted review. Do not claim compliance with the two-hour cap unless accurate.
