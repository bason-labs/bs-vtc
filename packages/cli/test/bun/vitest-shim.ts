/**
 * The part of Vitest's API the engine's Storage contract suite uses (`describe`, `it`,
 * `afterEach`, `expect` with `toBe`, `toEqual`, `toBeUndefined`, `toBeInstanceOf`, `toContain`,
 * `toThrow`), for running that suite unchanged inside a `bun build --compile` binary, where
 * Vitest cannot run. The binary build maps `vitest` to this module (`scripts/build-binary.ts`).
 */
type Fn = () => unknown;

interface Scope {
  readonly name: string;
  readonly parent: Scope | null;
  readonly afterEach: Fn[];
}

interface Test {
  readonly name: string;
  readonly scope: Scope;
  readonly fn: Fn;
}

const root: Scope = { name: "", parent: null, afterEach: [] };
let current = root;
const tests: Test[] = [];

export const describe = (name: string, fn: () => void): void => {
  const parent = current;
  current = { name, parent, afterEach: [] };
  try {
    fn();
  } finally {
    current = parent;
  }
};

export const it = (name: string, fn: Fn): void => {
  tests.push({ name, scope: current, fn });
};

export const afterEach = (fn: Fn): void => {
  current.afterEach.push(fn);
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Vitest's `toEqual`: recursive, ignores prototypes and `undefined` properties. */
const equal = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (!isObject(a) || !isObject(b)) return false;
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (!(ArrayBuffer.isView(a) && ArrayBuffer.isView(b))) return false;
    const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    return x.length === y.length && x.every((v, i) => v === y[i]);
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = (o: Record<string, unknown>): string[] =>
    Object.keys(o).filter((k) => o[k] !== undefined);
  const ka = keys(a);
  const kb = keys(b);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && equal(a[k], b[k]));
};

const show = (v: unknown): string => {
  try {
    return JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? `${String(x)}n` : x));
  } catch {
    return String(v);
  }
};

const fail = (message: string): never => {
  throw new Error(message);
};

export const expect = (actual: unknown) => ({
  toBe: (expected: unknown): void => {
    if (!Object.is(actual, expected)) fail(`expected ${show(actual)} to be ${show(expected)}`);
  },
  toEqual: (expected: unknown): void => {
    if (!equal(actual, expected)) fail(`expected ${show(actual)} to equal ${show(expected)}`);
  },
  toBeUndefined: (): void => {
    if (actual !== undefined) fail(`expected ${show(actual)} to be undefined`);
  },
  toBeInstanceOf: (type: abstract new (...args: never[]) => unknown): void => {
    if (!(actual instanceof type)) fail(`expected ${show(actual)} to be a ${type.name}`);
  },
  toContain: (item: unknown): void => {
    const ok =
      typeof actual === "string"
        ? typeof item === "string" && actual.includes(item)
        : Array.isArray(actual) && actual.some((x) => Object.is(x, item));
    if (!ok) fail(`expected ${show(actual)} to contain ${show(item)}`);
  },
  toThrow: (expected?: string | RegExp): void => {
    if (typeof actual !== "function") fail("toThrow needs a function");
    try {
      (actual as () => unknown)();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (typeof expected === "string" && !message.includes(expected))
        fail(`expected the error "${message}" to include "${expected}"`);
      if (expected instanceof RegExp && !expected.test(message))
        fail(`expected the error "${message}" to match ${String(expected)}`);
      return;
    }
    fail("expected the function to throw");
  },
});

const fullName = (test: Test): string => {
  const names: string[] = [test.name];
  for (let s: Scope | null = test.scope; s !== null; s = s.parent)
    if (s.name !== "") names.unshift(s.name);
  return names.join(" > ");
};

/** Runs every registered test in order (TAP-style lines on stdout); resolves the failure count. */
export const runRegistered = async (write: (line: string) => void): Promise<number> => {
  let failures = 0;
  write(`1..${String(tests.length)}`);
  for (const [i, test] of tests.entries()) {
    let error: unknown = null;
    try {
      await test.fn();
    } catch (e) {
      error = e;
    }
    for (let s: Scope | null = test.scope; s !== null; s = s.parent) {
      for (const hook of s.afterEach) {
        try {
          await hook();
        } catch (e) {
          error ??= e;
        }
      }
    }
    const n = String(i + 1);
    if (error === null) write(`ok ${n} - ${fullName(test)}`);
    else {
      failures += 1;
      write(
        `not ok ${n} - ${fullName(test)}: ${error instanceof Error ? error.message : show(error)}`,
      );
    }
  }
  return failures;
};
