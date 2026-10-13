/**
 * The product ruleset embedded in the binary (§4.4: `gates/` holds MIT rulesets). Mirrors
 * `gates/rules/`; `scanner-pins.test.ts` fails when they differ. Written to the VTC home on
 * first use and passed to Opengrep through the `{rules}` placeholder of a gate command.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Ruleset files by path relative to `gates/rules/`. */
export const PRODUCT_RULES: Readonly<Record<string, string>> = {
  "opengrep/vtc-security.yml":
    '# VTC baseline security rules for Opengrep (spec §7.2 L4). Written for VTC and licensed MIT;\n# no Semgrep-maintained rules are bundled (§7.2 licensing). Embedded in the binary\n# (packages/engine/src/gates/rules.ts mirrors this file; a test keeps them equal).\nrules:\n  - id: vtc.js.eval\n    languages: [javascript, typescript]\n    severity: ERROR\n    message: eval() runs a string as code. Parse the data instead.\n    metadata:\n      category: security\n      cwe: ["CWE-95: Eval Injection"]\n      license: MIT\n    pattern: eval($X)\n  - id: vtc.js.new-function\n    languages: [javascript, typescript]\n    severity: ERROR\n    message: new Function() runs a string as code. Parse the data instead.\n    metadata:\n      category: security\n      cwe: ["CWE-95: Eval Injection"]\n      license: MIT\n    pattern: new Function(...)\n  - id: vtc.js.inner-html\n    languages: [javascript, typescript]\n    severity: WARNING\n    message: Assigning dynamic content to innerHTML allows script injection. Use textContent or a sanitiser.\n    metadata:\n      category: security\n      cwe: ["CWE-79: Cross-site Scripting"]\n      license: MIT\n    patterns:\n      - pattern: $EL.innerHTML = $X\n      - pattern-not: $EL.innerHTML = "..."\n  - id: vtc.js.tls-reject-unauthorized\n    languages: [javascript, typescript]\n    severity: ERROR\n    message: rejectUnauthorized false disables TLS certificate checks.\n    metadata:\n      category: security\n      cwe: ["CWE-295: Improper Certificate Validation"]\n      license: MIT\n    pattern: "{..., rejectUnauthorized: false, ...}"\n  - id: vtc.py.subprocess-shell\n    languages: [python]\n    severity: ERROR\n    message: shell=True passes the command through a shell. Pass an argument list without a shell.\n    metadata:\n      category: security\n      cwe: ["CWE-78: OS Command Injection"]\n      license: MIT\n    pattern: subprocess.$FUNC(..., shell=True, ...)\n  - id: vtc.py.yaml-unsafe-load\n    languages: [python]\n    severity: ERROR\n    message: yaml.load without a safe Loader can construct arbitrary objects. Use yaml.safe_load.\n    metadata:\n      category: security\n      cwe: ["CWE-502: Deserialization of Untrusted Data"]\n      license: MIT\n    patterns:\n      - pattern: yaml.load(...)\n      - pattern-not: yaml.load(..., Loader=yaml.SafeLoader, ...)\n      - pattern-not: yaml.load(..., Loader=yaml.CSafeLoader, ...)\n  - id: vtc.py.pickle-loads\n    languages: [python]\n    severity: WARNING\n    message: Unpickling untrusted data runs arbitrary code.\n    metadata:\n      category: security\n      cwe: ["CWE-502: Deserialization of Untrusted Data"]\n      license: MIT\n    pattern-either:\n      - pattern: pickle.loads(...)\n      - pattern: pickle.load(...)\n  - id: vtc.go.tls-insecure-skip-verify\n    languages: [go]\n    severity: ERROR\n    message: InsecureSkipVerify disables TLS certificate checks.\n    metadata:\n      category: security\n      cwe: ["CWE-295: Improper Certificate Validation"]\n      license: MIT\n    pattern: "tls.Config{..., InsecureSkipVerify: true, ...}"\n',
};

/** Hash of the ruleset: its directory name under the VTC home, so a new release never mixes sets. */
export const rulesHash = (rules: Readonly<Record<string, string>> = PRODUCT_RULES): string => {
  const hash = createHash("sha256");
  for (const name of Object.keys(rules).sort())
    hash.update(`${name}\u0000${rules[name] ?? ""}\u0000`);
  return hash.digest("hex").slice(0, 16);
};

/** Writes the ruleset under `<vtcHome>/rules/<hash>/` (once) and returns that directory. */
export const ensureRules = (
  vtcHome: string,
  rules: Readonly<Record<string, string>> = PRODUCT_RULES,
): string => {
  const dir = join(vtcHome, "rules", rulesHash(rules));
  for (const [name, content] of Object.entries(rules)) {
    const file = join(dir, name);
    if (existsSync(file) && readFileSync(file, "utf8") === content) continue;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, content, { mode: 0o600 });
  }
  return dir;
};
