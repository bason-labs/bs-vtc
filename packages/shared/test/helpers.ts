import { expect } from "vitest";
import type { z } from "zod";

/** Asserts the value fails validation and that one issue points at `path` (dot-joined). */
export const expectInvalid = (schema: z.ZodType, value: unknown, path?: string): void => {
  const result = schema.safeParse(value);
  expect(result.success, `expected invalid: ${JSON.stringify(value)}`).toBe(false);
  if (path !== undefined && !result.success) {
    const paths = result.error.issues.map((issue) => issue.path.join("."));
    expect(paths).toContain(path);
  }
};

export const expectValid = <T extends z.ZodType>(schema: T, value: unknown): z.infer<T> => {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(JSON.stringify(result.error.issues, null, 2));
  return result.data;
};
