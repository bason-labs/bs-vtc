/**
 * Replay arm plugins (D-cg, spine §5 reading 201; `ArmPluginCompiler` in @vtc/shared).
 *
 * A Claude Code headless run loads the compiled agent, so a Lookback replay arm cannot hand it a
 * candidate prompt through the task pack. Instead each arm gets its own plugin directory: a full
 * copy of the shipped `vtc` plugin in which only `agents/<agent>.md`'s editable section differs.
 * The adapter runs it with `claude -p --plugin-dir <arm dir> --agent vtc:<agent>`.
 *
 * - The manifest keeps `name: "vtc"`, so `--agent vtc:<agent>` and every `vtc:` reference resolve
 *   unchanged; its `version` is `arm-<sha12>` of the directory's content ({@link armPluginVersion}),
 *   so two arms with the same section get the same version and an A/A pair is byte-identical.
 * - The agent's locked part (frontmatter, locked core, contract, protocol) is copied verbatim;
 *   the base agent must still hash to its manifest `prompt_sha256` and its locked asset to
 *   `locked_sha256`, so a tampered base is refused rather than replayed.
 * - An `editable_in_pack` agent carries no editable section: its arm's section reaches it through
 *   the task pack's `Role heuristics`, so its agent file is copied unchanged.
 * - The candidate section must pass the shared `editableSectionErrors` and the AD-9 marker check,
 *   exactly as a compiled section would.
 * - Every write lands inside `outDir`: the base tree is read without following links (a link in
 *   it is refused), `outDir` must be a real, empty directory, every file is created exclusively
 *   with `O_NOFOLLOW`, and the written tree is walked again to prove it holds no link and nothing
 *   resolves outside. Nothing runs the real `claude`.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import {
  editableSectionErrors,
  effectivePromptSha,
  parsePersisted,
  PLUGIN_MANIFEST_ASSET,
  PluginManifestSchema,
  promptShaFor,
  rolePromptAssetPath,
  sha256Hex,
  type ArmPlugin,
  type ArmPluginCompiler,
  type ArmPluginRequest,
  type PluginManifestAgent,
} from "@vtc/shared";
import { checkPluginFiles } from "./checks.js";
import { PLUGIN_NAME } from "./hosts.js";
import { readRegularFile } from "./io.js";

/** The Claude Code plugin manifest, relative to the plugin root (`HOST_PLUGIN_FILES`). */
export const CLAUDE_PLUGIN_JSON = ".claude-plugin/plugin.json";

/** The only host whose headless run loads the compiled agent, and so needs arm plugins. */
export const ARM_PLUGIN_HOST = "claude-code";

export interface ArmPluginCompilerOptions {
  /** The shipped compiled Claude Code plugin on disk (the cli's `pluginDir("claude-code")`). */
  readonly pluginDir: string;
}

/** One file of a plugin tree, by POSIX path relative to the plugin root. */
export interface PluginTreeFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

const byPath = (a: { path: string }, b: { path: string }): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

const bytesSha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * Pure: an arm plugin's manifest version, `arm-<first 12 hex>` of a SHA-256 over every file but
 * the manifest itself (which holds the version): one `<path>\0<sha256 of the bytes>\n` line per
 * file, sorted by path.
 */
export const armPluginVersion = (files: readonly PluginTreeFile[]): string => {
  const lines = files
    .filter((f) => f.path !== CLAUDE_PLUGIN_JSON)
    .sort(byPath)
    .map((f) => `${f.path}\0${bytesSha(f.bytes)}\n`);
  return `arm-${sha256Hex(lines.join("")).slice(0, 12)}`;
};

/** Every regular file under `dir`, sorted; a symbolic link or any other entry is refused. */
export const readPluginTree = (dir: string): PluginTreeFile[] => {
  const files: PluginTreeFile[] = [];
  const walk = (rel: string): void => {
    for (const name of readdirSync(rel === "" ? dir : join(dir, rel)).sort()) {
      const path = rel === "" ? name : `${rel}/${name}`;
      const stat = lstatSync(join(dir, path));
      if (stat.isSymbolicLink()) {
        throw new Error(`refusing to copy ${path}: the base plugin holds a symbolic link`);
      }
      if (stat.isDirectory()) {
        walk(path);
        continue;
      }
      const bytes = stat.isFile() ? readRegularFile(join(dir, path)) : undefined;
      if (bytes === undefined) throw new Error(`refusing to copy ${path}: not a regular file`);
      files.push({ path, bytes });
    }
  };
  walk("");
  return files.sort(byPath);
};

const decoder = new TextDecoder("utf-8", { fatal: true });

const textOf = (files: readonly PluginTreeFile[], path: string): string => {
  const file = files.find((f) => f.path === path);
  if (file === undefined) throw new Error(`the base plugin has no ${path}`);
  return decoder.decode(file.bytes);
};

const FRONTMATTER = /^---\n[\s\S]*?\n---\n\n/;

/**
 * Pure: the arm's agent file. The base file's instructions (the text after its frontmatter) must
 * hash to the manifest's `prompt_sha256` and end with the compiled default section; that section
 * is replaced by `editable` and nothing else changes. An `editable_in_pack` agent is returned
 * unchanged.
 */
export const armAgentFile = (
  agent: PluginManifestAgent,
  agentFile: string,
  defaultEditable: string,
  editable: string,
): string => {
  const front = FRONTMATTER.exec(agentFile)?.[0];
  if (front === undefined) throw new Error(`${agent.file}: no agent frontmatter`);
  const instructions = agentFile.slice(front.length);
  if (promptShaFor(instructions) !== agent.prompt_sha256) {
    throw new Error(`${agent.file}: its instructions no longer match the manifest's prompt_sha256`);
  }
  if (agent.editable_in_pack === true) return agentFile;
  const section = defaultEditable.trim();
  if (section === "" || !instructions.endsWith(`\n${section}`)) {
    throw new Error(`${agent.file}: the compiled editable section is not where the agent ends`);
  }
  return `${front}${instructions.slice(0, instructions.length - section.length)}${editable.trim()}`;
};

/** Throws unless `outDir` is absolute and is (or now is) a real, empty directory. */
const prepareOutDir = (outDir: string): void => {
  if (!isAbsolute(outDir)) throw new Error(`outDir must be an absolute path: ${outDir}`);
  let stat;
  try {
    stat = lstatSync(outDir);
  } catch {
    mkdirSync(outDir, { recursive: true });
    stat = lstatSync(outDir);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`outDir must be a real directory, not a symbolic link: ${outDir}`);
  }
  if (readdirSync(outDir).length > 0) throw new Error(`outDir must be empty: ${outDir}`);
};

const NEW_FILE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

/** Writes `files` into the empty `outDir`, creating each directory and file exclusively. */
const writeTree = (outDir: string, files: readonly PluginTreeFile[]): void => {
  const made = new Set<string>();
  for (const file of files) {
    const parts = file.path.split("/");
    for (let i = 1; i < parts.length; i += 1) {
      const dir = parts.slice(0, i).join("/");
      if (made.has(dir)) continue;
      mkdirSync(join(outDir, dir));
      made.add(dir);
    }
    const fd = openSync(join(outDir, file.path), NEW_FILE, 0o644);
    try {
      writeSync(fd, file.bytes);
    } finally {
      closeSync(fd);
    }
  }
};

/** Walks the written tree: no symbolic link, nothing outside `outDir`, exactly `count` files. */
const assertContained = (outDir: string, count: number): void => {
  const root = realpathSync(outDir);
  let files = 0;
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      const inside = relative(root, realpathSync(path));
      if (stat.isSymbolicLink() || inside.startsWith("..") || isAbsolute(inside)) {
        throw new Error(`arm plugin entry ${relative(root, path)} leaves ${outDir}`);
      }
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) files += 1;
      else throw new Error(`arm plugin entry ${relative(root, path)} is not a regular file`);
    }
  };
  walk(root);
  if (files !== count) {
    throw new Error(`arm plugin holds ${String(files)} files, expected ${String(count)}`);
  }
};

const isCleanPath = (path: string): boolean =>
  !path.includes("\\") && path.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");

/** Builds the arm's files in memory and checks everything before anything is written. */
const armFiles = (
  base: readonly PluginTreeFile[],
  request: ArmPluginRequest,
): { readonly files: PluginTreeFile[]; readonly version: string; readonly locked: string } => {
  const parsed = parsePersisted(
    PluginManifestSchema,
    JSON.parse(textOf(base, PLUGIN_MANIFEST_ASSET)) as unknown,
  );
  if (!parsed.success) throw new Error(`${PLUGIN_MANIFEST_ASSET} does not match PluginManifest`);
  const manifest = parsed.data;
  if (manifest.host !== ARM_PLUGIN_HOST || manifest.plugin !== PLUGIN_NAME) {
    throw new Error(`the base plugin must be the ${PLUGIN_NAME} plugin for ${ARM_PLUGIN_HOST}`);
  }
  const pluginJson = JSON.parse(textOf(base, CLAUDE_PLUGIN_JSON)) as unknown;
  if (
    typeof pluginJson !== "object" ||
    pluginJson === null ||
    (pluginJson as { name?: unknown }).name !== PLUGIN_NAME
  ) {
    throw new Error(`${CLAUDE_PLUGIN_JSON} must name the plugin ${PLUGIN_NAME}`);
  }
  const agent = manifest.agents.find((a) => a.name === request.agent);
  if (agent === undefined) throw new Error(`the base plugin has no agent ${request.agent}`);
  if (!isCleanPath(agent.file) || agent.file !== `agents/${agent.name}.md`) {
    throw new Error(`agent ${agent.name} has an unexpected file ${agent.file}`);
  }
  const locked = textOf(base, rolePromptAssetPath(agent.name, "locked"));
  if (agent.locked_sha256 !== undefined && sha256Hex(locked.trim()) !== agent.locked_sha256) {
    throw new Error(`agent ${agent.name}: its locked asset no longer matches locked_sha256`);
  }
  const defaultEditable = textOf(base, rolePromptAssetPath(agent.name, "editable"));
  const agentText = armAgentFile(
    agent,
    textOf(base, agent.file),
    defaultEditable,
    request.editable,
  );
  const violations = checkPluginFiles([{ path: agent.file, text: agentText }]);
  if (violations.length > 0) {
    throw new Error(
      `the editable section carries an AD-9 marker: ${violations.map((v) => v.marker).join(", ")}`,
    );
  }
  const copied = base
    .filter((f) => f.path !== CLAUDE_PLUGIN_JSON)
    .map((f) => (f.path === agent.file ? { path: f.path, bytes: Buffer.from(agentText) } : f));
  const version = armPluginVersion(copied);
  const manifestJson = `${JSON.stringify({ ...pluginJson, version }, null, 2)}\n`;
  return {
    files: [...copied, { path: CLAUDE_PLUGIN_JSON, bytes: Buffer.from(manifestJson) }].sort(byPath),
    version,
    locked,
  };
};

const compileArmSync = (
  options: ArmPluginCompilerOptions,
  request: ArmPluginRequest,
): ArmPlugin => {
  if (request.host !== ARM_PLUGIN_HOST) {
    throw new Error(
      `arm plugins are for ${ARM_PLUGIN_HOST}, whose headless run loads the compiled agent; a ${request.host} replay passes its prompt without one`,
    );
  }
  const editable = request.editable.trim();
  const problems =
    editable === "" ? ["the editable section is empty"] : editableSectionErrors(editable);
  if (problems.length > 0) {
    throw new Error(`refusing the arm's editable section: ${problems.join("; ")}`);
  }
  const built = armFiles(readPluginTree(options.pluginDir), { ...request, editable });
  prepareOutDir(request.outDir);
  try {
    writeTree(request.outDir, built.files);
    assertContained(request.outDir, built.files.length);
  } catch (error) {
    for (const entry of readdirSync(request.outDir)) {
      rmSync(join(request.outDir, entry), { recursive: true, force: true });
    }
    throw error;
  }
  return {
    dir: request.outDir,
    version: built.version,
    promptSha256: effectivePromptSha(built.locked, editable),
  };
};

/**
 * The `ArmPluginCompiler` the cli binds to the shipped Claude Code plugin and injects as
 * `EngineDeps.armPlugins`. Each call reads the base plugin afresh, so an upgraded install is
 * picked up without a restart.
 */
export const createArmPluginCompiler = (options: ArmPluginCompilerOptions): ArmPluginCompiler => ({
  compileArm: (request) =>
    new Promise((resolve) => {
      resolve(compileArmSync(options, request));
    }),
});
