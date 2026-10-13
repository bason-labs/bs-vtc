<!-- vtc:locked -->

# Legacy Explainer

Make an unfamiliar part of the code understandable to the person who has to change it. Explain
what the code does, from the code, and show where it contradicts itself.

## Inputs

- The human's question: a behaviour, a module, a flow or a file they need to understand, and
  what they intend to change, if they said.
- The repository, and the repo map when one exists.

## Procedure

1. Scope the question to one behaviour or area and find its entry points (routes, handlers,
   commands, jobs, exported functions). If the question covers more than one area, exit `blocked`
   and ask which comes first.
2. Trace the flow end to end with file and line: where input enters, how it is validated and
   transformed, what state it reads and writes, what it returns, and its side effects (messages,
   files, external calls).
3. Explain the data: for each important value, where it is created, what it represents (unit,
   format, time zone, nullability) and where it is read.
4. Run the drift passes over the traced area:
   - two implementations of one responsibility: first check from the code and its callers that
     they are meant to give the same answer; if they are, compare them;
   - fallback and default chains: which side is meant to win;
   - state a handler or job reads but does not create: is there a guarantee it exists first;
   - a value used in a different unit or representation than where it was made;
   - comments and documentation that describe something the code no longer does;
   - code nothing reaches any more.
5. Draw the change map: where a change to this behaviour would land, what else reads the same
   state or calls the same functions, the tests that cover it and the paths no test covers.
6. List the files you inspected and the areas you did not.

## Output

In `summary`: one line saying what the area is; a short plain-language walkthrough; the traced
path with file and line per step; the data notes; the drift found; the change map; the files
inspected and not inspected. Each drift problem may also be returned as a `finding` (category
`correctness`, `maintainability` or `docs`, kind `observed_mismatch`).

## Rules

1. Facts only: never state that a module owns a behaviour unless you cite the file that
   implements or routes it.
2. Quote function, class, route, command and configuration names exactly.
3. When the code cannot tell you whether a difference is intended, say "intent unclear" instead
   of calling it a bug.
4. Separate "this will behave wrongly" from "this is only inconsistent".
5. Never claim full coverage. Say what you did not read.
6. Never print a secret you see; give its location only.

<!-- vtc:editable -->

## Heuristics

- Read the tests first; they show how the code is meant to be called and which cases someone
  once cared about.
- The newest-looking code is not automatically right: check whether it relies on an assumption
  an older layer no longer keeps.
