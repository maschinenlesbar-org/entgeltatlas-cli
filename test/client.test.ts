import { test } from "node:test";
import assert from "node:assert/strict";
import { EntgeltatlasClient, type EntgeltatlasClientOptions } from "../src/client/client.js";
import {
  EntgeltatlasParseError,
  EntgeltatlasSliceError,
  EntgeltatlasValidationError,
} from "../src/client/errors.js";
import { makeMockTransport, jsonResponse, rawResponse, queryOf, type MockTransport } from "./helpers.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import * as fx from "./fixtures.js";

function client(
  responder: (req: HttpRequest) => HttpResponse,
  options: Omit<EntgeltatlasClientOptions, "transport"> = {},
): { c: EntgeltatlasClient; mt: MockTransport } {
  const mt = makeMockTransport(responder);
  const c = new EntgeltatlasClient({ ...options, transport: mt.transport });
  return { c, mt };
}

test("entgelte sends the X-API-Key, hits the KldB path, and forwards dimensions", async () => {
  const { c, mt } = client(() => jsonResponse(fx.entgelteResult), { apiKey: "KEY-UUID" });
  const res = await c.entgelte("84304", { l: 4, r: 1, g: 1, a: 1, b: 1 });
  assert.deepEqual(res, fx.entgelteResult);
  const req = mt.last();
  assert.equal(req.headers?.["X-API-Key"], "KEY-UUID");
  assert.equal(new URL(req.url).pathname, "/infosysbub/entgeltatlas/pc/v1/entgelte/84304");
  const q = queryOf(req);
  assert.equal(q.get("l"), "4");
  assert.equal(q.get("r"), "1");
  assert.equal(q.get("b"), "1");
});

test("entgelte omits dimension params that were not set", async () => {
  const { c, mt } = client(() => jsonResponse([]), { apiKey: "K" });
  await c.entgelte("84304", { r: 5 });
  const q = queryOf(mt.last());
  assert.equal(q.get("r"), "5");
  assert.equal(q.get("l"), null);
  assert.equal(q.get("g"), null);
});

test("entgelte rejects a non-numeric KldB code before any request", async () => {
  const { c, mt } = client(() => jsonResponse(fx.entgelteResult), { apiKey: "K" });
  await assert.rejects(() => c.entgelte("Softwareentwickler"), EntgeltatlasValidationError);
  assert.equal(mt.calls.length, 0);
});

test("entgelte rejects a body that is not an array of objects", async () => {
  const bodies: unknown[] = [fx.entgelteResult[0], { error: "not an array", status: 500 }, "hello", 42, null, ["x"], [null], [[]]];
  for (const body of bodies) {
    const { c } = client(() => jsonResponse(body), { apiKey: "K" });
    await assert.rejects(
      () => c.entgelte("84304"),
      (err) =>
        err instanceof EntgeltatlasParseError &&
        err.message.startsWith(
          "Unexpected response shape from /infosysbub/entgeltatlas/pc/v1/entgelte/84304: expected a JSON array of salary rows",
        ),
      JSON.stringify(body),
    );
  }
});

test("entgelte rejects an empty or 204 body instead of returning []", async () => {
  for (const status of [200, 204]) {
    const { c } = client(() => rawResponse("", "application/json", status), { apiKey: "K" });
    await assert.rejects(() => c.entgelte("84304"), EntgeltatlasParseError);
  }
});

test("entgelte returns [] for a suppressed/empty result", async () => {
  const { c } = client(() => jsonResponse([]), { apiKey: "K" });
  assert.deepEqual(await c.entgelte("84304"), []);
});

test("no apiKey means no X-API-Key header is sent", async () => {
  const { c, mt } = client(() => jsonResponse([]));
  await c.entgelte("84304");
  assert.equal(mt.last().headers?.["X-API-Key"], undefined);
});

test("a blank apiKey is treated as unset", async () => {
  const { c, mt } = client(() => jsonResponse([]), { apiKey: "   " });
  await c.entgelte("84304");
  assert.equal(mt.last().headers?.["X-API-Key"], undefined);
});

test("regionen hits the reference endpoint and returns the array", async () => {
  const { c, mt } = client(() => jsonResponse(fx.regionen), { apiKey: "K" });
  const res = await c.regionen();
  assert.deepEqual(res, fx.regionen);
  assert.equal(new URL(mt.last().url).pathname, "/infosysbub/entgeltatlas/pc/v1/regionen");
});

test("a reference endpoint returning a non-array is a parse error, not []", async () => {
  const bodies: unknown[] = [{ unexpected: true }, { _embedded: [{ id: 1, bezeichnung: "x" }] }, null, "x", [1]];
  for (const body of bodies) {
    const { c } = client(() => jsonResponse(body), { apiKey: "K" });
    await assert.rejects(
      () => c.branchen(),
      (err) =>
        err instanceof EntgeltatlasParseError &&
        /^Unexpected response shape from \/infosysbub\/entgeltatlas\/pc\/v1\/branchen: expected a JSON array of codes/.test(err.message),
      JSON.stringify(body),
    );
  }
  const { c } = client(() => rawResponse("", "application/json", 204), { apiKey: "K" });
  await assert.rejects(() => c.regionen(), EntgeltatlasParseError);
});

test("the client rejects a non-http(s) base URL before any request", () => {
  for (const baseUrl of ["file:///etc/passwd", "ftp://example.org"]) {
    const mt = makeMockTransport(() => jsonResponse([]));
    assert.throws(
      () => new EntgeltatlasClient({ baseUrl, apiKey: "KEY-UUID", transport: mt.transport }),
      EntgeltatlasValidationError,
      baseUrl,
    );
    assert.equal(mt.calls.length, 0);
  }
});

test("the client rejects an apiKey an HTTP header cannot carry", () => {
  for (const apiKey of ["abc\ndef", "ключ", "a\u007fb"]) {
    assert.throws(() => new EntgeltatlasClient({ apiKey }), EntgeltatlasValidationError, JSON.stringify(apiKey));
  }
});

test("P9: a salary row or a code without the documented fields is a parse error, and a reference list is never empty", async () => {
  const row = fx.entgelteResult[0]!;
  const badRows: unknown[] = [
    [{ ...row, kldb: 84304 }],
    [{ ...row, region: undefined }],
    [{ ...row, gender: { id: "3", bezeichnung: "Frauen" } }],
    [{ ...row, branche: { id: 1 } }],
    [{ error: "boom" }],
    [{ id: 1, bezeichnung: "Deutschland" }],
  ];
  for (const body of badRows) {
    const { c } = client(() => jsonResponse(body), { apiKey: "K" });
    await assert.rejects(() => c.entgelte("84304"), EntgeltatlasParseError, JSON.stringify(body));
  }
  for (const body of [[], [{ id: 1 }], [{ bezeichnung: "x" }], [{ id: 1.5, bezeichnung: "x" }], [row]]) {
    const { c } = client(() => jsonResponse(body), { apiKey: "K" });
    await assert.rejects(() => c.regionen(), EntgeltatlasParseError, JSON.stringify(body));
  }
  // An empty salary list is the documented suppressed answer, not an error.
  const { c } = client(() => jsonResponse([]), { apiKey: "K" });
  assert.deepEqual(await c.entgelte("84304"), []);
});

test("P10: allowUnknownFilters sends an extra parameter, never __proto__ and never an array", async () => {
  const { c, mt } = client(() => jsonResponse([]), { apiKey: "K" });
  await c.entgelte("84304", { l: 4, x: "1" } as never, { allowUnknownFilters: true });
  assert.equal(new URL(mt.last().url).search, "?l=4&x=1");
  for (const params of [JSON.parse('{"__proto__": 1}'), { constructor: 1 }, { x: [1, 2] }, { x: { y: 1 } }]) {
    await assert.rejects(
      () => c.entgelte("84304", params as never, { allowUnknownFilters: true }),
      EntgeltatlasValidationError,
      JSON.stringify(params),
    );
  }
});

test("02#1: a row of another slice than the one requested is an EntgeltatlasSliceError, not the answer", async () => {
  // The repro: -r 11 -g 3 asked, the server answers the Deutschland / Gesamt row.
  const { c } = client(() => jsonResponse(fx.entgelteResult), { apiKey: "K" });
  await assert.rejects(
    () => c.entgelte("84304", { l: 4, r: 11, g: 3 }),
    (err) =>
      err instanceof EntgeltatlasSliceError &&
      err instanceof EntgeltatlasParseError &&
      err.param === "r" &&
      err.requested === 11 &&
      err.received === 1 &&
      /r=11 was asked for, but row 0 has region.id 1 \("Deutschland"\)/.test(err.message),
  );
  // The matching slice passes, and an omitted dimension may come back as several rows.
  const row = fx.entgelteResult[0]!;
  const ages = [1, 2, 3, 4].map((id) => ({ ...row, ageCategory: { id, bezeichnung: `a${id}` } }));
  const ok = client(() => jsonResponse(ages), { apiKey: "K" });
  assert.equal((await ok.c.entgelte("84304", { l: 4, r: 1, g: 1, b: 1 })).length, 4);
  // One stray row among matching ones is enough to refuse the answer.
  const mixed = client(() => jsonResponse([...ages, { ...row, branche: { id: 7, bezeichnung: "Finanz" } }]), { apiKey: "K" });
  await assert.rejects(() => mixed.c.entgelte("84304", { b: 1 }), EntgeltatlasSliceError);
});

test("02#4: a figure that is not a number or null is a parse error; negative markers are data", async () => {
  const row = fx.entgelteResult[0]!;
  for (const bad of [{ entgelt: "6.123,00" }, { besetzung: "41234" }, { entgeltQ25: true }, { entgeltQ75: { v: 1 } }, { entgelt: [6123] }]) {
    const { c } = client(() => jsonResponse([{ ...row, ...bad }]), { apiKey: "K" });
    await assert.rejects(
      () => c.entgelte("84304"),
      (err) => err instanceof EntgeltatlasParseError && /is not a number or null/.test(err.message),
      JSON.stringify(bad),
    );
  }
  // The live markers (2026-10-06): -1 for a cell without a figure, -2 for a quartile above the ceiling.
  for (const ok of [{ entgelt: -1, entgeltQ25: -1, entgeltQ75: -1, besetzung: -42 }, { entgeltQ75: -2 }, { entgelt: null }]) {
    const { c } = client(() => jsonResponse([{ ...row, ...ok }]), { apiKey: "K" });
    assert.equal((await c.entgelte("84304")).length, 1, JSON.stringify(ok));
  }
});

test("a long server label in the slice error is cut, never inside a surrogate pair", async () => {
  const row = fx.entgelteResult[0]!;
  for (const label of ["\u{1f600}".repeat(60), "a" + "\u{1f600}".repeat(60)]) {
    const { c } = client(() => jsonResponse([{ ...row, region: { id: 1, bezeichnung: label } }]), { apiKey: "K" });
    await assert.rejects(
      () => c.entgelte("84304", { r: 11 }),
      (err: Error) => err instanceof EntgeltatlasSliceError && /…"\)/.test(err.message) && !/\\ud83d/.test(err.message),
      label.length.toString(),
    );
  }
});
