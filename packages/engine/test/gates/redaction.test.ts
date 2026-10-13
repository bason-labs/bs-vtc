/**
 * The redaction rules the gate-runner team owns (`packages/shared/src/helpers/redaction.ts`,
 * AD-18): token formats added for gate evidence, secret assignments, and what stays readable.
 */
import { redactSecrets } from "@vtc/shared";
import { describe, expect, it } from "vitest";
import { knownSecretValues } from "../../src/gates/index.js";
import { tempDir, writeFile, cleanupDirs } from "../helpers/repo.js";
import { afterEach } from "vitest";

afterEach(cleanupDirs);

describe("redactSecrets: gate evidence formats", () => {
  const planted = [
    ["npm_" + "a1B2c3D4".repeat(4) + "e5F6", "npm_token"],
    ["pypi-AgEIcHlwaS5vcmc" + "x".repeat(60), "pypi_token"],
    ["hf_" + "Q".repeat(34), "huggingface_token"],
    ["SG." + "a".repeat(22) + "." + "b".repeat(43), "sendgrid_key"],
  ] as const;
  it.each(planted)("redacts %s as %s", (secret, kind) => {
    const out = redactSecrets(`value ${secret} end`);
    expect(out).toBe(`value [REDACTED:${kind}] end`);
  });

  it("redacts values assigned to secret-named keys and keeps the key", () => {
    expect(redactSecrets("DB_PASSWORD=hunter2hunter2")).toBe(
      "DB_PASSWORD=[REDACTED:secret_assignment]",
    );
    expect(redactSecrets('{"api_key": "abc123def456"}')).toBe(
      '{"api_key": "[REDACTED:secret_assignment]"}',
    );
    expect(redactSecrets("client_secret: s3cr3t-value-x")).toBe(
      "client_secret: [REDACTED:secret_assignment]",
    );
  });

  it("leaves code, short values and already-redacted markers alone", () => {
    for (const text of [
      "const apiKey = config.apiKey;",
      "password: process.env.DB_PASSWORD",
      "secret=short1",
      "token=[REDACTED:known_value]",
      "SECRET=[REDACTED:known_value]",
      "expected 404 to be 400 at tests/api.test.ts:12:5",
    ]) {
      expect(redactSecrets(text)).toBe(text);
    }
  });
});

describe("redactSecrets: linear time on agent-controlled text", () => {
  const SIZE = 200_000;
  const inputs: readonly (readonly [string, string])[] = [
    ["whitespace", " ".repeat(SIZE)],
    ["tabs and newlines", "\t \n".repeat(SIZE / 3)],
    ["a bearer prefix before whitespace", `Authorization: Bearer${" ".repeat(SIZE)}x`],
    ["a secret key before whitespace", `password${" ".repeat(SIZE)}= value123456`],
    ["repeated secret keys", "password=".repeat(SIZE / 9)],
    ["repeated key headers", "-----BEGIN RSA PRIVATE KEY-----\n".repeat(SIZE / 32)],
    ["repeated url schemes", "a://".repeat(SIZE / 4)],
  ];
  it.each(inputs)("redacts 200 KB of %s in under 100 ms", (_name, text) => {
    redactSecrets("warm-up password=abc123def456 Bearer abcdefghijklmnopqrstuvwxyz");
    const started = performance.now();
    redactSecrets(text);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it("still redacts bearer tokens and assignments with bounded separators", () => {
    expect(redactSecrets("Bearer\tabcdefghijklmnopqrstuvwxyz0123")).toBe(
      "Bearer\t[REDACTED:bearer_token]",
    );
    expect(redactSecrets("api_key :  'abc123def456'")).toBe(
      "api_key :  '[REDACTED:secret_assignment]'",
    );
  });
});

describe("knownSecretValues", () => {
  it("collects .env* values from the repo and checkout tops plus scanner matches", () => {
    const repo = tempDir();
    const checkout = tempDir();
    writeFile(repo, ".env", "TOKEN=from-dot-env-1\n");
    writeFile(repo, ".env.local", "OTHER=from-env-local-2\n");
    writeFile(checkout, ".env.production", "PROD=from-production-3\n");
    writeFile(repo, "sub/.env", "NESTED=not-read-here-4\n");
    expect(
      knownSecretValues([repo, checkout, "/does/not/exist"], [" scanner-secret-5 "]).sort(),
    ).toEqual(["from-dot-env-1", "from-env-local-2", "from-production-3", "scanner-secret-5"]);
  });
});
