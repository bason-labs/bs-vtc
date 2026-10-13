/**
 * The cli's calls to the daemon's HTTP API on 127.0.0.1 (AD-5): the install token as the bearer,
 * `Host` set to the engine's own origin, no `Origin`. Used for the two `install` routes the cli
 * takes part in: the statusline ingest and `vtc dashboard`'s session nonce.
 */
import { request } from "node:http";
import { ENGINE_HTTP } from "@vtc/shared";

export interface EngineHttpResponse {
  /** HTTP status; 0 when the engine could not be reached in time. */
  readonly status: number;
  readonly body: string;
}

export const postToEngine = (
  port: number,
  path: string,
  token: string,
  body: string,
  timeoutMs = 2_000,
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
        method: "POST",
        timeout: timeoutMs,
        headers: {
          host: `${ENGINE_HTTP.bindHost}:${String(port)}`,
          authorization: `${ENGINE_HTTP.tokenScheme} ${token}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk: Buffer) => {
          if (text.length < 64 * 1024) text += chunk.toString("utf8");
        });
        res.on("end", () => {
          finish({ status: res.statusCode ?? 0, body: text });
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
    req.end(body);
  });
