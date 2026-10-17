---
description: Drive VTC, the local multi-agent software delivery engine (start, continue, status, escalations, change, advise, pause, resume, cancel).
argument-hint: start "<idea>" | continue | status | escalations | change "<what and why>" | advise "<question>" | pause | resume | cancel
---

Use the `lead` skill to act on this VTC request: $ARGUMENTS

- `start "<idea>"`: classify the request, confirm the track with the user, call the engine's
  `start`, then run the Lead loop.
- `continue` or no argument: run the Lead loop from `next`.
- `status`: call `status` and summarise it in a few lines.
- `escalations`: call `escalations` and present the open items together.
- `change "<what and why>"`: open a change request with `change_request`, as the Lead skill says.
- `advise "<question>"`: pick the advisor whose kind of help the question needs, tell the user
  which one and that it counts against the run's advisor budget, then call `consult` as the Lead
  skill's Advisors section says.
- `pause` or `resume`: call the engine tool of that name and report the result.
- `cancel`: end the active run for good, as the Lead skill's "Status, pause and resume" says:
  name the run and its request, ask the human to confirm in this chat, then call `cancel`.
