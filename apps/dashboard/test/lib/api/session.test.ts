import { describe, expect, it, vi } from "vitest";
import { bootstrapSession, readNonce, SESSION_STORAGE_KEY } from "@/lib/api/session";

const NONCE = "n".repeat(43);
const SESSION = "s".repeat(43);
const NOW = Date.parse("2026-10-13T10:00:00.000Z");

const memoryStorage = (): Storage => {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => {
      map.clear();
    },
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => {
      map.delete(k);
    },
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
};

const exchangeOk = () =>
  vi.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve(Response.json({ session: SESSION, expires_at: "2026-10-13T22:00:00.000Z" })),
  );

describe("readNonce", () => {
  it("reads #nonce= from the fragment", () => {
    expect(readNonce(`#nonce=${NONCE}`)).toBe(NONCE);
    expect(readNonce(`#other=1&nonce=${NONCE}`)).toBe(NONCE);
  });
  it("ignores malformed nonces", () => {
    expect(readNonce("#nonce=short")).toBeNull();
    expect(readNonce("")).toBeNull();
    expect(readNonce(`#nonce=${NONCE}<script>`)).toBeNull();
  });
});

describe("bootstrapSession", () => {
  it("exchanges a fragment nonce once, strips it from the URL and stores the session", async () => {
    const fetch = exchangeOk();
    const storage = memoryStorage();
    const replaceUrl = vi.fn();
    const result = await bootstrapSession({
      hash: `#nonce=${NONCE}`,
      replaceUrl,
      storage,
      fetch,
      now: () => NOW,
    });
    expect(result).toEqual({ status: "exchanged", token: SESSION });
    expect(replaceUrl).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("/api/session");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ nonce: NONCE });
    expect(new Headers(init?.headers).get("authorization")).toBeNull();
    expect(JSON.parse(storage.getItem(SESSION_STORAGE_KEY) ?? "{}")).toMatchObject({
      session: SESSION,
    });
  });

  it("strips the nonce even when the exchange fails, and reports it", async () => {
    const replaceUrl = vi.fn();
    const result = await bootstrapSession({
      hash: `#nonce=${NONCE}`,
      replaceUrl,
      storage: memoryStorage(),
      fetch: () => Promise.resolve(new Response("{}", { status: 403 })),
      now: () => NOW,
    });
    expect(result).toEqual({ status: "failed", token: null });
    expect(replaceUrl).toHaveBeenCalledOnce();
  });

  it("restores an unexpired session from storage without a request", async () => {
    const storage = memoryStorage();
    storage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ session: SESSION, expires_at: "2026-10-13T22:00:00.000Z" }),
    );
    const fetch = vi.fn();
    const result = await bootstrapSession({
      hash: "",
      replaceUrl: vi.fn(),
      storage,
      fetch,
      now: () => NOW,
    });
    expect(result).toEqual({ status: "restored", token: SESSION });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("drops an expired or malformed stored session", async () => {
    const storage = memoryStorage();
    storage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ session: SESSION, expires_at: "2026-10-13T09:00:00.000Z" }),
    );
    const base = { hash: "", replaceUrl: vi.fn(), storage, fetch: vi.fn(), now: () => NOW };
    expect(await bootstrapSession(base)).toEqual({ status: "none", token: null });
    expect(storage.getItem(SESSION_STORAGE_KEY)).toBeNull();
    storage.setItem(SESSION_STORAGE_KEY, "not json");
    expect(await bootstrapSession(base)).toEqual({ status: "none", token: null });
  });

  it("works when storage is blocked (keeps the token in memory)", async () => {
    const blocked = memoryStorage();
    blocked.setItem = () => {
      throw new Error("blocked");
    };
    const result = await bootstrapSession({
      hash: `#nonce=${NONCE}`,
      replaceUrl: vi.fn(),
      storage: blocked,
      fetch: exchangeOk(),
      now: () => NOW,
    });
    expect(result).toEqual({ status: "exchanged", token: SESSION });
  });
});
