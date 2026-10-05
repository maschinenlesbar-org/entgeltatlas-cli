// Public entry point for the API client library.

export { EntgeltatlasClient } from "./client.js";
export type { EntgeltatlasClientOptions } from "./client.js";
export {
  RequestEngine,
  DEFAULT_BASE_URL,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_USER_AGENT,
  MAX_REDIRECTS,
  MAX_RETRIES,
  MAX_RETRY_AFTER_MS,
  assertHeaderValue,
  parseRetryAfter,
  transientRetryDelay,
  validateBaseUrl,
} from "./engine.js";
export type { EngineOptions, RawResponse } from "./engine.js";
export { MAX_TIMEOUT_MS, nodeHttpTransport } from "./http.js";
export type { Transport, HttpRequest, HttpResponse } from "./http.js";
export { obtainKey, API_KEY_ENV_VAR, KEY_FORMAT, KEY_SOURCE_URL, MAX_KEY_SOURCE_REDIRECTS } from "./obtain-key.js";
export type { ObtainKeyOptions, ObtainedKey } from "./obtain-key.js";
export { buildQueryString } from "./query.js";
export {
  assertValid,
  baseUrlProblem,
  baseUrlWhitespaceProblem,
  headerNameProblem,
  headerValueProblem,
  httpUrlProblem,
  intRangeProblem,
  normalizeApiKey,
} from "./validate.js";
export { DIMENSIONS, DIMENSION_PARAMS, dimensionCodeProblem } from "./codes.js";
export type { CodeEntry, Dimension, DimensionCodeWording, DimensionParam } from "./codes.js";
export type { Problem } from "./validate.js";
export type { QueryParams, QueryValue } from "./query.js";
export {
  EntgeltatlasError,
  EntgeltatlasApiError,
  EntgeltatlasKeySourceError,
  EntgeltatlasNetworkError,
  EntgeltatlasValidationError,
  EntgeltatlasParseError,
  redactUrl,
} from "./errors.js";

export * from "./types.js";
