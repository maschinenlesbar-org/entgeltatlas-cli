// EntgeltatlasClient — a typed client over the open Entgeltatlas API of the
// Bundesagentur für Arbeit (rest.arbeitsagentur.de/infosysbub/entgeltatlas).
//
// Auth: the API requires a static, publicly-documented `X-API-Key` header (its
// value is the BA "client_id" UUID). The key is NOT bundled with this client —
// pass it via `apiKey` (the CLI maps this to `--api-key` / the
// ENTGELTATLAS_API_KEY env var). When no key is supplied the header is omitted
// and the API answers 401/403. The public key can be fetched out-of-band for
// CI / live testing via scripts/fetch-api-key.mjs.
//
//   client.entgelte("84304", { l: 4, r: 1 })
//   client.regionen()

import { RequestEngine, type EngineOptions } from "./engine.js";
import { EntgeltatlasValidationError } from "./errors.js";
import type { QueryParams } from "./query.js";
import type { EntgeltEntry, EntgelteParams, ReferenceItem } from "./types.js";

const SERVICE = "/infosysbub/entgeltatlas/pc/v1";

/** A KldB-2010 occupation code as accepted by the API: 3–5 ASCII digits. */
const KLDB_PATTERN = /^[0-9]{3,5}$/;

/** Options for the Entgeltatlas client (engine options plus the API key). */
export interface EntgeltatlasClientOptions extends EngineOptions {
  /**
   * The `X-API-Key` to send (the BA client_id UUID). No key is bundled; when
   * omitted (or blank) the header is not sent. Obtain the public key via
   * scripts/fetch-api-key.mjs.
   */
  apiKey?: string;
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
    const res = await this.engine.getJson<EntgeltEntry[] | EntgeltEntry | null>(
      `${SERVICE}/entgelte/${kldb}`,
      prune({ ...params }),
    );
    // The API is documented to return an array; defend against a single object
    // or a null/empty body so callers always get a well-formed array.
    if (Array.isArray(res)) return res;
    return res ? [res] : [];
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
    const res = await this.engine.getJson<ReferenceItem[] | null>(`${SERVICE}/${name}`);
    return Array.isArray(res) ? res : [];
  }
}
