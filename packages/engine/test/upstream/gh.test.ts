/** The gh seam of AD-27 rule 1: argv guard, stub-binary services, the per-repo queue (D-cc). */
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AUTO_COMMENT_MARKER, AUTOMATION_LIMITS, renderAutoMarker } from "@vtc/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertGhArgsAllowed,
  createGhServices,
  createRepoQueue,
  GhArgvRefusedError,
  issueFromGh,
  lockIsStale,
  QUIET_CLOSE_MARKER,
  stripUnresolvedReferences,
  withFileLock,
  type GhResult,
} from "../../src/upstream/index.js";
import { cleanupDirs, tempDir } from "../helpers/repo.js";
import { ghIssue, ghPr, stubGh, type GhRule, type StubGh } from "./stub-gh.js";

afterEach(cleanupDirs);

const FP = "0123456789abcdef";
const MARKER = renderAutoMarker({ v: 1, kind: "defect", fp: FP });
const REPO = "bason-labs/bs-vtc";

const fastQueue = (): ReturnType<typeof createRepoQueue> =>
  createRepoQueue({ minWriteIntervalMs: 0, sleep: () => Promise.resolve() });

const stagingWith = (body: string, files: string[] = []): string => {
  const dir = tempDir("vtc-staging-");
  writeFileSync(join(dir, "body.md"), body);
  for (const f of files) writeFileSync(join(dir, f), "x");
  return dir;
};

describe("the argv guard", () => {
  const refused = (args: string[]): void => {
    expect(() => {
      assertGhArgsAllowed(args);
    }).toThrow(GhArgvRefusedError);
  };
  it("refuses merges, auto-merge, admin, force and repo-setting changes", () => {
    refused(["pr", "merge", "3", "-R", REPO]);
    refused(["pr", "merge", "3", "-R", REPO, "--auto"]);
    refused(["pr", "edit", "3", "-R", REPO, "--auto"]);
    refused(["pr", "close", "3", "-R", REPO, "--admin"]);
    refused(["pr", "create", "-R", REPO, "--admin=true"]);
    refused(["repo", "edit", REPO, "--default-branch", "x"]);
    refused(["repo", "delete", REPO]);
    refused(["repo", "sync", REPO, "--force"]);
    refused(["api", "-X", "PATCH", "repos/o/r"]);
    refused(["label", "create", "x", "-R", REPO, "--force"]);
    refused(["secret", "set", "X"]);
  });
  it("refuses bodies on argv and user paths as body files", () => {
    refused(["issue", "create", "-R", REPO, "--title", "t", "--body", "b"]);
    refused(["issue", "comment", "1", "-R", REPO, "-b", "b"]);
    refused(["issue", "close", "1", "-R", REPO, "--comment", "c"]);
    refused(["issue", "create", "-R", REPO, "--body-file", "/Users/me/body.md"]);
    refused(["issue", "create", "-R", REPO, "--body-file", "../body.md"]);
    refused(["pr", "create", "-R", REPO, "--attach", "/tmp/shot.png"]);
  });
  it("needs an explicit -R owner/name and --delete-branch only on pr close", () => {
    refused(["issue", "list", "--label", "vtc:auto"]);
    refused(["issue", "list", "-R", "../x"]);
    refused(["repo", "view", "--json", "defaultBranchRef"]);
    refused(["issue", "close", "1", "-R", REPO, "--delete-branch"]);
    expect(() => {
      assertGhArgsAllowed(["pr", "close", "1", "-R", REPO, "--delete-branch"]);
      assertGhArgsAllowed(["repo", "view", REPO, "--json", "defaultBranchRef"]);
      assertGhArgsAllowed([
        "issue",
        "create",
        "-R",
        REPO,
        "--title",
        "-x",
        "--body-file",
        "body.md",
      ]);
      assertGhArgsAllowed(["pr", "create", "-R", REPO, "--attach", "01-replay.webm"]);
    }).not.toThrow();
  });
});

describe("gh-backed services with a stub gh", () => {
  it("creates an issue with -R, --body-file in the staging cwd and GH_PROMPT_DISABLED", async () => {
    const gh = stubGh([
      { match: ["issue", "create"], stdout: "https://github.com/o/r/issues/7\n" },
      {
        match: ["issue", "view", "7"],
        stdout: JSON.stringify(ghIssue({ number: 7, body: `${MARKER}\nhello` })),
      },
    ]);
    const services = createGhServices({
      command: gh.command,
      queue: fastQueue(),
      stagingRoot: tempDir(),
    });
    const staging = stagingWith(`${MARKER}\nhello`);
    const issue = await services.issues.create(REPO, {
      title: "vtc(defect): x",
      stagingDir: staging,
      bodyFile: "body.md",
      labels: ["vtc:auto", "vtc:kind/defect"],
    });
    expect(issue.number).toBe(7);
    expect(issue.marker?.fp).toBe(FP);
    const [create] = gh.calls();
    expect(create?.args).toEqual([
      "issue",
      "create",
      "-R",
      REPO,
      "--title",
      "vtc(defect): x",
      "--body-file",
      "body.md",
      "--label",
      "vtc:auto",
      "--label",
      "vtc:kind/defect",
    ]);
    expect(create?.promptDisabled).toBe(true);
    expect(create?.body).toContain(MARKER);
    expect(gh.calls().every((c) => !c.args.includes("--body"))).toBe(true);
  });

  it("lists automatic issues by label (never search) and reads human activity", async () => {
    const gh = stubGh([
      {
        match: ["issue", "list"],
        stdout: JSON.stringify([
          ghIssue({
            number: 1,
            body: MARKER,
            state: "CLOSED",
            stateReason: "NOT_PLANNED",
            comments: [`${AUTO_COMMENT_MARKER} quiet`],
          }),
          ghIssue({ number: 2, body: "no marker", comments: ["a human"] }),
        ]),
      },
    ]);
    const services = createGhServices({ command: gh.command, stagingRoot: tempDir() });
    const list = await services.issues.listAutomatic(REPO);
    expect(list.map((i) => [i.number, i.state, i.stateReason, i.humanActivity])).toEqual([
      [1, "closed", "not_planned", false],
      [2, "open", null, true],
    ]);
    expect(list[0]?.marker?.fp).toBe(FP);
    const [call] = gh.calls();
    expect(call?.args.slice(0, 8)).toEqual([
      "issue",
      "list",
      "-R",
      REPO,
      "--label",
      "vtc:auto",
      "--state",
      "all",
    ]);
    expect(call?.args.join(" ")).not.toMatch(/search/);
  });

  it("reads the remote facts: when an issue opened, and whether VTC's quiet sweep closed it", () => {
    const quiet = issueFromGh({
      number: 3,
      url: "https://github.com/o/r/issues/3",
      state: "CLOSED",
      stateReason: "NOT_PLANNED",
      body: MARKER,
      createdAt: "2026-10-01T08:00:00Z",
      closedAt: "2026-10-15T09:00:01Z",
      comments: [
        { body: "a human", createdAt: "2026-10-02T00:00:00Z" },
        {
          body: `${AUTO_COMMENT_MARKER}\n${QUIET_CLOSE_MARKER}\nNot seen for 14 days`,
          createdAt: "2026-10-15T09:00:00Z",
        },
      ],
    });
    expect(quiet).toMatchObject({ createdAt: "2026-10-01T08:00:00Z", closedQuietByVtc: true });
    // A human closed it later as not planned (or commented after VTC's close): not VTC's close.
    expect(
      issueFromGh({
        number: 3,
        url: "u",
        state: "CLOSED",
        stateReason: "NOT_PLANNED",
        closedAt: "2026-10-20T00:00:00Z",
        comments: [{ body: QUIET_CLOSE_MARKER, createdAt: "2026-10-15T09:00:00Z" }],
      })?.closedQuietByVtc,
    ).toBe(false);
    expect(
      issueFromGh({
        number: 3,
        url: "u",
        state: "CLOSED",
        stateReason: "NOT_PLANNED",
        closedAt: "2026-10-15T09:00:01Z",
        comments: [{ body: "not planned, thanks", createdAt: "2026-10-15T09:00:00Z" }],
      })?.closedQuietByVtc,
    ).toBe(false);
  });

  it("reads the PR head after its comment, right before closing", async () => {
    const gh = stubGh([
      {
        match: ["pr", "view", "9"],
        stdout: JSON.stringify(ghPr({ number: 9, sha: "b".repeat(40), body: MARKER })),
      },
    ]);
    const services = createGhServices({
      command: gh.command,
      queue: fastQueue(),
      stagingRoot: tempDir(),
    });
    await services.pullRequests.close(REPO, 9, "superseded", "b".repeat(40));
    expect(gh.calls().map((c) => c.args.slice(0, 2).join(" "))).toEqual([
      "pr comment",
      "pr view",
      "pr close",
    ]);
  });

  it("comments, closes and reopens through body files that carry the comment marker", async () => {
    const gh = stubGh([]);
    const services = createGhServices({
      command: gh.command,
      queue: fastQueue(),
      stagingRoot: tempDir(),
    });
    await services.issues.close(REPO, 4, "not_planned", "quiet for 14 days");
    await services.issues.reopen(REPO, 4, "seen again");
    const calls = gh.calls();
    expect(calls.map((c) => c.args.slice(0, 2).join(" "))).toEqual([
      "issue comment",
      "issue close",
      "issue reopen",
      "issue comment",
    ]);
    expect(calls[1]?.args).toContain("not planned");
    for (const c of calls.filter((x) => x.body !== undefined)) {
      expect(c.body?.startsWith(AUTO_COMMENT_MARKER)).toBe(true);
    }
  });

  it("creates labels that are missing only, without --force", async () => {
    const gh = stubGh([
      { match: ["label", "list"], stdout: JSON.stringify([{ name: "vtc:auto" }]) },
    ]);
    const services = createGhServices({
      command: gh.command,
      queue: fastQueue(),
      stagingRoot: tempDir(),
    });
    await services.issues.ensureLabels(REPO, ["vtc:auto", "vtc:kind/defect"]);
    const creates = gh.calls().filter((c) => c.args[1] === "create");
    expect(creates.map((c) => c.args[2])).toEqual(["vtc:kind/defect"]);
  });

  it("opens PRs as drafts on the automatic branch and deletes a branch only at our head", async () => {
    const head = "b".repeat(40);
    const gh = stubGh([
      { match: ["pr", "create"], stdout: "https://github.com/o/r/pull/9\n" },
      {
        match: ["pr", "view", "9"],
        stdout: JSON.stringify(ghPr({ number: 9, sha: head, body: MARKER })),
      },
    ]);
    const services = createGhServices({
      command: gh.command,
      queue: fastQueue(),
      stagingRoot: tempDir(),
    });
    const staging = stagingWith(`${MARKER}\nbody`);
    const request = {
      title: "vtc(defect): fix",
      stagingDir: staging,
      bodyFile: "body.md",
      labels: ["vtc:auto"],
      kind: "defect" as const,
      fingerprint: FP,
      branch: "vtc/auto/defect/01234567",
      base: "main",
    };
    const pr = await services.pullRequests.openDraft(REPO, request);
    expect(pr.isDraft).toBe(true);
    const create = gh.calls().find((c) => c.args[1] === "create");
    expect(create?.args).toEqual(expect.arrayContaining(["--draft", "--head", request.branch]));
    await expect(
      services.pullRequests.openDraft(REPO, { ...request, branch: "main" }),
    ).rejects.toThrow(/autoBranchName/);

    await services.pullRequests.close(REPO, 9, "superseded", "c".repeat(40));
    await services.pullRequests.close(REPO, 9, "superseded", head);
    const closes = gh.calls().filter((c) => c.args[0] === "pr" && c.args[1] === "close");
    expect(closes.map((c) => c.args.includes("--delete-branch"))).toEqual([false, true]);
    expect(gh.calls().some((c) => c.args.includes("merge"))).toBe(false);
  });

  const partialUpload = (extra: GhRule[] = []): GhRule[] => [
    ...extra,
    { match: ["label", "list"], stdout: JSON.stringify([{ name: "vtc:auto" }]) },
    {
      match: ["pr", "create"],
      code: 1,
      stdout: "https://github.com/o/r/pull/5\n",
      stderr: "upload failed for 02-flow.png",
    },
    {
      match: ["pr", "view", "5", "-R", REPO, "--json", "body"],
      stdout: JSON.stringify({
        body: `${MARKER}\n![replay](https://github.com/user-attachments/assets/x)\n![shot](02-flow.png)\n`,
      }),
    },
    { match: ["pr", "view", "5"], stdout: JSON.stringify(ghPr({ number: 5, body: MARKER })) },
  ];
  const openWithAttachments = async (gh: StubGh): Promise<void> => {
    const staging = stagingWith(`${MARKER}\n![replay](01-replay.webm)\n![shot](02-flow.png)\n`, [
      "01-replay.webm",
      "02-flow.png",
    ]);
    const services = createGhServices({
      command: gh.command,
      queue: fastQueue(),
      stagingRoot: tempDir(),
    });
    await services.pullRequests.openDraft(REPO, {
      title: "t",
      stagingDir: staging,
      bodyFile: "body.md",
      labels: [],
      kind: "defect",
      fingerprint: FP,
      branch: "vtc/auto/defect/01234567",
      base: "main",
      attach: [
        { name: "01-replay.webm", alt: "replay" },
        { name: "02-flow.png", alt: "shot" },
      ],
    });
  };

  it("creates the evidence: partial label a repair needs when the repo lacks it", async () => {
    const gh = stubGh(partialUpload());
    await openWithAttachments(gh);
    const calls = gh.calls().map((c) => c.args.slice(0, 3).join(" "));
    expect(calls.indexOf("label create evidence: partial")).toBeGreaterThan(-1);
    expect(calls.indexOf("label create evidence: partial")).toBeLessThan(
      calls.indexOf("pr edit 5"),
    );
  });

  it("strips the unresolved references even when labelling the item fails", async () => {
    const gh = stubGh(
      partialUpload([
        {
          match: ["pr", "edit", "5", "-R", REPO, "--body-file", "body-resolved.md", "--add-label"],
          code: 1,
          stderr: "could not add label: 'evidence: partial' not found",
        },
      ]),
    );
    await openWithAttachments(gh);
    const edits = gh.calls().filter((c) => c.args[1] === "edit");
    expect(edits.map((e) => e.args.includes("--add-label"))).toEqual([true, false]);
    expect(edits[1]?.body).toContain("user-attachments");
    expect(edits[1]?.body).not.toContain("02-flow.png");
  });

  it("repairs a partial --attach upload: strips unresolved references, labels partial", async () => {
    const staging = stagingWith(`${MARKER}\n![replay](01-replay.webm)\n![shot](02-flow.png)\n`, [
      "01-replay.webm",
      "02-flow.png",
    ]);
    const gh = stubGh([
      { match: ["label", "list"], stdout: JSON.stringify([{ name: "evidence: partial" }]) },
      {
        match: ["pr", "create"],
        code: 1,
        stdout: "https://github.com/o/r/pull/5\n",
        stderr: "upload failed for 02-flow.png",
      },
      {
        match: ["pr", "view", "5", "-R", REPO, "--json", "body"],
        stdout: JSON.stringify({
          body: `${MARKER}\n![replay](https://github.com/user-attachments/assets/x)\n![shot](02-flow.png)\n`,
        }),
      },
      { match: ["pr", "view", "5"], stdout: JSON.stringify(ghPr({ number: 5, body: MARKER })) },
    ]);
    const services = createGhServices({
      command: gh.command,
      queue: fastQueue(),
      stagingRoot: tempDir(),
    });
    await services.pullRequests.openDraft(REPO, {
      title: "t",
      stagingDir: staging,
      bodyFile: "body.md",
      labels: [],
      kind: "defect",
      fingerprint: FP,
      branch: "vtc/auto/defect/01234567",
      base: "main",
      attach: [
        { name: "01-replay.webm", alt: "replay" },
        { name: "02-flow.png", alt: "shot" },
      ],
    });
    const create = gh.calls().find((c) => c.args[1] === "create");
    expect(create?.attached).toEqual(["01-replay.webm", "02-flow.png"]);
    expect(create?.cwd.endsWith(staging.split("/").at(-1) ?? "")).toBe(true);
    const repair = gh.calls().find((c) => c.args[1] === "edit");
    expect(repair?.args).toEqual(expect.arrayContaining(["--add-label", "evidence: partial"]));
    expect(repair?.body).toContain("user-attachments");
    expect(repair?.body).not.toContain("02-flow.png");
  });

  it("strips only relative evidence references", () => {
    expect(
      stripUnresolvedReferences("a ![x](01-a.png) [v](02-b.webm) ![y](https://h/01-a.png)"),
    ).toBe("a   ![y](https://h/01-a.png)");
  });
});

describe("the per-repo queue", () => {
  const ok: GhResult = { code: 0, stdout: "", stderr: "" };
  const limited: GhResult = {
    code: 1,
    stdout: "",
    stderr: "You have exceeded a secondary rate limit",
  };

  const clock = (): {
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    slept: number[];
  } => {
    let t = 1_000_000;
    const slept: number[] = [];
    return {
      now: () => t,
      sleep: (ms) => {
        slept.push(ms);
        t += ms;
        return Promise.resolve();
      },
      slept,
    };
  };

  it("serialises writes per repo with at least the minimum interval", async () => {
    const c = clock();
    const queue = createRepoQueue({ now: c.now, sleep: c.sleep });
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3].map((n) =>
        queue.write("o/r", () => {
          order.push(n);
          return Promise.resolve(ok);
        }),
      ),
    );
    expect(order).toEqual([1, 2, 3]);
    expect(c.slept).toEqual([1000, 1000]);
  });

  it("caps mutating calls per hour with rate_limit", async () => {
    const c = clock();
    const queue = createRepoQueue({ now: c.now, sleep: c.sleep, mutatingCallsPerHour: 2 });
    await queue.write("o/r", () => Promise.resolve(ok));
    await queue.write("o/r", () => Promise.resolve(ok));
    await expect(queue.write("o/r", () => Promise.resolve(ok))).rejects.toMatchObject({
      reason: "rate_limit",
    });
    await expect(queue.write("o/other", () => Promise.resolve(ok))).resolves.toEqual(ok);
  });

  it("shares the interval and the hourly cap across processes through VTC's home", async () => {
    const home = tempDir("vtc-home-");
    const pacing = { root: home, dir: join(home, "upstream", "pacing") };
    const c = clock();
    // Two daemons (two queues, nothing shared in memory) writing to the same repo.
    const a = createRepoQueue({ now: c.now, sleep: c.sleep, mutatingCallsPerHour: 3, pacing });
    const b = createRepoQueue({ now: c.now, sleep: c.sleep, mutatingCallsPerHour: 3, pacing });
    await a.write("o/r", () => Promise.resolve(ok));
    await b.write("o/r", () => Promise.resolve(ok));
    expect(c.slept).toEqual([AUTOMATION_LIMITS.minWriteIntervalMs]);
    await a.write("o/r", () => Promise.resolve(ok));
    await expect(b.write("o/r", () => Promise.resolve(ok))).rejects.toMatchObject({
      reason: "rate_limit",
    });
    expect(existsSync(join(home, "upstream", "pacing", "o__r.json"))).toBe(true);
  });

  it("backs off 60 s x 2^n on the secondary limit, then skips with github_rate_limit", async () => {
    const c = clock();
    const queue = createRepoQueue({ now: c.now, sleep: c.sleep, minWriteIntervalMs: 0 });
    let calls = 0;
    await expect(
      queue.write("o/r", () => {
        calls += 1;
        return Promise.resolve(limited);
      }),
    ).rejects.toMatchObject({ reason: "github_rate_limit" });
    expect(calls).toBe(3);
    expect(c.slept).toEqual([60_000, 120_000]);
    let second = 0;
    const result = await queue.write("o/r", () => {
      second += 1;
      return Promise.resolve(second === 1 ? limited : ok);
    });
    expect(result).toEqual(ok);
  });
});

describe("the automation lock", () => {
  it("runs one holder at a time across lock instances, and releases on failure", async () => {
    const dir = tempDir("vtc-lock-");
    const path = join(dir, "o__r.lock");
    const order: string[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withFileLock(path, async () => {
      order.push("first in");
      await held;
      order.push("first out");
    });
    const second = withFileLock(
      path,
      () => {
        order.push("second");
        return Promise.resolve();
      },
      { pollMs: 5 },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(order).toEqual(["first in"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first in", "first out", "second"]);
    await expect(withFileLock(path, () => Promise.reject(new Error("boom")))).rejects.toThrow(
      "boom",
    );
    expect(existsSync(path)).toBe(false);
  });

  it("breaks a lock whose holder is gone, and never follows a symlink", async () => {
    const dir = tempDir("vtc-lock-");
    const path = join(dir, "o__r.lock");
    expect(lockIsStale(`999999999\n${String(Date.now())}\nx\n`, Date.now(), 60_000)).toBe(true);
    expect(
      lockIsStale(`${String(process.pid)}\n${String(Date.now())}\nx\n`, Date.now(), 60_000),
    ).toBe(false);
    writeFileSync(path, `999999999\n${String(Date.now())}\nstale\n`);
    await expect(withFileLock(path, () => Promise.resolve("ran"))).resolves.toBe("ran");
    const target = join(dir, "target");
    writeFileSync(target, "keep");
    const link = join(dir, "link.lock");
    symlinkSync(target, link);
    await expect(
      withFileLock(link, () => Promise.resolve("ran"), { timeoutMs: 50, pollMs: 5 }),
    ).rejects.toThrow();
  });

  it("keeps a slow live holder's lock fresh with its heartbeat", async () => {
    const path = join(tempDir("vtc-lock-"), "o__r.lock");
    const order: string[] = [];
    const first = withFileLock(
      path,
      async () => {
        order.push("first in");
        await new Promise((resolve) => setTimeout(resolve, 900));
        order.push("first out");
      },
      { staleMs: 300 },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = withFileLock(
      path,
      () => {
        order.push("second");
        return Promise.resolve();
      },
      { staleMs: 300, pollMs: 10 },
    );
    await Promise.all([first, second]);
    expect(order).toEqual(["first in", "first out", "second"]);
  });

  it("breaks a stale lock only under the break file, and clears a break file a dead process left", async () => {
    const path = join(tempDir("vtc-lock-"), "o__r.lock");
    writeFileSync(path, `999999999\n${String(Date.now())}\nstale\n`);
    // Another live process is breaking it right now: this waiter leaves the lock alone.
    writeFileSync(`${path}.break`, `${String(process.pid)}\n${String(Date.now())}\n`);
    await expect(
      withFileLock(path, () => Promise.resolve("ran"), { timeoutMs: 50, pollMs: 5 }),
    ).rejects.toThrow("holds the automation lock");
    expect(readFileSync(path, "utf8")).toContain("stale");
    writeFileSync(`${path}.break`, `999999999\n${String(Date.now())}\n`);
    await expect(withFileLock(path, () => Promise.resolve("ran"), { pollMs: 5 })).resolves.toBe(
      "ran",
    );
    expect(existsSync(`${path}.break`)).toBe(false);
    expect(existsSync(path)).toBe(false);
  });
});
