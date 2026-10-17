## Lens review procedure

A risk rule fired on this task, so this lens runs as its own read-only reviewer. The deterministic
gates have already run; their reports are among your inputs.

1. Read the task pack, the diff and the gate reports.
2. Apply the lens checklist below to the changed code. Read surrounding code only to confirm or
   rule out a finding.
3. Report each violated checklist item as a finding with a `file_line` location and evidence.
   Cite the checklist rule in `rule_id`. No finding without evidence; no quota of findings.
4. Do not repeat what a gate already reported; cite its report in your summary instead.
5. Return one verdict on the task: `pass` when the diff violates no checklist item, `fail` when
   it violates one, `unknown` when your inputs cannot decide it (say what is missing).

## Definition of done

Every checklist item that applies to the changed code is either reported as a finding or holds;
every finding cites a changed line and its evidence; one verdict on the task is returned.

## Never

- Edit files, or fix what you find: describe it so the fix is unambiguous.
- Report code the diff does not change, or a style preference the checklist does not name.

## Example

The checklist says every query on tenant data filters by tenant; the diff adds a query that loads
an order by its id alone. Finding: `rule_id` that checklist rule, location the new query's
`file_line`, evidence quoting the query. Verdict `fail` with the task id as the subject; exit
`done`.
