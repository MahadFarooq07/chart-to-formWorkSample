# Submission results

What happened to the work sample after it was submitted, and what to carry into the next version.

## Timeline

| Date | Event |
|---|---|
| Oct 27, 2026 | Paul sends the kit: two-hour cap, due Nov 1 |
| Oct 28, 2026 | Submitted the 54-test version |
| Oct 28, 2026 | Paul's results (below); asks for the AI tools section, proposes an interview |
| Oct 29, 2026 | AI tools sent by email; interview set for Nov 3 |
| Nov 1, 2026 | Asked to move the interview to late next week |
| Nov 2, 2026 | Paul asks for times that week (finalizing interviews) |
| Nov 3, 2026 | Stepped back from the round |
| Nov 9, 2026 | Role offered to another candidate; Paul asks to keep details on file |

## Paul's results (Oct 28, 2026)

> All 54 tests pass and chart A scores 24/24, as you said. I also ran it on a second chart we keep back from candidates: it scored 22/24, with no unsafe values, and abstained correctly wherever it was unsure. The README is clear, and the --explain output made your one miss on that chart easy to trace.
>
> One thing is missing. The brief asked which AI coding tools you used and how.

He also said they'd walk through "the eosinophil rule" in the interview.

From the Nov 9 decision:

> Your work sample was among the strongest we received.

## What went well

- **Held-back chart: 22/24, 0 unsafe values.** The abstain-over-guess design held up on data the code had never seen. The one miss was a blank, not a wrong value.
- **Chart A: 24/24, all 54 tests passing**, reproduced on their side exactly as claimed.
- **`--explain` paid off.** Paul used it to trace the miss himself. Explaining why a field is blank was worth building.
- **The README was clear** and short enough to read.

## What went wrong

- **The AI tools section was missing.** The brief required it and Paul had to ask. Required sections go in before submitting, every time.
- **One field on the held-back chart came out blank.** Paul didn't say which one. Since the eosinophil rule was singled out for the interview, check that field first.
- **Scheduling cost the role.** Rescheduling on short notice during their final interview week, then stepping back, ended the process despite one of the strongest samples. Next time, protect the interview slot.

## Where the code is now

This repo is ahead of what was submitted:

| | Submitted (Oct 28) | Now |
|---|---|---|
| Tests | 54 | 88 |
| Chart A | 24/24 | 24/24 |
| Mock charts | 9 (one version) | 13, 302/312, 0 wrong values |
| Fixes since | | `<0.10` lab values, encounter diagnoses ("Dx: acute exacerbation"), "asthma flared", quit year kept, "first dose given", "d/c'd", relative's lab no longer blanks the patient's |

Next steps are in [TASKS.md](TASKS.md).
