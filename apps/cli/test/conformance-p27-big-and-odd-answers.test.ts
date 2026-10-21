// Conformance test P27 (fix plan 2026-10-21, D2 and D7): a big or odd answer is printed or
// refused in one clean record, within memory; never a heap crash, never output `jq` can't read.
// - A lone surrogate in an answer (`"\ud800"`) and bytes that are not valid UTF-8 are replaced
//   with U+FFFD, with one WARN record of <bin>.api naming the count and the request; the output is
//   well-formed and the run succeeds (one bad character never sinks a whole answer).
// Shared across the *-cli repos that print JSON; only the adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";

// ---- adapter (per repo) -------------------------------------------------------------
/** `parity` as in P24; `rawResponse(body, contentType)`. */
import type { HttpRequest, HttpResponse, Transport } from "@maschinenlesbar.org/entgeltatlas-client/internal/http";
import { parity as repoParity, rawResponse } from "./helpers.js";
import { EntgeltatlasClient as Client } from "@maschinenlesbar.org/entgeltatlas-client/internal/client";
/**
 * CLI argv (after the global options) for a call whose answer carries a free-form value, and the
 * same call in the library. The key is a dummy (the mock takes any), given so a spawned bin never
 * reads a credentials file.
 */
const call = ["--api-key", "dummy-key-1234", "entgelte", "84304"];
const lib = (client: Client): Promise<unknown> => client.entgelte("84304");
/**
 * The raw 2xx body with `json` (a JSON value, written as is) as that value: one salary row of the
 * documented shape with an extra member `x` (the shape check passes members it doesn't know).
 */
const bodyWith = (json: string): string =>
  `[{"kldb":"84304","region":{"id":1,"bezeichnung":"Deutschland"},"gender":{"id":1,"bezeichnung":"Gesamt"},` +
  `"ageCategory":{"id":1,"bezeichnung":"Gesamt"},"performanceLevel":{"id":4,"bezeichnung":"Experte"},` +
  `"branche":{"id":1,"bezeichnung":"Gesamt"},"entgelt":5731,"entgeltQ25":null,"entgeltQ75":null,"besetzung":null,"x":${json}}]`;
/** The value from the CLI's printed result and from the library's. */
const fromCli = (out: string): unknown => (JSON.parse(out) as Array<{ x: unknown }>)[0]?.x;
const fromLib = (value: unknown): unknown => (value as Array<{ x: unknown }>)[0]?.x;
/** The log program, as in `WARN [<bin>.api]`. */
const PROGRAM = "entgeltatlas";
/**
 * The shared body's parity(argv, call, responder) over this repo's parity(argv, call, { responder }),
 * with the library's error as { name, message }, as the shared body reads it.
 */
async function parity(
  argv: string[],
  libCall: (transport: Transport) => unknown,
  responder?: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>,
) {
  const o = await repoParity(argv, libCall, responder === undefined ? {} : { responder });
  const e = o.lib.error;
  const error = e === undefined ? undefined : e instanceof Error ? { name: e.constructor.name, message: e.message } : { name: typeof e, message: String(e) };
  return { cli: o.cli, lib: { ok: o.lib.ok, value: o.lib.value, error, requests: o.lib.requests } };
}
// --------------------------------------------------------------------------------------

/** The body with the string value `a<bytes>b`, the bytes as they are. */
const withBytes = (bytes: number[]): Buffer => {
  const [head = "", tail = ""] = bodyWith('"a\u0000b"').split("\u0000");
  return Buffer.concat([Buffer.from(head), Buffer.from(bytes), Buffer.from(tail)]);
};

const WELL_FORMED = (text: string): boolean => !/[\ud800-\udfff]/u.test(text) && !/\\u[dD][89abAB][0-9a-fA-F]{2}(?!\\u[dD][c-fC-F])/.test(text);

test("P27: a lone surrogate or invalid bytes are replaced with U+FFFD and reported, never silent or fatal", async () => {
  const cases: Array<[string, Buffer, string, number]> = [
    ["a lone high surrogate", Buffer.from(bodyWith('"a\\ud800b"')), "a\ufffdb", 1],
    ["a lone low surrogate and a pair", Buffer.from(bodyWith('"\\udc00\\ud83d\\ude00"')), "\ufffd\u{1f600}", 1],
    ["invalid UTF-8", withBytes([0xff, 0xfe]), "a\ufffd\ufffdb", 2],
  ];
  for (const [label, body, expected, count] of cases) {
    const o = await parity(call, (t) => lib(new Client({ transport: t })), () => rawResponse(body, "application/json"));
    assert.equal(o.cli.code, 0, `${label}: ${o.cli.err}`);
    assert.ok(WELL_FORMED(o.cli.out), `${label}: ${o.cli.out}`);
    assert.equal(fromCli(o.cli.out), expected, label);
    const warn = new RegExp(
      `^WARN  \\[${PROGRAM}\\.api\\] GET \\S+: ${count} characters? of the answer (was|were) not valid text .*replaced with U\\+FFFD\\.$`,
    );
    assert.match(o.cli.err, warn, `${label}: ${o.cli.err}`);
    assert.equal(o.lib.ok, true, `${label}: ${o.lib.error?.message}`);
    assert.equal(fromLib(o.lib.value), expected, label);
  }
});
