# AI Evals

Settle uses Claude Haiku to collect meal preferences in a private chat. The restaurant and time are chosen by code. We checked this description against main `5cf7951` on November 17, 2026.

## What we tested and why

- Recording time, budget, travel, diet, cuisine, restaurant style, named places, and notes. The optimizer only knows what the chat records.
- Distinguishing wishes from limits. “Dinner works best” should not mean “I cannot come at any other time.” Budget and travel limits carry more weight, but are not guarantees.
- Applying corrections without changing unrelated fields. Changing cuisine should not change someone's budget.
- Rejecting unrelated requests and prompt injection without losing real preferences in mixed messages.
- Returning valid data and avoiding repeated questions or misleading privacy statements.

## Test inputs

We have three fixture files under `tests/fixtures/`:

- `assistant-cases.json`: 23 cases, 28 turns. Preference strength, indirect answers, corrections, allergies, named places, and food terms.
- `off-topic-cases.json`: 23 requests to reject and 13 legitimate messages to accept. Includes instruction overrides, requests for other people's information, and mixed messages.
- `extract-cases.json`: 55 older cases covering clear and vague answers, corrections, other languages, multi-turn chats, and 16 adversarial cases. We compare 44 cases with fields shared by the old and new formats.

We wrote these within the team, with AI assistance. Five assistant cases came from errors found during evaluations and a local two-person walkthrough. We also ran a user test on November 16 by inviting two friends from outside the team, who each chatted with the assistant (`docs/user-tests/2026-11-16/`).

## Scoring

Run `npm run sim:extract -- --llm` with an Anthropic API key. The script calls the app's assistant function one message at a time and checks the saved state.

- Expected values and absent fields: ignore case and simple-list order; use substring checks for some notes.
- Off-topic behavior: check whether a message was refused and whether it changed the person's preferences.
- Violations: check empty replies, invalid state, repeated question tracking, and two misleading privacy phrases.
- Fallback: report which turns used Claude and which used the rule-based reader.

The current assistant suite has 59 state checks and four required reply patterns. The script adds a reply-pattern failure to the score only when it fails, so 59/59 with all four patterns matched is a complete pass. Real-model runs skip checks that prescribe the next question, since several questions can be valid.

We score the stored record because it determines the plan. Reply quality is only checked through the specific patterns and violation checks above; we do not use human ratings or an LLM judge. Unit tests use scripted model responses to check the code separately.

## First results

The first real-model report, `extract/report.json`, recorded on November 15:

- 23/23 off-topic requests rejected; 1/13 legitimate messages wrongly rejected.
- 54/60 assistant checks passed, across the original 18 cases; 14 cases fully correct.
- 103/120 comparable fields correct on the older cases.
- Two fallback turns across the suites; no detected violations.

Mistakes included treating “at least $50” as a ceiling, recording “does halal count?” as a dietary preference, and only partly applying a change of mind.

## Changes after testing

- #113: parse string-wrapped JSON; clarify corrections, mixed requests, questions, and budget floors; remove overly specific next-question expectations.
- #128: treat “dinner works best” as a wish; add privacy wording checks; move the private-number reminder into code after prompt changes failed to keep it limited to budget questions.
- #141: change budget and travel wording so the assistant does not promise strict caps that the optimizer may exceed.

The three `final-1` through `final-3` reports after #113 show:

- Off-topic rejection: 23/23 each time; false rejection: 0/13 each time.
- Assistant checks: 51/51, 51/51, and 49/51. The third run had one fallback turn and one case failed.
- Older fields: 110/120, 111/120, and 111/120. Mean 110.7, range 110–111.
- No detected violations in any of the three runs.

During later prompt edits, three runs recorded 5, 4, and 3 privacy-wording violations. That led to moving the budget reminder into code.

The latest report, `must/report.json`, was generated November 16 at 10:49 PM Pacific:

- 23/23 assistant cases correct, 59/59 state checks, all four reply patterns matched.
- 23/23 off-topic requests rejected; 0/13 legitimate messages wrongly rejected.
- 111/120 older fields correct; no fallback turns or detected violations.

These numbers were checked against the saved JSON reports. The latest report's assistant code, prompt, scoring script, and assistant/off-topic fixtures match the current main. The assistant suite changed between the first and latest runs, so their percentages are not a direct comparison.

## When is it good enough?

For this checkpoint, our target is a full pass of the current assistant suite, 23/23 off-topic rejections, no false rejections, no fallback calls, and no detected violations. The latest saved run meets that target.

We chose this bar because it covers the preference records used by the optimizer and the attacks we explicitly tested. It is enough for our checkpoint demo, not evidence that arbitrary conversations always work. Nine older-field mismatches remain, including old question-order assumptions, cuisine definitions, and budget/time interpretation errors. We still need outside-user inputs and repeated runs of the latest version. The eval is currently manual.
