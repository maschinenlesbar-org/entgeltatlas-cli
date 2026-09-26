// Error types raised by the client. Kept free of any I/O so they are trivial to
// construct in tests and to `instanceof`-check by consumers.

/**
 * Replace the userinfo of a URL (`https://user:secret@host/...`) with `***`, so a
 * credential in a base URL never reaches an error message, a log or CI output.
 * A URL without userinfo, or one that does not parse, is returned unchanged.
 */
export function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.username === "" && parsed.password === "") return url;
  parsed.username = "***";
  parsed.password = "";
  return parsed.href;
}

/** Base class for every error originating from this client. */
export class EntgeltatlasError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * The API responded with a non-2xx status code. `detail` holds a human-readable
 * message extracted from the response body when one is present.
 */
export class EntgeltatlasApiError extends EntgeltatlasError {
  readonly status: number;
  readonly detail: string | undefined;
  readonly url: string;
  readonly method: string;
  readonly body: string;

  constructor(args: {
    status: number;
    url: string;
    method: string;
    body: string;
    detail?: string;
  }) {
    // The URL is shown without userinfo: a credential in --base-url must not leak.
    const url = redactUrl(args.url);
    const detailPart = args.detail ? `: ${args.detail}` : "";
    super(`HTTP ${args.status} for ${args.method} ${url}${detailPart}`);
    this.status = args.status;
    this.url = url;
    this.method = args.method;
    this.body = args.body;
    this.detail = args.detail;
  }

  /** True for statuses the API documents as transient and retry-able. */
  get isRetryable(): boolean {
    return this.status === 429 || this.status === 503;
  }
}

/**
 * `obtainKey()` could not read the document that publishes the key (a non-2xx
 * from the key source, not from the Entgeltatlas API). An `EntgeltatlasApiError`,
 * so `status`/`url` are available; the CLI maps a 404 to exit 4 and every other
 * status to 1 (never to 3, which means the API rejected a key).
 */
export class EntgeltatlasKeySourceError extends EntgeltatlasApiError {}

/** A transport-level failure (DNS, connection reset, timeout, ...). */
export class EntgeltatlasNetworkError extends EntgeltatlasError {}

/** A client-side validation error (e.g. a malformed KldB code) — no request made. */
export class EntgeltatlasValidationError extends EntgeltatlasError {}

/** The response body could not be parsed as the expected JSON shape. */
export class EntgeltatlasParseError extends EntgeltatlasError {}
