import { describe, expect, it, vi } from "vitest";
import { hrefs, matchView, navigate, subscribeLocation } from "@/lib/router";

describe("matchView (AD-20 fixed pages)", () => {
  it.each([
    ["/", "runs"],
    ["/index.html", "runs"],
    ["/run/", "run"],
    ["/run", "run"],
    ["/task/", "task"],
    ["/task/index.html", "task"],
    ["/feature/", "feature"],
    ["/escalations/", "escalations"],
    ["/usage/", "usage"],
    ["/artifact/", "artifact"],
    ["/runs/golden-1", "not_found"],
  ])("%s → %s", (path, view) => {
    expect(matchView(path)).toBe(view);
  });
});

describe("hrefs", () => {
  it("puts ids in the query string, never in path segments", () => {
    expect(hrefs.run("golden-1")).toBe("/run/?run=golden-1");
    expect(hrefs.run("golden-1", "tasks")).toBe("/run/?run=golden-1&zoom=tasks");
    expect(hrefs.task("golden-1", "T-2")).toBe("/task/?run=golden-1&task=T-2");
    expect(hrefs.task("golden-1", "T-2", "loop-guard")).toBe(
      "/task/?run=golden-1&task=T-2&node=loop-guard",
    );
    expect(hrefs.feature("golden-1", "F-1")).toBe("/feature/?run=golden-1&feature=F-1");
    expect(hrefs.escalations("golden-1")).toBe("/escalations/?run=golden-1");
    expect(hrefs.artifact("golden-1", ".vtc/spec/spec.md")).toBe(
      "/artifact/?run=golden-1&path=.vtc%2Fspec%2Fspec.md",
    );
    expect(hrefs.usage()).toBe("/usage/");
    expect(hrefs.runs()).toBe("/");
  });
});

describe("navigate", () => {
  it("pushes history and notifies subscribers without a page load", () => {
    const cb = vi.fn();
    const off = subscribeLocation(cb);
    navigate("/task/?run=golden-1&task=T-2");
    expect(window.location.pathname).toBe("/task/");
    expect(window.location.search).toBe("?run=golden-1&task=T-2");
    expect(cb).toHaveBeenCalled();
    off();
  });
});
