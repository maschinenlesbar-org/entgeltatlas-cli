// Test helpers of this server's own tests and the adapters of the conformance tests: a mock of
// the Entgeltatlas API on its own paths (the salary endpoint and the reference lists) answering
// with the client's recorded answers (recorded.ts, live on 2026-11-20), and the client's transport
// helpers. The generic harness (a connection, a config, a log recorder, the HTTP server) is
// harness.ts; it gives the server TEST_ENV, so no test reads a credentials file or obtains a key.

import { DIMENSIONS } from "@maschinenlesbar.org/entgeltatlas-client";
import { jsonResponse, makeMockTransport, type MockTransport } from "@maschinenlesbar.org/entgeltatlas-client/test/helpers";
import {
  KLDB_434_L2_GENDERS,
  KLDB_434_L2_REGIONS,
  KLDB_434_LEVELS,
  KLDB_81302_SAARLAND_WOMEN_U25,
  KLDB_814_LEVELS,
  KLDB_84304_DE_GESAMT,
  REGIONEN,
} from "@maschinenlesbar.org/entgeltatlas-client/test/recorded";

export * from "@maschinenlesbar.org/entgeltatlas-client/test/helpers";
export * from "@maschinenlesbar.org/entgeltatlas-client/test/recorded";

/** The test key the server finds in its environment (harness.ts); never a real one. */
export const TEST_KEY = "test-key-only";

/** The environment every server of these tests sees, unless a test passes its own. */
export const TEST_ENV: Record<string, string> = { ENTGELTATLAS_API_KEY: TEST_KEY };

/** The recorded salary answers, by the code and which dimension the request left out; else no rows. */
export function recordedEntgelte(kldb: string, query: URLSearchParams): unknown {
  if (kldb === "84304") return KLDB_84304_DE_GESAMT;
  if (kldb === "81302") return KLDB_81302_SAARLAND_WOMEN_U25;
  if (kldb === "814") return KLDB_814_LEVELS;
  if (kldb === "434") {
    if (!query.has("l")) return KLDB_434_LEVELS;
    if (!query.has("g")) return KLDB_434_L2_GENDERS;
    if (!query.has("r")) return KLDB_434_L2_REGIONS;
    return KLDB_434_L2_GENDERS.filter((row) => row.gender.id === Number(query.get("g")));
  }
  return [];
}

const tableOf = (param: string) => DIMENSIONS.find((d) => d.param === param)?.values ?? [];

/** The reference lists: the recorded regions, the others from the code tables. */
const LISTS: Record<string, unknown> = { regionen: REGIONEN, geschlechter: tableOf("g"), alter: tableOf("a"), branchen: tableOf("b") };

/**
 * The Entgeltatlas API: `/infosysbub/entgeltatlas/pc/v1/entgelte/<kldb>` answered by `entgelte`
 * (default: recordedEntgelte), the reference lists by name, anything else 404.
 */
export function entgeltatlasApi(options: { entgelte?: (kldb: string, query: URLSearchParams) => unknown } = {}): MockTransport {
  return makeMockTransport((request) => {
    const url = new URL(request.url);
    const kldb = url.pathname.match(/\/infosysbub\/entgeltatlas\/pc\/v1\/entgelte\/(\d+)$/)?.[1];
    if (kldb !== undefined) return jsonResponse((options.entgelte ?? recordedEntgelte)(kldb, url.searchParams));
    const list = url.pathname.match(/\/infosysbub\/entgeltatlas\/pc\/v1\/(\w+)$/)?.[1];
    if (list !== undefined && LISTS[list] !== undefined) return jsonResponse(LISTS[list]);
    return jsonResponse({ message: "no such path" }, 404);
  });
}
