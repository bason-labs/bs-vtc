/**
 * JUnit XML reports (§7.2 L2): the test records of one run. Accepts a `<testsuites>` or a bare
 * `<testsuite>` root, as written by Vitest, Jest (jest-junit), pytest, gotestsum, Maven and
 * Gradle. Pure.
 *
 * **Test ids.** A test's id is `<classname> > <name>` when the runner sets a `classname` that the
 * name does not already start with (Vitest sets the file path, pytest the dotted module), else
 * `<name>`. REQ tags in the name (`[REQ-3.AC-2]`) therefore appear in the id (§7.4).
 */
import type { TestRecord } from "@vtc/shared";
import { findAll, parseXml, type XmlElement } from "./xml.js";

export interface JunitCase extends TestRecord {
  /** The case's source file, when the runner reports one (`file` attribute, or a path classname). */
  readonly file?: string;
  /** Failure or error message text (raw; redact before writing it anywhere git-tracked). */
  readonly message?: string;
}

export const junitTestId = (classname: string | undefined, name: string): string => {
  const cls = classname?.trim() ?? "";
  const n = name.trim();
  if (cls === "" || cls === n || n.startsWith(`${cls} `)) return n;
  return `${cls} > ${n}`;
};

const looksLikePath = (value: string): boolean =>
  /\.[A-Za-z0-9]+$/.test(value) && value.includes("/");

const assertionsOf = (element: XmlElement): number | null => {
  const raw = element.attrs.assertions;
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
};

const caseOf = (element: XmlElement): JunitCase | null => {
  const name = element.attrs.name;
  if (name === undefined || name.trim() === "") return null;
  const classname = element.attrs.classname;
  const id = junitTestId(classname, name).slice(0, 500);
  const child = (n: string): XmlElement | undefined => element.children.find((c) => c.name === n);
  const failure = child("failure");
  const error = child("error");
  const skipped = child("skipped");
  const status: TestRecord["status"] =
    failure !== undefined
      ? "fail"
      : error !== undefined
        ? "error"
        : skipped !== undefined
          ? "skipped"
          : "pass";
  const problem = failure ?? error;
  const message =
    problem === undefined
      ? undefined
      : [problem.attrs.message ?? "", problem.text.trim()].filter((s) => s !== "").join("\n");
  const file =
    element.attrs.file ??
    (classname !== undefined && looksLikePath(classname) ? classname : undefined);
  return {
    id,
    status,
    assertions: assertionsOf(element),
    ...(file === undefined ? {} : { file }),
    ...(message === undefined || message === "" ? {} : { message }),
  };
};

const rank: Readonly<Record<TestRecord["status"], number>> = {
  error: 3,
  fail: 2,
  pass: 1,
  skipped: 0,
};

/**
 * Parses a JUnit report into test cases, sorted by id without duplicates. A test reported more
 * than once (retries, parametrised duplicates) keeps its worst status and the smallest assertion
 * count, so a retry can never hide a failure.
 */
export const parseJunit = (xml: string): JunitCase[] => {
  const root = parseXml(xml);
  if (root.name !== "testsuites" && root.name !== "testsuite") {
    throw new Error(`not a JUnit report: root element <${root.name}>`);
  }
  const byId = new Map<string, JunitCase>();
  for (const element of findAll(root, "testcase")) {
    const parsed = caseOf(element);
    if (parsed === null) continue;
    const seen = byId.get(parsed.id);
    if (seen === undefined) {
      byId.set(parsed.id, parsed);
      continue;
    }
    const worse = rank[parsed.status] > rank[seen.status] ? parsed : seen;
    const assertions =
      seen.assertions === null || parsed.assertions === null
        ? (seen.assertions ?? parsed.assertions)
        : Math.min(seen.assertions, parsed.assertions);
    const file = worse.file ?? seen.file ?? parsed.file;
    byId.set(parsed.id, { ...worse, assertions, ...(file === undefined ? {} : { file }) });
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
};
