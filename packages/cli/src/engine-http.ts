/**
 * The cli's calls to the daemon's HTTP API on 127.0.0.1 (AD-5): the install token as the bearer,
 * `Host` set to the engine's own origin, no `Origin`. Used for the two `install` routes the cli
 * takes part in (the statusline ingest and `vtc dashboard`'s session nonce) and, since contracts
 * 5.0.0, one read route: `vtc automation status` reads `GET /api/automation` (AD-27 rule 7). The
 * HTTP API stays read-only for the cli; control commands go over MCP (AD-19 rule 4).
 */
import { request } from "node:http";
import { ENGINE_HTTP } from "@vtc/shared";

export interface EngineHttpResponse {
  /** HTTP status; 0 when the engine could not be reached in time. */
  readonly status: number;
  readonly body: string;
}

/** A POST's answer is short; a read model (500 automation items, say) is not. */
const POST_BODY_CAP = 64 * 1024;
const GET_BODY_CAP = 8 * 1024 * 1024;

const callEngine = (
  method: "GET" | "POST",
  port: number,
  path: string,
  token: string,
  body: string | null,
  timeoutMs: number,
  cap: number,
): Promise<EngineHttpResponse> =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (response: EngineHttpResponse): void => {
      if (settled) return;
      settled = true;
      resolve(response);
    };
    const req = request(
      {
        host: ENGINE_HTTP.bindHost,
        port,
        path,
        method,
        timeout: timeoutMs,
        headers: {
          host: `${ENGINE_HTTP.bindHost}:${String(port)}`,
          authorization: `${ENGINE_HTTP.tokenScheme} ${token}`,
          ...(body === null
            ? {}
            : { "content-type": "application/json", "content-length": Buffer.byteLength(body) }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          if (size < cap) chunks.push(chunk);
          size += chunk.length;
        });
        res.on("end", () => {
          finish({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
        });
        res.on("error", () => {
          finish({ status: 0, body: "" });
        });
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => {
      finish({ status: 0, body: "" });
    });
    if (body === null) req.end();
    else req.end(body);
  });

export const postToEngine = (
  port: number,
  path: string,
  token: string,
  body: string,
  timeoutMs = 2_000,
): Promise<EngineHttpResponse> =>
  callEngine("POST", port, path, token, body, timeoutMs, POST_BODY_CAP);

/** A read route (`auth: "token"`), with the install token as the bearer. */
export const getFromEngine = (
  port: number,
  path: string,
  token: string,
  timeoutMs = 10_000,
): Promise<EngineHttpResponse> =>
  callEngine("GET", port, path, token, null, timeoutMs, GET_BODY_CAP);
