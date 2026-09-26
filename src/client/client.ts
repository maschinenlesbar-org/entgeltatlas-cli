// EntgeltatlasClient — a typed client over the open Entgeltatlas API of the
// Bundesagentur für Arbeit (rest.arbeitsagentur.de/infosysbub/entgeltatlas).
//
// Auth: the API requires a static, publicly-documented `X-API-Key` header (its
// value is the BA "client_id" UUID). The key is NOT bundled with this client —
// pass it via `apiKey` (the CLI maps this to `--api-key` / the
// ENTGELTATLAS_API_KEY env var). When no key is supplied the header is omitted
// and the API answers 401/403. The public key is fetched at run time by
// obtainKey() / the CLI's `obtain-key` command.
//
//   client.entgelte("84304", { l: 4, r: 1 })
//   client.regionen()

import { RequestEngine, type EngineOptions } from "./engine.js";
import { EntgeltatlasParseError, EntgeltatlasValidationError } from "./errors.js";
import type { QueryParams } from "./query.js";
import type { EntgeltEntry, EntgelteParams, ReferenceItem } from "./types.js";

const SERVICE = "/infosysbub/entgeltatlas/pc/v1";

/** A KldB-2010 occupation code as accepted by the API: 3–5 ASCII digits. */
const KLDB_PATTERN = /^[0-9]{3,5}$/;

/** Options for the Entgeltatlas client (engine options plus the API key). */
export interface EntgeltatlasClientOptions extends EngineOptions {
  /**
   * The `X-API-Key` to send (the BA client_id UUID). No key is bundled; when
   * omitted (or blank) the header is not sent. Obtain the public key with
   * obtainKey() (see obtain-key.ts).
   */
  apiKey?: string;
}

/** True if Node can send `value` as a header value: no C0 control but tab, no DEL, nothing above U+00FF. */
function isHeaderSafe(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09) || c === 0x7f || c > 0xff) return false;
  }
  return true;
}

/** A non-null, non-array JSON object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Check the top-level shape the CLI relies on: every endpoint answers a JSON
 * array of objects. Anything else (an error object with a 200, a string, a HAL
 * envelope) is not data and must not be printed as an observation or turned into
 * an empty — i.e. "suppressed" — result.
 */
function assertArrayOfObjects<T>(body: unknown, path: string): T[] {
  if (!Array.isArray(body) || !body.every(isObject)) {
    throw new EntgeltatlasParseError(
      `Unexpected response shape from ${path}: expected a JSON array of objects.`,
    );
  }
  return body as T[];
}

/** Drop undefined values so only the parameters the caller set are sent. */
function prune(params: Record<string, unknown>): QueryParams {
  const out: QueryParams = {};
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) out[k] = v as QueryParams[string];
  }
  return out;
}

export class EntgeltatlasClient {
  private readonly engine: RequestEngine;

  constructor(options: EntgeltatlasClientOptions = {}) {
    const { apiKey, ...engineOptions } = options;
    // Only send X-API-Key when a non-blank key was supplied; never default one.
    const key = apiKey?.trim() ? apiKey.trim() : undefined;
    if (key !== undefined && !isHeaderSafe(key)) {
      throw new EntgeltatlasValidationError(
        "Invalid apiKey: it contains control characters or characters outside Latin-1 " +
          "(above U+00FF), which an HTTP header cannot carry.",
      );
    }
    this.engine = new RequestEngine({
      ...engineOptions,
      defaultHeaders: {
        ...(key ? { "X-API-Key": key } : {}),
        ...engineOptions.defaultHeaders,
      },
    });
  }

  /**
   * Earnings statistics for one KldB-2010 occupation, sliced by the optional
   * dimensions (l/r/g/a/b). Returns one observation per slice — an array, which
   * is empty when the requested cell is suppressed (too few observations).
   */
  async entgelte(kldb: string, params: EntgelteParams = {}): Promise<EntgeltEntry[]> {
    if (!KLDB_PATTERN.test(kldb)) {
      throw new EntgeltatlasValidationError(
        `Invalid KldB code "${kldb}": expected 3–5 digits (e.g. 84304). ` +
          "This API takes the numeric KldB-2010 code, not an occupation name.",
      );
    }
    const path = `${SERVICE}/entgelte/${kldb}`;
    const res = await this.engine.getJson<unknown>(path, prune({ ...params }));
    // The API is documented to return an array of observations; anything else is
    // a ParseError, never wrapped or coerced (an empty array means suppressed).
    return assertArrayOfObjects<EntgeltEntry>(res, path);
  }

  /** Reference list of region codes (`r`). */
  regionen(): Promise<ReferenceItem[]> {
    return this.reference("regionen");
  }
  /** Reference list of gender codes (`g`). */
  geschlechter(): Promise<ReferenceItem[]> {
    return this.reference("geschlechter");
  }
  /** Reference list of age-band codes (`a`). */
  alter(): Promise<ReferenceItem[]> {
    return this.reference("alter");
  }
  /** Reference list of branch/industry codes (`b`). */
  branchen(): Promise<ReferenceItem[]> {
    return this.reference("branchen");
  }

  private async reference(name: string): Promise<ReferenceItem[]> {
    const path = `${SERVICE}/${name}`;
    return assertArrayOfObjects<ReferenceItem>(await this.engine.getJson<unknown>(path), path);
  }
}
