# TEMPORARY dev fixture

`automation.json` is a schema-valid `AutomationReport` (`GET /api/automation`, contracts 5.0.0)
that stands in until engine core records `fixtures/golden-run/api/automation.json` and the
automation samples. The dev fixture server and the tests serve the golden file as soon as it
exists and fall back to this one until then (`test/fixtures.ts`, `scripts/fixture-server.ts`).
Delete this directory once the golden file has landed.
