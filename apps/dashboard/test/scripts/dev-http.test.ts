// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkLoopbackRequest,
  isLoopbackOrigin,
  prototypeFile,
  readLimitedBody,
} from "../../scripts/dev-http.ts";

describe("checkLoopbackRequest (AD-5 rule 3 for the dev servers)", () => {
  it("accepts its own loopback Host and the allowed origins", () => {
    expect(checkLoopbackRequest({ host: "127.0.0.1:4310" }, 4310, [])).toBeNull();
    expect(
      checkLoopbackRequest(
        { host: "localhost:4310", origin: "http://127.0.0.1:4300" },
        4310,
        [4310, 4300],
      ),
    ).toBeNull();
  });

  it("refuses a foreign or missing Host, and a foreign Origin", () => {
    expect(checkLoopbackRequest({ host: "attacker.example:4310" }, 4310, [])).not.toBeNull();
    expect(checkLoopbackRequest({}, 4310, [])).not.toBeNull();
    expect(
      checkLoopbackRequest({ host: "127.0.0.1:4310", origin: "http://evil.test" }, 4310, [4300]),
    ).not.toBeNull();
  });

  it("accepts only exact http loopback origins", () => {
    expect(isLoopbackOrigin("http://localhost:4300", 4300)).toBe(true);
    expect(isLoopbackOrigin("http://127.0.0.1:4300/", 4300)).toBe(false);
    expect(isLoopbackOrigin("https://127.0.0.1:4300", 4300)).toBe(false);
    expect(isLoopbackOrigin("null", 4300)).toBe(false);
  });
});

describe("prototypeFile", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("serves files inside the directory, index.html otherwise, and refuses bad escapes", () => {
    dir = mkdtempSync(join(tmpdir(), "vtc-proto-"));
    mkdirSync(join(dir, "app"));
    writeFileSync(join(dir, "index.html"), "<p>i</p>");
    writeFileSync(join(dir, "app", "a.js"), "1");
    expect(prototypeFile(dir, "/app/a.js")).toBe(join(dir, "app", "a.js"));
    expect(prototypeFile(dir, "/reset/")).toBe(join(dir, "index.html"));
    expect(prototypeFile(dir, "/%2e%2e/%2e%2e/etc/passwd")).toBe(join(dir, "index.html"));
    expect(prototypeFile(dir, "/%E0%A4%A")).toBeNull();
    expect(prototypeFile(dir, "/a%00b")).toBeNull();
  });
});

describe("readLimitedBody", () => {
  let server: Server | null = null;
  afterEach(async () => {
    const s = server;
    server = null;
    if (s !== null) {
      s.closeAllConnections();
      await new Promise<void>((done) => {
        s.close(() => {
          done();
        });
      });
    }
  });

  const post = (body: string, max: number): Promise<string | null> =>
    new Promise((done, fail) => {
      let result: string | null = null;
      server = createServer((req, res) => {
        void readLimitedBody(req, max).then((read) => {
          result = read;
          res.writeHead(read === null ? 413 : 200);
          res.end();
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const port = (server?.address() as AddressInfo).port;
        const req = request({ host: "127.0.0.1", port, method: "POST" }, (res) => {
          res.resume();
          res.on("end", () => {
            done(result);
          });
        });
        req.on("error", fail);
        req.end(body);
      });
    });

  it("returns the body up to the limit and null beyond it", async () => {
    expect(await post("héllo", 6)).toBe("héllo");
    expect(await post("x".repeat(64 * 1024), 1024)).toBeNull();
  });
});
