/**
 * AD-22 Check: no research test opens a socket. Every research test file calls
 * {@link guardNoNetwork} at its top level: any `net.Socket.connect` or global `fetch` fails the
 * test loudly, and the file fails at the end if one was attempted.
 */
import net from "node:net";
import { afterAll, beforeAll, expect, vi } from "vitest";

export const guardNoNetwork = (): void => {
  const connect = vi.fn(() => {
    throw new Error("a research test tried to open a socket");
  });
  const realFetch = globalThis.fetch;
  beforeAll(() => {
    vi.spyOn(net.Socket.prototype, "connect").mockImplementation(connect);
    globalThis.fetch = () => Promise.reject(new Error("a research test called fetch"));
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
    expect(connect).not.toHaveBeenCalled();
  });
};
