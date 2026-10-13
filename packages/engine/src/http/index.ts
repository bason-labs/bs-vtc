/**
 * Localhost HTTP/SSE server (AD-5; owner: engine-core team, sub-project 1; routes frozen in
 * `ENGINE_HTTP`). Serves the live API and, for `vtc dashboard` without a running engine, the
 * same routes in read-only snapshot mode (AD-12). Dashboard files come from an injected
 * `AssetBundle`. A transport: it calls engine core, never the reverse.
 */
export {};
