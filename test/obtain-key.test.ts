// `obtain-key`: the command that fetches the public X-API-Key at run time.
// No key is bundled, so this path must never invent one — every failure mode
// below asserts that it fails loudly instead.

import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { EntgeltatlasClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import {
  API_KEY_ENV_VAR,
  KEY_SOURCE_URL,
  MAX_KEY_SOURCE_REDIRECTS,
  obtainKey,
} from "../src/client/obtain-key.js";
import {
  EntgeltatlasApiError,
  EntgeltatlasError,
  EntgeltatlasKeySourceError,
  EntgeltatlasNetworkError,
  EntgeltatlasValidationError,
} from "../src/client/errors.js";
import { makeMockTransport, rawResponse } from "./helpers.js";

/** The web app's page, in the shape it states the key (a dummy value, not the real key). */
const page = (clientId: string): string =>
  [
    "<!doctype html><html><head>",
    '<script type="text/javascript">',
    "  globalThis.egaConfig = { backendHost: 'https://rest.arbeitsagentur.de/infosysbub/entgeltatlas' };",
    "  globalThis.infosysbubLibConfig = {",
    `    clientId: '${clientId}',`,
    "    redirecturi: 'https://web.arbeitsagentur.de/entgeltatlas/',",
    "  };",
    "</script></head><body></body></html>",
  ].join("\n");
const EXPECTED_KEY = "dummy-test-key";
const SOURCE_DOC = page(EXPECTED_KEY);

function makeCli(responder: (req: HttpRequest) => HttpResponse) {
  const out: string[] = [];
  const err: string[] = [];
  const mt = makeMockTransport(responder);
  const deps: CliDeps = {
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    createClient: (opts) => new EntgeltatlasClient({ ...opts, transport: mt.transport }),
    env: {},
    transport: mt.transport,
  };
  return { deps, out, err, mt };
}

test("obtainKey reads the key from the published source", async () => {
  const mt = makeMockTransport(() => rawResponse(SOURCE_DOC, "text/html"));
  const result = await obtainKey({ transport: mt.transport });
  assert.equal(result.key, EXPECTED_KEY);
  assert.equal(result.sourceUrl, KEY_SOURCE_URL);
  assert.equal(mt.last().url, KEY_SOURCE_URL);
  assert.equal(mt.last().method, "GET");
});

test("obtainKey throws when the source is unreachable, after the client's retries", async () => {
  const mt = makeMockTransport(() => rawResponse("nope", "text/plain", 503));
  const waits: number[] = [];
  const sleep = async (ms: number) => void waits.push(ms);
  await assert.rejects(() => obtainKey({ transport: mt.transport, sleep }), EntgeltatlasError);
  // Without a Retry-After the backoff is retryDelayMs (200) × attempt, as in the engine.
  assert.equal(mt.calls.length, 3);
  assert.deepEqual(waits, [200, 400]);
});

test("obtainKey throws when the source no longer states a key", async () => {
  const mt = makeMockTransport(() => rawResponse("<html>no key here</html>", "text/html"));
  await assert.rejects(() => obtainKey({ transport: mt.transport }), EntgeltatlasError);
});

test("obtainKey rejects a non-http(s) source URL before any request", async () => {
  for (const sourceUrl of ["file:///etc/passwd", "ftp://example.org"]) {
    const mt = makeMockTransport(() => rawResponse(SOURCE_DOC, "text/html"));
    await assert.rejects(
      () => obtainKey({ transport: mt.transport, sourceUrl }),
      EntgeltatlasValidationError,
      sourceUrl,
    );
    assert.equal(mt.calls.length, 0);
  }
});

test("obtain-key prints only the key on stdout, provenance on stderr", async () => {
  const cli = makeCli(() => rawResponse(SOURCE_DOC, "text/html"));
  const code = await run(["obtain-key"], cli.deps);
  assert.equal(code, 0);
  assert.deepEqual(cli.out, [EXPECTED_KEY]);
  assert.ok(cli.err.join("\n").includes(KEY_SOURCE_URL));
  assert.match(cli.err.join("\n"), /not checked against the API/);
});

test("obtain-key --export emits a quoted, eval-safe export line", async () => {
  const cli = makeCli(() => rawResponse(SOURCE_DOC, "text/html"));
  const code = await run(["obtain-key", "--export"], cli.deps);
  assert.equal(code, 0);
  assert.deepEqual(cli.out, [`export ${API_KEY_ENV_VAR}='${EXPECTED_KEY}'`]);
});

test("obtain-key needs no configured key and sends none", async () => {
  const cli = makeCli(() => rawResponse(SOURCE_DOC, "text/html"));
  const code = await run(["obtain-key"], cli.deps);
  assert.equal(code, 0);
  assert.equal(cli.mt.last().headers?.["X-API-Key"], undefined);
});

test("a failing obtain-key exits non-zero rather than printing a guess", async () => {
  const cli = makeCli(() => rawResponse("", "text/plain", 404));
  const code = await run(["obtain-key"], cli.deps);
  assert.notEqual(code, 0);
  assert.deepEqual(cli.out, []);
});

test("obtainKey applies the client's default timeout and size cap", async () => {
  const mt = makeMockTransport(() => rawResponse(SOURCE_DOC, "text/html"));
  await obtainKey({ transport: mt.transport });
  assert.equal(mt.last().timeoutMs, 30_000);
  assert.equal(mt.last().maxResponseBytes, 100 * 1024 * 1024);
});

test("obtainKey passes explicit limits, and 0 turns a limit off", async () => {
  const mt = makeMockTransport(() => rawResponse(SOURCE_DOC, "text/html"));
  await obtainKey({ transport: mt.transport, timeoutMs: 1234, maxResponseBytes: 5678 });
  assert.equal(mt.last().timeoutMs, 1234);
  assert.equal(mt.last().maxResponseBytes, 5678);
  await obtainKey({ transport: mt.transport, timeoutMs: 0, maxResponseBytes: 0 });
  assert.equal("timeoutMs" in mt.last(), false);
  assert.equal("maxResponseBytes" in mt.last(), false);
});

test("obtainKey sends the default User-Agent, and rejects a blank one like the API client", async () => {
  const mt = makeMockTransport(() => rawResponse(SOURCE_DOC, "text/html"));
  await obtainKey({ transport: mt.transport });
  assert.equal(mt.last().headers?.["User-Agent"], "entgeltatlas-cli");
  await assert.rejects(
    () => obtainKey({ transport: mt.transport, userAgent: "  " }),
    (err) => err instanceof EntgeltatlasValidationError && err.message === "Invalid userAgent: Expected a non-empty value.",
  );
  assert.equal(mt.calls.length, 1);
});

test("obtain-key forwards --timeout and --max-response-bytes", async () => {
  const cli = makeCli(() => rawResponse(SOURCE_DOC, "text/html"));
  const code = await run(["--timeout", "500", "--max-response-bytes", "10000", "obtain-key"], cli.deps);
  assert.equal(code, 0);
  assert.equal(cli.mt.last().timeoutMs, 500);
  assert.equal(cli.mt.last().maxResponseBytes, 10000);
});

test("obtain-key fails on a source larger than --max-response-bytes", async () => {
  const cli = makeCli((req) => {
    if (req.maxResponseBytes !== undefined && SOURCE_DOC.length > req.maxResponseBytes) {
      throw new EntgeltatlasNetworkError(`Response exceeded maxResponseBytes (${req.maxResponseBytes})`);
    }
    return rawResponse(SOURCE_DOC, "text/html");
  });
  const code = await run(["--max-response-bytes", "10", "obtain-key"], cli.deps);
  assert.equal(code, 6);
  assert.deepEqual(cli.out, []);
});

test("obtainKey follows same-origin redirects and cites the final URL", async () => {
  const moved = "https://web.arbeitsagentur.de/entgeltatlas/start";
  const mt = makeMockTransport((req) =>
    req.url === KEY_SOURCE_URL
      ? { status: 301, headers: { location: "/entgeltatlas/start" }, body: Buffer.alloc(0) }
      : rawResponse(SOURCE_DOC, "text/html"),
  );
  const result = await obtainKey({ transport: mt.transport });
  assert.equal(result.key, EXPECTED_KEY);
  assert.equal(result.sourceUrl, moved);
  assert.equal(mt.calls.length, 2);
});

test("obtainKey does not follow a redirect to another host, nor a loop past the limit", async () => {
  const cross = makeMockTransport(() => ({
    status: 302,
    headers: { location: "https://evil.example/entgeltatlas/" },
    body: Buffer.alloc(0),
  }));
  await assert.rejects(() => obtainKey({ transport: cross.transport }), /HTTP 302/);
  assert.equal(cross.calls.length, 1);

  const loop = makeMockTransport((req) => ({
    status: 302,
    headers: { location: req.url },
    body: Buffer.alloc(0),
  }));
  await assert.rejects(() => obtainKey({ transport: loop.transport }), /HTTP 302/);
  assert.equal(loop.calls.length, MAX_KEY_SOURCE_REDIRECTS + 1);
});

async function keyFrom(doc: string): Promise<string> {
  const mt = makeMockTransport(() => rawResponse(doc, "text/html"));
  return (await obtainKey({ transport: mt.transport })).key;
}

test("obtainKey reads the web app's clientId, in single or double quotes", async () => {
  assert.equal(await keyFrom(page("infosysbub-test")), "infosysbub-test");
  assert.equal(await keyFrom(`<script>cfg = { "clientId": "abc-def-1" }</script>`), "abc-def-1");
  assert.equal(await keyFrom(`clientId:'x9z'`), "x9z");
  // A UUID fits the format too (the old key shape).
  const uuid = "11111111-2222-3333-4444-555555555555";
  assert.equal(await keyFrom(page(uuid)), uuid);
  // The same value twice is one key.
  assert.equal(await keyFrom(page("abc-def") + page("abc-def")), "abc-def");
});

test("obtainKey ignores a label that only ends in clientId, and an all-zero placeholder UUID", async () => {
  await assert.rejects(() => keyFrom(`my_clientId: 'not-this-one'`), /No X-API-Key found/);
  await assert.rejects(() => keyFrom(page("00000000-0000-0000-0000-000000000000")), /No X-API-Key found/);
});

test("obtainKey refuses a clientId that is not shaped like a key", async () => {
  for (const value of ["YOUR-API-KEY", "--help", "a b", "x", "key;rm -rf", "\u001b[2Jkey", "${clientId}", "-leading"]) {
    await assert.rejects(
      () => keyFrom(page(value)),
      (err) => err instanceof EntgeltatlasError && /not shaped like a key/.test(err.message) && !err.message.includes(value),
      value,
    );
  }
});

test("obtainKey fails on a source that states conflicting keys", async () => {
  await assert.rejects(
    () => keyFrom(page("first-key") + page("second-key")),
    (err) => err instanceof EntgeltatlasError && /states conflicting keys/.test(err.message),
  );
});

test("a key-source HTTP failure is a typed EntgeltatlasApiError with status and url", async () => {
  const mt = makeMockTransport(() => rawResponse("", "text/plain", 404));
  await assert.rejects(
    () => obtainKey({ transport: mt.transport }),
    (err) =>
      err instanceof EntgeltatlasKeySourceError &&
      err instanceof EntgeltatlasApiError &&
      err.status === 404 &&
      err.url === KEY_SOURCE_URL &&
      err.message ===
        `HTTP 404 for GET ${KEY_SOURCE_URL}: could not read the key source. ` +
          "Retry, or copy the clientId from the page source of https://web.arbeitsagentur.de/entgeltatlas/ by hand",
  );
});

test("obtain-key exits 4 for a vanished key source and 1 (no API-key hint) for a 403 from it", async () => {
  const gone = makeCli(() => rawResponse("", "text/plain", 404));
  assert.equal(await run(["obtain-key"], gone.deps), 4);
  const refused = makeCli(() => rawResponse("", "text/plain", 403));
  assert.equal(await run(["obtain-key"], refused.deps), 1);
  assert.doesNotMatch(refused.err.join("\n"), /Hint:/);
  assert.deepEqual(refused.out, []);
});

test("P5: obtainKey holds its limits and reads headers for any transport", async () => {
  // A transport that never answers is cut off at timeoutMs.
  await assert.rejects(
    () => obtainKey({ transport: () => new Promise<HttpResponse>(() => {}), timeoutMs: 100, maxRetries: 0 }),
    EntgeltatlasNetworkError,
  );
  // A transport that read a body over the cap is refused, naming the flag.
  await assert.rejects(
    () => obtainKey({ transport: async () => rawResponse(SOURCE_DOC, "text/html"), maxResponseBytes: 10 }),
    (err) => err instanceof EntgeltatlasNetworkError && /--max-response-bytes/.test(err.message),
  );
  // A capitalised Location (or a Headers object) is followed like a lower-case one.
  for (const headers of [{ Location: "/entgeltatlas/start" }, new Headers({ Location: "/entgeltatlas/start" })]) {
    const mt = makeMockTransport((req) =>
      req.url === KEY_SOURCE_URL
        ? ({ status: 301, headers, body: Buffer.alloc(0) } as unknown as HttpResponse)
        : rawResponse(SOURCE_DOC, "text/html"),
    );
    assert.equal((await obtainKey({ transport: mt.transport })).key, EXPECTED_KEY);
  }
  // Whatever a transport throws or returns is a typed error.
  for (const transport of [async () => { throw "nope"; }, async () => ({ status: Number.NaN, headers: {}, body: Buffer.alloc(0) })]) {
    await assert.rejects(() => obtainKey({ transport: transport as never, maxRetries: 0 }), EntgeltatlasNetworkError);
  }
});

test("P2: obtainKey names a source URL without its userinfo, in errors and in the result", async () => {
  const sourceUrl = "http://alice:s3cret@mirror.example/entgeltatlas/";
  const ok = makeMockTransport(() => rawResponse(SOURCE_DOC, "text/html"));
  assert.ok(!(await obtainKey({ transport: ok.transport, sourceUrl })).sourceUrl.includes("s3cret"));
  // The userinfo is sent as Basic auth, never in the URL the transport sees.
  assert.equal(ok.last().url, "http://mirror.example/entgeltatlas/");
  assert.equal(ok.last().headers?.["Authorization"], `Basic ${Buffer.from("alice:s3cret").toString("base64")}`);
  for (const doc of ["<html>no key</html>", page("first-key") + page("second-key"), page("YOUR-API-KEY")]) {
    const mt = makeMockTransport(() => rawResponse(doc, "text/html"));
    await assert.rejects(
      () => obtainKey({ transport: mt.transport, sourceUrl }),
      (err) => err instanceof EntgeltatlasError && !err.message.includes("s3cret"),
      doc,
    );
  }
  // A transport that echoes the URL in its error.
  await assert.rejects(
    () => obtainKey({ transport: async (req) => { throw new TypeError(`Failed to fetch ${req.url}`); }, sourceUrl, maxRetries: 0 }),
    (err) => err instanceof EntgeltatlasNetworkError && !err.message.includes("s3cret"),
  );
});

test("P3: obtainKey tells the transport not to follow redirects, and refuses an answer from another origin", async () => {
  const mt = makeMockTransport(() => ({ ...rawResponse(SOURCE_DOC, "text/html"), url: "https://elsewhere.example/page" }));
  await assert.rejects(() => obtainKey({ transport: mt.transport }), EntgeltatlasNetworkError);
  assert.equal(mt.last().redirect, "manual");
  const same = makeMockTransport(() => ({ ...rawResponse(SOURCE_DOC, "text/html"), url: KEY_SOURCE_URL }));
  assert.equal((await obtainKey({ transport: same.transport })).key, EXPECTED_KEY);
});
