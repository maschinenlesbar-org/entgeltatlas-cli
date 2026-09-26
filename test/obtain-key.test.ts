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
import { EntgeltatlasError, EntgeltatlasNetworkError } from "../src/client/errors.js";
import { makeMockTransport, rawResponse } from "./helpers.js";

const SOURCE_DOC = ["# entgeltatlas-api", "", "```bash", 'curl -H "X-API-Key: c4f0d292-9d0f-4763-87dd-d3f9e78fb006" https://rest.arbeitsagentur.de/...', "```"].join("\\n");
const EXPECTED_KEY = "c4f0d292-9d0f-4763-87dd-d3f9e78fb006";

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
  const mt = makeMockTransport(() => rawResponse(SOURCE_DOC, "text/plain"));
  const result = await obtainKey({ transport: mt.transport });
  assert.equal(result.key, EXPECTED_KEY);
  assert.equal(result.sourceUrl, KEY_SOURCE_URL);
  assert.equal(mt.last().url, KEY_SOURCE_URL);
  assert.equal(mt.last().method, "GET");
});

test("obtainKey throws when the source is unreachable", async () => {
  const mt = makeMockTransport(() => rawResponse("nope", "text/plain", 503));
  await assert.rejects(() => obtainKey({ transport: mt.transport }), EntgeltatlasError);
});

test("obtainKey throws when the source no longer states a key", async () => {
  const mt = makeMockTransport(() => rawResponse("# readme with no key", "text/plain"));
  await assert.rejects(() => obtainKey({ transport: mt.transport }), EntgeltatlasError);
});

test("obtainKey rejects a non-http(s) source URL before any request", async () => {
  for (const sourceUrl of ["file:///etc/passwd", "ftp://example.org"]) {
    const mt = makeMockTransport(() => rawResponse(SOURCE_DOC, "text/plain"));
    await assert.rejects(
      () => obtainKey({ transport: mt.transport, sourceUrl }),
      EntgeltatlasNetworkError,
      sourceUrl,
    );
    assert.equal(mt.calls.length, 0);
  }
});

test("obtain-key prints only the key on stdout, provenance on stderr", async () => {
  const cli = makeCli(() => rawResponse(SOURCE_DOC, "text/plain"));
  const code = await run(["obtain-key"], cli.deps);
  assert.equal(code, 0);
  assert.deepEqual(cli.out, [EXPECTED_KEY]);
  assert.ok(cli.err.join("\n").includes(KEY_SOURCE_URL));
  assert.match(cli.err.join("\n"), /not checked against the API/);
});

test("obtain-key --export emits a quoted, eval-safe export line", async () => {
  const cli = makeCli(() => rawResponse(SOURCE_DOC, "text/plain"));
  const code = await run(["obtain-key", "--export"], cli.deps);
  assert.equal(code, 0);
  assert.deepEqual(cli.out, [`export ${API_KEY_ENV_VAR}='${EXPECTED_KEY}'`]);
});

test("obtain-key needs no configured key and sends none", async () => {
  const cli = makeCli(() => rawResponse(SOURCE_DOC, "text/plain"));
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
  const mt = makeMockTransport(() => rawResponse(SOURCE_DOC, "text/plain"));
  await obtainKey({ transport: mt.transport });
  assert.equal(mt.last().timeoutMs, 30_000);
  assert.equal(mt.last().maxResponseBytes, 100 * 1024 * 1024);
});

test("obtainKey passes explicit limits, and 0 turns a limit off", async () => {
  const mt = makeMockTransport(() => rawResponse(SOURCE_DOC, "text/plain"));
  await obtainKey({ transport: mt.transport, timeoutMs: 1234, maxResponseBytes: 5678 });
  assert.equal(mt.last().timeoutMs, 1234);
  assert.equal(mt.last().maxResponseBytes, 5678);
  await obtainKey({ transport: mt.transport, timeoutMs: 0, maxResponseBytes: 0 });
  assert.equal("timeoutMs" in mt.last(), false);
  assert.equal("maxResponseBytes" in mt.last(), false);
});

test("obtainKey falls back to the default User-Agent for a blank one", async () => {
  const mt = makeMockTransport(() => rawResponse(SOURCE_DOC, "text/plain"));
  await obtainKey({ transport: mt.transport, userAgent: "  " });
  assert.equal(mt.last().headers?.["User-Agent"], "entgeltatlas-cli");
});

test("obtain-key forwards --timeout and --max-response-bytes", async () => {
  const cli = makeCli(() => rawResponse(SOURCE_DOC, "text/plain"));
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
    return rawResponse(SOURCE_DOC, "text/plain");
  });
  const code = await run(["--max-response-bytes", "10", "obtain-key"], cli.deps);
  assert.equal(code, 6);
  assert.deepEqual(cli.out, []);
});

test("obtainKey follows same-origin redirects and cites the final URL", async () => {
  const moved = "https://raw.githubusercontent.com/bundesAPI/renamed/main/README.md";
  const mt = makeMockTransport((req) =>
    req.url === KEY_SOURCE_URL
      ? { status: 301, headers: { location: "/bundesAPI/renamed/main/README.md" }, body: Buffer.alloc(0) }
      : rawResponse(SOURCE_DOC, "text/plain"),
  );
  const result = await obtainKey({ transport: mt.transport });
  assert.equal(result.key, EXPECTED_KEY);
  assert.equal(result.sourceUrl, moved);
  assert.equal(mt.calls.length, 2);
});

test("obtainKey does not follow a redirect to another host, nor a loop past the limit", async () => {
  const cross = makeMockTransport(() => ({
    status: 302,
    headers: { location: "https://evil.example/README.md" },
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
  const mt = makeMockTransport(() => rawResponse(doc, "text/plain"));
  return (await obtainKey({ transport: mt.transport })).key;
}

test("obtainKey reads the README's **client_id:** line, JSON and query forms", async () => {
  const uuid = "11111111-2222-3333-4444-555555555555";
  assert.equal(await keyFrom(`# API\n\n**client_id:** ${uuid}\n`), uuid);
  assert.equal(await keyFrom(`{"client_id": "${uuid}"}`), uuid);
  assert.equal(await keyFrom(`curl -d "client_id=${uuid}&grant_type=client_credentials"`), uuid);
  // The upstream layout: the key twice, as **client_id:** and in a curl example.
  assert.equal(await keyFrom(`**client_id:** ${uuid}\n\ncurl -d "client_id=${uuid.toUpperCase()}"`), uuid);
});

test("obtainKey prefers client_id and ignores an all-zero placeholder", async () => {
  const uuid = "11111111-2222-3333-4444-555555555555";
  const zero = "00000000-0000-0000-0000-000000000000";
  assert.equal(await keyFrom(`curl -H "X-API-Key: ${zero}"\n**client_id:** ${uuid}`), uuid);
  assert.equal(await keyFrom(`curl -H "X-API-Key: ${uuid}"\n**client_id:** ${uuid}`), uuid);
  await assert.rejects(() => keyFrom(`curl -H "X-API-Key: ${zero}"`), /No X-API-Key found/);
});

test("obtainKey fails on a source that states conflicting keys", async () => {
  const a = "11111111-2222-3333-4444-555555555555";
  const b = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  for (const doc of [`**client_id:** ${a}\nclient_id=${b}`, `curl -H "X-API-Key: ${b}"\n**client_id:** ${a}`]) {
    await assert.rejects(
      () => keyFrom(doc),
      (err) => err instanceof EntgeltatlasError && /states conflicting keys/.test(err.message),
      doc,
    );
  }
});
