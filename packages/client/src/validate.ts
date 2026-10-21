// Input validation shared by the library and the CLI. Every rule about what a
// request may contain lives in the library as a pure `…Problem(value)` function: it
// returns the reason a value is invalid, or undefined when the value is fine. The
// client enforces a rule with assertValid before any request; the CLI's commander
// value-parsers call the same function and turn the reason into a usage error, so
// the rule exists exactly once.

import { EntgeltatlasValidationError, quoteValue, redactUrl } from "./errors.js";

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

/** `typeof`, with `null` and arrays named as such, for messages about a wrong type. */
export function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

/** True for a plain object (`{…}`, not null, an array, a Map, a class instance or a primitive). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Check that an options argument is a plain object (or `undefined`, meaning none) and
 * return it as one. Anything else — `5`, `"x"`, an array — is an
 * EntgeltatlasValidationError naming `name`, not a destructuring that silently reads
 * nothing or a raw TypeError later. `null` counts as "no options".
 */
export function optionsObject<T extends object>(name: string, value: T | null | undefined): Partial<T> {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) {
    throw new EntgeltatlasValidationError(`Invalid ${name}: Expected an object, got ${describeType(value)}.`);
  }
  return value;
}

/**
 * Read a function option: `undefined` gives the fallback; anything else that is not a
 * function is an EntgeltatlasValidationError. A string `transport` used to fail at the
 * first request as a TypeError wrapped into a network error, and a bad `sleep` on the
 * first retry.
 */
export function functionOption<F>(name: string, value: F | undefined, fallback: F): F {
  if (value === undefined) return fallback;
  if (typeof value !== "function") {
    throw new EntgeltatlasValidationError(`Invalid ${name}: Expected a function, got ${describeType(value)}.`);
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
  if (typeof value !== "string") return `Expected a string, got ${describeType(value)}.`;
  if (value.trim() === "") return "Expected a non-empty value.";
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
    // Redacted before it is cut, so a cut never leaves part of a password unmatched.
    return `Invalid URL ${quoteValue(String(redactUrl(value)))}.`;
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
 * A `%` in the user name or password must start a valid escape (`%25` for a literal
 * one): Node decodes the userinfo for the Authorization header and throws "URI
 * malformed" otherwise — at request time, as a network error. Checked here instead,
 * so it is a usage error before any request. The reason never echoes the value.
 */
export const userinfoEscapeProblem: Problem = (value) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined; // schemeProblem reports an unparseable value
  }
  for (const part of [url.username, url.password]) {
    try {
      decodeURIComponent(part);
    } catch {
      return 'The user name or password has a "%" that is not followed by two hex digits; write a literal "%" as %25.';
    }
  }
  return undefined;
};

/**
 * A base URL: an absolute `http:`/`https:` URL (a path prefix is fine) without a
 * query or fragment — request paths are appended to it as a string, so `http://h/?x=1`
 * would request `/?x=1/infosysbub/...` and `http://h/#f` would request `/` — with a
 * decodable userinfo (userinfoEscapeProblem), and without surrounding whitespace
 * (baseUrlWhitespaceProblem). The reasons are the CLI's `--base-url` messages.
 */
export const baseUrlProblem: Problem = (value) =>
  (typeof value === "string" ? undefined : `Invalid URL ${quoteValue(String(value))}.`) ??
  schemeProblem(value, "base URLs") ??
  (/[?#]/.test(value) ? "A base URL cannot have a query (?) or fragment (#)." : undefined) ??
  userinfoEscapeProblem(value) ??
  baseUrlWhitespaceProblem(value);

/**
 * The canonical form of an API key: trimmed, and `undefined` when blank (a blank
 * key means "no key", so no X-API-Key header is sent). Idempotent. Trimming comes
 * before the header check (headerValueProblem), so a key read from a CRLF file
 * (`"k\r"`) is the same key from the client, the env var and the CLI flag.
 * A non-string is returned as is, for the header check to reject.
 */
/**
 * Why a (trimmed, non-blank) API key cannot be sent, or undefined: what an HTTP header cannot
 * carry (`headerValueProblem`), and whitespace inside — a key is one token. A tab or space from a
 * paste went out as part of the header and ended in the API's empty 403, which looks like a
 * network block; the credentials file already refused such a value.
 */
export const apiKeyProblem: Problem = (value) =>
  headerValueProblem(value) ?? (typeof value === "string" && /\s/.test(value) ? "The key holds whitespace inside; a key is one token." : undefined);

export function normalizeApiKey(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return raw;
  const key = raw.trim();
  return key === "" ? undefined : key;
}

/** Characters that never make a value non-blank: whitespace, controls, format characters, combining marks. */
const INVISIBLE = /[\s\p{Cc}\p{Cf}\p{M}]/gu;

/** A lone surrogate: half of a character, which URLSearchParams would send as U+FFFD. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * True when nothing in `value` would match anything: it holds only whitespace, control and
 * format characters (a zero-width space, a soft hyphen) and combining marks. Such a value reads
 * as "no filter" upstream, or matches nothing, so it is refused as blank.
 */
function isBlank(value: string): boolean {
  return value.replace(INVISIBLE, "") === "";
}

/** `U+200B` for the first character of `text` that `pattern` matches. */
function codePointOf(text: string, pattern: RegExp): string {
  const ch = pattern.exec(text)?.[0] ?? "";
  return `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
}

/** A control character inside a text filter: C0 and C1, but not TAB, LF or CR (whitespace in a pasted phrase). */
const TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

/** A format character inside a text filter, but not ZWNJ/ZWJ (U+200C/U+200D), which some scripts and emoji need. */
const TEXT_FORMAT = /(?![\u200c\u200d])\p{Cf}/u;

/**
 * Why `value` cannot be sent as a text filter, or undefined when it can. Refused, before any
 * request, as the API would match nothing or everything:
 * - a value that is blank once trimmed (Unicode whitespace, U+00A0 included), or that holds only
 *   invisible characters and combining marks (`isBlank`): an empty filter reads as "no filter"
 *   upstream, which answers with the whole unfiltered list;
 * - a lone surrogate (half of a character, sent as U+FFFD);
 * - a control character (but TAB, LF and CR) or a format character (a zero-width space, a soft
 *   hyphen, a bidi control; ZWNJ and ZWJ are allowed): pasted along, it makes the search find
 *   nothing.
 * The reason quotes the value with every invisible character escaped (`quoteValue`).
 */
export function textProblem(value: string): string | undefined {
  if (typeof value !== "string") return "Expected a string.";
  if (isBlank(value)) return "Expected a non-empty value.";
  if (LONE_SURROGATE.test(value)) return `${quoteValue(value)} contains half of a character (a lone surrogate).`;
  if (TEXT_CONTROL.test(value)) return `${quoteValue(value)} contains a control character (${codePointOf(value, TEXT_CONTROL)}).`;
  if (TEXT_FORMAT.test(value)) return `${quoteValue(value)} contains an invisible character (${codePointOf(value, TEXT_FORMAT)}).`;
  return undefined;
}

/**
 * A text filter as the API matches it: without surrounding whitespace (a value pasted with a
 * trailing space matched nothing) and in composed Unicode, NFC (a decomposed "Müller", u plus
 * U+0308 as pasted from a macOS file name, matched nothing). Inner whitespace is kept.
 */
export function normalizeText(value: string): string {
  return value.trim().normalize("NFC");
}

/** A control or format character in a token (after trimming): every Cc and every Cf. */
const TOKEN_INVISIBLE = /[\p{Cc}\p{Cf}]/u;

/**
 * Why `value` cannot be sent as a token, or undefined when it can. A token is an id, a code, an
 * enum value or a sort key: a value the API compares exactly. The rules apply to the value with
 * surrounding whitespace trimmed, as it is sent ({@link normalizeToken}): not blank (and not only
 * invisible characters or combining marks), no lone surrogate, and no control or format character
 * at all (a zero-width space, ZWJ, a soft hyphen, a bidi control), since an invisible character in
 * an id or a code only ever makes it match nothing. The reason quotes the value visibly.
 */
export function tokenProblem(value: string): string | undefined {
  if (typeof value !== "string") return "Expected a string.";
  if (isBlank(value)) return "Expected a non-empty value.";
  const token = value.trim();
  if (LONE_SURROGATE.test(token)) return `${quoteValue(value)} contains half of a character (a lone surrogate).`;
  if (TOKEN_INVISIBLE.test(token)) {
    return `${quoteValue(value)} contains an invisible or control character (${codePointOf(token, TOKEN_INVISIBLE)}).`;
  }
  return undefined;
}

/** A token as it is sent: trimmed and in composed Unicode (NFC). Check it with {@link tokenProblem} first. */
export function normalizeToken(value: string): string {
  return value.trim().normalize("NFC");
}

/**
 * The items of a comma-separated list option (`--ids a1,a2`), as typed: each item is checked
 * (`listProblem`) and canonicalised (`normalizeToken`) on its own, so `"a1, a2"` sends `a2`, and
 * `"a1,,a2"`, `"a1,"` and `","` are refused rather than sent as an empty item (which an API may
 * read as "no filter").
 */
export function splitList(value: string): string[] {
  return value.split(",");
}

/**
 * Why `items` cannot be sent as a list, or undefined when it can: not an array of strings, no
 * item at all (an empty list reads as "no filter"), or an item that `itemProblem` refuses (by
 * default {@link tokenProblem}: a blank item is refused, never dropped). The reason names the item.
 */
export function listProblem(items: readonly string[], itemProblem: Problem = tokenProblem): string | undefined {
  if (!Array.isArray(items)) return "Expected a list of strings.";
  if (items.length === 0) return "Expected at least one value.";
  for (let i = 0; i < items.length; i++) {
    const problem = itemProblem(items[i] as string);
    if (problem !== undefined) return items.length === 1 ? problem : `item ${i + 1} of ${items.length}: ${problem}`;
  }
  return undefined;
}

/** A KldB-2010 occupation code as the API takes it: 3–5 ASCII digits (leading zeros kept). */
const KLDB_PATTERN = /^[0-9]{3,5}$/;

/**
 * Why `value` cannot be sent as a KldB-2010 occupation code, or undefined when it can: the
 * {@link tokenProblem} rules (not blank, no control, format or invisible character, no lone
 * surrogate), then 3–5 ASCII digits as it is sent ({@link normalizeToken}: trimmed, NFC). It goes
 * into the request path, so no other form passes (a name, full-width digits, `/`, `..`, `%`).
 */
export function kldbProblem(value: string): string | undefined {
  const problem = tokenProblem(value);
  if (problem !== undefined) return problem;
  if (KLDB_PATTERN.test(normalizeToken(value))) return undefined;
  return `${quoteValue(value)} is not a KldB-2010 code: expected 3–5 digits (e.g. 84304). This API takes the numeric KldB-2010 code, not an occupation name.`;
}
