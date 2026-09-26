// Obtain the public `X-API-Key` the Entgeltatlas API requires.
//
// No key ships with this package (see client.ts). the Bundesagentur für Arbeit publishes a
// single static key for public use, and this module reads it at run time from the
// document that publishes it — so a rotated key needs no release of this CLI.
//
// The value is deliberately *public*, not a secret: printing it, putting it in an
// environment variable and showing it to the user are all intended. What this
// module must never do is invent one, or fall back to a stale literal compiled
// into the package.
//
// The fetch goes through the same `Transport` seam as every other request, so it
// honours --timeout/--max-response-bytes/--user-agent and is testable in-process
// without a network. Like the API client it has a 30 s timeout and a 100 MiB
// size cap by default, so a stalled source cannot hang
// `eval "$(entgeltatlas obtain-key --export)"`, and it follows a few same-origin
// redirects (GitHub raw answers a renamed repository with one).
//
// NOTE: obtaining the key is no guarantee a later request succeeds. The gateway
// answers a wrong key, a refused network (WAF) and — seen on every Entgeltatlas
// endpoint on 2026-09-26 — the published static key itself with the same empty
// 403, and upstream now documents an OAuth client-credentials flow this package
// does not implement. The key is therefore not checked here (an empty 403 would
// not say why), and the CLI's note says it was not checked.

import type { HttpResponse, Transport } from "./http.js";
import { nodeHttpTransport } from "./http.js";
import { EntgeltatlasError } from "./errors.js";
import { DEFAULT_MAX_RESPONSE_BYTES, DEFAULT_TIMEOUT_MS, assertHttpScheme } from "./engine.js";

/** The environment variable the client and CLI read the key from. */
export const API_KEY_ENV_VAR = "ENTGELTATLAS_API_KEY";

/** Authoritative, plain-text source of the public key. */
export const KEY_SOURCE_URL =
  "https://raw.githubusercontent.com/bundesAPI/entgeltatlas-api/main/README.md";

/** The key is a UUID, published as an `X-API-Key` value or a `client_id`. */
const KEY_PATTERNS = [
  /X-API-Key[:=]\s*["'`]?([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/i,
  /client_id[":=\s]+["'`]?([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/i,
];

/** Same-origin redirects the key-source request follows (e.g. a renamed repository). */
export const MAX_KEY_SOURCE_REDIRECTS = 5;

/** The redirect statuses followed, as in the API client. */
const FOLLOWED_REDIRECTS = new Set([301, 302, 303, 307, 308]);

export interface ObtainKeyOptions {
  /** Injectable transport; defaults to the built-in node:http/https one. */
  transport?: Transport;
  /** Override the source document (tests, mirrors). */
  sourceUrl?: string;
  /**
   * Time limit per request in milliseconds, whole response included. Defaults to
   * `DEFAULT_TIMEOUT_MS` (30 s), like the API client, so a stalled source cannot hang
   * `eval "$(entgeltatlas obtain-key --export)"`; 0 disables it.
   */
  timeoutMs?: number;
  /**
   * Cap on the response body in bytes. Defaults to `DEFAULT_MAX_RESPONSE_BYTES`
   * (100 MiB), like the API client; 0 disables it.
   */
  maxResponseBytes?: number;
  /** User-Agent header; a blank value falls back to the default. */
  userAgent?: string;
}

export interface ObtainedKey {
  /** The public key, ready to put in `API_KEY_ENV_VAR`. */
  key: string;
  /** Where it was read from (after any redirect), so callers can cite it. */
  sourceUrl: string;
}

/**
 * Fetch the public key from its upstream source.
 *
 * Throws (rather than returning a placeholder) when the source is unreachable or
 * no longer states a key, so a caller never proceeds with a made-up value.
 */
export async function obtainKey(options: ObtainKeyOptions = {}): Promise<ObtainedKey> {
  const sourceUrl = options.sourceUrl ?? KEY_SOURCE_URL;
  const transport = options.transport ?? nodeHttpTransport;
  // A custom transport may do no scheme check of its own; never hand it a
  // file:/ftp: source URL.
  assertHttpScheme(sourceUrl);

  // A blank User-Agent falls back to the default, as in the API client.
  const userAgent = options.userAgent?.trim() ? options.userAgent : "entgeltatlas-cli";
  // The request gets the client's limits: a source that stalls, or streams
  // without end, must not hang the command.
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  let url = sourceUrl;
  let response: HttpResponse;
  for (let redirects = 0; ; redirects += 1) {
    response = await transport({
      method: "GET",
      url,
      headers: {
        Accept: "text/plain, text/markdown;q=0.9, */*;q=0.8",
        "User-Agent": userAgent,
      },
      ...(timeoutMs > 0 ? { timeoutMs } : {}),
      ...(maxResponseBytes > 0 ? { maxResponseBytes } : {}),
    });
    if (!FOLLOWED_REDIRECTS.has(response.status) || redirects >= MAX_KEY_SOURCE_REDIRECTS) break;
    const next = resolveLocation(response.headers["location"], url);
    // Only same-origin hops: the key is trusted because of where it is
    // published, so a redirect to another host is not followed.
    if (next === undefined || next.origin !== new URL(url).origin) break;
    url = next.href;
  }

  if (response.status < 200 || response.status >= 300) {
    throw new EntgeltatlasError(
      `Could not read the key source ${sourceUrl} (HTTP ${response.status}). ` +
        `Retry, or copy the key from github.com/bundesAPI/entgeltatlas-api by hand.`,
    );
  }

  const text = response.body.toString("utf8");
  let key: string | undefined;
  for (const pattern of KEY_PATTERNS) {
    key = pattern.exec(text)?.[1]?.trim();
    if (key) break;
  }
  if (!key) {
    throw new EntgeltatlasError(
      `No X-API-Key found at ${sourceUrl}. The upstream document may have changed ` +
        `format or stopped publishing the key — check it by hand before relying on this command.`,
    );
  }
  return { key, sourceUrl: url };
}

/** Resolve a Location header against the request URL; undefined if missing or malformed. */
function resolveLocation(location: string | string[] | undefined, base: string): URL | undefined {
  const value = Array.isArray(location) ? location[0] : location;
  if (value === undefined || value === "") return undefined;
  try {
    return new URL(value, base);
  } catch {
    return undefined;
  }
}

/**
 * Quote a value for safe use inside a POSIX `export VAR=...` line, so
 * `eval "$(... obtain-key --export)"` cannot execute anything the source
 * document smuggled in.
 */
export function shellQuoteSingle(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
