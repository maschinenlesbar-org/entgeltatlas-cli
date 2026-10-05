// CLI <-> library parity: the same input through run() and through the library,
// on one recording mock transport, must give the same outcome — both reject and
// send nothing, or both send the identical request.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as lib from "../src/index.js";
import { EntgeltatlasValidationError } from "../src/client/errors.js";
import type { EntgelteParams } from "../src/client/types.js";
import { run } from "../src/cli/run.js";
import { parity } from "./helpers.js";

const KEY = ["--api-key", "k"];
const client = (transport: lib.Transport) => new lib.EntgeltatlasClient({ transport, apiKey: "k" });

/** Both sides rejected the input as a validation error and sent no request. */
function assertBothReject(r: Awaited<ReturnType<typeof parity>>, label: string): void {
  assert.equal(r.cli.code, 2, `${label}: CLI exit (${r.cli.err})`);
  assert.equal(r.cli.requests.length, 0, `${label}: CLI requests`);
  assert.equal(r.lib.ok, false, `${label}: library accepted it`);
  assert.ok(r.lib.error instanceof EntgeltatlasValidationError, `${label}: ${String(r.lib.error)}`);
  assert.equal(r.lib.requests.length, 0, `${label}: library requests`);
}

test("parity #1: a dimension code outside its table is rejected by both, before any request", async () => {
  const cases: [string[], EntgelteParams][] = [
    [["--region", "31"], { r: 31 }],
    [["--level", "5"], { l: 5 }],
    [["--gender", "0"], { g: 0 }],
    [["--age", "5"], { a: 5 }],
    [["--branch", "12"], { b: 12 }],
  ];
  for (const [flags, params] of cases) {
    const r = await parity([...KEY, "entgelte", "84304", ...flags], (t) => client(t).entgelte("84304", params));
    assertBothReject(r, flags.join(" "));
  }
});

test("parity #1: the library rejects codes the CLI cannot even parse (NaN, Infinity, fractions, negatives)", async () => {
  for (const params of [{ l: NaN }, { r: Infinity }, { b: 1.5 }, { a: -1 }, { g: "2" as unknown as number }]) {
    const r = await parity([...KEY, "entgelte", "84304", "--level", "NaN"], (t) => client(t).entgelte("84304", params));
    assertBothReject(r, JSON.stringify(params));
  }
});

test("parity #1: a valid code gives the identical request on both sides", async () => {
  const r = await parity(
    [...KEY, "entgelte", "84304", "-l", "4", "-r", "30", "-g", "3", "-a", "4", "-b", "11"],
    (t) => client(t).entgelte("84304", { l: 4, r: 30, g: 3, a: 4, b: 11 }),
  );
  assert.equal(r.cli.code, 0, r.cli.err);
  assert.equal(r.lib.ok, true);
  assert.equal(r.cli.requests.length, 1);
  assert.deepEqual(r.lib.requests, r.cli.requests);
});

test("parity #1: the code tables come from the library, and `codes` prints them", async () => {
  const r = await parity(["--compact", "codes"], () => lib.DIMENSIONS);
  assert.equal(r.cli.code, 0);
  const printed = JSON.parse(r.cli.out) as { param: string; flag: string }[];
  assert.deepEqual(
    printed.map(({ flag: _flag, ...rest }) => rest),
    lib.DIMENSIONS,
  );
  assert.deepEqual(
    printed.map((d) => d.param),
    [...lib.DIMENSION_PARAMS],
  );
});

test("parity #2: an out-of-range engine limit is rejected by both, before any request", async () => {
  const cases: [string[], lib.EntgeltatlasClientOptions][] = [
    [["--timeout", "-1"], { timeoutMs: -1 }],
    [["--timeout", "NaN"], { timeoutMs: NaN }],
    [["--timeout", "2147483648"], { timeoutMs: 2_147_483_648 }],
    [["--max-retries", "11"], { maxRetries: 11 }],
    [["--max-retries", "1.5"], { maxRetries: 1.5 }],
    [["--max-response-bytes", "-1"], { maxResponseBytes: -1 }],
    [["--max-response-bytes", "NaN"], { maxResponseBytes: NaN }],
  ];
  for (const [flags, options] of cases) {
    const r = await parity([...KEY, ...flags, "regionen"], async (transport) =>
      new lib.EntgeltatlasClient({ transport, apiKey: "k", ...options }).regionen(),
    );
    assertBothReject(r, flags.join(" "));
  }
});

test("parity #2: obtain-key and obtainKey() reject the same out-of-range limits", async () => {
  const cases: [string[], lib.ObtainKeyOptions][] = [
    [["--timeout", "-1"], { timeoutMs: -1 }],
    [["--max-response-bytes", "-1"], { maxResponseBytes: -1 }],
  ];
  for (const [flags, options] of cases) {
    const r = await parity([...flags, "obtain-key"], (transport) => lib.obtainKey({ transport, ...options }));
    assertBothReject(r, `obtain-key ${flags.join(" ")}`);
  }
});

test("parity #2: in-range limits give the identical request on both sides", async () => {
  const r = await parity(
    [...KEY, "--timeout", "0", "--max-retries", "10", "--max-response-bytes", "0", "regionen"],
    (transport) =>
      new lib.EntgeltatlasClient({ transport, apiKey: "k", timeoutMs: 0, maxRetries: 10, maxResponseBytes: 0 }).regionen(),
  );
  assert.equal(r.cli.code, 0, r.cli.err);
  assert.equal(r.lib.ok, true);
  assert.deepEqual(r.lib.requests, r.cli.requests);
});

test("parity #3: a User-Agent an HTTP header cannot carry, or a blank one, is rejected by both", async () => {
  for (const ua of ["a\r\nX-Evil: 1", "", "   ", "Bot €", "日本", "x" + String.fromCharCode(0x7f)]) {
    const r = await parity([...KEY, "--user-agent", ua, "regionen"], async (transport) =>
      new lib.EntgeltatlasClient({ transport, apiKey: "k", userAgent: ua }).regionen(),
    );
    assertBothReject(r, JSON.stringify(ua));
    const o = await parity(["--user-agent", ua, "obtain-key"], (transport) =>
      lib.obtainKey({ transport, userAgent: ua }),
    );
    assertBothReject(o, `obtain-key ${JSON.stringify(ua)}`);
  }
});

test("parity #3: a valid User-Agent is sent as given by both", async () => {
  const r = await parity([...KEY, "--user-agent", "ok-agent\t1", "regionen"], (transport) =>
    new lib.EntgeltatlasClient({ transport, apiKey: "k", userAgent: "ok-agent\t1" }).regionen(),
  );
  assert.equal(r.cli.code, 0, r.cli.err);
  assert.deepEqual(r.lib.requests, r.cli.requests);
  assert.equal(r.cli.requests[0]?.headers?.["User-Agent"], "ok-agent\t1");
});

test("parity #4: a base URL with surrounding whitespace is rejected by both, before any request", async () => {
  for (const baseUrl of ["http://h.example ", " http://h.example", "\thttps://h.example", "https://h.example\n", "http://h.example/ "]) {
    const r = await parity([...KEY, "--base-url", baseUrl, "regionen"], async (transport) =>
      new lib.EntgeltatlasClient({ transport, apiKey: "k", baseUrl }).regionen(),
    );
    assertBothReject(r, JSON.stringify(baseUrl));
  }
});

test("parity #4: a clean base URL gives the identical request on both sides", async () => {
  const r = await parity([...KEY, "--base-url", "http://h.example/", "regionen"], (transport) =>
    new lib.EntgeltatlasClient({ transport, apiKey: "k", baseUrl: "http://h.example/" }).regionen(),
  );
  assert.equal(r.cli.code, 0, r.cli.err);
  assert.deepEqual(r.lib.requests, r.cli.requests);
  assert.equal(r.cli.requests[0]?.url, "http://h.example/infosysbub/entgeltatlas/pc/v1/regionen");
});

test("parity #6: flag, env and library trim a key the same way before the header check", async () => {
  for (const raw of ["k\r", "k\n", "\r\nk", "k\v", "k﻿", "　k", "k ", " k "]) {
    const lib6 = (transport: lib.Transport) => new lib.EntgeltatlasClient({ transport, apiKey: raw }).regionen();
    const flag = await parity(["--api-key", raw, "regionen"], lib6);
    const env = await parity(["regionen"], lib6, { env: { ENTGELTATLAS_API_KEY: raw } });
    for (const [label, r] of [["flag", flag], ["env", env]] as const) {
      assert.equal(r.cli.code, 0, `${label} ${JSON.stringify(raw)}: ${r.cli.err}`);
      assert.equal(r.lib.ok, true, JSON.stringify(raw));
      assert.deepEqual(r.lib.requests, r.cli.requests, `${label} ${JSON.stringify(raw)}`);
      assert.equal(r.cli.requests[0]?.headers?.["X-API-Key"], "k");
    }
  }
});

test("parity #6: a key an HTTP header cannot carry is rejected by flag, env and library alike", async () => {
  for (const raw of ["a\nb", "ключ", "a" + String.fromCharCode(0x7f) + "b"]) {
    const lib6 = async (transport: lib.Transport) => new lib.EntgeltatlasClient({ transport, apiKey: raw }).regionen();
    assertBothReject(await parity(["--api-key", raw, "regionen"], lib6), `flag ${JSON.stringify(raw)}`);
    const env = await parity(["regionen"], lib6, { env: { ENTGELTATLAS_API_KEY: raw } });
    assertBothReject(env, `env ${JSON.stringify(raw)}`);
    // One rule, one message: the env path prints the library's error.
    assert.equal(env.cli.err, `Error: ${(env.lib.error as Error).message}`);
  }
});

/** The published key, in the shape the key source states it. */
const KEY_DOC = "<script>globalThis.infosysbubLibConfig = { clientId: 'dummy-test-key' };</script>\n";

/** Answers each side's first request with `first`, its second with the key document. */
function flaky(first: lib.HttpResponse): () => lib.HttpResponse {
  let n = 0;
  return () => {
    n += 1;
    return n % 2 === 1
      ? first
      : { status: 200, headers: { "content-type": "text/plain" }, body: Buffer.from(KEY_DOC) };
  };
}

const busy = (status: number, retryAfter?: string): lib.HttpResponse => ({
  status,
  headers: { "content-type": "text/plain", ...(retryAfter === undefined ? {} : { "retry-after": retryAfter }) },
  body: Buffer.from("busy"),
});

test("parity #7: obtain-key and obtainKey() retry a transient 429/503 like the API client", async () => {
  for (const [flags, options] of [
    [["--max-retries", "2"], { maxRetries: 2 }],
    [[], {}],
  ] as [string[], lib.ObtainKeyOptions][]) {
    for (const status of [503, 429]) {
      const r = await parity([...flags, "obtain-key"], (transport) => lib.obtainKey({ transport, ...options }), {
        responder: flaky(busy(status, "0")),
      });
      assert.equal(r.cli.code, 0, `${status} ${flags.join(" ")}: ${r.cli.err}`);
      assert.equal(r.cli.out, "dummy-test-key");
      assert.equal(r.lib.ok, true, String(r.lib.error));
      assert.equal(r.cli.requests.length, 2);
      assert.deepEqual(r.lib.requests, r.cli.requests);
    }
  }
});

test("parity #7: --max-retries 0 / maxRetries: 0 and a too-long Retry-After surface the error at once", async () => {
  for (const [flags, options, first] of [
    [["--max-retries", "0"], { maxRetries: 0 }, busy(503, "0")],
    [[], {}, busy(503, "31")],
  ] as [string[], lib.ObtainKeyOptions, lib.HttpResponse][]) {
    const r = await parity([...flags, "obtain-key"], (transport) => lib.obtainKey({ transport, ...options }), {
      responder: () => first,
    });
    assert.equal(r.cli.code, 1, r.cli.err);
    assert.equal(r.cli.requests.length, 1);
    assert.ok(r.lib.error instanceof lib.EntgeltatlasKeySourceError, String(r.lib.error));
    assert.equal(r.lib.requests.length, 1);
  }
});

test("parity #7: an out-of-range retry count is rejected by obtain-key and obtainKey() alike", async () => {
  const r = await parity(["--max-retries", "11", "obtain-key"], (transport) =>
    lib.obtainKey({ transport, maxRetries: 11 }),
  );
  assertBothReject(r, "maxRetries 11");
});

test("parity #5: an invalid base URL is a validation error in the library, as it is a usage error in the CLI", async () => {
  for (const baseUrl of ["ftp://h.example", "http://h.example/?x=1", "http://h.example/#f", "", "not a url"]) {
    const r = await parity([...KEY, "--base-url", baseUrl, "regionen"], async (transport) =>
      new lib.EntgeltatlasClient({ transport, apiKey: "k", baseUrl }).regionen(),
    );
    assertBothReject(r, JSON.stringify(baseUrl));
  }
});

test("parity #5: run() maps the library's base-URL error to the usage exit code, not the network one", async () => {
  const err: string[] = [];
  const code = await run(["regionen"], {
    io: { out: () => {}, err: (s) => err.push(s) },
    // A library-side rejection, bypassing the CLI's --base-url parser.
    createClient: (opts) => new lib.EntgeltatlasClient({ ...opts, baseUrl: "ftp://h.example" }),
    env: {},
  });
  assert.equal(code, 2);
  assert.deepEqual(err, ["Error: Invalid baseUrl: Only http: and https: base URLs are supported."]);
});
