// CLI <-> library parity: the same input through run() and through the library,
// on one recording mock transport, must give the same outcome — both reject and
// send nothing, or both send the identical request.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as lib from "../src/index.js";
import { EntgeltatlasValidationError } from "../src/client/errors.js";
import type { EntgelteParams } from "../src/client/types.js";
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
