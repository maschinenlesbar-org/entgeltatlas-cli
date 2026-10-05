// Conformance test P4 + P19 (fix plan 2026-10-06): a base URL the client can't use fails as a
// usage error before any request (P4), and help works whatever an environment variable holds
// (P19). Shared across the *-cli repos; only the adapter block differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { run } from "../src/cli/run.js";
import { EntgeltatlasClient as Client } from "../src/client/client.js";
import { EntgeltatlasValidationError as ValidationError } from "../src/client/errors.js";
const SIMPLE_COMMAND = ["regionen"];
const USAGE_EXIT = 2;
/** The members this repo's CliIO has besides out/err. */
const IO_EXTRAS = {};
/** P4: what the rejection of a '%' in the userinfo says, and whether an escaped one (%25) is accepted. */
const P4_MESSAGE = /%25/;
const P4_ESCAPED_OK = true;
/** A body every command used here accepts. */
const okBody = [{ id: 1, bezeichnung: "Deutschland" }];
// --------------------------------------------------------------------------------------

function cli(env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  let requests = 0;
  const transport = async (): Promise<HttpResponse> => {
    requests++;
    return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(okBody)) };
  };
  const deps: CliDeps = {
    io: { out: (s) => out.push(s), err: (s) => err.push(s), ...IO_EXTRAS },
    env,
    createClient: (opts) => new Client({ ...opts, transport }),
  };
  return { deps, out, err, requests: () => requests };
}

test("P4: a '%' that isn't an escape in the userinfo is a usage error before any request", async () => {
  for (const url of ["https://alice:100%@mirror.example", "https://alice:pa%zzss@mirror.example", "https://al%ice:pw@mirror.example"]) {
    const c = cli();
    const code = await run(["--base-url", url, ...SIMPLE_COMMAND], c.deps);
    assert.equal(code, USAGE_EXIT, `${url}: ${c.err.join("\n")}`);
    assert.equal(c.requests(), 0);
    assert.match(c.err.join("\n"), P4_MESSAGE);
    assert.throws(() => new Client({ baseUrl: url }), ValidationError);
  }
  // An escaped "%" is fine (where the CLI takes userinfo at all).
  const escaped = () => new Client({ baseUrl: "https://alice:100%25@mirror.example" });
  if (P4_ESCAPED_OK) assert.doesNotThrow(escaped);
  else assert.throws(escaped, ValidationError);
});
