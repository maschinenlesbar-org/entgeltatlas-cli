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
import { EntgeltatlasParseError, EntgeltatlasSliceError, EntgeltatlasValidationError, cutText } from "./errors.js";
import { DIMENSION_PARAMS, dimensionCodeProblem, filterKeyProblem, type DimensionParam } from "./codes.js";
import { assertValid, describeType, headerValueProblem, isPlainObject, normalizeApiKey, optionsObject } from "./validate.js";
import type { EntgeltEntry, EntgelteOptions, EntgelteParams, ReferenceItem } from "./types.js";

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

/** A server label for a message: JSON-quoted (C0 escaped), DEL/C1 dropped, at most 80 characters (never half a character). */
function quoteLabel(label: string): string {
  return JSON.stringify(label.length > 80 ? `${cutText(label, 80)}…` : label).replace(/[\u007f-\u009f]/g, "");
}

/** The row field that carries each dimension filter's code. */
const ROW_FIELD: Record<DimensionParam, (typeof ROW_DIMENSIONS)[number]> = {
  l: "performanceLevel",
  r: "region",
  g: "gender",
  a: "ageCategory",
  b: "branche",
};

/**
 * Check that every row is the slice that was asked for: for each dimension filter that
 * was sent, the row's dimension id must equal it. A server that ignores a filter (or a
 * gateway that serves a cached answer) would otherwise hand back the Deutschland /
 * Gesamt figure as the answer to "Baden-Württemberg, Frauen", with HTTP 200. An omitted
 * dimension is not checked: the API answers one row per value of it (recorded live on
 * 2026-10-06: all four age bands for an omitted `a`).
 */
function assertRequestedSlice(rows: EntgeltEntry[], query: Record<string, unknown>, path: string): void {
  for (const param of DIMENSION_PARAMS) {
    const wanted = query[param];
    if (wanted === undefined) continue;
    const field = ROW_FIELD[param];
    rows.forEach((row, i) => {
      const got = row[field];
      if (got.id !== wanted) {
        throw new EntgeltatlasSliceError(
          `The API answered another slice than the one requested from ${path}: ${param}=${String(wanted)} was ` +
            `asked for, but row ${i} has ${field}.id ${got.id} (${quoteLabel(got.bezeichnung)}). It may have ` +
            "ignored the filter; no figure is returned rather than the wrong one.",
          { param, requested: wanted as number, received: got.id, row: i },
        );
      }
    });
  }
}

/** The figure fields of a salary row: each a JSON number, `null`, or absent. */
const ROW_FIGURES = ["entgelt", "entgeltQ25", "entgeltQ75", "besetzung"] as const;

/** Why `value` is not a salary row (the documented shape), or undefined. */
function entgeltRowProblem(value: unknown): string | undefined {
  if (!isObject(value)) return "is not an object";
  if (typeof value["kldb"] !== "string") return "has no kldb text";
  for (const name of ROW_DIMENSIONS) {
    const problem = labelledCodeProblem(value[name]);
    if (problem !== undefined) return `${name} ${problem}`;
  }
  // A figure is a number (negative ones are the API's markers, see GLOSSARY.md) or
  // null; a string such as "6.123,00" would turn a caller's arithmetic into string
  // concatenation, and the types promise `number | null`.
  for (const name of ROW_FIGURES) {
    const figure = value[name];
    if (figure !== undefined && figure !== null && !(typeof figure === "number" && Number.isFinite(figure))) {
      return `has a figure ${name} that is not a number or null (${describeType(figure)})`;
    }
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
  async entgelte(kldb: string, params: EntgelteParams = {}, options: EntgelteOptions = {}): Promise<EntgeltEntry[]> {
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
    const { allowUnknownFilters = false } = optionsObject("options", options);
    // Every key the caller set, own and enumerable — a JSON-parsed "__proto__" included.
    const query: Record<string, string | number | boolean> = {};
    for (const key of Object.keys(params)) {
      assertValid("params", key, (k) => filterKeyProblem(k, allowUnknownFilters === true));
      const value = (params as Record<string, unknown>)[key];
      if (value === undefined) continue;
      if ((DIMENSION_PARAMS as readonly string[]).includes(key)) {
        // One integer code from the dimension's table: an array, NaN, a string or null
        // is rejected (the API takes one value, and might ignore a bad one).
        query[key] = assertValid(key, value as number, dimensionCodeProblem(key as DimensionParam));
      } else if (
        typeof value === "string" ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value))
      ) {
        query[key] = value;
      } else {
        throw new EntgeltatlasValidationError(
          `Invalid ${JSON.stringify(key)}: Expected a string, a finite number or a boolean, got ${describeType(value)}.`,
        );
      }
    }
    const path = `${SERVICE}/entgelte/${kldb}`;
    const res = await this.#engine.getJson<unknown>(path, query);
    // The API is documented to return an array of observations; anything else is
    // a ParseError, never wrapped or coerced (an empty array means suppressed).
    const rows = assertArrayOf<EntgeltEntry>(res, path, "salary rows", entgeltRowProblem, true);
    assertRequestedSlice(rows, query, path);
    return rows;
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
