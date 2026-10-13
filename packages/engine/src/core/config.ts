/**
 * Project configuration (§4.3): `.vtc/project.yaml` (caps, budgets, merge level, dispatch mode,
 * concurrency…) and `.vtc/gates.yml` (calibrated gates and the test layout). Readers of persisted,
 * git-shared data (AD-3 rule 2): unknown keys a newer vtc wrote are dropped, everything else is
 * validated. A missing project.yaml means every spec default; a broken one is an error, never a
 * silent default.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  GatesConfigSchema,
  parsePersisted,
  ProjectConfigSchema,
  type GatesConfig,
  type GitOps,
  type ProjectConfig,
} from "@vtc/shared";
import { parseYaml } from "./yaml.js";

export const PROJECT_CONFIG_PATH = ".vtc/project.yaml";
export const GATES_CONFIG_PATH = ".vtc/gates.yml";

export class ConfigError extends Error {
  constructor(
    readonly path: string,
    detail: string,
  ) {
    super(`${path}: ${detail}`);
    this.name = "ConfigError";
  }
}

const readDoc = (repoRoot: string, path: string): unknown => {
  const text = readFileSync(join(repoRoot, path), "utf8");
  try {
    return parseYaml(text);
  } catch (error) {
    throw new ConfigError(path, error instanceof Error ? error.message : String(error));
  }
};

const issues = (error: {
  issues: readonly { path: readonly PropertyKey[]; message: string }[];
}): string =>
  error.issues.map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`).join("; ");

export const loadProjectConfig = (repoRoot: string): ProjectConfig => {
  if (!existsSync(join(repoRoot, PROJECT_CONFIG_PATH)))
    return ProjectConfigSchema.parse({ version: 1 });
  const parsed = parsePersisted(ProjectConfigSchema, readDoc(repoRoot, PROJECT_CONFIG_PATH) ?? {});
  if (!parsed.success) throw new ConfigError(PROJECT_CONFIG_PATH, issues(parsed.error));
  return parsed.data;
};

/** Parses `gates.yml` text (as `vtc calibrate` writes it); throws {@link ConfigError}. */
export const parseGatesConfig = (text: string): GatesConfig => {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (error) {
    throw new ConfigError(
      GATES_CONFIG_PATH,
      error instanceof Error ? error.message : String(error),
    );
  }
  const parsed = parsePersisted(GatesConfigSchema, doc);
  if (!parsed.success) throw new ConfigError(GATES_CONFIG_PATH, issues(parsed.error));
  return parsed.data;
};

/**
 * The working tree's `gates.yml`, or `null` before `vtc calibrate` has run. Only for noticing an
 * edit during a run (reading 20): what a run verifies with is the committed file
 * ({@link committedGatesConfig}, spine §5 reading 46f).
 */
export const loadGatesConfig = (repoRoot: string): GatesConfig | null => {
  if (!existsSync(join(repoRoot, GATES_CONFIG_PATH))) return null;
  return parseGatesConfig(readFileSync(join(repoRoot, GATES_CONFIG_PATH), "utf8"));
};

/** SHA-256 of a `gates.yml`'s raw bytes: `GateRunRequest.gates_config_hash` (reading 46b). */
export const gatesConfigHash = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

/** A `gates.yml` as committed: the parsed config and the hash of its bytes. */
export interface CommittedGates {
  readonly config: GatesConfig;
  readonly sha256: string;
}

/**
 * `.vtc/gates.yml` at a commit (spine §5 reading 46f: never the working tree), or `null` when that
 * commit has none. Throws {@link ConfigError} when it does not parse.
 */
export const committedGatesConfig = async (
  git: Pick<GitOps, "readFileAtCommit">,
  commit: string,
): Promise<CommittedGates | null> => {
  const bytes = await git.readFileAtCommit(commit, GATES_CONFIG_PATH);
  if (bytes === undefined) return null;
  return {
    config: parseGatesConfig(new TextDecoder().decode(bytes)),
    sha256: gatesConfigHash(bytes),
  };
};

/** Where QA author mode writes acceptance tests before calibration confirmed a layout. */
export const DEFAULT_ACCEPTANCE_GLOBS = ["tests/acceptance/**", "test/acceptance/**"] as const;

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
};

/** Hash of the composed pipeline config in force (§13 trace data, `Run.pipeline_config_hash`). */
export const pipelineConfigHash = (config: ProjectConfig, gates: GatesConfig | null): string =>
  createHash("sha256")
    .update(JSON.stringify(canonical({ project: config, gates })))
    .digest("hex");
