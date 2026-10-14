/**
 * Recorded-fixture HTTP for research tests (AD-22: no test touches the network). Routes are keyed
 * `METHOD url`; a list answers in order (the last entry repeats). Every request is recorded.
 */
import type { HttpClient, HttpRequest, HttpResponse } from "@vtc/shared";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type FixtureAnswer = HttpResponse | Error | ((request: HttpRequest) => HttpResponse | Error);

export class FixtureHttp implements HttpClient {
  readonly requests: HttpRequest[] = [];
  private readonly served = new Map<string, number>();

  constructor(private readonly routes: Record<string, FixtureAnswer | FixtureAnswer[]> = {}) {}

  set(route: string, answer: FixtureAnswer | FixtureAnswer[]): void {
    this.routes[route] = answer;
    this.served.delete(route);
  }

  request(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    const route = `${request.method} ${request.url}`;
    const entry = this.routes[route];
    if (entry === undefined) return Promise.reject(new Error(`no fixture for ${route}`));
    const list = Array.isArray(entry) ? entry : [entry];
    const index = this.served.get(route) ?? 0;
    this.served.set(route, index + 1);
    const answer = list[Math.min(index, list.length - 1)];
    const value = typeof answer === "function" ? answer(request) : answer;
    return value instanceof Error || value === undefined
      ? Promise.reject(value ?? new Error("empty fixture"))
      : Promise.resolve(value);
  }

  count(route: string): number {
    return this.requests.filter((r) => `${r.method} ${r.url}` === route).length;
  }
}

export const respond = (
  url: string,
  status: number,
  body: string,
  headers: Record<string, string> = {},
): HttpResponse => ({
  status,
  url,
  headers: { "content-type": "application/json", ...headers },
  body: new TextEncoder().encode(body),
});

export const jsonResponse = (
  url: string,
  value: unknown,
  headers: Record<string, string> = {},
): HttpResponse => respond(url, 200, JSON.stringify(value), headers);

/** A mutable clock. */
export const clock = (start = "2026-10-14T10:00:00.000Z") => {
  let at = new Date(start);
  return {
    now: (): Date => at,
    advanceDays: (days: number): void => {
      at = new Date(at.getTime() + days * 86_400_000);
    },
  };
};

export const tempDir = (prefix: string): Promise<string> =>
  mkdtemp(join(tmpdir(), `vtc-${prefix}-`));
