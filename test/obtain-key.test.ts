// `obtain-key`: the command that fetches the public X-API-Key at run time.
// No key is bundled, so this path must never invent one — every failure mode
// below asserts that it fails loudly instead.

import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { EntgeltatlasClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { API_KEY_ENV_VAR, KEY_SOURCE_URL, obtainKey } from "../src/client/obtain-key.js";
import { EntgeltatlasError } from "../src/client/errors.js";
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

test("obtain-key prints only the key on stdout, provenance on stderr", async () => {
  const cli = makeCli(() => rawResponse(SOURCE_DOC, "text/plain"));
  const code = await run(["obtain-key"], cli.deps);
  assert.equal(code, 0);
  assert.deepEqual(cli.out, [EXPECTED_KEY]);
  assert.ok(cli.err.join("\n").includes(KEY_SOURCE_URL));
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
