/**
 * Pinned scanners' arguments (§7.2 L4, §15): they come from repo content and no human confirms
 * them, so only known flags run, every path stays in the checkout and nothing goes online.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkScannerArgs, detectToolchain, scannerArgsProblem } from "../../src/gates/index.js";
import { cleanupDirs, tempDir, writeFile } from "../helpers/repo.js";
import { afterEach } from "vitest";

afterEach(cleanupDirs);

const ctx = { checkoutAbs: "/work/checkout", cwd: "/work/checkout" };
const problem = (scanner: string, args: string[]): string | null =>
  scannerArgsProblem(scanner, args, ctx);

describe("checkScannerArgs", () => {
  it("accepts what vtc calibrate proposes", () => {
    const root = tempDir("vtc-scan-");
    writeFile(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    writeFile(root, "src/a.ts", "export const a = 1;\n");
    writeFile(root, "infra/main.tf", 'resource "x" "y" {}\n');
    const scanners = ["gitleaks", "osv-scanner", "opengrep", "checkov"];
    const gates = detectToolchain(root, { scanners }).gates.filter((g) =>
      scanners.includes(g.command[0] ?? ""),
    );
    expect(gates.map((g) => g.id)).toEqual(["secrets", "sast", "dependencies", "iac"]);
    for (const g of gates) {
      const [name = "", ...args] = g.command;
      expect(checkScannerArgs(name, args, ctx)).toMatchObject({ ok: true });
    }
  });

  it("keeps osv-scanner offline", () => {
    expect(problem("osv-scanner", ["scan", "source", "-r", "."])).toMatch(/--offline/);
    expect(problem("osv-scanner", ["scan", "source", "--offline=false", "-r", "."])).toMatch(
      /--offline/,
    );
    expect(problem("osv-scanner", ["scan", "--offline=true", "-r", "."])).toBeNull();
    expect(
      problem("osv-scanner", ["scan", "--offline", "--download-offline-databases", "."]),
    ).toMatch(/not supported/);
  });

  it("takes Opengrep rules only from local files, under every alias", () => {
    for (const flag of ["--config", "-c", "-f"]) {
      expect(problem("opengrep", ["scan", flag, "https://example.com/r.yml", "."])).toMatch(
        /never the network/,
      );
      expect(problem("opengrep", ["scan", flag, "p/default", "."])).toMatch(/never the network/);
      expect(problem("opengrep", ["scan", flag, "auto", "."])).toMatch(/never the network/);
      expect(problem("opengrep", ["scan", flag, "{rules}/opengrep", "."])).toBeNull();
    }
    expect(problem("opengrep", ["scan", "--config=r/python", "."])).toMatch(/never the network/);
    expect(problem("opengrep", ["scan", "--config", "missing.yml", "."])).toMatch(/file in the/);
  });

  it("lets no scanner write or read outside the checkout", () => {
    expect(problem("opengrep", ["scan", "--text", "--output", "/home/u/.zshrc", "."])).toMatch(
      /inside the checkout/,
    );
    expect(problem("opengrep", ["scan", "--sarif-output=../../x.sarif", "."])).toMatch(
      /inside the checkout/,
    );
    expect(problem("gitleaks", ["dir", ".", "--report-path", "../out.json"])).toMatch(
      /inside the checkout/,
    );
    expect(problem("checkov", ["-d", ".", "--output-file-path", "/tmp/x"])).toMatch(
      /inside the checkout/,
    );
    expect(problem("gitleaks", ["dir", "/home/u/.ssh"])).toMatch(/inside the checkout/);
    const ok = checkScannerArgs("gitleaks", ["dir", ".", "-r", ".vtc/state/g.json"], {
      checkoutAbs: ctx.checkoutAbs,
      cwd: join(ctx.checkoutAbs, "sub"),
    });
    expect(ok).toEqual({ ok: true, outputs: ["sub/.vtc/state/g.json"], configs: [] });
  });

  it("refuses unknown flags: repo config, external checks, git options", () => {
    expect(problem("checkov", ["-d", ".", "--external-checks-dir", "checks"])).toMatch(
      /not supported/,
    );
    expect(problem("checkov", ["-d", ".", "--config-file", ".checkov.yaml"])).toMatch(
      /not supported/,
    );
    expect(problem("gitleaks", ["git", ".", "--log-opts=--output=/tmp/x"])).toMatch(/commit range/);
    expect(problem("gitleaks", ["git", ".", "--config", "evil.toml"])).toMatch(/not supported/);
    expect(problem("gitleaks", ["protect"])).toMatch(/runs only as/);
    expect(problem("opengrep", ["ci"])).toMatch(/runs only as/);
    expect(problem("opengrep", ["scan", "--autofix", "."])).toMatch(/not supported/);
    expect(problem("gitleaks", ["git", ".", "--no-banner=false"])).toMatch(/takes no value/);
  });
});
