/** Where a Lookback PR puts its CHANGELOG entry (D-bv; contracts 5.1.0 `ROLES_CHANGELOG_ANCHOR`). */
import { readFileSync } from "node:fs";
import { ROLES_CHANGELOG, ROLES_CHANGELOG_ANCHOR } from "@vtc/shared";
import { describe, expect, it } from "vitest";
import { insertChangelogEntry } from "../../src/upstream/index.js";

const shipped = readFileSync(new URL(`../../../../${ROLES_CHANGELOG}`, import.meta.url), "utf8");

describe("insertChangelogEntry", () => {
  it("puts each entry directly below the anchor of the shipped CHANGELOG, newest first", () => {
    const once = insertChangelogEntry(shipped, "## engineer 1.1.0 (2026-10-15)\n\nfirst");
    const twice = insertChangelogEntry(once, "## engineer 1.2.0 (2026-10-16)\n\nsecond");
    const header = shipped.slice(0, shipped.indexOf(ROLES_CHANGELOG_ANCHOR));
    expect(twice.startsWith(header)).toBe(true);
    const after = twice.slice(
      twice.indexOf(ROLES_CHANGELOG_ANCHOR) + ROLES_CHANGELOG_ANCHOR.length,
    );
    expect(after.indexOf("second")).toBeGreaterThan(0);
    expect(after.indexOf("second")).toBeLessThan(after.indexOf("first"));
    expect(twice.split(ROLES_CHANGELOG_ANCHOR)).toHaveLength(2);
  });

  it("falls back to the title, then to the top, for a file without the anchor", () => {
    expect(insertChangelogEntry("# T\n\nold\n", "new")).toBe("# T\n\nnew\n\nold\n");
    expect(insertChangelogEntry("old\n", "new")).toBe("new\n\nold\n");
    expect(insertChangelogEntry(null, "new")).toBe("# Role prompt changes\n\nnew\n");
  });
});
