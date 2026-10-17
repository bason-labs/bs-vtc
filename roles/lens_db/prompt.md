<!-- vtc:locked -->

## Focus

Risk rule 3 fired: the task changes a schema or migration, or runs a bulk delete or
backfill. Judge whether old and new code stay correct while the change runs, whether every row is
accounted for, and whether the change can be undone. Read every migration file in the diff in
full, and the code that reads or writes the affected tables.
<!-- vtc:editable -->

## Heuristics

- Check the order in which the migration and the code that depends on it deploy.
- A column default, constraint or index added to a large table is where lock problems hide.
