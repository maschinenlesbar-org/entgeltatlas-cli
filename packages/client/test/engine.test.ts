import { test } from "node:test";
import { TextDecoder } from "node:util";
import assert from "node:assert/strict";
import {
  MAX_RETRY_AFTER_MS,
  RequestEngine,
  bigIntegerKeysOption,
  cleartextCredentialsProblem,
  firstInexactNumber,
  scanNumbers,
  isTransientNetworkError,
  cleartextProblem,
  parseRetryAfter,
} from "../src/engine.js";
import {
  EntgeltatlasApiError,
  EntgeltatlasNetworkError,
  EntgeltatlasParseError,
  EntgeltatlasValidationError,
  credentialsDroppedHint,
  cutText,
  toWellFormed,
} from "../src/errors.js";
import { filterKeyProblem } from "../src/codes.js";
import { baseUrlProblem } from "../src/validate.js";
import type { HttpResponse } from "../src/http.js";
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

test("getJson rejects an empty or 204 body with EntgeltatlasParseError", async () => {
  for (const [body, status] of [["", 204], ["", 200], ["  \n", 200]] as const) {
    const mt = makeMockTransport(() => rawResponse(body, "application/json", status));
    const e = new RequestEngine({ transport: mt.transport });
    await assert.rejects(
      () => e.getJson("/x"),
      (err) => err instanceof EntgeltatlasParseError && err.message === "GET https://rest.arbeitsagentur.de/x: empty response body.",
    );
  }
});

test("a number the JSON cannot carry exactly is a parse error, never a changed value", async () => {
  // JSON.parse rounds 12345678901234567890 (in any form: .0, e0, E-1) and 9007199254740992.5 to the
  // nearest double, turns 1e400 into Infinity (printed as null) and 1e-400 into 0, silently.
  const body = (n: string) => `{"id":"a","n":${n},"text":"12345678901234567890 in a string"}`;
  for (const n of [
    "12345678901234567890", "-9007199254740993", "1e400", "-1E400", "12345678901234567890.0", "9007199254740993e0",
    "90071992547409930E-1", "9007199254740992.5", "-9007199254740992.5", "1e-400", "-0.0001e-399",
    "123456789012345678901234567890",
    // Subnormal: below the smallest normal double a double has fewer digits (D4).
    "3e-324", "4e-324", "-4.9e-324", "1.2345678901234567e-310", "2.225073858507201e-309",
  ]) {
    const e = new RequestEngine({ transport: makeMockTransport(() => rawResponse(body(n), "application/json")).transport });
    await assert.rejects(e.getJson("/items/a"), (err: unknown) => {
      assert.ok(err instanceof EntgeltatlasParseError, n);
      assert.equal(err.message, `GET https://rest.arbeitsagentur.de/items/a: the number ${n} cannot be represented exactly.`);
      return true;
    });
  }
  // What a double carries exactly, or as JSON means it (a decimal fraction below 2^53), passes:
  // a salary of 5731.5 keeps its cents.
  const exact: Array<[string, number]> = [
    ["9007199254740991", 9007199254740991], ["9007199254740992.0", 2 ** 53], ["9007199254740992e0", 2 ** 53],
    ["90071992547409920E-1", 2 ** 53], ["1e21", 1e21], ["1.2e21", 1.2e21], ["0", 0], ["-0", -0], ["0.0e-500", 0],
    ["1.10", 1.1], ["0.1", 0.1], ["1.00000000000000001", 1], ["5e-324", 5e-324], ["5731.5", 5731.5], ["-2", -2],
    // A double a server printed in its shortest form reads back as that double and prints as the
    // same number: not a changed value, though the decimal is not the double's exact binary value.
    ["1e23", 1e23], ["100000000000000000000000", 1e23], ["1E23", 1e23], ["1.7976931348623157E308", Number.MAX_VALUE], ["-1.7976931348623157e308", -Number.MAX_VALUE],
    ["4.35e30", 4.35e30],
    // A subnormal printed as written, and the smallest normal double (D4).
    ["-5e-324", -5e-324], ["1e-310", 1e-310], ["2.2250738585072014e-308", 2.2250738585072014e-308],
  ];
  for (const [n, value] of exact) {
    const e = new RequestEngine({ transport: makeMockTransport(() => rawResponse(body(n), "application/json")).transport });
    assert.equal((await e.getJson<{ n: number }>("/x")).n, value, n);
  }
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

function retryAfterResponse(retryAfter: string | undefined, status = 429): HttpResponse {
  return {
    status,
    headers: retryAfter === undefined ? {} : { "retry-after": retryAfter },
    body: Buffer.from("{}"),
  };
}

test("a 429 waits the server's Retry-After (seconds) before each retry", async () => {
  const delays: number[] = [];
  const mt = makeMockTransport(() => retryAfterResponse("1"));
  const e = new RequestEngine({ transport: mt.transport, sleep: async (ms) => void delays.push(ms) });
  await assert.rejects(() => e.getJson("/x"), EntgeltatlasApiError);
  assert.deepEqual(delays, [1000, 1000]);
  assert.equal(mt.calls.length, 3);
});

test("an HTTP-date Retry-After is turned into the time left", () => {
  const now = Date.parse("Wed, 21 Oct 2026 07:28:00 GMT");
  assert.equal(parseRetryAfter("Wed, 21 Oct 2026 07:28:05 GMT", now), 5000);
  assert.equal(parseRetryAfter("Wed, 21 Oct 2026 07:27:00 GMT", now), 0);
  assert.equal(parseRetryAfter([" 3 "], now), 3000);
});

test("a malformed Retry-After falls back to the linear backoff", async () => {
  for (const header of ["-1", "+5", "1.5", "1e3", "0x10", "", "2026-10-21T07:28:00Z", "Wednesday, 21-Oct-26 07:28:00 GMT", undefined]) {
    assert.equal(parseRetryAfter(header), undefined, String(header));
    const delays: number[] = [];
    const mt = makeMockTransport(() => retryAfterResponse(header, 503));
    const e = new RequestEngine({ transport: mt.transport, sleep: async (ms) => void delays.push(ms) });
    await assert.rejects(() => e.getJson("/x"), EntgeltatlasApiError);
    assert.deepEqual(delays, [200, 400], String(header));
  }
});

test("a Retry-After beyond the cap is not retried: the error surfaces at once", async () => {
  const far = new Date(Date.now() + 10 * MAX_RETRY_AFTER_MS).toUTCString();
  for (const header of ["31", "99999999", far]) {
    const delays: number[] = [];
    const mt = makeMockTransport(() => retryAfterResponse(header));
    const e = new RequestEngine({ transport: mt.transport, sleep: async (ms) => void delays.push(ms) });
    await assert.rejects(
      () => e.getJson("/x"),
      (err) => err instanceof EntgeltatlasApiError && err.status === 429,
    );
    assert.equal(mt.calls.length, 1, header);
    assert.deepEqual(delays, [], header);
  }
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

test("a non-http(s) base URL is rejected in the engine, before any request", () => {
  // A custom transport does no scheme check of its own; the engine must not hand
  // it a file:/ftp: URL (with the X-API-Key header attached).
  for (const baseUrl of ["file:///etc/passwd", "ftp://example.org", "not a url"]) {
    const mt = makeMockTransport(() => jsonResponse([]));
    assert.throws(
      () =>
        new RequestEngine({
          baseUrl,
          transport: mt.transport,
          defaultHeaders: { "X-API-Key": "SECRET" },
        }),
      EntgeltatlasValidationError,
      baseUrl,
    );
    assert.equal(mt.calls.length, 0);
  }
});

test("a base URL with a query or fragment is rejected in the engine (library users)", () => {
  for (const baseUrl of ["https://rest.test/x?token=abc", "https://rest.test/x#frag"]) {
    const mt = makeMockTransport(() => jsonResponse([]));
    assert.throws(
      () => new RequestEngine({ baseUrl, transport: mt.transport }),
      (err) =>
        err instanceof EntgeltatlasValidationError &&
        err.message === "Invalid baseUrl: A base URL cannot have a query (?) or fragment (#).",
    );
  }
});

test("userinfo in the base URL is never in a message, and is sent as Basic auth, not in the URL", async () => {
  const mt = makeMockTransport(() => jsonResponse({ message: "boom" }, 500));
  const e = new RequestEngine({ baseUrl: "http://user:s3cret@rest.test/ba", transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) =>
      err instanceof EntgeltatlasApiError &&
      err.message === "HTTP 500 for GET http://rest.test/ba/x: boom" &&
      err.url === "http://rest.test/ba/x" &&
      !err.message.includes("s3cret"),
  );
  // The transport never sees the userinfo: the engine sends it per hop as a header.
  assert.equal(mt.last().url, "http://rest.test/ba/x");
  assert.equal(mt.last().headers?.["Authorization"], `Basic ${Buffer.from("user:s3cret").toString("base64")}`);
  assert.throws(
    () => new RequestEngine({ baseUrl: "http://user:s3cret@rest.test/?x=1" }),
    (err) => err instanceof EntgeltatlasValidationError && !err.message.includes("s3cret"),
  );
  assert.throws(
    () => new RequestEngine({ baseUrl: "ftp://user:s3cret@rest.test/" }),
    (err) => err instanceof EntgeltatlasValidationError && !err.message.includes("s3cret"),
  );
});

test("a redirect loop stops at maxRedirects and names the target and the count", async () => {
  const mt = makeMockTransport((req) => redirectResponse(req.url));
  const e = new RequestEngine({ baseUrl: "https://rest.test", transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) =>
      err instanceof EntgeltatlasApiError &&
      err.status === 302 &&
      err.location === "https://rest.test/x" &&
      err.message ===
        "HTTP 302 for GET https://rest.test/x: redirect to https://rest.test/x not followed (stopped after 5 redirects)",
  );
  assert.equal(mt.calls.length, 6);
});

test("a 3xx without a usable Location, or a non-followed 3xx, names why it stopped", async () => {
  const noLocation = makeMockTransport(() => ({ status: 302, headers: {}, body: Buffer.alloc(0) }));
  await assert.rejects(
    () => new RequestEngine({ baseUrl: "https://rest.test", transport: noLocation.transport }).getJson("/x"),
    (err) =>
      err instanceof EntgeltatlasApiError &&
      err.message === "HTTP 302 for GET https://rest.test/x: redirect not followed (no Location header)",
  );
  for (const status of [300, 304, 305]) {
    const mt = makeMockTransport(() => redirectResponse("/elsewhere", status));
    await assert.rejects(
      () => new RequestEngine({ baseUrl: "https://rest.test", transport: mt.transport }).getJson("/x"),
      (err) =>
        err instanceof EntgeltatlasApiError &&
        err.message === `HTTP ${status} for GET https://rest.test/x: redirect to https://rest.test/elsewhere not followed`,
    );
    assert.equal(mt.calls.length, 1, String(status));
  }
  const malformed = makeMockTransport(() => redirectResponse("http://[bad"));
  await assert.rejects(
    () => new RequestEngine({ baseUrl: "https://rest.test", transport: malformed.transport }).getJson("/x"),
    (err) =>
      err instanceof EntgeltatlasApiError &&
      err.message === "HTTP 302 for GET https://rest.test/x: redirect to http://[bad not followed",
  );
});

test("P5: a redirect to a non-http(s) target is not followed: the transport never sees it", async () => {
  for (const location of ["file:///etc/passwd", "data:text/plain,x", "javascript:alert(1)"]) {
    const mt = makeMockTransport(() => ({ status: 302, headers: { location }, body: Buffer.alloc(0) }));
    const engine = new RequestEngine({ transport: mt.transport, maxRetries: 0 });
    await assert.rejects(
      () => engine.getJson("/x"),
      (err) => err instanceof EntgeltatlasApiError && err.status === 302,
      location,
    );
    assert.equal(mt.calls.length, 1, location);
  }
});

test("P8: a body is decoded by its declared charset, and a BOM is dropped", async () => {
  const text = "Baden-Württemberg";
  const latin1 = makeMockTransport(() => ({
    status: 200,
    headers: { "content-type": "application/json; charset=ISO-8859-1" },
    body: Buffer.from(JSON.stringify([{ id: 11, bezeichnung: text }]), "latin1"),
  }));
  assert.deepEqual(await new RequestEngine({ transport: latin1.transport }).getJson("/x"), [{ id: 11, bezeichnung: text }]);
  const bom = makeMockTransport(() => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify([{ id: 1 }]))]),
  }));
  assert.deepEqual(await new RequestEngine({ transport: bom.transport }).getJson("/x"), [{ id: 1 }]);
  const unknown = makeMockTransport(() => rawResponse("[]", "application/json; charset=x-no-such"));
  await assert.rejects(
    () => new RequestEngine({ transport: unknown.transport }).getJson("/x"),
    (err) => err instanceof EntgeltatlasParseError && /x-no-such/.test(err.message),
  );
});

test("P13: server text in an error message is cut at 500 characters; the body keeps it all", async () => {
  const long = "x".repeat(2000);
  const mt = makeMockTransport(() => jsonResponse({ message: long }, 500));
  await assert.rejects(
    () => new RequestEngine({ transport: mt.transport, maxRetries: 0 }).getJson("/x"),
    (err) => err instanceof EntgeltatlasApiError && err.detail?.length === 501 && err.detail.endsWith("…") && err.body.includes(long),
  );
});

test("cleartextProblem names the host and each secret, never its value; the deprecated alias keeps its shape", () => {
  assert.equal(cleartextProblem("http://[::1]:8080"), undefined);
  assert.equal(cleartextProblem("http://127.1"), undefined);
  assert.equal(cleartextProblem("not a url"), undefined);
  assert.equal(
    cleartextProblem("http://u:pw@mirror.example:8080", ["the API key"]),
    "the API key and the base URL's credentials are sent unencrypted to mirror.example:8080 (http:, not https:)",
  );
  assert.equal(cleartextProblem("http://mirror.example", ["the API key"]), "the API key is sent unencrypted to mirror.example (http:, not https:)");
  assert.equal(cleartextCredentialsProblem("http://mirror.example", false), undefined);
  assert.equal(
    cleartextCredentialsProblem("http://mirror.example", true),
    "The API key is sent unencrypted to mirror.example (http:, not https:).",
  );
});

test("cutText never cuts inside a surrogate pair; toWellFormed replaces half a character", () => {
  assert.equal(cutText("ab\u{1f600}cd", 3), "ab");
  assert.equal(cutText("ab\u{1f600}cd", 4), "ab\u{1f600}");
  assert.equal(cutText("short", 10), "short");
  assert.equal(toWellFormed("a\ud83d b\ude00 \u{1f600}"), "a\ufffd b\ufffd \u{1f600}");
});

test("a server detail cut at 500 characters keeps the message well-formed", async () => {
  const detail = "a" + "\u{1f600}".repeat(400);
  const mt = makeMockTransport(() => jsonResponse({ detail }, 500));
  await assert.rejects(new RequestEngine({ transport: mt.transport }).getJson("/x"), (err: Error) => {
    assert.equal(toWellFormed(err.message), err.message);
    assert.match(err.message, /…$/);
    return true;
  });
});

test("own messages quote a server or user value at most 200 characters long (L3)", async () => {
  const long = "x".repeat(5000);
  const redirect = new RequestEngine({ maxRedirects: 0, transport: async () => ({ status: 302, headers: { location: `https://other.test/${long}` }, body: Buffer.alloc(0) }) });
  await assert.rejects(redirect.getJson("/x"), (err: Error) => err.message.length < 400 && /redirect to https:\/\/other\.test\/x+… not followed/.test(err.message));
  const charset = new RequestEngine({ transport: async () => ({ status: 200, headers: { "content-type": `application/json; charset=${long}` }, body: Buffer.from("{}") }) });
  await assert.rejects(charset.getJson("/x"), (err: Error) => err.message.length < 400 && /unsupported response charset "x+…"/.test(err.message));
  assert.match(filterKeyProblem(long) ?? "", /^Unknown filter "x{200}"…: /);
  assert.match(baseUrlProblem(`https://${long}:99999`) ?? "", /^Invalid URL "https:\/\/x{192}"…\.$/);
  const hint = credentialsDroppedHint({ from: "https://a.test/p", to: `https://b.test/${long}` });
  assert.ok(hint.length < 400 && hint.includes("…"), hint);
});

test("credentials a server echoes are scrubbed from the error: Basic, user:password, password (L13)", async () => {
  const basic = Buffer.from("alice:pa ss-pw", "latin1").toString("base64");
  const body = JSON.stringify({ detail: `no: Basic ${basic} / alice:pa ss-pw / pa ss-pw` });
  const engine = new RequestEngine({
    baseUrl: "https://alice:pa%20ss-pw@mirror.test",
    transport: async () => ({ status: 401, headers: { "content-type": "application/json" }, body: Buffer.from(body) }),
  });
  await assert.rejects(engine.getJson("/x"), (err: EntgeltatlasApiError) => {
    for (const form of [basic, "alice:pa ss-pw", "pa ss-pw"]) assert.ok(!err.message.includes(form), err.message);
    assert.match(err.message, /no: Basic \*\*\* \/ \*\*\* \/ \*\*\*/);
    return true;
  });
});

test("onRetry is called once per retry, with the event fields, right before the sleep", async () => {
  const log: string[] = [];
  const events: unknown[] = [];
  let n = 0;
  const mt = makeMockTransport(() =>
    n++ < 2
      ? { status: 503, headers: n === 1 ? { "retry-after": "2" } : {}, body: Buffer.from("{}") }
      : jsonResponse({ ok: 1 }),
  );
  const e = new RequestEngine({
    transport: mt.transport,
    baseUrl: "https://user:pw@example.test",
    maxRetries: 3,
    sleep: async (ms) => void log.push(`sleep ${ms}`),
    onRetry: (ev) => {
      events.push(ev);
      log.push("retry");
    },
  });
  await e.getJson("/x");
  assert.deepEqual(log, ["retry", "sleep 2000", "retry", "sleep 400"]);
  assert.deepEqual(events, [
    { retry: 1, maxRetries: 3, delayMs: 2000, status: 503, url: "https://example.test/x" },
    { retry: 2, maxRetries: 3, delayMs: 400, status: 503, url: "https://example.test/x" },
  ]);
});

test("onRetry reports a reset connection without a status", async () => {
  let n = 0;
  const events: unknown[] = [];
  const mt = makeMockTransport(() => {
    if (n++ === 0) throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    return jsonResponse({ ok: 1 });
  });
  const e = new RequestEngine({ transport: mt.transport, sleep: async () => {}, onRetry: (ev) => void events.push(ev) });
  await e.getJson("/x");
  assert.equal(events.length, 1);
  assert.equal((events[0] as { status?: number }).status, undefined);
  assert.equal((events[0] as { retry: number }).retry, 1);
});

test("onRetry is never called without a retry, and a throw in it is swallowed", async () => {
  const events: unknown[] = [];
  const onRetry = (ev: unknown) => void events.push(ev);
  const ok = new RequestEngine({ transport: makeMockTransport(() => jsonResponse({ ok: 1 })).transport, sleep: async () => {}, onRetry });
  await ok.getJson("/x");
  const notFound = new RequestEngine({
    transport: makeMockTransport(() => ({ status: 404, headers: { "content-type": "application/json" }, body: Buffer.from('{"detail":"no"}') })).transport,
    sleep: async () => {},
    onRetry,
  });
  await assert.rejects(notFound.getJson("/x"), EntgeltatlasApiError);
  // retries exhausted: the last 503 is an error, not a retry
  const down = new RequestEngine({
    transport: makeMockTransport(() => ({ status: 503, headers: {}, body: Buffer.from("{}") })).transport,
    maxRetries: 1,
    sleep: async () => {},
    onRetry,
  });
  await assert.rejects(down.getJson("/x"), EntgeltatlasApiError);
  assert.equal(events.length, 1);
  // a Retry-After over the cap is not retried
  const long = new RequestEngine({
    transport: makeMockTransport(() => ({ status: 503, headers: { "retry-after": "999999" }, body: Buffer.from("{}") })).transport,
    sleep: async () => {},
    onRetry,
  });
  await assert.rejects(long.getJson("/x"), EntgeltatlasApiError);
  assert.equal(events.length, 1);
  let n = 0;
  const throwing = new RequestEngine({
    transport: makeMockTransport(() => (n++ === 0 ? { status: 503, headers: {}, body: Buffer.from("{}") } : jsonResponse({ ok: 1 }))).transport,
    sleep: async () => {},
    onRetry: () => {
      throw new Error("boom");
    },
  });
  await throwing.getJson("/x");
});

test("onRetry must be a function", () => {
  assert.throws(() => new RequestEngine({ onRetry: 5 as never }), EntgeltatlasValidationError);
});

test("a timeout, the size cap, a refused connection and a DNS failure name the request", async () => {
  // They said only "Request timed out after 20ms", "Response exceeded maxResponseBytes (…)",
  // "connect ECONNREFUSED 127.0.0.1:9" and "getaddrinfo ENOTFOUND …", where a reset says
  // "GET <url> failed: socket hang up".
  const url = "http://127.0.0.1:9/infosysbub/entgeltatlas/pc/v1/regionen";
  const refused = new EntgeltatlasNetworkError("connect ECONNREFUSED 127.0.0.1:9");
  const dns = new EntgeltatlasNetworkError("getaddrinfo ENOTFOUND rest.invalid");
  const cases: Array<[string, ConstructorParameters<typeof RequestEngine>[0], RegExp, unknown]> = [
    ["engine deadline", { transport: () => new Promise<HttpResponse>(() => {}), timeoutMs: 20 }, /^Request timed out after 20ms$/, undefined],
    ["size cap", { transport: async () => rawResponse("x".repeat(100), "application/json"), maxResponseBytes: 10 }, /^Response exceeded maxResponseBytes \(10 bytes/, undefined],
    ["refused", { transport: async () => { throw refused; } }, /^connect ECONNREFUSED 127\.0\.0\.1:9$/, refused],
    ["dns", { transport: async () => { throw dns; } }, /^getaddrinfo ENOTFOUND rest\.invalid$/, dns],
  ];
  for (const [name, options, reason, cause] of cases) {
    const e = new RequestEngine({ baseUrl: "http://user:pw@127.0.0.1:9", maxRetries: 0, ...options });
    await assert.rejects(e.getJson("/infosysbub/entgeltatlas/pc/v1/regionen"), (err) => {
      assert.ok(err instanceof EntgeltatlasNetworkError, name);
      assert.ok(err.message.startsWith(`GET ${url} failed: `), `${name}: ${err.message}`);
      assert.match(err.message.slice(`GET ${url} failed: `.length), reason, name);
      assert.ok(err.cause instanceof EntgeltatlasNetworkError, `${name}: the original is the cause`);
      if (cause !== undefined) assert.equal(err.cause, cause, name);
      return true;
    });
  }
  // A message that names the request already is not prefixed twice.
  const named = new RequestEngine({
    baseUrl: "http://127.0.0.1:9",
    transport: async () => {
      throw new EntgeltatlasNetworkError(`GET ${url} failed: x`);
    },
  });
  await assert.rejects(named.getJson("/infosysbub/entgeltatlas/pc/v1/regionen"), { message: `GET ${url} failed: x` });
});

test("a reset connection that outlasts the retries names the request and the retries (bug 5, 2026-10-15)", async () => {
  // The default transport rejects a reset with a bare "socket hang up" (the Node error is its
  // cause); passed through, the CLI's last record named neither the host nor the retries.
  const reset = () =>
    new EntgeltatlasNetworkError("socket hang up", { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
  for (const [maxRetries, suffix] of [[0, ""], [1, " (after 1 retry)"], [2, " (after 2 retries)"]] as const) {
    let calls = 0;
    const e = new RequestEngine({
      baseUrl: "http://127.0.0.1:9",
      transport: async () => {
        calls += 1;
        throw reset();
      },
      maxRetries,
      sleep: async () => {},
    });
    await assert.rejects(e.getJson("/infosysbub/entgeltatlas/pc/v1/regionen"), (err) => {
      assert.ok(err instanceof EntgeltatlasNetworkError);
      assert.equal(err.message, `GET http://127.0.0.1:9/infosysbub/entgeltatlas/pc/v1/regionen failed: socket hang up${suffix}`);
      assert.ok(isTransientNetworkError(err), "still recognisable as a reset");
      return true;
    });
    assert.equal(calls, maxRetries + 1);
  }
});

test("a header named __proto__ is an ordinary header, never the prototype of the headers read (T12)", async () => {
  // A JavaScript transport may return any object; JSON.parse makes "__proto__" an own key.
  // With it as the prototype, its "content-type" was read as the answer's (an unknown charset).
  const headers = JSON.parse('{"__proto__":{"content-type":"application/json; charset=x-no-such-charset"}}') as Record<string, string>;
  const e = new RequestEngine({ transport: async () => ({ status: 200, headers, body: Buffer.from('{"a":1}') }) });
  assert.deepEqual(await e.getJson("/x"), { a: 1 });
  const fetchLike = new Headers([["__proto__", "x"], ["content-type", "application/json"]]);
  const f = new RequestEngine({ transport: async () => ({ status: 200, headers: fetchLike as unknown as Record<string, string>, body: Buffer.from('{"a":1}') }) });
  assert.deepEqual(await f.getJson("/x"), { a: 1 });
});

test("an answer error names the request: method and URL, userinfo redacted (D9)", async () => {
  const answers: Array<[string, () => HttpResponse]> = [
    ["not valid JSON", () => rawResponse("<html>", "text/html")],
    ["empty response body", () => rawResponse(" ", "application/json")],
    ["cannot be represented exactly", () => rawResponse('{"n":1e400}', "application/json")],
    ["unsupported response charset", () => rawResponse("{}", "application/json; charset=x-bogus")],
  ];
  const base = new URL("https://rest.arbeitsagentur.de");
  base.username = "alice";
  base.password = "s3cret";
  for (const [what, respond] of answers) {
    const e = new RequestEngine({ baseUrl: base.href, transport: makeMockTransport(respond).transport });
    await assert.rejects(e.getJson("/items", { q: "x" }), (err: unknown) => {
      assert.ok(err instanceof EntgeltatlasParseError, what);
      assert.ok(err.message.startsWith(`GET ${base.protocol}//***@${base.host}`), err.message);
      assert.ok(err.message.includes("/items?q=x: ") && err.message.includes(what), err.message);
      assert.ok(!err.message.includes("s3cret"), err.message);
      return true;
    });
  }
  // A non-JSON answer names its Content-Type, so it reads as an upstream page, not a client bug.
  const html = new RequestEngine({ transport: makeMockTransport(() => rawResponse("<html>", "text/html; charset=utf-8")).transport });
  await assert.rejects(html.getJson("/x"), (err: Error) =>
    err.message === 'GET https://rest.arbeitsagentur.de/x: the answer is not valid JSON (expected JSON, got Content-Type "text/html").');
});

test("text that is not valid is replaced with U+FFFD and reported through onWarning, never silently (D2)", async () => {
  const cases: Array<[string, Buffer, string, unknown, number]> = [
    // A lone surrogate written as an escape (high alone, low alone); a real pair and an escaped backslash stay.
    ["lone escapes", Buffer.from('{"a":"x\\ud800y","b":"\\udc00","c":"\\ud83d\\ude00","d":"\\\\ud800"}'), "application/json", { a: "x\ufffdy", b: "\ufffd", c: "\u{1f600}", d: "\\ud800" }, 2],
    // A lone surrogate in a member name.
    ["lone in a key", Buffer.from('{"\\udbff":1}'), "application/json", { "\ufffd": 1 }, 1],
    // Invalid UTF-8 bytes; a U+FFFD the server sent is not counted.
    ["invalid bytes", Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xff, 0xc3]), Buffer.from('","b":"\ufffd"}')]), "application/json", { a: "\ufffd\ufffd", b: "\ufffd" }, 2],
    // A byte undefined in a single-byte charset.
    ["iso-8859-3", Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xa5]), Buffer.from('"}')]), "application/json; charset=iso-8859-3", { a: "\ufffd" }, 1],
  ];
  for (const [label, body, type, expected, count] of cases) {
    const warnings: string[] = [];
    const e = new RequestEngine({ onWarning: (m) => warnings.push(m), transport: makeMockTransport(() => rawResponse(body, type)).transport });
    const value = await e.getJson("/items", { q: "x" });
    assert.deepEqual(value, expected, label);
    assert.ok(!/[\ud800-\udfff]/u.test(JSON.stringify(value)), `${label}: well-formed`);
    assert.deepEqual(warnings, [
      `GET https://rest.arbeitsagentur.de/items?q=x: ${count} ${count === 1 ? "character" : "characters"} of the answer ${count === 1 ? "was" : "were"} not valid text (invalid bytes or a lone surrogate) and replaced with U+FFFD.`,
    ], label);
  }
  // Valid text: no warning; a throwing hook never fails the request.
  const quiet: string[] = [];
  const ok = new RequestEngine({ onWarning: (m) => quiet.push(m), transport: makeMockTransport(() => rawResponse('{"a":"\\u00fc\ufffd"}', "application/json")).transport });
  assert.deepEqual(await ok.getJson("/x"), { a: "ü\ufffd" });
  assert.deepEqual(quiet, []);
  const throwing = new RequestEngine({ onWarning: () => { throw new Error("hook"); }, transport: makeMockTransport(() => rawResponse('"\\ud800"', "application/json")).transport });
  assert.equal(await throwing.getJson("/x"), "\ufffd");
  assert.throws(() => new RequestEngine({ onWarning: "log" as unknown as () => void }), EntgeltatlasValidationError);
});

test("an answer longer than V8's longest string is an EntgeltatlasParseError naming the request, not a plain Error (T14)", async (t) => {
  // A real one needs a body of 512 MB and more (possible with maxResponseBytes 0): V8's own
  // error is stood in for, for the body marked by its length.
  const huge = Buffer.from('[{"a":1}]                 ');
  const tooLong = Object.assign(new Error("Cannot create a string longer than 0x1fffffe8 characters"), { code: "ERR_STRING_TOO_LONG" });
  const decode = TextDecoder.prototype.decode;
  t.mock.method(TextDecoder.prototype, "decode", function (this: InstanceType<typeof TextDecoder>, input?: Uint8Array, options?: { stream?: boolean }) {
    if (input !== undefined && input.byteLength === huge.length) throw tooLong;
    return decode.call(this, input, options);
  });
  const toString = Buffer.prototype.toString;
  t.mock.method(Buffer.prototype, "toString", function (this: Buffer, ...args: Parameters<Buffer["toString"]>) {
    if (this.length === huge.length && args[0] === "utf8") throw tooLong;
    return toString.apply(this, args);
  });
  const e = new RequestEngine({ maxResponseBytes: 0, transport: makeMockTransport(() => rawResponse(huge, "application/json")).transport });
  await assert.rejects(e.getJson("/items", { q: "x" }), (err: unknown) => {
    assert.ok(err instanceof EntgeltatlasParseError, String(err));
    assert.equal(
      err.message,
      `GET https://rest.arbeitsagentur.de/items?q=x: the answer is too large to read as text (${huge.length} bytes; the longest string is 536870888 characters).`,
    );
    return true;
  });
  // An error status with such a body is still the API error, without the unreadable body.
  const failing = new RequestEngine({ maxResponseBytes: 0, transport: makeMockTransport(() => rawResponse(huge, "text/plain", 500)).transport });
  await assert.rejects(failing.getJson("/x"), (err: unknown) => err instanceof EntgeltatlasApiError && err.status === 500 && err.body === "");
});

test("bigIntegerKeys: a declared member's number is its exact literal as a string; others keep the rule (D3)", async () => {
  const body = '{"_version_":1858054135406919680,"small":{"_version_":5},"neg":{"\\u005fversion_":-12345678901234567890},' +
    '"s":{"_version_":"text"},"n":{"_version_":null},"arr":{"_version_":[1]},"t":"\\"_version_\\":1","n2":42}';
  const e = new RequestEngine({
    bigIntegerKeys: new Set(["_version_"]),
    transport: makeMockTransport(() => rawResponse(body, "application/json")).transport,
  });
  assert.deepEqual(await e.getJson("/x"), {
    _version_: "1858054135406919680", small: { _version_: "5" }, neg: { _version_: "-12345678901234567890" },
    s: { _version_: "text" }, n: { _version_: null }, arr: { _version_: [1] }, t: '"_version_":1', n2: 42,
  });
  assert.deepEqual([...e.bigIntegerKeys], ["_version_"]);
  // An undeclared big number is still refused; a declared member doesn't make others exact.
  const other = new RequestEngine({
    bigIntegerKeys: ["_version_"] as unknown as ReadonlySet<string>,
    transport: makeMockTransport(() => rawResponse('{"_version_":1858054135406919680,"id":12345678901234567890}', "application/json")).transport,
  });
  await assert.rejects(other.getJson("/x"), /the number 12345678901234567890 cannot be represented exactly/);
  // Malformed stays malformed: a declared member with a leading zero still fails JSON.parse.
  const malformed = new RequestEngine({ bigIntegerKeys: new Set(["_version_"]), transport: makeMockTransport(() => rawResponse('{"_version_":01}', "application/json")).transport });
  await assert.rejects(malformed.getJson("/x"), /not valid JSON/);
  for (const bad of [new Set([""]), new Set([1]), "x", 5, null]) {
    assert.throws(() => new RequestEngine({ bigIntegerKeys: bad as unknown as ReadonlySet<string> }),
      (err: unknown) => err instanceof EntgeltatlasValidationError && err.message === "Invalid bigIntegerKeys: Expected a set of non-empty member names.");
  }
  // The option reader copies a set or a list; undefined is none.
  const names = new Set(["a"]);
  const copy = bigIntegerKeysOption(names);
  names.add("b");
  assert.deepEqual([...copy], ["a"]);
  assert.deepEqual([...bigIntegerKeysOption(["x", "y"] as unknown as ReadonlySet<string>)], ["x", "y"]);
  assert.equal(bigIntegerKeysOption(undefined).size, 0);
  // Without declarations the scan is the plain number check.
  assert.equal(firstInexactNumber('{"a":"1e400","b":3e-324}'), "3e-324");
  assert.deepEqual(scanNumbers('{"a":1}'), { json: '{"a":1}', inexact: undefined });
});
