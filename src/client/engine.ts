// The request engine: turns logical (method, path, query) calls into HTTP
// requests via a Transport, applies retry/backoff for transient statuses
// (429, 503), and decodes responses.

import { TextDecoder } from "node:util";
import {
  MAX_TIMEOUT_MS,
  nodeHttpTransport,
  sizeLimitMessage,
  type HttpRequest,
  type HttpResponse,
  type Transport,
} from "./http.js";
import { buildQueryString, type QueryParams } from "./query.js";
import {
  EntgeltatlasApiError,
  EntgeltatlasError,
  EntgeltatlasNetworkError,
  EntgeltatlasParseError,
  credentialsIn,
  redactCredentials,
  redactSecrets,
  redactUrl,
} from "./errors.js";
import {
  assertValid,
  baseUrlProblem,
  functionOption,
  headerNameProblem,
  headerValueProblem,
  intRangeProblem,
  isPlainObject,
  optionsObject,
} from "./validate.js";
import { EntgeltatlasValidationError } from "./errors.js";

export const DEFAULT_BASE_URL = "https://rest.arbeitsagentur.de";
/** The User-Agent sent when none is given (the API client and obtainKey()). */
export const DEFAULT_USER_AGENT = "entgeltatlas-cli";

export interface RawResponse {
  data: Buffer;
  contentType: string;
  status: number;
  /** The URL that answered, after any redirects, without userinfo. */
  url: string;
  /**
   * Set when a redirect led to another origin (another scheme, host or port), so the
   * credentials (the API key, the base URL's userinfo) were not sent to the server
   * that answered: the origins before and after that hop.
   */
  credentialsDropped?: CredentialsDropped;
}

/** Where a redirect left the origin the credentials belong to. */
export interface CredentialsDropped {
  /** The origin that received the credentials. */
  from: string;
  /** The other origin the redirect led to, which did not. */
  to: string;
}

export interface EngineOptions {
  /**
   * Base URL of the API. Defaults to https://rest.arbeitsagentur.de. A value that
   * breaks a rule of {@link validateBaseUrl} (unparseable, not http(s), a query or
   * fragment, surrounding whitespace) throws an EntgeltatlasValidationError.
   */
  baseUrl?: string;
  /** Swappable transport. Defaults to the built-in node http/https transport. */
  transport?: Transport;
  /**
   * Value of the User-Agent header (default `DEFAULT_USER_AGENT`). A blank value, a
   * control character other than tab, or a character above U+00FF throws an
   * EntgeltatlasValidationError.
   */
  userAgent?: string;
  /** Extra headers sent on every request (e.g. the X-API-Key); names and values are checked like `userAgent`. */
  defaultHeaders?: Record<string, string>;
  /**
   * Time limit per request in milliseconds, covering the whole response body, not
   * only idle gaps: 0 to `MAX_TIMEOUT_MS` (2^31 - 1 ms); 0 disables it. Enforced by
   * the engine for every transport: the transport gets an AbortSignal that fires at
   * the deadline, and the call rejects then whether the transport stops or not.
   */
  timeoutMs?: number;
  /**
   * Number of automatic retries for transient (429/503) responses and reset
   * connections (`isTransientNetworkError`; GET/HEAD only), 0 to `MAX_RETRIES`
   * (default 2). Each waits the response's `Retry-After` (up to
   * `MAX_RETRY_AFTER_MS`; a longer one is not retried), or else `retryDelayMs * attempt`.
   */
  maxRetries?: number;
  /**
   * Base backoff between retries in milliseconds (grows linearly; default 200, 0 to
   * `MAX_RETRY_AFTER_MS`). A Retry-After can lengthen a wait, never shorten it.
   */
  retryDelayMs?: number;
  /**
   * Number of HTTP redirects (301/302/303/307/308) to follow, 0 to `MAX_REDIRECTS`.
   * Defaults to 5. Any other 3xx, one with a missing or malformed Location, and one
   * past this limit surface as an EntgeltatlasApiError naming the target.
   */
  maxRedirects?: number;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint). Defaults to 100 MiB; set to 0 for no limit.
   * Checked on the body of every transport (the default one also aborts early).
   *
   * Every numeric option must be a safe integer within its range; the constructor
   * throws an EntgeltatlasValidationError otherwise (a negative or NaN timeout or
   * cap would silently switch that guard off).
   */
  maxResponseBytes?: number;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** Default time limit per request (30 s); `timeoutMs: 0` disables it. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Default cap on a response body (100 MiB); `maxResponseBytes: 0` disables it. */
export const DEFAULT_MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

/** Retries for a transient 429/503 when `maxRetries` is not given (the API client and obtainKey()). */
export const DEFAULT_MAX_RETRIES = 2;

/** Base backoff between retries when `retryDelayMs` is not given. */
export const DEFAULT_RETRY_DELAY_MS = 200;

/** Most automatic retries the engine performs (`maxRetries`, the CLI's --max-retries). */
export const MAX_RETRIES = 10;

/** Most redirects the engine follows (`maxRedirects`). */
export const MAX_REDIRECTS = 10;

/**
 * Check an optional numeric option against `[min, max]` and return it; undefined
 * stays undefined (the caller applies its default). Anything else throws an
 * EntgeltatlasValidationError naming the option. Shared with obtainKey().
 */
export function intOption(name: string, value: number | undefined, min: number, max: number): number | undefined {
  return value === undefined ? undefined : assertValid(name, value, intRangeProblem(min, max));
}

/**
 * Check a value bound for an HTTP header (see {@link headerValueProblem}) and
 * return it unchanged; anything else throws an EntgeltatlasValidationError naming
 * `name` ("Invalid userAgent: Value contains control characters.").
 */
export function assertHeaderValue(name: string, value: string): string {
  return assertValid(name, value, headerValueProblem);
}

/** Check every name and value of `defaultHeaders`, returning a copy. */
function headerOption(headers: Record<string, string> | undefined): Record<string, string> {
  if (headers === undefined) return {};
  if (!isPlainObject(headers)) {
    throw new EntgeltatlasValidationError("Invalid defaultHeaders: Expected an object of header names and values.");
  }
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    assertValid("defaultHeaders name", name, headerNameProblem);
    out[name] = assertHeaderValue(`defaultHeaders["${name}"]`, value);
  }
  return out;
}

/**
 * Longest `Retry-After` the engine waits out before retrying a 429/503. When the
 * server asks for longer, the engine does not retry at all and surfaces the error at
 * once: retrying early would only land inside the window the server asked us to wait
 * out, and a hostile value must not stall the CLI.
 */
export const MAX_RETRY_AFTER_MS = 30_000;

/** An IMF-fixdate (RFC 9110 §5.6.7), the one HTTP-date form senders must generate. */
const IMF_FIXDATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Parse a `Retry-After` header into a delay in milliseconds (RFC 9110 §10.2.3):
 * either delay-seconds (`"120"`) or an HTTP-date (`"Wed, 21 Oct 2026 07:28:00 GMT"`,
 * turned into the time left from `now`; a date in the past gives 0).
 *
 * Returns `undefined` when the header is absent or malformed — negative (`"-1"`),
 * fractional (`"1.5"`), padded inside, any other date format — so the caller falls
 * back to its own backoff. The strict patterns matter: `Date.parse` alone would
 * read `"1.5"` as a date in 2001 and retry at once.
 */
export function parseRetryAfter(
  header: string | string[] | undefined,
  now: number = Date.now(),
): number | undefined {
  const value = (Array.isArray(header) ? header[0] : header)?.trim();
  if (value === undefined || value === "") return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  if (!IMF_FIXDATE.test(value)) return undefined;
  const when = Date.parse(value);
  return Number.isNaN(when) ? undefined : Math.max(0, when - now);
}

/**
 * The retry policy for one response, shared by the engine and obtainKey(): how
 * long to wait before the next try, or `undefined` when the response is not
 * retried. Only a transient 429/503 is retried, and only while `attempt` (retries
 * done so far) is below `maxRetries`. The normal backoff, `retryDelayMs ×
 * (attempt + 1)`, is the floor: a `Retry-After` can lengthen a wait, never shorten it
 * (`Retry-After: 0` or a date in the past would turn the retries into a zero-delay
 * burst against a server that has just asked for less load). A `Retry-After` above
 * `MAX_RETRY_AFTER_MS` is not retried at all (see `retryAfterTooLong`).
 */
export function transientRetryDelay(
  response: { status: number; headers: object },
  attempt: number,
  policy: { maxRetries: number; retryDelayMs: number },
): number | undefined {
  if ((response.status !== 429 && response.status !== 503) || attempt >= policy.maxRetries) return undefined;
  const retryAfter = parseRetryAfter(plainHeaders(response.headers)["retry-after"]);
  const backoff = policy.retryDelayMs * (attempt + 1);
  if (retryAfter === undefined) return backoff;
  return retryAfter <= MAX_RETRY_AFTER_MS ? Math.max(retryAfter, backoff) : undefined;
}

/**
 * The `Retry-After` of a 429/503 that asks for longer than `MAX_RETRY_AFTER_MS`, in
 * milliseconds, or `undefined`. Such a response is not retried (retrying sooner would
 * only land inside the window the server asked to be left alone); the error then names
 * the requested wait, so a script or an agent knows to try again later, not at once.
 */
export function retryAfterTooLong(response: { status: number; headers: object }): number | undefined {
  if (response.status !== 429 && response.status !== 503) return undefined;
  const retryAfter = parseRetryAfter(plainHeaders(response.headers)["retry-after"]);
  return retryAfter !== undefined && retryAfter > MAX_RETRY_AFTER_MS ? retryAfter : undefined;
}

/**
 * Strip control characters (all C0 except tab and newline, plus DEL and the C1
 * range) from a string that originates in an attacker-controlled response — the
 * error `detail` and any echoed Content-Type. `JSON.parse` decodes an escaped
 * control character in an error body into a real byte, so without this a
 * hostile/MITM'd endpoint could drive ANSI/OSC escape sequences into the user's
 * terminal when the message is printed to stderr (title spoofing, screen
 * clearing, hidden output). This only covers text flowing into an error message:
 * the CLI's JSON output is escaped separately (escapeControlChars in
 * cli/shared.ts), since `JSON.stringify` alone leaves DEL and the C1 range raw. Implemented as a char-code filter to keep zero control-byte literals
 * in this source file.
 */
function sanitizeServerText(text: string): string {
  let out = "";
  for (const ch of text) {
    const n = ch.codePointAt(0) ?? 0;
    // Keep tab (0x09) and newline (0x0a); drop the rest of C0, DEL, and C1.
    if (n <= 8 || (n >= 0x0b && n <= 0x1f) || (n >= 0x7f && n <= 0x9f)) continue;
    out += ch;
  }
  return out;
}

/**
 * Request headers that carry credentials and must NOT be forwarded across an
 * origin boundary on a redirect (the classic auth-header-on-redirect leak that
 * fetch/curl --location guard against). Compared case-insensitively.
 */
const CREDENTIAL_HEADERS = ["authorization", "x-api-key", "oauthaccesstoken", "cookie"];

/**
 * Check a base URL against every rule of {@link baseUrlProblem} — unparseable
 * (including `""`), a scheme other than `http:`/`https:`, a query or fragment,
 * surrounding whitespace — and return it with trailing slashes stripped. A bad
 * value throws an EntgeltatlasValidationError ("Invalid baseUrl: <reason>"): it is
 * a configuration error, not a transport failure. The default transport still gates
 * the scheme per hop (an EntgeltatlasNetworkError, as for a redirect target), but the
 * engine may be handed a custom transport that does no such check, so the configured
 * value is checked here, raw, before the slash strip.
 */
export function validateBaseUrl(raw: string): string {
  return assertValid("baseUrl", raw, baseUrlProblem).replace(/\/+$/, "");
}

/**
 * The redirect statuses the engine follows. 300 (a choice for the user), 304 (a
 * cache answer to a conditional request this client never sends) and 305/306
 * (deprecated) are not redirects to follow; they surface as an EntgeltatlasApiError.
 */
const FOLLOWED_REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * Decode a response body by the charset its Content-Type names (UTF-8 when it names
 * none). TextDecoder drops a leading byte order mark, which Buffer#toString keeps and
 * JSON.parse then rejects, so a BOM added by a gateway cannot turn a valid answer into
 * a parse error, and an `iso-8859-1` body keeps its umlauts. An unknown charset label
 * is an EntgeltatlasParseError naming it and `where`. Shared with obtainKey().
 */
export function decodeBody(body: Buffer, contentType: string, where: string): string {
  const charset = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType)?.[1] ?? "utf-8";
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    throw new EntgeltatlasParseError(`Unsupported response charset "${sanitizeServerText(charset)}" from ${where}.`);
  }
  return decoder.decode(body);
}

/** Resolve a Location header against the current URL; undefined if missing or malformed. */
function resolveLocation(location: string | undefined, base: string): URL | undefined {
  if (location === undefined || location === "") return undefined;
  try {
    return new URL(location, base);
  } catch {
    return undefined;
  }
}

/**
 * The absolute, printable form of a `Location` header: resolved against the request
 * URL, userinfo redacted, control characters stripped and whitespace folded (it is
 * server text bound for stderr). An unparseable value is shown sanitised as it came.
 */
function redirectTarget(requestUrl: string, location: string): string | undefined {
  const resolved = resolveLocation(location, requestUrl);
  const clean = sanitizeServerText(resolved ? redactUrl(resolved.href) : location)
    .replace(/\s+/g, " ")
    .trim();
  return clean === "" ? undefined : clean;
}

/** Response headers as the engine reads them: a plain record with lower-case names. */
export type PlainHeaders = Record<string, string | string[] | undefined>;

/** A transport's answer after the engine's checks: a status, plain headers and bytes. */
export interface CheckedResponse {
  status: number;
  headers: PlainHeaders;
  body: Buffer;
}

/**
 * The response headers as a plain record with lower-case names, as the engine reads
 * them. A transport built on `fetch` naturally returns its `Headers` object, which
 * passes as an object but has no plain properties: the engine then saw no
 * Retry-After and no Location at all. Such an object (anything with `get` and
 * `forEach`, a `Map` included) is copied into a record; a plain record gets its names
 * lower-cased (Node's transport does that already, a custom one may not).
 */
export function plainHeaders(headers: object): PlainHeaders {
  const h = headers as { get?: unknown; forEach?: unknown };
  const record: PlainHeaders = {};
  if (typeof h.get === "function" && typeof h.forEach === "function") {
    (h.forEach as (cb: (value: string, name: string) => void) => void).call(headers, (value, name) => {
      record[String(name).toLowerCase()] = String(value);
    });
    return record;
  }
  for (const [name, value] of Object.entries(headers as PlainHeaders)) {
    record[name.toLowerCase()] = value;
  }
  return record;
}

/** A single header value (the first of a repeated one), or undefined. */
export function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The response body as a Buffer (a view, no copy): a Buffer, any ArrayBuffer view (a
 * Uint8Array from fetch, a DataView) or an ArrayBuffer/SharedArrayBuffer — checked by
 * internal slot, not `instanceof`, so a value from another realm (a vm context, a Jest
 * test) counts. A string is read as UTF-8. Undefined for anything else.
 */
function bodyBytes(value: unknown): Buffer | undefined {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  const tag = Object.prototype.toString.call(value);
  if (tag === "[object ArrayBuffer]" || tag === "[object SharedArrayBuffer]") {
    return Buffer.from(value as ArrayBuffer);
  }
  return undefined;
}

/** Why `value` is not a usable HttpResponse, or undefined when it is. */
function responseProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return "not an object";
  const r = value as Partial<Record<"status" | "headers" | "body", unknown>>;
  if (typeof r.status !== "number" || !Number.isInteger(r.status) || r.status < 100 || r.status > 599) {
    return "status is not an HTTP status code";
  }
  if (typeof r.headers !== "object" || r.headers === null || Array.isArray(r.headers)) return "headers is not an object";
  if (bodyBytes(r.body) === undefined) {
    return "body is not a Buffer, Uint8Array, other ArrayBuffer view, ArrayBuffer or string";
  }
  return undefined;
}

/**
 * Error codes of a connection that broke off mid-request: Node's (`socket hang up` is
 * ECONNRESET) and undici's (`fetch failed` with cause UND_ERR_SOCKET, "other side closed").
 */
const TRANSIENT_NETWORK_CODES = new Set(["ECONNRESET", "EPIPE", "ECONNABORTED", "UND_ERR_SOCKET"]);

/** True when `err` or an error in its `cause` chain has a transient connection code. */
function hasTransientCode(err: unknown, depth = 0): boolean {
  if (typeof err !== "object" || err === null || depth > 4) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && TRANSIENT_NETWORK_CODES.has(code)) return true;
  return hasTransientCode((err as { cause?: unknown }).cause, depth + 1);
}

/**
 * True for a failure caused by a reset or aborted connection (`ECONNRESET`, `EPIPE`,
 * `ECONNABORTED`, undici's `UND_ERR_SOCKET`, anywhere in the `cause` chain), which the
 * engine retries like a 503 — whichever transport raised it. A refused connection, a
 * DNS failure or a timeout is not transient in that sense and is not retried.
 */
export function isTransientNetworkError(err: unknown): boolean {
  return hasTransientCode(err);
}

/**
 * Call `transport` under the time limit `timeoutMs` (0 = none): the request gets an
 * AbortSignal that fires at the deadline, and the call rejects then (an
 * EntgeltatlasNetworkError) whether the transport stops or not — a custom transport
 * (fetch, a node:http wrapper) that ignores `timeoutMs` can't hang the caller. A
 * synchronous throw becomes a rejection. Shared with obtainKey().
 */
export async function callWithDeadline(
  transport: Transport,
  request: HttpRequest,
  timeoutMs: number,
): Promise<HttpResponse> {
  const call = (signal?: AbortSignal): Promise<HttpResponse> =>
    Promise.resolve().then(() => transport(signal === undefined ? request : { ...request, signal }));
  if (timeoutMs === 0) return call();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new EntgeltatlasNetworkError(`Request timed out after ${timeoutMs}ms`);
      controller.abort(err);
      reject(err);
    }, Math.min(timeoutMs, MAX_TIMEOUT_MS));
  });
  try {
    return await Promise.race([call(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A transport's answer, checked: an integer status 100–599, an object of headers
 * (normalised by plainHeaders) and a byte body (bodyBytes) within `maxResponseBytes`
 * (0 = no cap). Anything else is an EntgeltatlasNetworkError naming the request, never
 * a raw TypeError, and a status of NaN is never read as success. Shared with obtainKey().
 */
export function checkResponse(raw: unknown, method: string, url: string, maxResponseBytes: number): CheckedResponse {
  const invalid = responseProblem(raw);
  if (invalid !== undefined) {
    throw new EntgeltatlasNetworkError(
      `${method} ${redactUrl(url)} failed: the transport returned an invalid response (${invalid}).`,
    );
  }
  const r = raw as HttpResponse;
  const body = bodyBytes(r.body) as Buffer;
  // The size cap holds whatever the transport did: the default one aborts early, a
  // custom one may have read everything.
  if (maxResponseBytes > 0 && body.byteLength > maxResponseBytes) {
    throw new EntgeltatlasNetworkError(sizeLimitMessage(maxResponseBytes));
  }
  return { status: r.status, headers: plainHeaders(r.headers), body };
}

/**
 * A transport failure as an EntgeltatlasError. The default transport rejects with an
 * EntgeltatlasNetworkError already (passed through); an injected one may throw
 * anything (a TypeError from fetch, a string, null), which is wrapped naming the
 * request, with the original as `cause`. Shared with obtainKey().
 */
export function transportError(method: string, url: string, cause: unknown): EntgeltatlasError {
  if (cause instanceof EntgeltatlasError) return cause;
  const reason =
    cause instanceof Error && cause.message.trim() !== ""
      ? cause.message
      : typeof cause === "string" && cause.trim() !== ""
        ? cause
        : "the transport failed without a message";
  return new EntgeltatlasNetworkError(`${method} ${redactUrl(url)} failed: ${cleanDetail(reason)}`, {
    cause,
  });
}

/**
 * Longest server text (in characters) kept for an error message (a `detail`). A longer
 * one is cut and ends in "…", so a hostile or buggy body cannot flood stderr or a CI
 * log with one huge line. `EntgeltatlasApiError.body` keeps the full text.
 */
const MAX_DETAIL_LENGTH = 500;

/** sanitizeServerText, then cut at MAX_DETAIL_LENGTH characters. */
function cleanDetail(text: string): string {
  const clean = sanitizeServerText(text);
  return clean.length > MAX_DETAIL_LENGTH ? `${clean.slice(0, MAX_DETAIL_LENGTH)}…` : clean;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `url` without its userinfo, and the `Authorization: Basic` value the userinfo
 * stands for (undefined without one). The engine attaches credentials per hop
 * itself, so a transport never sees a URL with userinfo: Node's http would turn it
 * into a Basic header on every hop, and `fetch` refuses such a URL. A URL that does
 * not parse is returned as is, for the transport to report.
 */
export function splitUserinfo(url: string): { url: string; basic: string | undefined } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { url, basic: undefined };
  }
  if (parsed.username === "" && parsed.password === "") return { url, basic: undefined };
  const decode = (part: string): string => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  };
  const pair = `${decode(parsed.username)}:${decode(parsed.password)}`;
  parsed.username = "";
  parsed.password = "";
  return { url: parsed.href, basic: `Basic ${Buffer.from(pair, "latin1").toString("base64")}` };
}

/** The origin of `url` (scheme, host and port), or undefined when it does not parse. */
export function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/**
 * The error for a transport that followed a redirect itself (fetch's default) to
 * another origin, as its response `url` shows, or undefined when it didn't. Such a
 * request went to a host the engine never checked, credential headers and all: fetch
 * strips Authorization across origins, but not X-API-Key or Cookie. Shared with
 * obtainKey().
 */
export function followedElsewhere(method: string, url: string, reported: unknown): EntgeltatlasNetworkError | undefined {
  if (typeof reported !== "string" || reported === "" || originOf(reported) === originOf(url)) return undefined;
  return new EntgeltatlasNetworkError(
    `${method} ${redactUrl(url)} failed: the transport followed a redirect to ` +
      `${originOf(reported) ?? "an unparseable URL"}, another origin. A transport must not ` +
      `follow redirects (HttpRequest.redirect is "manual"); the engine follows them and ` +
      `decides where credentials may go.`,
  );
}

/** The phrase for the API key in `cleartextProblem`'s sentence (as the CLI passes it). */
export const API_KEY_PHRASE = "the API key";

/** The phrase `cleartextProblem` uses for a base URL's `user:password@`. */
const USERINFO_PHRASE = "the base URL's credentials";

/**
 * Why requests to `baseUrl` would cross the network unencrypted, or `undefined`.
 *
 * Returns `undefined` for an `https:` URL, for one that does not parse, and for the
 * loopback interface (`localhost`, `127.0.0.0/8`, `::1`). For any other plain `http:`
 * URL it returns one sentence (no `warning: ` prefix) naming the host (`url.host`: host
 * and port, never the userinfo) and what secret travels with the requests: `secrets`
 * are noun phrases such as `"the API key"`, and a `user:password@` in the URL adds
 * "the base URL's credentials". The secrets themselves are never in the sentence. Not
 * an error (a mirror on a trusted network is a legitimate setup), so the CLI prints it
 * as a warning on stderr, once per run.
 *
 * - `requests to <host> are sent unencrypted (http:, not https:)`
 * - `the base URL's credentials are sent unencrypted to <host> (http:, not https:)`
 * - `the API key and the base URL's credentials are sent unencrypted to <host> (http:, not https:)`
 */
export function cleartextProblem(baseUrl: string, secrets: readonly string[] = []): string | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:") return undefined;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  // The WHATWG parser normalises IPv4 (`127.1`, `0x7f.0.0.1`) to dotted decimal.
  if (host === "localhost" || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host)) return undefined;
  const named = [...secrets];
  if (url.username !== "" || url.password !== "") named.push(USERINFO_PHRASE);
  if (named.length === 0) return `requests to ${url.host} are sent unencrypted (http:, not https:)`;
  const subject =
    named.length === 1 ? named[0]! : `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]!}`;
  const verb = named.length === 1 && named[0] !== USERINFO_PHRASE ? "is" : "are";
  return `${subject} ${verb} sent unencrypted to ${url.host} (http:, not https:)`;
}

/**
 * @deprecated Use {@link cleartextProblem}, which also warns when no secret is sent.
 * Kept for library callers: the same check with {@link API_KEY_PHRASE} as the secret
 * when `hasKey`, in the old shape (capitalised, ending in "."), and still `undefined`
 * when neither a key nor a `user:password@` would be sent.
 */
export function cleartextCredentialsProblem(baseUrl: string, hasKey: boolean): string | undefined {
  const problem = cleartextProblem(baseUrl, hasKey ? [API_KEY_PHRASE] : []);
  if (problem === undefined || problem.startsWith("requests to ")) return undefined;
  return `${problem.charAt(0).toUpperCase()}${problem.slice(1)}.`;
}

/** Return a copy of `headers` with any credential-bearing header removed. */
function stripCredentialHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!CREDENTIAL_HEADERS.includes(key.toLowerCase())) out[key] = value;
  }
  return out;
}

/**
 * The secret forms of a URL's userinfo, for scrubbing text: as written and
 * percent-decoded (a server or transport may echo either).
 */
export function userinfoForms(url: string): string[] {
  return credentialsIn(url).flatMap((raw) => {
    try {
      const decoded = decodeURIComponent(raw);
      return decoded === raw ? [raw] : [raw, decoded];
    } catch {
      return [raw];
    }
  });
}

export class RequestEngine {
  // Real private fields (not TypeScript's `private`): util.inspect, console.log and
  // JSON.stringify of a client never show them, so a password in the base URL or
  // the API key in the default headers can't be logged by accident.
  readonly #baseUrl: string;
  readonly #defaultHeaders: Record<string, string>;
  /** The base URL's userinfo, raw and percent-decoded, for scrubbing server and transport text. */
  readonly #credentials: string[];
  /** Secrets without an `@` to anchor on (the API key), for the same scrubbing. */
  readonly #secrets: string[];
  private readonly transport: Transport;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxRedirects: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(rawOptions: EngineOptions = {}) {
    // A JavaScript caller may pass null for "no options"; anything else but an object is an error.
    const options = optionsObject("options", rawOptions);
    // Only an omitted baseUrl selects the default; validateBaseUrl checks the raw
    // value before the trailing-slash strip, so "https://h/ " cannot slip past it.
    this.#baseUrl = validateBaseUrl(options.baseUrl === undefined ? DEFAULT_BASE_URL : options.baseUrl);
    this.#credentials = userinfoForms(this.#baseUrl);
    this.transport = functionOption("transport", options.transport, nodeHttpTransport);
    // Only an omitted userAgent selects the default: a blank one is an error, not
    // a silent fallback, and a malformed one fails here rather than at request time.
    this.userAgent =
      options.userAgent === undefined ? DEFAULT_USER_AGENT : assertHeaderValue("userAgent", options.userAgent);
    this.#defaultHeaders = headerOption(options.defaultHeaders);
    // The secret part of a credential header (`Bearer <token>` → the token), never echoed.
    this.#secrets = Object.entries(this.#defaultHeaders)
      .filter(([name]) => CREDENTIAL_HEADERS.includes(name.toLowerCase()))
      .map(([, value]) => value.replace(/^\S+\s+/, "").trim());
    this.timeoutMs = intOption("timeoutMs", options.timeoutMs, 0, MAX_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = intOption("maxRetries", options.maxRetries, 0, MAX_RETRIES) ?? DEFAULT_MAX_RETRIES;
    // A base delay above MAX_RETRY_AFTER_MS would outlast any wait the server may ask for.
    this.retryDelayMs =
      intOption("retryDelayMs", options.retryDelayMs, 0, MAX_RETRY_AFTER_MS) ?? DEFAULT_RETRY_DELAY_MS;
    this.maxRedirects = intOption("maxRedirects", options.maxRedirects, 0, MAX_REDIRECTS) ?? 5;
    this.maxResponseBytes =
      intOption("maxResponseBytes", options.maxResponseBytes, 0, Number.MAX_SAFE_INTEGER) ??
      DEFAULT_MAX_RESPONSE_BYTES;
    this.sleep = functionOption("sleep", options.sleep, realSleep);
  }

  /** Build a fully-qualified URL from a path and optional query parameters. */
  buildUrl(path: string, query?: QueryParams): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const qs = query ? buildQueryString(query) : "";
    return `${this.#baseUrl}${normalizedPath}${qs ? `?${qs}` : ""}`;
  }

  /** Perform a request with Accept negotiation and transient-error retries. */
  async request(
    method: string,
    path: string,
    options: { query?: QueryParams; accept: string } = { accept: "application/json" },
  ): Promise<RawResponse> {
    // The per-request `accept` and User-Agent are applied AFTER defaultHeaders so
    // a default cannot shadow per-endpoint negotiation.
    const all: Record<string, string> = {
      ...this.#defaultHeaders,
      Accept: options.accept,
      "User-Agent": this.userAgent,
    };
    // Credentials — the credential headers (X-API-Key, Authorization, OAuthAccessToken,
    // Cookie) and the base URL's userinfo, sent as `Authorization: Basic` unless an
    // Authorization header is already set — are attached per hop, never baked into the
    // URL the transport sees. They go to the start URL's origin only: a redirect to the
    // same origin (a relative or an absolute Location) keeps them; one to another
    // scheme, host or port drops them for the rest of the chain, and the result says so.
    const plain = stripCredentialHeaders(all);
    const credentials: Record<string, string> = {};
    for (const [name, value] of Object.entries(all)) if (!(name in plain)) credentials[name] = value;
    const start = splitUserinfo(this.buildUrl(path, options.query));
    if (start.basic !== undefined && !Object.keys(credentials).some((n) => n.toLowerCase() === "authorization")) {
      credentials["Authorization"] = start.basic;
    }
    const hasCredentials = Object.keys(credentials).length > 0;
    const credentialOrigin = originOf(start.url);
    let dropped: CredentialsDropped | undefined;
    let url = start.url;

    // Only an idempotent request is sent again: request() is public, and a POST re-sent
    // after a reset may be applied twice. The client itself sends GETs only.
    const idempotent = /^(GET|HEAD)$/i.test(method);
    let attempt = 0;
    let redirects = 0;
    // attempts = initial try + maxRetries (redirects are counted separately)
    for (;;) {
      const sendCredentials = dropped === undefined && originOf(url) === credentialOrigin;
      const headers = sendCredentials ? { ...plain, ...credentials } : plain;
      let raw: HttpResponse;
      try {
        raw = await callWithDeadline(
          this.transport,
          {
            method,
            url,
            headers,
            redirect: "manual",
            timeoutMs: this.timeoutMs,
            ...(this.maxResponseBytes > 0 ? { maxResponseBytes: this.maxResponseBytes } : {}),
          },
          this.timeoutMs,
        );
      } catch (cause) {
        // A connection the server (or a gateway) reset is the network-level twin of a
        // 503: retry the GET like one, whichever transport reported it. Timeouts are
        // not retried — a slow upstream should not be asked again at once.
        if (idempotent && hasTransientCode(cause) && attempt < this.maxRetries) {
          attempt += 1;
          await this.sleep(this.retryDelayMs * attempt);
          continue;
        }
        throw this.toNetworkError(method, url, cause);
      }
      // An injected transport may resolve with anything; check it before reading it.
      let response: CheckedResponse;
      try {
        response = checkResponse(raw, method, url, this.maxResponseBytes);
      } catch (err) {
        throw this.toNetworkError(method, url, err);
      }
      // A transport that followed a redirect itself took the request to a host the
      // engine never checked: don't trust its answer.
      const elsewhere = followedElsewhere(method, url, (raw as { url?: unknown }).url);
      if (elsewhere !== undefined) throw elsewhere;

      const status = response.status;
      // Honour Retry-After; without a usable one, back off linearly. A Retry-After
      // beyond MAX_RETRY_AFTER_MS is not retried: the error below surfaces at once.
      const wait = idempotent
        ? transientRetryDelay(response, attempt, {
            maxRetries: this.maxRetries,
            retryDelayMs: this.retryDelayMs,
          })
        : undefined;
      if (wait !== undefined) {
        attempt += 1;
        await this.sleep(wait);
        continue;
      }

      // Follow redirects, resolving the Location relative to the current URL. Only an
      // http(s) target is followed: a file:, data: or javascript: one never reaches the
      // transport, and surfaces below as an EntgeltatlasApiError naming it.
      const location = headerValue(response.headers["location"]);
      const target = FOLLOWED_REDIRECTS.has(status) ? resolveLocation(location, url) : undefined;
      const next = target !== undefined && /^https?:$/.test(target.protocol) ? target : undefined;
      if (next !== undefined && redirects >= this.maxRedirects) {
        // A loop (or a long chain): say how far it got rather than a bare 3xx.
        // (With maxRedirects 0 nothing was followed; the plain text says enough.)
        throw this.toApiError(method, url, status, response.body, location, redirects || undefined, dropped);
      }
      if (next !== undefined) {
        // SECURITY: the credentials belong to the start URL's origin. A redirect to
        // another scheme, host or port drops them for the rest of the chain — http→https
        // on the same host included, as the key must not be re-sent on a hop the user
        // did not choose. A Location's own userinfo is never used.
        next.username = "";
        next.password = "";
        if (hasCredentials && dropped === undefined && next.origin !== credentialOrigin) {
          dropped = { from: originOf(url) ?? "", to: next.origin };
        }
        url = next.href;
        redirects += 1;
        continue;
      }
      // Any other 3xx — not a followed status, or no usable Location — falls
      // through and surfaces as an EntgeltatlasApiError naming the target.

      const contentType = sanitizeServerText(String(headerValue(response.headers["content-type"]) ?? ""));
      if (status < 200 || status >= 300) {
        throw this.toApiError(method, url, status, response.body, location, undefined, dropped, retryAfterTooLong(response));
      }

      return {
        data: response.body,
        contentType,
        status,
        url,
        ...(dropped !== undefined ? { credentialsDropped: dropped } : {}),
      };
    }
  }

  /** Perform a GET expecting JSON and parse it into `T`. */
  async getJson<T>(path: string, query?: QueryParams, accept = "application/json"): Promise<T> {
    const res = await this.request("GET", path, { query, accept });
    const text = decodeBody(res.data, res.contentType, path);
    // Every endpoint answers a JSON document; a 204 or an empty body is not "no
    // data" (that is an empty array), so it is an error rather than null.
    if (res.status === 204 || text.trim().length === 0) {
      throw new EntgeltatlasParseError(`Empty response body from ${path}`);
    }
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new EntgeltatlasParseError(`Failed to parse JSON response from ${path}`, { cause });
    }
  }

  /**
   * `text` without the base URL's credentials or the API key: server text (an error
   * body that echoes the request URL or its headers) and transport text (fetch's
   * "Failed to fetch <url>") can carry them.
   */
  private scrub(text: string): string {
    return redactSecrets(redactCredentials(text, this.#credentials), this.#secrets);
  }

  /**
   * A transport failure as the `cause` of the error the engine raises: the original
   * when its text carries no secret, otherwise a copy with them scrubbed (message,
   * `code` and the cause chain kept), so logging the error with its causes can't
   * reveal the base URL's password or the key.
   */
  private scrubCause(cause: unknown, depth = 0): unknown {
    if ((this.#credentials.length === 0 && this.#secrets.length === 0) || depth > 5) return cause;
    if (typeof cause === "string") return this.scrub(cause);
    if (!(cause instanceof Error)) return cause;
    const inner = this.scrubCause(cause.cause, depth + 1);
    const message = this.scrub(cause.message);
    const stack = cause.stack ?? "";
    if (message === cause.message && inner === cause.cause && this.scrub(stack) === stack) return cause;
    const copy = new Error(message, inner === undefined ? undefined : { cause: inner });
    copy.name = cause.name;
    const code = (cause as { code?: unknown }).code;
    if (code !== undefined) Object.assign(copy, { code });
    return copy;
  }

  /**
   * A transport failure as an EntgeltatlasError (transportError), with the base URL's
   * credentials and the key scrubbed from its message and its cause chain.
   */
  private toNetworkError(method: string, url: string, cause: unknown): EntgeltatlasError {
    const err = transportError(method, url, typeof cause === "string" ? this.scrub(cause) : cause);
    if (!(err instanceof EntgeltatlasNetworkError)) return err;
    const message = this.scrub(err.message);
    const inner = this.scrubCause(err.cause);
    if (message === err.message && inner === err.cause) return err;
    return new EntgeltatlasNetworkError(message, inner === undefined ? undefined : { cause: inner });
  }

  private toApiError(
    method: string,
    url: string,
    status: number,
    body: Buffer,
    locationHeader?: string,
    redirectsFollowed?: number,
    credentialsDropped?: CredentialsDropped,
    retryAfterMs?: number,
  ): EntgeltatlasApiError {
    const text = this.scrub(body.toString("utf8"));
    let detail: string | undefined;
    try {
      const parsed = JSON.parse(text) as { detail?: unknown; message?: unknown; error?: unknown };
      if (typeof parsed?.detail === "string") detail = parsed.detail;
      else if (typeof parsed?.message === "string") detail = parsed.message;
      else if (typeof parsed?.error === "string") detail = parsed.error;
    } catch {
      // Non-JSON error body (e.g. an empty 403 from the Akamai WAF); leave undefined.
    }
    // `detail` came from the response body; strip control characters so a hostile
    // endpoint cannot inject terminal escape sequences via the stderr error message.
    if (detail !== undefined) detail = cleanDetail(detail);
    // Name the target of a redirect that was not followed.
    const location =
      status >= 300 && status < 400 && locationHeader ? redirectTarget(url, locationHeader) : undefined;
    return new EntgeltatlasApiError({
      status,
      url,
      method,
      body: text,
      detail,
      ...(location !== undefined ? { location } : {}),
      ...(redirectsFollowed !== undefined ? { redirectsFollowed } : {}),
      ...(credentialsDropped !== undefined ? { credentialsDropped } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }
}
