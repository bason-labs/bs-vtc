/**
 * Engine discovery file (AD-12): `~/.vtc/engines/<repo-key>.json`, mode 0600. The running
 * daemon publishes its port and MCP socket here; the stdio bridge, `vtc dashboard` and the
 * statusline shim find it here. It holds no secret.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { engineDiscoveryFile, EngineDiscoverySchema, type EngineDiscovery } from "@vtc/shared";

export const engineDiscoveryPath = (vtcHome: string, repoRoot: string): string =>
  join(vtcHome, engineDiscoveryFile(repoRoot));

/** Atomically writes the discovery file (temp file + rename) with mode 0600. */
export const writeEngineDiscovery = (vtcHome: string, info: EngineDiscovery): string => {
  const record = EngineDiscoverySchema.parse(info);
  const path = engineDiscoveryPath(vtcHome, record.repo_root);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${String(record.pid)}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
  return path;
};

/** The repo's discovery record, or `null` when there is none or it is invalid. */
export const readEngineDiscovery = (vtcHome: string, repoRoot: string): EngineDiscovery | null => {
  try {
    const raw: unknown = JSON.parse(readFileSync(engineDiscoveryPath(vtcHome, repoRoot), "utf8"));
    const parsed = EngineDiscoverySchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/** Removes the discovery file if it still names `pid` (a newer engine's file is left alone). */
export const removeEngineDiscovery = (vtcHome: string, repoRoot: string, pid: number): void => {
  const current = readEngineDiscovery(vtcHome, repoRoot);
  if (current?.pid !== pid) return;
  try {
    unlinkSync(engineDiscoveryPath(vtcHome, repoRoot));
  } catch {
    // already gone
  }
};
