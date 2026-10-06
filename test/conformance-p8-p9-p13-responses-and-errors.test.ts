// Conformance test P8 + P9 + P13 (fix plan 2026-10-06): a body is decoded by its declared
// charset (P8); a 2xx body without the documented shape is a parse error, never data or
// "nothing found" (P9); every rejected input is the library's validation error, never a raw
// TypeError or RangeError (P13). Shared across the *-cli repos; only the adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { EntgeltatlasClient as Client } from "../src/client/client.js";
import {
  EntgeltatlasError as BaseError,
  EntgeltatlasParseError as ParseError,
  EntgeltatlasValidationError as ValidationError,
} from "../src/client/errors.js";
import { obtainKey } from "../src/client/obtain-key.js";
/** A call whose answer contains a text field, and how to read that field from the result. */
const textCall = (client: Client): Promise<unknown> => client.regionen();
const textBody = (text: string): unknown => [{ id: 11, bezeichnung: text, schluessel: "08" }];
const readText = (result: unknown): string => (result as Array<{ bezeichnung: string }>)[0]!.bezeichnung;
/** 2xx bodies the call must reject (error envelopes, empty or wrong shapes). None is an error envelope. */
const malformedBodies: unknown[] = [
  null,
  {},
  [],
  "text",
  42,
  { error: "boom" },
  [{ error: "boom" }],
  [null],
  [{ id: "11", bezeichnung: "Baden-Württemberg" }],
  [{ id: 11 }],
  { _embedded: [{ id: 11, bezeichnung: "Baden-Württemberg" }] },
];
type Any = never;
/** Library calls with wrong-typed or out-of-range input. */
const badCalls: Array<[string, () => unknown]> = [
  ["entgelte(null)", () => new Client().entgelte(null as Any)],
  ["entgelte(84304)", () => new Client().entgelte(84304 as Any)],
  ["entgelte('84304', null)", () => new Client().entgelte("84304", null as Any)],
  ["entgelte('84304', 'x')", () => new Client().entgelte("84304", "x" as Any)],
  ["entgelte('84304', { l: '4' })", () => new Client().entgelte("84304", { l: "4" as Any })],
  ["entgelte('84304', { r: 31 })", () => new Client().entgelte("84304", { r: 31 })],
  ["options: 5", () => new Client(5 as Any)],
  ["apiKey: 5", () => new Client({ apiKey: 5 as Any })],
  ["timeoutMs: 'x'", () => new Client({ timeoutMs: "x" as Any })],
  ["timeoutMs: -1", () => new Client({ timeoutMs: -1 })],
  ["maxRetries: 1.5", () => new Client({ maxRetries: 1.5 })],
  ["baseUrl: 5", () => new Client({ baseUrl: 5 as Any })],
  ["userAgent: {}", () => new Client({ userAgent: {} as Any })],
  ["transport: 'x'", () => new Client({ transport: "x" as Any })],
  ["sleep: 5", () => new Client({ sleep: 5 as Any })],
  ["defaultHeaders: 'x'", () => new Client({ defaultHeaders: "x" as Any })],
  ["obtainKey(5)", () => obtainKey(5 as Any)],
  ["obtainKey({ transport: 'x' })", () => obtainKey({ transport: "x" as Any })],
  ["obtainKey({ sourceUrl: 5 })", () => obtainKey({ sourceUrl: 5 as Any })],
];
// --------------------------------------------------------------------------------------

const respond = (body: Buffer, contentType: string) => async (): Promise<HttpResponse> => ({
  status: 200,
  headers: { "content-type": contentType },
  body,
});

test("P8: a body is decoded by its declared charset", async () => {
  const text = "Müller µg/l";
  for (const [charset, encoding] of [["iso-8859-1", "latin1"], ["utf-8", "utf8"]] as const) {
    const body = Buffer.from(JSON.stringify(textBody(text)), encoding);
    const client = new Client({ transport: respond(body, `application/json; charset=${charset}`) });
    assert.equal(readText(await textCall(client)), text, charset);
  }
});

test("P9: a 2xx body without the documented shape is a parse error", async () => {
  for (const body of malformedBodies) {
    const client = new Client({ transport: respond(Buffer.from(JSON.stringify(body)), "application/json"), maxRetries: 0 });
    await assert.rejects(textCall(client), BaseError, `body ${JSON.stringify(body)}`);
    // An error envelope is the API's error; every other wrong shape is a parse error.
    const isErrorEnvelope = typeof body === "object" && body !== null && "Type" in body;
    if (!isErrorEnvelope) await assert.rejects(textCall(client), ParseError, `body ${JSON.stringify(body)}`);
  }
  for (const raw of ["", "<html>maintenance</html>"]) {
    const client = new Client({ transport: respond(Buffer.from(raw), "text/html"), maxRetries: 0 });
    await assert.rejects(textCall(client), BaseError, `raw ${JSON.stringify(raw)}`);
  }
});

test("P13: every rejected input is the validation error, never a raw TypeError", async () => {
  for (const [label, fn] of badCalls) {
    await assert.rejects(async () => fn(), (e: unknown) => e instanceof ValidationError, label);
  }
});
