import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { EntgeltatlasClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { makeMockTransport, jsonResponse, rawResponse, queryOf } from "./helpers.js";
import * as fx from "./fixtures.js";

function makeCli(
  responder: (req: HttpRequest) => HttpResponse,
  env: Record<string, string | undefined> = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const mt = makeMockTransport(responder);
  const deps: CliDeps = {
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    createClient: (opts) => new EntgeltatlasClient({ ...opts, transport: mt.transport }),
    env,
  };
  return { deps, out, err, mt };
}

const KEY = ["--api-key", "00000000-0000-4000-8000-000000000000"];

test("entgelte prints the salary array and sends the X-API-Key", async () => {
  const cli = makeCli(() => jsonResponse(fx.entgelteResult));
  const code = await run([...KEY, "entgelte", "84304", "-l", "4", "-r", "1"], cli.deps);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(cli.out.join("\n")), fx.entgelteResult);
  const req = cli.mt.last();
  assert.equal(req.headers?.["X-API-Key"], "00000000-0000-4000-8000-000000000000");
  assert.equal(new URL(req.url).pathname, "/infosysbub/entgeltatlas/pc/v1/entgelte/84304");
  assert.equal(queryOf(req).get("l"), "4");
});

test("ENTGELTATLAS_API_KEY from the environment seeds the key", async () => {
  const cli = makeCli(() => jsonResponse(fx.entgelteResult), {
    ENTGELTATLAS_API_KEY: "env-key-uuid",
  });
  const code = await run(["entgelte", "84304"], cli.deps);
  assert.equal(code, 0);
  assert.equal(cli.mt.last().headers?.["X-API-Key"], "env-key-uuid");
});

test("an explicit --api-key overrides the environment", async () => {
  const cli = makeCli(() => jsonResponse(fx.entgelteResult), { ENTGELTATLAS_API_KEY: "env-key" });
  await run([...KEY, "entgelte", "84304"], cli.deps);
  assert.equal(cli.mt.last().headers?.["X-API-Key"], "00000000-0000-4000-8000-000000000000");
});

test("a non-numeric KldB code exits 2 (usage) before any request", async () => {
  const cli = makeCli(() => jsonResponse(fx.entgelteResult));
  const code = await run([...KEY, "entgelte", "Softwareentwickler"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
});

test("a non-http(s) --base-url exits 2 (usage) before any request", async () => {
  const cli = makeCli(() => jsonResponse(fx.entgelteResult));
  const code = await run(
    [...KEY, "--base-url", "file:///etc/passwd", "entgelte", "84304"],
    cli.deps,
  );
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
});

test("a suppressed result is printed faithfully (null, not 0)", async () => {
  const cli = makeCli(() => jsonResponse(fx.suppressedResult));
  await run([...KEY, "entgelte", "84304", "-g", "3", "-a", "2"], cli.deps);
  const printed = JSON.parse(cli.out.join("\n"));
  assert.equal(printed[0].entgelt, null);
  assert.notEqual(printed[0].entgelt, 0);
});

test("DEL and C1 control characters in server data are escaped in the JSON output", async () => {
  const controls = String.fromCharCode(0x7f, 0x85, 0x9b) + "2J";
  const entry = fx.entgelteResult[0]!;
  const served = [
    {
      ...entry,
      region: { ...entry.region, bezeichnung: `Deutschland${controls}` },
      gender: { id: 1, bezeichnung: String.fromCharCode(0x1b) + "[31m" },
    },
  ];
  for (const format of [[], ["--compact"]]) {
    const cli = makeCli(() => jsonResponse(served));
    assert.equal(await run([...KEY, ...format, "entgelte", "84304"], cli.deps), 0);
    const text = cli.out.join("\n");
    const raw = [...text].filter((c) => c.charCodeAt(0) < 0x20 ? c !== "\n" : c.charCodeAt(0) >= 0x7f && c.charCodeAt(0) <= 0x9f);
    assert.deepEqual(raw, [], format.join(" "));
    assert.match(text, /Deutschland\\u007f\\u0085\\u009b2J/);
    assert.deepEqual(JSON.parse(text), served);
  }
});

test("a 403 exits 3 with a hint that names both a wrong key and a refused network", async () => {
  // The gateway answers a wrong key with the same one-space text/plain 403 as a WAF block.
  const cli = makeCli(() => rawResponse(" ", "text/plain", 403));
  const code = await run([...KEY, "entgelte", "84304"], cli.deps);
  assert.equal(code, 3);
  const err = cli.err.join("\n");
  assert.match(err, /ENTGELTATLAS_API_KEY env var against `entgeltatlas obtain-key`/);
  assert.match(err, /looks the same for a wrong key, a refused network \(WAF\/IP block\) and a key the API no longer accepts/);
  assert.match(err, /OAuth client-credentials flow this CLI does not implement/);
  assert.doesNotMatch(err, /not a bad key/);
});

test("a 403 without any key says that no key was sent", async () => {
  const cli = makeCli(() => rawResponse(" ", "text/plain", 403));
  const code = await run(["entgelte", "84304"], cli.deps);
  assert.equal(code, 3);
  assert.match(cli.err.join("\n"), /no X-API-Key was sent\. Pass --api-key or set ENTGELTATLAS_API_KEY/);
});

test("a 404 exits 4", async () => {
  const cli = makeCli(() => jsonResponse({ message: "not found" }, 404));
  const code = await run([...KEY, "entgelte", "84304"], cli.deps);
  assert.equal(code, 4);
});

test("regionen hits the reference endpoint", async () => {
  const cli = makeCli(() => jsonResponse(fx.regionen));
  const code = await run([...KEY, "regionen"], cli.deps);
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).pathname, "/infosysbub/entgeltatlas/pc/v1/regionen");
  assert.deepEqual(JSON.parse(cli.out.join("\n")), fx.regionen);
});

test("codes works offline: no request, no key needed", async () => {
  const cli = makeCli(() => {
    throw new Error("codes must not hit the network");
  });
  const code = await run(["codes", "--compact"], cli.deps);
  assert.equal(code, 0);
  assert.equal(cli.mt.calls.length, 0);
  const dims = JSON.parse(cli.out.join("\n"));
  assert.ok(Array.isArray(dims) && dims.some((d: { param: string }) => d.param === "r"));
});

test("--compact prints single-line JSON", async () => {
  const cli = makeCli(() => jsonResponse(fx.entgelteResult));
  await run([...KEY, "--compact", "entgelte", "84304"], cli.deps);
  assert.equal(cli.out.length, 1);
  assert.equal(cli.out[0], JSON.stringify(fx.entgelteResult));
});

test("--timeout accepts up to the largest timer Node supports", async () => {
  const cli = makeCli(() => jsonResponse(fx.entgelteResult));
  assert.equal(await run([...KEY, "--timeout", "2147483647", "entgelte", "84304"], cli.deps), 0);
  assert.equal(cli.mt.last().timeoutMs, 2_147_483_647);

  const over = makeCli(() => jsonResponse(fx.entgelteResult));
  assert.equal(await run([...KEY, "--timeout", "2147483648", "entgelte", "84304"], over.deps), 2);
  assert.equal(over.mt.calls.length, 0);
  assert.match(over.err.join("\n"), /Must be <= 2147483647/);
});

test("a wrong-shaped 2xx body exits 1 with a shape error, not exit 0", async () => {
  const cli = makeCli(() => jsonResponse({ error: "not an array", status: 500 }));
  const code = await run([...KEY, "entgelte", "84304"], cli.deps);
  assert.equal(code, 1);
  assert.deepEqual(cli.out, []);
  assert.match(cli.err.join("\n"), /Unexpected response shape from .*expected a JSON array of objects/);
});

test("--max-retries is bounded to 0..10 (usage error, no request)", async () => {
  for (const value of ["11", "9007199254740991", "-1", "1.5"]) {
    const cli = makeCli(() => jsonResponse(fx.entgelteResult));
    const code = await run([...KEY, "--max-retries", value, "entgelte", "84304"], cli.deps);
    assert.equal(code, 2, value);
    assert.equal(cli.mt.calls.length, 0, value);
  }
  const cli = makeCli(() => jsonResponse(fx.entgelteResult));
  assert.equal(await run([...KEY, "--max-retries", "10", "entgelte", "84304"], cli.deps), 0);
});

test("a bare invocation prints help to stdout and exits 0", async () => {
  const cli = makeCli(() => jsonResponse([]));
  const code = await run([], cli.deps);
  assert.equal(code, 0);
  assert.match(cli.out.join("\n"), /Usage: entgeltatlas/);
});

test("--help exits 0", async () => {
  const cli = makeCli(() => jsonResponse([]));
  assert.equal(await run(["--help"], cli.deps), 0);
});
