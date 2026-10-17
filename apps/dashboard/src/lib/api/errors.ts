import type { HttpError } from "@vtc/shared";

/** `HttpError` codes from the engine, plus what the client itself can tell. */
export type ApiErrorCode = HttpError["error"]["code"] | "offline" | "bad_response" | "aborted";

/** A failed engine request. `status` is 0 when no HTTP response arrived. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;

  constructor(code: ApiErrorCode, message: string, status = 0) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

const FALLBACK_CODES: Readonly<Record<number, ApiErrorCode>> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  413: "payload_too_large",
};

export const codeForStatus = (status: number): ApiErrorCode => FALLBACK_CODES[status] ?? "internal";

/** True when the engine refused our credentials (the session expired or was never set up). */
export const isAuthError = (error: unknown): boolean =>
  error instanceof ApiError && (error.code === "unauthorized" || error.code === "forbidden");

/** True when the engine has no such item (e.g. a file nobody has written yet). */
export const isNotFound = (error: unknown): boolean =>
  error instanceof ApiError && error.code === "not_found";

/** One sentence for the person looking at the page. */
export const describeError = (error: unknown): string => {
  if (!(error instanceof ApiError)) return "Something went wrong while reading from the engine.";
  switch (error.code) {
    case "offline":
      return "The engine is not reachable. Is `vtc dashboard` still running?";
    case "unauthorized":
    case "forbidden":
      return "This dashboard session is not valid. Open it again with `vtc dashboard`.";
    case "not_found":
      return "The engine has no such item.";
    case "bad_response":
      return "The engine answered in a shape this dashboard does not understand. Are both on the same vtc version?";
    default:
      return error.message === "" ? "The engine reported an error." : error.message;
  }
};
