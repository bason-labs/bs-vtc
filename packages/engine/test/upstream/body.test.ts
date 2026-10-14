/** Bodies from the roles-compiler's templates (AD-27 rule 3; spine §5 reading 208 (5)). */
import { AUTOMATION_LIMITS, renderAutoMarker } from "@vtc/shared";
import { describe, expect, it } from "vitest";
import {
  fillTemplate,
  loadAutoTemplate,
  MAX_TITLE_CHARS,
  renderBody,
  renderNote,
  renderTitle,
  TemplateError,
  TRUNCATED,
} from "../../src/upstream/index.js";
import { fakeAssets } from "./fakes.js";

const PR = loadAutoTemplate(fakeAssets(), "auto-pr");
const MARKER = renderAutoMarker({
  v: 1,
  kind: "lookback",
  fp: "0123456789abcdef",
  role: "implementer",
});
const NOTE = renderNote({
  kind: "lookback",
  pr: true,
  disclosure: { vtcVersion: "0.4.0", host: "codex" },
  evidence: "complete",
});

describe("templates", () => {
  it("refuse unknown slots", () => {
    expect(() => fillTemplate("{{marker}}\n{{note}}\n{{project_name}}", {})).toThrow(TemplateError);
    expect(() =>
      loadAutoTemplate(
        {
          read: () => new TextEncoder().encode("{{marker}} {{secret}}"),
          list: () => [],
        },
        "auto-pr",
      ),
    ).toThrow(/secret/);
  });
  it("must start with the marker and then the note", () => {
    expect(() => renderBody("{{summary}}\n{{marker}}\n{{note}}", {})).toThrow(/marker/);
    expect(() => renderBody("{{marker}}\n{{summary}}\n{{note}}", {})).toThrow(/note/);
  });
  it("fill missing slots with 'unavailable' and put marker, note and AI disclosure first", () => {
    const body = renderBody(PR, { marker: MARKER, note: NOTE, summary: "Shorter steps." });
    expect(body.startsWith(MARKER)).toBe(true);
    expect(body.indexOf("VTC never merges automatic PRs")).toBeLessThan(body.indexOf("## Summary"));
    expect(body).toContain("model unavailable");
    expect(body).toContain("## Verification\n\nunavailable");
  });
  it("throw when no plugin carries the template", () => {
    expect(() => loadAutoTemplate({ read: () => undefined, list: () => [] }, "auto-issue")).toThrow(
      /vtc\/templates\/auto-issue\.md/,
    );
  });
});

describe("body truncation", () => {
  const big = (n: number): string => "x".repeat(n);
  const slots = {
    marker: MARKER,
    note: NOTE,
    summary: "s",
    diff: big(30_000),
    provenance: big(20_000),
    verification: big(15_000),
  };
  it("drops the diff, then the provenance, then the verification", () => {
    const one = renderBody(PR, slots);
    expect(one.length).toBeLessThanOrEqual(AUTOMATION_LIMITS.maxBodyChars);
    expect(one).toContain(TRUNCATED);
    expect(one).not.toContain(big(30_000));
    expect(one).toContain(big(20_000));
    const two = renderBody(PR, { ...slots, provenance: big(50_000) });
    expect(two).not.toContain(big(16_000));
    expect(two).toContain(big(15_000));
    const three = renderBody(PR, { ...slots, provenance: big(50_000), verification: big(70_000) });
    expect(three).not.toContain("xx");
    expect(three.match(new RegExp(TRUNCATED.replace(/[().;]/g, "\\$&"), "g"))?.length).toBe(3);
  });
  it("hard-cuts what is still too long but keeps the marker and the note", () => {
    const body = renderBody(PR, { ...slots, summary: big(80_000) });
    expect(body.length).toBeLessThanOrEqual(AUTOMATION_LIMITS.maxBodyChars);
    expect(body.startsWith(`${MARKER}\n${NOTE}`)).toBe(true);
    expect(body.trimEnd().endsWith(TRUNCATED)).toBe(true);
  });
});

describe("titles", () => {
  it("are vtc(<kind>): … within 72 characters", () => {
    expect(renderTitle("defect", "adapter.parse_failure in implementer")).toBe(
      "vtc(defect): adapter.parse_failure in implementer",
    );
    const long = renderTitle("security", "x ".repeat(80));
    expect(long.length).toBe(MAX_TITLE_CHARS);
    expect(long.endsWith("…")).toBe(true);
    expect(renderTitle("cost", "a\nb")).toBe("vtc(cost): a b");
  });
});
