import { describe, expect, it } from "vitest";
import { focusBox, followView, READABLE_ZOOM, type NodeBox } from "@/lib/flows/follow";

const box = (id: string, x: number, state: NodeBox["state"]): NodeBox => ({
  id,
  x,
  y: 0,
  width: 200,
  height: 100,
  state,
});

describe("focusBox", () => {
  it("prefers running or looping, then nodes needing attention, then the furthest started", () => {
    expect(focusBox([box("a", 0, "passed"), box("b", 300, "running")])?.id).toBe("b");
    expect(focusBox([box("a", 0, "looping"), box("b", 300, "parked")])?.id).toBe("a");
    expect(focusBox([box("a", 0, "passed"), box("b", 300, "parked")])?.id).toBe("b");
    expect(focusBox([box("a", 0, "interrupted"), box("b", 300, "waiting")])?.id).toBe("a");
    expect(
      focusBox([box("a", 0, "passed"), box("b", 300, "passed"), box("c", 600, "waiting")])?.id,
    ).toBe("b");
    expect(focusBox([box("a", 0, "waiting")])?.id).toBe("a");
    expect(focusBox([])).toBeNull();
  });
});

describe("followView", () => {
  it("fits a small graph", () => {
    const view = followView([box("a", 0, "passed"), box("b", 300, "running")], {
      width: 1200,
      height: 600,
    });
    expect(view?.zoom).toBe(1);
    expect(view?.center).toEqual({ x: 250, y: 50 });
  });
  it("never zooms below the readable floor; centres on the focus instead", () => {
    const nodes = Array.from({ length: 12 }, (_, i) =>
      box(`n${String(i)}`, i * 300, i === 7 ? "running" : "passed"),
    );
    const view = followView(nodes, { width: 600, height: 400 });
    expect(view?.zoom).toBe(READABLE_ZOOM);
    expect(view?.center.x).toBe(7 * 300 + 100);
  });
  it("has no view without nodes or size", () => {
    expect(followView([], { width: 100, height: 100 })).toBeNull();
    expect(followView([box("a", 0, "running")], { width: 0, height: 100 })).toBeNull();
  });
});
