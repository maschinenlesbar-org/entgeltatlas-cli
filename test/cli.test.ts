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

const KEY = ["--api-key", "c4f0d292-9d0f-4763-87dd-d3f9e78fb006"];

test("entgelte prints the salary array and sends the X-API-Key", async () => {
  const cli = makeCli(() => jsonResponse(fx.entgelteResult));
  const code = await run([...KEY, "entgelte", "84304", "-l", "4", "-r", "1"], cli.deps);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(cli.out.join("\n")), fx.entgelteResult);
  const req = cli.mt.last();
  assert.equal(req.headers?.["X-API-Key"], "c4f0d292-9d0f-4763-87dd-d3f9e78fb006");
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
  assert.equal(cli.mt.last().headers?.["X-API-Key"], "c4f0d292-9d0f-4763-87dd-d3f9e78fb006");
});

test("a non-numeric KldB code exits 2 (usage) before any request", async () => {
  const cli = makeCli(() => jsonResponse(fx.entgelteResult));
  const code = await run([...KEY, "entgelte", "Softwareentwickler"], cli.deps);
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

test("a 403 exits 3 with a WAF/IP-block hint", async () => {
  const cli = makeCli(() => rawResponse("", "text/html", 403));
  const code = await run([...KEY, "entgelte", "84304"], cli.deps);
  assert.equal(code, 3);
  assert.match(cli.err.join("\n"), /WAF\/IP block/);
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
