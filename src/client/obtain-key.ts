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
// `eval "$(entgeltatlas obtain-key --export)"`, it retries a transient 429/503 with
// the client's policy (transientRetryDelay), and it follows a few same-origin
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
import { EntgeltatlasError, EntgeltatlasKeySourceError } from "./errors.js";
import {
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_USER_AGENT,
  MAX_RETRIES,
  assertHeaderValue,
  intOption,
  transientRetryDelay,
} from "./engine.js";
import { MAX_TIMEOUT_MS } from "./http.js";
import { assertValid, httpUrlProblem } from "./validate.js";

/** The environment variable the client and CLI read the key from. */
export const API_KEY_ENV_VAR = "ENTGELTATLAS_API_KEY";

/** Authoritative, plain-text source of the public key. */
export const KEY_SOURCE_URL =
  "https://raw.githubusercontent.com/bundesAPI/entgeltatlas-api/main/README.md";

/** The key is a UUID. */
const UUID = String.raw`[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}`;

/**
 * Between a label and its value: Markdown emphasis, quotes, `:`/`=` and blanks —
 * so `**client_id:** <uuid>`, `"client_id": "<uuid>"`, `client_id=<uuid>` and
 * `X-API-Key: <uuid>` all match.
 */
const SEPARATOR = String.raw`[\s"'\x60*:=]+`;

/** The documented value: the BA `client_id`. */
const CLIENT_ID_PATTERN = new RegExp(String.raw`client_id${SEPARATOR}(${UUID})`, "gi");
/** Fallback only: a UUID sent as an `X-API-Key` header in an example. */
const X_API_KEY_PATTERN = new RegExp(String.raw`X-API-Key${SEPARATOR}(${UUID})`, "gi");

/** A placeholder such as 00000000-0000-0000-0000-000000000000: one repeated hex digit. */
function isPlaceholder(uuid: string): boolean {
  return /^([0-9a-f])(?:\1|-)*$/i.test(uuid);
}

/** Distinct non-placeholder UUIDs the pattern finds, lower-cased, in document order. */
function findKeys(text: string, pattern: RegExp): string[] {
  const keys: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const key = match[1]?.toLowerCase();
    if (key !== undefined && !isPlaceholder(key) && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

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
   * `eval "$(entgeltatlas obtain-key --export)"`; 0 disables it. 0 to `MAX_TIMEOUT_MS`,
   * as in the API client; anything else rejects with an EntgeltatlasValidationError.
   */
  timeoutMs?: number;
  /**
   * Cap on the response body in bytes. Defaults to `DEFAULT_MAX_RESPONSE_BYTES`
   * (100 MiB), like the API client; 0 disables it. A non-negative safe integer, as
   * in the API client; anything else rejects with an EntgeltatlasValidationError.
   */
  maxResponseBytes?: number;
  /**
   * Retries for a transient 429/503 from the key source, 0 to `MAX_RETRIES`
   * (default `DEFAULT_MAX_RETRIES`, 2), with the API client's policy: each waits
   * the response's `Retry-After` (up to `MAX_RETRY_AFTER_MS`; a longer one is not
   * retried), or else `retryDelayMs × attempt`.
   */
  maxRetries?: number;
  /** Base backoff between retries in milliseconds (default 200); used without a Retry-After. */
  retryDelayMs?: number;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * User-Agent header (default `DEFAULT_USER_AGENT`). Checked like the API client's:
   * a blank value or one an HTTP header cannot carry rejects with an
   * EntgeltatlasValidationError.
   */
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
  // file:/ftp: source URL (a configuration error: EntgeltatlasValidationError).
  assertValid("sourceUrl", sourceUrl, httpUrlProblem);

  // The API client's rule: only an omitted User-Agent selects the default.
  const userAgent =
    options.userAgent === undefined ? DEFAULT_USER_AGENT : assertHeaderValue("userAgent", options.userAgent);
  // The request gets the client's limits: a source that stalls, or streams
  // without end, must not hang the command.
  // The same range checks as the API client: a negative or NaN limit must not
  // silently switch the guard off.
  const timeoutMs = intOption("timeoutMs", options.timeoutMs, 0, MAX_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes =
    intOption("maxResponseBytes", options.maxResponseBytes, 0, Number.MAX_SAFE_INTEGER) ??
    DEFAULT_MAX_RESPONSE_BYTES;
  // The API client's retry policy (transientRetryDelay), with its defaults and bounds.
  const retry = {
    maxRetries: intOption("maxRetries", options.maxRetries, 0, MAX_RETRIES) ?? DEFAULT_MAX_RETRIES,
    retryDelayMs:
      intOption("retryDelayMs", options.retryDelayMs, 0, Number.MAX_SAFE_INTEGER) ?? DEFAULT_RETRY_DELAY_MS,
  };
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let url = sourceUrl;
  let response: HttpResponse;
  let redirects = 0;
  let attempt = 0;
  for (;;) {
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
    const wait = transientRetryDelay(response, attempt, retry);
    if (wait !== undefined) {
      attempt += 1;
      await sleep(wait);
      continue;
    }
    if (!FOLLOWED_REDIRECTS.has(response.status) || redirects >= MAX_KEY_SOURCE_REDIRECTS) break;
    const next = resolveLocation(response.headers["location"], url);
    // Only same-origin hops: the key is trusted because of where it is
    // published, so a redirect to another host is not followed.
    if (next === undefined || next.origin !== new URL(url).origin) break;
    url = next.href;
    redirects += 1;
  }

  if (response.status < 200 || response.status >= 300) {
    throw new EntgeltatlasKeySourceError({
      status: response.status,
      url,
      method: "GET",
      body: response.body.toString("utf8"),
      detail:
        "could not read the key source. Retry, or copy the key from " +
        "github.com/bundesAPI/entgeltatlas-api by hand",
    });
  }

  const text = response.body.toString("utf8");
  // The `client_id` is the documented value and wins; an `X-API-Key` UUID is
  // only a fallback, since an example may show a placeholder or another API's
  // key. When the document states more than one distinct key — two client_ids,
  // or an X-API-Key that contradicts the client_id — it is ambiguous, and
  // guessing would be worse than failing.
  const clientIds = findKeys(text, CLIENT_ID_PATTERN);
  const headerKeys = findKeys(text, X_API_KEY_PATTERN);
  const candidates = clientIds.length > 0 ? clientIds : headerKeys;
  const conflicting = [...new Set([...candidates, ...(clientIds.length > 0 ? headerKeys : [])])];
  if (conflicting.length > 1) {
    throw new EntgeltatlasError(
      `The key source ${url} states conflicting keys (${conflicting.join(", ")}). ` +
        `Check it by hand before relying on this command.`,
    );
  }
  const key = candidates[0];
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
