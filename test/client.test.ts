import { test } from "node:test";
import assert from "node:assert/strict";
import { EntgeltatlasClient, type EntgeltatlasClientOptions } from "../src/client/client.js";
import {
  EntgeltatlasNetworkError,
  EntgeltatlasParseError,
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
  const { c, mt } = client(() => jsonResponse(fx.entgelteResult), { apiKey: "K" });
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
        err.message ===
          "Unexpected response shape from /infosysbub/entgeltatlas/pc/v1/entgelte/84304: expected a JSON array of objects.",
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
        /^Unexpected response shape from \/infosysbub\/entgeltatlas\/pc\/v1\/branchen: expected a JSON array of objects\.$/.test(err.message),
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
      EntgeltatlasNetworkError,
      baseUrl,
    );
    assert.equal(mt.calls.length, 0);
  }
});
