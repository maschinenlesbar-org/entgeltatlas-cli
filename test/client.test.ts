import { test } from "node:test";
import assert from "node:assert/strict";
import { EntgeltatlasClient, type EntgeltatlasClientOptions } from "../src/client/client.js";
import { EntgeltatlasValidationError } from "../src/client/errors.js";
import { makeMockTransport, jsonResponse, queryOf, type MockTransport } from "./helpers.js";
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

test("entgelte wraps a single returned object into an array (defensive)", async () => {
  const single = fx.entgelteResult[0]!;
  const { c } = client(() => jsonResponse(single), { apiKey: "K" });
  assert.deepEqual(await c.entgelte("84304"), [single]);
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

test("a reference endpoint returning a non-array yields []", async () => {
  const { c } = client(() => jsonResponse({ unexpected: true }), { apiKey: "K" });
  assert.deepEqual(await c.branchen(), []);
});
