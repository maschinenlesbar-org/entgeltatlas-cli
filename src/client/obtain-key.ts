// Obtain the public `X-API-Key` the Entgeltatlas API requires.
//
// No key ships with this package (see client.ts). The Bundesagentur für Arbeit
// publishes a single static key for public use: its own Entgeltatlas web app
// (https://web.arbeitsagentur.de/entgeltatlas/) states it in its inline
// configuration as `clientId: '…'`, and this module reads it from there at run
// time — so a rotated key needs no release of this CLI.
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
// redirects.
//
// Why the web app and not the bundesAPI README: in 2026 the BA replaced the UUID
// `client_id` (c4f0d292-…) that the bundesAPI README and OpenAPI still publish with
// the name the web app now configures; the gateway answers the UUID with an empty
// 403 (investigated 2026-10-06). The README itself names the web app as the place the
// credentials come from.
//
// NOTE: obtaining the key is no guarantee a later request succeeds — the gateway
// answers a wrong key and a refused network (WAF) with the same empty 403. The key
// is not checked here, and the CLI's note says it was not checked.

import type { Transport } from "./http.js";
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
  callWithDeadline,
  checkResponse,
  intOption,
  transientRetryDelay,
  transportError,
  type CheckedResponse,
} from "./engine.js";
import { MAX_TIMEOUT_MS } from "./http.js";
import { assertValid, httpUrlProblem } from "./validate.js";

/** The environment variable the client and CLI read the key from. */
export const API_KEY_ENV_VAR = "ENTGELTATLAS_API_KEY";

/** Authoritative source of the public key: the BA's own Entgeltatlas web app. */
export const KEY_SOURCE_URL = "https://web.arbeitsagentur.de/entgeltatlas/";

/**
 * The shape of the key: 3–64 lower-case ASCII letters, digits and inner hyphens, as
 * the web app's `infosysbub-ega` (a UUID fits too). Anything else the page might put
 * after `clientId` — a placeholder such as `YOUR-API-KEY`, punctuation, a template
 * expression, escape sequences — is not a key and is never returned.
 */
export const KEY_FORMAT = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

/**
 * `clientId: '…'` (the web app's inline `infosysbubLibConfig`), also with double
 * quotes or a quoted name (`"clientId": "…"`). The value is captured as written, up
 * to its closing quote, and checked against KEY_FORMAT afterwards.
 */
const CLIENT_ID_PATTERN = /["']?\bclientId["']?\s*[:=]\s*(["'])([^"'\r\n]{0,200})\1/g;

/**
 * True for a value shaped like a UUID key (the BA's former key shape, and a common one
 * for keys): the CLI keeps such a value out of its stderr even when it was typed
 * without `--api-key`. The current key is a short name (`infosysbub-ega`) that can't
 * be told from an ordinary word, so only the UUID shape is recognised on its own.
 */
export function looksLikeApiKey(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
}

/** A placeholder UUID such as 00000000-0000-0000-0000-000000000000: one repeated hex digit. */
function isPlaceholder(key: string): boolean {
  return /^([0-9a-f])(?:\1|-)*$/i.test(key);
}

/** Every distinct `clientId` value the text states, in document order, as written. */
function findClientIds(text: string): string[] {
  const values: string[] = [];
  for (const match of text.matchAll(CLIENT_ID_PATTERN)) {
    const value = match[2];
    if (value !== undefined && !values.includes(value)) values.push(value);
  }
  return values;
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
  let response: CheckedResponse;
  let redirects = 0;
  let attempt = 0;
  for (;;) {
    // The engine's transport contract (P5): the time limit and the size cap hold for
    // any transport, a malformed answer or a thrown value is a typed error, and the
    // headers are read whatever their case or container.
    try {
      const raw = await callWithDeadline(
        transport,
        {
          method: "GET",
          url,
          headers: {
            Accept: "text/html, */*;q=0.8",
            "User-Agent": userAgent,
          },
          ...(timeoutMs > 0 ? { timeoutMs } : {}),
          ...(maxResponseBytes > 0 ? { maxResponseBytes } : {}),
        },
        timeoutMs,
      );
      response = checkResponse(raw, "GET", url, maxResponseBytes);
    } catch (cause) {
      throw transportError("GET", url, cause);
    }
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
        "could not read the key source. Retry, or copy the clientId from the page source of " +
        "https://web.arbeitsagentur.de/entgeltatlas/ by hand",
    });
  }

  const text = response.body.toString("utf8");
  // The page states the key once. Two different values make it ambiguous, and a
  // value that isn't shaped like a key (a placeholder, a template expression) is not
  // one: guessing would be worse than failing.
  const values = findClientIds(text).filter((value) => !isPlaceholder(value));
  if (values.length > 1) {
    throw new EntgeltatlasError(
      `The key source ${url} states conflicting keys (${values.length} different clientId values). ` +
        `Check it by hand before relying on this command.`,
    );
  }
  const key = values[0];
  if (key === undefined) {
    throw new EntgeltatlasError(
      `No X-API-Key found at ${sourceUrl}: the page states no clientId. The web app may have ` +
        `changed format or stopped publishing the key — check it by hand before relying on this command.`,
    );
  }
  if (!KEY_FORMAT.test(key)) {
    throw new EntgeltatlasError(
      `The key source ${url} states a clientId that is not shaped like a key (3–64 lower-case ` +
        `letters, digits and hyphens), so it is not used. Check the page by hand.`,
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
