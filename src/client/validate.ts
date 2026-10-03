// Input validation shared by the library and the CLI. Every rule about what a
// request may contain lives in the library as a pure `…Problem(value)` function: it
// returns the reason a value is invalid, or undefined when the value is fine. The
// client enforces a rule with assertValid before any request; the CLI's commander
// value-parsers call the same function and turn the reason into a usage error, so
// the rule exists exactly once.

import { EntgeltatlasValidationError, redactUrl } from "./errors.js";

/** Why `value` is invalid, or `undefined` if it is valid. */
export type Problem<T = string> = (value: T) => string | undefined;

/**
 * Throw an EntgeltatlasValidationError (`Invalid <name>: <reason>`) when `problem`
 * finds something wrong with `value`; otherwise return `value` unchanged.
 *
 * Client methods that return a promise call this inside an `async` body, so a
 * rejected input surfaces as a rejected promise rather than a synchronous throw,
 * and no request is sent. Constructors throw.
 */
export function assertValid<T>(name: string, value: T, problem: Problem<T>): T {
  const reason = problem(value);
  if (reason !== undefined) {
    throw new EntgeltatlasValidationError(`Invalid ${name}: ${reason}`);
  }
  return value;
}

/**
 * A rule for a safe integer within `[min, max]`. The messages are the CLI's
 * (`Must be >= 0.`), so a flag and a client option report the same reason.
 */
export function intRangeProblem(min: number, max: number): Problem<number> {
  return (value) => {
    if (!Number.isSafeInteger(value)) return `Expected an integer from ${min} to ${max}.`;
    if (value < min) return `Must be >= ${min}.`;
    if (value > max) return `Must be <= ${max}.`;
    return undefined;
  };
}

/**
 * A value that ends up in an HTTP header (the User-Agent, a default header) must be
 * a non-blank string of Latin-1 characters without control characters (tab is
 * allowed, as in HTTP). Node's HTTP layer would otherwise throw an opaque "Invalid
 * character in header content" at request time, and a custom transport would get a
 * CR/LF through (header injection). Checked by char code so the source stays free
 * of control bytes.
 */
export const headerValueProblem: Problem = (value) => {
  if (typeof value !== "string" || value.trim() === "") return "Expected a non-empty value.";
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09) || c === 0x7f) return "Value contains control characters.";
    if (c > 0xff) return "Value contains characters outside Latin-1 (above U+00FF).";
  }
  return undefined;
};

/** An HTTP header name must be a non-empty RFC 9110 token. */
export const headerNameProblem: Problem = (value) =>
  typeof value === "string" && /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value)
    ? undefined
    : "Expected an HTTP header name (a token such as X-Request-Id).";

/**
 * A base URL must not have surrounding whitespace: `new URL()` trims it silently,
 * but the engine joins the raw value to every request path, so `"https://h/ "`
 * would request `/%20/...` and a custom transport would see the padded value.
 * Rejected rather than trimmed, so the value used is the value given.
 */
export const baseUrlWhitespaceProblem: Problem = (value) =>
  value !== value.trim() ? "A base URL cannot have surrounding whitespace." : undefined;

/** A parseable URL with an `http:` or `https:` scheme; `what` names it in the reason. */
function schemeProblem(value: string, what: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `Invalid URL "${redactUrl(value)}".`;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `Only http: and https: ${what} are supported.`;
  }
  return undefined;
}

/**
 * An absolute `http:`/`https:` URL (obtainKey()'s `sourceUrl`). A custom transport
 * may do no scheme check of its own, so a `file:`/`ftp:` URL is never handed to it.
 */
export const httpUrlProblem: Problem = (value) => schemeProblem(value, "URLs");

/**
 * A base URL: an absolute `http:`/`https:` URL (a path prefix is fine) without a
 * query or fragment — request paths are appended to it as a string, so `http://h/?x=1`
 * would request `/?x=1/infosysbub/...` and `http://h/#f` would request `/` — and
 * without surrounding whitespace (baseUrlWhitespaceProblem). The reasons are the
 * CLI's `--base-url` messages.
 */
export const baseUrlProblem: Problem = (value) =>
  (typeof value === "string" ? undefined : `Invalid URL "${String(value)}".`) ??
  schemeProblem(value, "base URLs") ??
  (/[?#]/.test(value) ? "A base URL cannot have a query (?) or fragment (#)." : undefined) ??
  baseUrlWhitespaceProblem(value);

/**
 * The canonical form of an API key: trimmed, and `undefined` when blank (a blank
 * key means "no key", so no X-API-Key header is sent). Idempotent. Trimming comes
 * before the header check (headerValueProblem), so a key read from a CRLF file
 * (`"k\r"`) is the same key from the client, the env var and the CLI flag.
 * A non-string is returned as is, for the header check to reject.
 */
export function normalizeApiKey(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return raw;
  const key = raw.trim();
  return key === "" ? undefined : key;
}
