import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestEngine } from "../src/client/engine.js";
import { EntgeltatlasApiError, EntgeltatlasParseError } from "../src/client/errors.js";
import type { HttpResponse } from "../src/client/http.js";
import { makeMockTransport, jsonResponse, rawResponse } from "./helpers.js";

// Built via char codes so no raw control bytes ever appear in this source file.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

test("buildUrl normalises the path and appends the query", () => {
  const e = new RequestEngine({ baseUrl: "https://rest.test/" });
  assert.equal(e.buildUrl("api/"), "https://rest.test/api/");
  assert.equal(e.buildUrl("/x", { a: "1", b: ["2", "3"] }), "https://rest.test/x?a=1&b=2&b=3");
});

test("getJson parses a JSON array body", async () => {
  const mt = makeMockTransport(() => jsonResponse([{ ok: true }]));
  const e = new RequestEngine({ transport: mt.transport });
  assert.deepEqual(await e.getJson("/x"), [{ ok: true }]);
});

test("getJson returns null for an empty body", async () => {
  const mt = makeMockTransport(() => rawResponse("", "application/json", 204));
  const e = new RequestEngine({ transport: mt.transport });
  assert.equal(await e.getJson("/x"), null);
});

test("getJson throws EntgeltatlasParseError on invalid JSON", async () => {
  const mt = makeMockTransport(() => rawResponse("not json", "application/json"));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(() => e.getJson("/x"), EntgeltatlasParseError);
});

test("error detail is stripped of terminal control characters (EA-02)", async () => {
  // A hostile/MITM'd endpoint returns an error body whose message carries ESC/BEL
  // control bytes. JSON.parse decodes them into real bytes; the sanitizer must
  // remove them before they reach err.message and are printed to stderr.
  const hostile = JSON.stringify({ message: `${ESC}]0;pwned${BEL}denied${ESC}[2J` });
  const mt = makeMockTransport(() => rawResponse(hostile, "application/json", 403));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) => {
      assert.ok(err instanceof EntgeltatlasApiError);
      assert.equal(err.detail, "]0;pwneddenied[2J");
      assert.ok(!err.message.includes(ESC));
      assert.ok(!err.message.includes(BEL));
      return true;
    },
  );
});

test("the default X-API-Key, Accept and User-Agent headers are sent", async () => {
  const mt = makeMockTransport(() => jsonResponse([]));
  const e = new RequestEngine({
    transport: mt.transport,
    userAgent: "ua/1",
    defaultHeaders: { "X-API-Key": "SECRET" },
  });
  await e.getJson("/x");
  assert.equal(mt.last().headers?.["X-API-Key"], "SECRET");
  assert.equal(mt.last().headers?.["Accept"], "application/json");
  assert.equal(mt.last().headers?.["User-Agent"], "ua/1");
});

test("a 503 is retried up to maxRetries then surfaces as EntgeltatlasApiError", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return jsonResponse({ message: "busy" }, 503);
  });
  const e = new RequestEngine({ transport: mt.transport, maxRetries: 2, sleep: async () => {} });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) => err instanceof EntgeltatlasApiError && err.status === 503,
  );
  assert.equal(calls, 3); // initial + 2 retries
});

test("a retried request that then succeeds resolves", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return calls === 1 ? jsonResponse({}, 503) : jsonResponse([{ ok: 1 }]);
  });
  const e = new RequestEngine({ transport: mt.transport, sleep: async () => {} });
  assert.deepEqual(await e.getJson("/x"), [{ ok: 1 }]);
  assert.equal(calls, 2);
});

function redirectResponse(location: string, status = 302): HttpResponse {
  return { status, headers: { location }, body: Buffer.alloc(0) };
}

test("a same-origin redirect is followed and keeps the X-API-Key", async () => {
  let calls = 0;
  const mt = makeMockTransport((req) => {
    calls += 1;
    if (calls === 1) return redirectResponse(new URL("/moved", req.url).origin + "/moved");
    return jsonResponse([{ ok: 1 }]);
  });
  const e = new RequestEngine({
    baseUrl: "https://rest.test",
    transport: mt.transport,
    defaultHeaders: { "X-API-Key": "SECRET" },
  });
  await e.getJson("/x");
  assert.equal(calls, 2);
  assert.equal(mt.calls[1]?.headers?.["X-API-Key"], "SECRET");
});

test("a cross-origin redirect drops the X-API-Key", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return calls === 1 ? redirectResponse("https://evil.example/collect") : jsonResponse([]);
  });
  const e = new RequestEngine({
    baseUrl: "https://rest.test",
    transport: mt.transport,
    defaultHeaders: { "X-API-Key": "SECRET" },
  });
  await e.getJson("/x");
  const followUp = mt.calls[1]!;
  assert.equal(new URL(followUp.url).origin, "https://evil.example");
  assert.equal(followUp.headers?.["X-API-Key"], undefined);
  assert.equal(followUp.headers?.["Accept"], "application/json"); // non-credential header still travels
});

test("a non-2xx surfaces the parsed error detail", async () => {
  const mt = makeMockTransport(() => jsonResponse({ message: "kaputt" }, 400));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) => err instanceof EntgeltatlasApiError && err.status === 400 && /kaputt/.test(err.message),
  );
});

test("a 403 with an empty body (WAF) surfaces as EntgeltatlasApiError with no detail", async () => {
  const mt = makeMockTransport(() => rawResponse("", "text/html", 403));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) => err instanceof EntgeltatlasApiError && err.status === 403 && err.detail === undefined,
  );
});
