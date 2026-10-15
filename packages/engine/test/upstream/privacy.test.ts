/** Privacy of upstream reports (D-by; AD-27 rule 5): allowlist, redaction, denylist, golden body. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertNoProjectPaths,
  assertUpstreamSafe,
  autoFingerprint,
  containsDenied,
  containsProjectPath,
  loadAutoTemplate,
  projectDenylist,
  projectUpstreamReport,
  redactProjectText,
  renderBody,
  selfDenylist,
  upstreamIssueSlots,
  vtcFramesFromStack,
  type UpstreamFacts,
} from "../../src/upstream/index.js";
import { fakeAssets } from "./fakes.js";

const IDENTITY = {
  repo: "acme-corp/payroll-portal",
  remoteUrl: "git@github.com:acme-corp/payroll-portal.git",
  repoRoot: "/Users/alice/clients/globex/payroll-portal",
  clientNames: ["Globex Industries", "Initech"],
  homeDir: "/Users/alice",
};

const STACK = `Error: unexpected token
    at parseLine (/Users/alice/vtc/packages/adapters/src/codex/parse.ts:120:17)
    at handler (/Users/alice/clients/globex/payroll-portal/src/payroll.ts:10:2)
    at async runTurn (/Users/alice/vtc/packages/engine/src/core/loop.ts:88:5)`;

const facts = (over: Partial<UpstreamFacts> = {}): UpstreamFacts => {
  const frames = vtcFramesFromStack(STACK, ["/Users/alice/vtc"]);
  return {
    kind: "defect",
    fingerprint: autoFingerprint({ kind: "defect", errorClass: "adapter.parse_failure", frames }),
    vtcVersion: "0.4.0",
    role: "implementer",
    host: "codex",
    model: "gpt-5.5-codex",
    promptSha: "a".repeat(64),
    errorClass: "adapter.parse_failure",
    frames,
    metrics: { "tokens.per_task": 1200 },
    occurrences: 3,
    firstSeen: "2026-10-13T08:00:00Z",
    lastSeen: "2026-10-15T09:30:00Z",
    ...over,
  };
};

const CHECK = {
  knownValues: ["sk-live-payroll-SECRET-1234"],
  denylist: projectDenylist(IDENTITY),
  upstreamRepo: "bason-labs/bs-vtc",
};

describe("the allowlist projection", () => {
  it("keeps VTC-side fields only and refuses anything that is not", () => {
    const report = projectUpstreamReport({
      ...facts(),
      // Extra fields of a richer fact object are never copied.
      ...({ task_title: "Payroll export for Globex", file: "/Users/alice/x.ts" } as object),
    });
    expect(Object.keys(report).sort()).toEqual(
      [
        "error_class",
        "first_seen",
        "fingerprint",
        "host",
        "kind",
        "last_seen",
        "metrics",
        "model",
        "occurrences",
        "prompt_sha",
        "role",
        "v",
        "vtc_frames",
        "vtc_version",
      ].sort(),
    );
    expect(() =>
      projectUpstreamReport(facts({ errorClass: "/Users/alice/clients/globex/err" })),
    ).toThrow(expect.objectContaining({ reason: "privacy" }) as Error);
    expect(() => projectUpstreamReport(facts({ frames: ["/Users/alice/payroll.ts:10"] }))).toThrow(
      expect.objectContaining({ reason: "privacy" }) as Error,
    );
    expect(() => projectUpstreamReport(facts({ metrics: { "Payroll Portal": 1 } }))).toThrow(
      expect.objectContaining({ reason: "privacy" }) as Error,
    );
  });
});

describe("the model id sent upstream", () => {
  it("keeps a public model id and sends any other as custom: an ARN, a gateway alias or a path never leaves", () => {
    const model = (id: string): string | undefined =>
      projectUpstreamReport(facts({ model: id })).model;
    expect(model("gpt-5.5-codex")).toBe("gpt-5.5-codex");
    expect(model("opus")).toBe("opus");
    expect(model("opus[1m]")).toBe("opus");
    expect(model("claude-sonnet-4-5-20250929")).toBe("claude-sonnet-4-5-20250929");
    expect(model("us.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe(
      "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    );
    expect(model("claude-sonnet-4-5@20250929")).toBe("claude-sonnet-4-5@20250929");
    expect(model("o4-mini")).toBe("o4-mini");
    // D-ci provider billing: an application inference profile ARN holds the AWS account id
    expect(
      model("arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123"),
    ).toBe("custom");
    expect(model("payroll-gateway-prod")).toBe("custom");
    expect(model("projects/acme-prod/locations/us/endpoints/42")).toBe("custom");
    expect(model("claude-sonnet-4-5-123456789012")).toBe("custom");
  });
});

describe("the denylist", () => {
  it("names the repo, owner, remote path, root segments, clients and home", () => {
    const deny = projectDenylist(IDENTITY);
    expect(deny).toEqual(
      expect.arrayContaining([
        "acme-corp/payroll-portal",
        "acme-corp",
        "payroll-portal",
        "/Users/alice",
        "alice",
        "globex",
        "Globex Industries",
        "Initech",
      ]),
    );
    expect(deny).not.toContain("Users");
    expect(deny).not.toContain("clients");
    expect(containsDenied("role implementer on Initech's app", deny)).toBe(true);
    expect(containsDenied("INITECH", deny)).toBe(true);
    // spine §5 reading 212(12): a value of 4 or more characters matches as a substring, so a
    // client or repo name joined to other letters is still the project's name
    expect(containsDenied("initechnology", deny)).toBe(true);
    expect(containsDenied("the InitechPortal service", deny)).toBe(true);
    expect(containsDenied("acmeApi", projectDenylist({ clientNames: ["acme"] }))).toBe(true);
    expect(containsDenied("globexpay", deny)).toBe(true);
  });

  it("matches a value under 4 characters as a whole word only (reading 212(12))", () => {
    const deny = projectDenylist({ clientNames: ["Ion"] });
    expect(containsDenied("the Ion client", deny)).toBe(true);
    expect(containsDenied("a validation error", deny)).toBe(false);
    expect(containsDenied("IonPortal", deny)).toBe(false);
  });

  it("leaves VTC's own vocabulary out of the denylist, so a substring match cannot refuse every report", () => {
    const deny = projectDenylist({
      repoRoot: "/Users/alice/work/roles/prompt",
      clientNames: ["Lookback", "Replay"],
      homeDir: "/Users/alice",
    });
    expect(deny).not.toContain("roles");
    expect(deny).not.toContain("prompt");
    expect(deny).not.toContain("Lookback");
    expect(deny).not.toContain("Replay");
    expect(containsDenied("roles/engineer/prompt.md: improve the lookback replay", deny)).toBe(
      false,
    );
  });
});

describe("VTC builds VTC", () => {
  it("leaves the upstream repo's public identifiers out of its own denylist, keeping local paths", () => {
    const own = projectDenylist({
      repo: "bason-labs/bs-vtc",
      remoteUrl: "git@github.com:bason-labs/bs-vtc.git",
      repoRoot: "/Users/bason/Documents/bason-labs/bs-vtc",
      clientNames: ["Initech"],
      homeDir: "/Users/bason",
    });
    const self = selfDenylist(own, "bason-labs/bs-vtc");
    expect(self).toEqual(["/Users/bason", "/Users/bason/Documents/bason-labs/bs-vtc", "Initech"]);
    expect(containsDenied("fix the bs-vtc engine crash in bason-labs", self)).toBe(false);
    expect(containsDenied("see /Users/bason/notes", self)).toBe(true);
  });
});

describe("project-repo text", () => {
  it("passes the shared redaction: known values and token formats", () => {
    const text = redactProjectText(`key sk-live-payroll-SECRET-1234 and ghp_${"a".repeat(36)}`, [
      "sk-live-payroll-SECRET-1234",
    ]);
    expect(text).not.toContain("SECRET-1234");
    expect(text).not.toContain("ghp_aaaa");
  });
});

describe("redaction fails closed", () => {
  it("skips with privacy when a secret or known value is in the report or a text", () => {
    const report = projectUpstreamReport(facts());
    expect(() => {
      assertUpstreamSafe(report, ["see sk-live-payroll-SECRET-1234"], CHECK);
    }).toThrow(expect.objectContaining({ reason: "privacy" }) as Error);
    expect(() => {
      assertUpstreamSafe(report, ["token ghp_" + "a".repeat(36)], CHECK);
    }).toThrow(expect.objectContaining({ reason: "privacy" }) as Error);
    // the projection sends such a model id as `custom`; the check still refuses one that got in
    expect(projectUpstreamReport(facts({ model: "sk-live-payroll-SECRET-1234" })).model).toBe(
      "custom",
    );
    const leaky = { ...projectUpstreamReport(facts()), model: "sk-live-payroll-SECRET-1234" };
    expect(() => {
      assertUpstreamSafe(leaky, [], CHECK);
    }).toThrow(expect.objectContaining({ reason: "privacy" }) as Error);
  });
  it("skips with privacy when a project identifier appears, and never says which", () => {
    const report = { ...projectUpstreamReport(facts()), model: "globex-tuned" };
    try {
      assertUpstreamSafe(report, [], CHECK);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ reason: "privacy" });
      expect(String(error)).not.toMatch(/globex/i);
    }
  });
  it("lets the upstream repo's own name and links through", () => {
    const report = projectUpstreamReport(facts());
    expect(() => {
      assertUpstreamSafe(report, ["https://github.com/bason-labs/bs-vtc/blob/abc/x.png?raw=true"], {
        ...CHECK,
        denylist: projectDenylist({ ...IDENTITY, homeDir: "/Users/bason" }),
      });
    }).not.toThrow();
  });
});

describe("upstream free text", () => {
  it("masks the upstream repo only as a whole name, so a project repo that extends it is caught", () => {
    const report = projectUpstreamReport(facts());
    const check = {
      ...CHECK,
      denylist: projectDenylist({ ...IDENTITY, repo: "bason-labs/bs-vtc-client" }),
    };
    expect(() => {
      assertUpstreamSafe(report, ["fails in bason-labs/bs-vtc-client too"], check);
    }).toThrow(expect.objectContaining({ reason: "privacy" }) as Error);
    expect(() => {
      assertUpstreamSafe(report, ["see bason-labs/bs-vtc#12"], {
        ...check,
        denylist: projectDenylist({
          ...IDENTITY,
          repo: "someone/bs-vtc-client",
          remoteUrl: "git@github.com:someone/bs-vtc-client.git",
        }),
      });
    }).not.toThrow();
  });
  it("refuses file paths outside VTC's tree, and lets VTC's own paths and URLs through", () => {
    expect(containsProjectPath("edit src/payroll/export.ts first")).toBe(true);
    expect(containsProjectPath("the app/models/user.rb model")).toBe(true);
    expect(containsProjectPath("see roles/implementer/prompt.md")).toBe(false);
    expect(containsProjectPath("packages/engine/src/core/loop.ts:runTurn")).toBe(false);
    expect(containsProjectPath("https://github.com/bason-labs/bs-vtc/blob/a/x.png?raw=true")).toBe(
      false,
    );
    expect(containsProjectPath("tokens per task fell 8% (p = 0.06)")).toBe(false);
    expect(() => {
      assertNoProjectPaths(["Plan the steps.", "check lib/billing/invoice.py before editing"]);
    }).toThrow(expect.objectContaining({ reason: "privacy" }) as Error);
  });
});

describe("the golden upstream body", () => {
  it("holds nothing project-specific", () => {
    const report = projectUpstreamReport(facts());
    const body = renderBody(
      loadAutoTemplate(fakeAssets(), "auto-issue"),
      upstreamIssueSlots(report),
    );
    assertUpstreamSafe(report, [body], CHECK);
    for (const word of [
      "alice",
      "globex",
      "payroll",
      "acme",
      "initech",
      "/Users",
      "clients",
      ".ts:",
    ]) {
      expect(body.toLowerCase()).not.toContain(word.toLowerCase());
    }
    // Plain text so no formatter rewrites it; any change to an upstream body is reviewed here.
    const golden = join(import.meta.dirname, "fixtures", "golden-upstream-issue.txt");
    expect(body).toBe(readFileSync(golden, "utf8"));
  });
});
