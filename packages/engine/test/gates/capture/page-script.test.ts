/**
 * The evidence runner's in-page script (layers 2 and 3 of the redaction, research §3), taken
 * from the real runner source and run in a VM over a minimal fake DOM: what it paints, that a bad
 * selector, a removed stylesheet, page CSS that beats the paint or a shadow root fails closed,
 * which texts the scan collects (and never from a painted subtree or a password), and that a
 * recording hands every change, and every value a script sets, to the binding.
 */
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { EVIDENCE_RUNNER_SCRIPT } from "../../../src/gates/capture/index.js";

const SHOW_ELEMENT = 1;
const SHOW_TEXT = 4;
const FILTER_ACCEPT = 1;
const FILTER_REJECT = 2;

type Node = El | Text;

class Text {
  readonly nodeType = 3;
  parentElement: El | null = null;
  constructor(public nodeValue: string) {}
}

class El {
  readonly nodeType = 1;
  parentElement: El | null = null;
  readonly childNodes: Node[] = [];
  value = "";
  shadowRoot: object | null = null;
  constructor(
    public tagName: string,
    readonly attrs: Record<string, string> = {},
    children: (Node | string)[] = [],
  ) {
    for (const c of children) this.append(typeof c === "string" ? new Text(c) : c);
    if (attrs.value !== undefined) this.value = attrs.value;
  }
  get type(): string {
    return this.attrs.type ?? "text";
  }
  append(node: Node): void {
    node.parentElement = this;
    this.childNodes.push(node);
  }
  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }
  querySelectorAll(selector: string): El[] {
    if (selector !== "*") throw new Error(`unsupported selector ${selector}`);
    return this.childNodes.flatMap((c) => (c instanceof El ? [c, ...c.querySelectorAll("*")] : []));
  }
  /** Supports `[attr]`, `tag[type=x]` and `.class`, in a `, ` list. */
  matches(list: string): boolean {
    return list.split(", ").some((s) => {
      const attr = /^\[([a-z-]+)\]$/.exec(s);
      if (attr) return attr[1] !== undefined && attr[1] in this.attrs;
      const typed = /^([a-z]+)\[type=([a-z]+)\]$/.exec(s);
      if (typed) return this.tagName.toLowerCase() === typed[1] && this.attrs.type === typed[2];
      if (s.startsWith(".")) return (this.attrs.class ?? "").split(" ").includes(s.slice(1));
      throw new Error(`unsupported selector ${s}`);
    });
  }
}

const h = (tag: string, attrs: Record<string, string> = {}, ...children: (Node | string)[]) =>
  new El(tag, attrs, children);

/** The `pageScript` function as the runner source has it. */
const pageScriptSource = (): string => {
  const start = EVIDENCE_RUNNER_SCRIPT.indexOf("function pageScript(config) {");
  const end = EVIDENCE_RUNNER_SCRIPT.indexOf("\n}\n", start);
  if (start === -1 || end === -1) throw new Error("pageScript not found in the runner source");
  return EVIDENCE_RUNNER_SCRIPT.slice(start, end + 2);
};

const PAINT = ["[data-vtc-redact]", "[data-vtc-secret]", "input[type=password]", ".prompt-text"];

const TRANSPARENT = "rgba(0, 0, 0, 0)";
interface Style {
  color: string;
  textFill: string;
  textShadow: string;
  content: string;
  visibility: string;
}
/** What the paint computes to, everywhere it applies; a test overrides one element's style. */
const PAINTED: Style = {
  color: TRANSPARENT,
  textFill: TRANSPARENT,
  textShadow: "none",
  content: "none",
  visibility: "hidden",
};

const load = (
  body: El,
  options: {
    paint?: string[];
    video?: boolean;
    maxChars?: number;
    styles?: Map<El, Partial<Style>>;
  } = {},
) => {
  const html = h(
    "html",
    {},
    h("head", {}, h("script", {}, "const leaked = 'ghp_in_script';")),
    body,
  );
  const observers: { callback: (records: { target: Node }[]) => void }[] = [];
  const sent: string[][] = [];
  const document = {
    nodeType: 9,
    title: "Run R1 · VTC",
    documentElement: html,
    adoptedStyleSheets: [] as unknown[],
    querySelectorAll: (selector: string) => {
      if (/[{}!]/.test(selector)) throw new SyntaxError(`'${selector}' is not a valid selector`);
      return [];
    },
    createTreeWalker: (root: El, _what: number, filter: { acceptNode: (n: Node) => number }) => {
      const order: Node[] = [root];
      const walk = (el: El): void => {
        for (const child of el.childNodes) {
          if (child.nodeType === 1 && filter.acceptNode(child) === FILTER_REJECT) continue;
          order.push(child);
          if (child.nodeType === 1) walk(child);
        }
      };
      walk(root);
      let i = 0;
      return { currentNode: root, nextNode: () => order[++i] ?? null };
    },
    addEventListener: () => undefined,
  };
  class CSSStyleSheet {
    readonly rules: string[] = [];
    insertRule(rule: string): number {
      this.rules.push(rule);
      return this.rules.length - 1;
    }
  }
  class MutationObserver {
    constructor(readonly callback: (records: { target: Node }[]) => void) {
      observers.push(this);
    }
    observe(): void {}
  }
  const getComputedStyle = (el: El, pseudo?: string) => {
    const style = { ...PAINTED, ...(options.styles?.get(el) ?? {}) };
    return {
      color: style.color,
      textShadow: style.textShadow,
      visibility: style.visibility,
      content: pseudo === undefined ? "normal" : style.content,
      getPropertyValue: (name: string) =>
        name === "-webkit-text-fill-color" ? style.textFill : "",
    };
  };
  // Fresh per load: the script patches these prototypes for good.
  class Element {
    attachShadow(this: El): object {
      this.shadowRoot = {};
      return this.shadowRoot;
    }
  }
  class HTMLInputElement {
    readonly tagName = "INPUT";
  }
  Object.defineProperty(HTMLInputElement.prototype, "value", {
    get(this: El) {
      return this.value;
    },
    set(this: El, v: string) {
      this.value = v;
    },
    configurable: true,
    enumerable: true,
  });
  const context: Record<string, unknown> = {
    document,
    CSSStyleSheet,
    MutationObserver,
    getComputedStyle,
    Element,
    HTMLInputElement,
    NodeFilter: { SHOW_ELEMENT, SHOW_TEXT, FILTER_ACCEPT, FILTER_REJECT },
    __vtcEvidenceText: (texts: string[]) => {
      sent.push(texts);
      return Promise.resolve();
    },
  };
  context.window = context;
  const config = {
    paint: options.paint ?? PAINT,
    color: "#1f1f1f",
    binding: "__vtcEvidenceText",
    video: options.video ?? false,
    maxChars: options.maxChars ?? 100_000,
  };
  runInNewContext(`(${pageScriptSource()})(${JSON.stringify(config)});`, context);
  const api = context.__vtcEvidence as {
    state: () => { painted: boolean; broken: string | null };
    collect: () => string[];
    flush: () => Promise<boolean>;
  };
  return { api, document, observers, sent, context };
};

const TOKEN_A = "ghp_aaaaaaaaaaaaaaaaaa";
const TOKEN_B = "bbbbbbbbbbbbbbbbbb";

const page = () =>
  h(
    "body",
    {},
    h("h1", { title: "Flow of run R1" }, "Run R1"),
    h("img", { alt: "replay chart" }),
    h("p", { "data-vtc-redact": "" }, "the prompt text", h("b", {}, "hidden detail")),
    h("div", { class: "prompt-text" }, "project prompt"),
    h("input", { type: "password", value: "hunter2hunter2" }),
    h("input", { type: "text", value: "search term", placeholder: "Search runs" }),
    h("code", {}, h("span", {}, TOKEN_A), h("span", {}, TOKEN_B)),
  );

describe("the evidence runner's page script", () => {
  it("paints every redact selector as a solid block, hiding what is inside", () => {
    const { api, document } = load(page());
    expect(api.state()).toEqual({ painted: true, broken: null });
    const sheet = document.adoptedStyleSheets[0] as { rules: string[] };
    expect(sheet.rules).toHaveLength(PAINT.length * 4);
    expect(sheet.rules[0]).toMatch(/^:is\(\[data-vtc-redact\]\) \{ color: transparent !important;/);
    expect(sheet.rules[0]).toContain("background: #1f1f1f !important");
    expect(sheet.rules[1]).toBe(":is([data-vtc-redact]) * { visibility: hidden !important; }");
    expect(sheet.rules.some((r) => r.startsWith(":is(.prompt-text) "))).toBe(true);
    // Generated content of a painted element, and of everything inside it, is dropped.
    expect(sheet.rules[3]).toBe(
      ":is([data-vtc-redact])::before, :is([data-vtc-redact])::after, :is([data-vtc-redact]) *::before, :is([data-vtc-redact]) *::after { content: none !important; }",
    );
  });

  it("fails closed when page CSS beats the paint", () => {
    for (const [target, style] of [
      ["root", { color: "rgb(0, 0, 0)" }],
      ["root", { textFill: "rgb(0, 0, 0)" }],
      ["root", { textShadow: "rgb(0, 0, 0) 1px 1px 0px" }],
      ["root", { content: '"leak"' }],
      ["child", { visibility: "visible" }],
    ] as const) {
      const body = page();
      const painted = body.childNodes[2] as El;
      const el = target === "root" ? painted : (painted.childNodes[1] as El);
      const { api } = load(body, { styles: new Map([[el, style]]) });
      expect(() => api.collect()).toThrow(/page CSS overrides the redaction paint/);
    }
  });

  it("fails closed on a shadow root, open or attached by script", () => {
    const body = page();
    const host = h("div", {}, "host");
    body.append(host);
    const { api, context } = load(body);
    expect(api.state().broken).toBeNull();
    host.shadowRoot = {};
    expect(() => api.collect()).toThrow(/shadow root/);
    host.shadowRoot = null;
    const element = context.Element as { prototype: { attachShadow: (this: El) => object } };
    element.prototype.attachShadow.call(host);
    expect(api.state().broken).toBe(
      "the page attached a shadow root, which the redaction cannot cover",
    );
    // The page cannot put the original back.
    expect(() => {
      element.prototype.attachShadow = () => ({});
    }).toThrow();
  });

  it("fails closed on a selector that is not valid CSS", () => {
    const { api, document } = load(page(), {
      paint: ["[data-vtc-redact]", "a{} body{display:none}"],
    });
    expect(api.state()).toEqual({
      painted: false,
      broken: "a redact selector is not valid CSS, so nothing could be painted",
    });
    expect(document.adoptedStyleSheets).toEqual([]);
  });

  it("reports a stylesheet the page removed", () => {
    const { api, document } = load(page());
    document.adoptedStyleSheets = [];
    expect(api.state().broken).toBe("the redaction stylesheet was removed from the page");
  });

  it("collects visible text, attributes and input values, never painted subtrees, passwords or scripts", () => {
    const { api } = load(page());
    const texts = api.collect();
    expect(texts).toEqual(
      expect.arrayContaining([
        "Run R1 · VTC",
        "Flow of run R1",
        "Run R1",
        "replay chart",
        "search term",
        "Search runs",
        TOKEN_A,
        TOKEN_B,
      ]),
    );
    const all = texts.join("\n");
    expect(all).not.toContain("the prompt text");
    expect(all).not.toContain("hidden detail");
    expect(all).not.toContain("project prompt");
    expect(all).not.toContain("hunter2hunter2");
    expect(all).not.toContain("ghp_in_script");
    // A token split over elements is scanned whole.
    expect(texts.at(-1)).toContain(`${TOKEN_A}${TOKEN_B}`);
  });

  it("refuses a page with more text than it may scan", () => {
    const { api } = load(page(), { maxChars: 10 });
    expect(() => api.collect()).toThrow(/too much text/);
  });

  it("hands each change to the binding during a recording, and flush waits for delivery", async () => {
    const body = page();
    const { api, observers, sent } = load(body, { video: true });
    expect(observers).toHaveLength(1);
    const added = h("li", {}, "event 42: gate passed");
    body.append(added);
    observers[0]?.callback([{ target: body }, { target: added.childNodes[0] as Node }]);
    await api.flush();
    const delivered = sent.flat();
    expect(delivered).toContain("event 42: gate passed");
    expect(delivered.join("\n")).not.toContain("hidden detail");
    // A change inside a painted subtree is not sent.
    sent.length = 0;
    const secret = body.childNodes[2] as El;
    observers[0]?.callback([{ target: secret }]);
    await api.flush();
    expect(sent).toEqual([]);
  });

  it("hands a value a script sets to the binding during a recording", async () => {
    const body = page();
    const input = body.childNodes[5] as El;
    const { api, sent, context } = load(body, { video: true });
    const proto = (context.HTMLInputElement as { prototype: object }).prototype;
    // What `input.value = ...` in a page script does: the prototype's setter on the element.
    Reflect.set(proto, "value", `typed ${TOKEN_A}`, input);
    await api.flush();
    expect(input.value).toBe(`typed ${TOKEN_A}`);
    expect(sent.flat()).toContain(`typed ${TOKEN_A}`);
    // A password set by script is never sent.
    sent.length = 0;
    Reflect.set(proto, "value", "hunter3hunter3", body.childNodes[4]);
    await api.flush();
    expect(sent.flat().join("\n")).not.toContain("hunter3");
  });

  it("observes nothing for a screenshot", () => {
    const { observers } = load(page(), { video: false });
    expect(observers).toHaveLength(0);
  });
});
