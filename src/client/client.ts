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
import { DIMENSION_PARAMS, dimensionCodeProblem } from "./codes.js";
import { assertValid, describeType, headerValueProblem, isPlainObject, normalizeApiKey, optionsObject } from "./validate.js";
import type { EntgeltEntry, EntgelteParams, ReferenceItem } from "./types.js";

const SERVICE = "/infosysbub/entgeltatlas/pc/v1";

/** A KldB-2010 occupation code as accepted by the API: 3–5 ASCII digits. */
const KLDB_PATTERN = /^[0-9]{3,5}$/;

/** Options for the Entgeltatlas client (engine options plus the API key). */
export interface EntgeltatlasClientOptions extends EngineOptions {
  /**
   * The `X-API-Key` to send (the BA client_id UUID). No key is bundled; when
   * omitted (or blank) the header is not sent. Surrounding whitespace is trimmed
   * (normalizeApiKey); a key an HTTP header cannot carry throws an
   * EntgeltatlasValidationError. Obtain the public key with obtainKey() (see obtain-key.ts).
   */
  apiKey?: string;
}

/** A non-null, non-array JSON object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Why `value` is not a labelled code (`{ id: <integer>, bezeichnung: <string> }`), or undefined. */
function labelledCodeProblem(value: unknown): string | undefined {
  if (!isObject(value)) return "is not an object";
  if (!Number.isSafeInteger(value["id"])) return "has no integer id";
  if (typeof value["bezeichnung"] !== "string") return "has no bezeichnung text";
  return undefined;
}

/** The dimension objects every salary row carries. */
const ROW_DIMENSIONS = ["region", "gender", "ageCategory", "performanceLevel", "branche"] as const;

/** Why `value` is not a salary row (the documented shape), or undefined. */
function entgeltRowProblem(value: unknown): string | undefined {
  if (!isObject(value)) return "is not an object";
  if (typeof value["kldb"] !== "string") return "has no kldb text";
  for (const name of ROW_DIMENSIONS) {
    const problem = labelledCodeProblem(value[name]);
    if (problem !== undefined) return `${name} ${problem}`;
  }
  return undefined;
}

/**
 * Check the documented shape of an answer: a JSON array whose every element passes
 * `itemProblem`, and — for a reference list, which is never empty — at least one
 * element. Anything else (an error object with a 200, a string, a HAL envelope, a
 * salary row where a code was expected) is not data and must not be printed as an
 * observation or turned into an empty — i.e. "suppressed" — result: it is an
 * EntgeltatlasParseError (CLI exit 1).
 */
function assertArrayOf<T>(
  body: unknown,
  path: string,
  what: string,
  itemProblem: (value: unknown) => string | undefined,
  allowEmpty: boolean,
): T[] {
  if (!Array.isArray(body)) {
    throw new EntgeltatlasParseError(`Unexpected response shape from ${path}: expected a JSON array of ${what}.`);
  }
  if (!allowEmpty && body.length === 0) {
    throw new EntgeltatlasParseError(`Unexpected response from ${path}: an empty list (this list is never empty).`);
  }
  for (let i = 0; i < body.length; i++) {
    const problem = itemProblem(body[i]);
    if (problem !== undefined) {
      throw new EntgeltatlasParseError(
        `Unexpected response shape from ${path}: expected a JSON array of ${what}; element ${i} ${problem}.`,
      );
    }
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
  // A real private field: logging a client never shows the engine (and its key).
  readonly #engine: RequestEngine;

  constructor(options: EntgeltatlasClientOptions = {}) {
    const { apiKey, ...engineOptions } = optionsObject("options", options);
    // Checked before the spread below, which would turn a string into { 0: "x" }.
    if (engineOptions.defaultHeaders !== undefined && !isPlainObject(engineOptions.defaultHeaders as unknown)) {
      throw new EntgeltatlasValidationError("Invalid defaultHeaders: Expected an object of header names and values.");
    }
    // Only send X-API-Key when a non-blank key was supplied; never default one. The
    // key is trimmed first (normalizeApiKey), then checked like any header value.
    const key = normalizeApiKey(apiKey);
    if (key !== undefined) assertValid("apiKey", key, headerValueProblem);
    this.#engine = new RequestEngine({
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
   *
   * Rejects with an EntgeltatlasValidationError, before any request, for a KldB
   * code that is not 3–5 digits and for a dimension code outside its table in
   * DIMENSIONS (see dimensionCodeProblem).
   */
  async entgelte(kldb: string, params: EntgelteParams = {}): Promise<EntgeltEntry[]> {
    if (typeof kldb !== "string") {
      throw new EntgeltatlasValidationError(
        `Invalid KldB code: Expected a string of 3–5 digits (e.g. "84304"), got ${describeType(kldb)}.`,
      );
    }
    if (!isPlainObject(params as unknown)) {
      throw new EntgeltatlasValidationError(
        `Invalid params: Expected an object of dimension filters ({ l, r, g, a, b }), got ${describeType(params)}.`,
      );
    }
    if (!KLDB_PATTERN.test(kldb)) {
      throw new EntgeltatlasValidationError(
        `Invalid KldB code "${kldb}": expected 3–5 digits (e.g. 84304). ` +
          "This API takes the numeric KldB-2010 code, not an occupation name.",
      );
    }
    for (const param of DIMENSION_PARAMS) {
      const code = params[param];
      if (code !== undefined) assertValid(param, code, dimensionCodeProblem(param));
    }
    const path = `${SERVICE}/entgelte/${kldb}`;
    const res = await this.#engine.getJson<unknown>(path, prune({ ...params }));
    // The API is documented to return an array of observations; anything else is
    // a ParseError, never wrapped or coerced (an empty array means suppressed).
    return assertArrayOf<EntgeltEntry>(res, path, "salary rows", entgeltRowProblem, true);
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
    return assertArrayOf<ReferenceItem>(
      await this.#engine.getJson<unknown>(path),
      path,
      "codes ({id, bezeichnung})",
      labelledCodeProblem,
      false,
    );
  }
}
