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
const BASE_URL_ENV: string | undefined = undefined; // entgeltatlas reads no base-URL variable
const SIMPLE_COMMAND = ["regionen"];
const USAGE_EXIT = 2;
/** The members this repo's CliIO has besides out/err. */
const IO_EXTRAS = {};
/** P4: what the rejection of a '%' in the userinfo says, and whether an escaped one (%25) is accepted. */
const P4_MESSAGE = /%25/;
const P4_ESCAPED_OK = true;
/**
 * P19, keyed repos: the variables holding a credential, the commands that never use one,
 * a command that does, and a flag that overrides each variable (with a valid value).
 * `codes` is offline and documented as working with no key.
 */
const KEY_ENVS: string[] = ["ENTGELTATLAS_API_KEY"];
const KEYLESS_ARGVS: string[][] = [
  ["--help"],
  ["--version"],
  ["help"],
  ["help", "regionen"],
  ["regionen", "--help"],
  ["codes"],
  ["obtain-key", "--help"],
];
const KEYED_COMMAND = ["regionen"];
const OVERRIDES: Record<string, string[]> = {
  ENTGELTATLAS_API_KEY: ["--api-key", "flag-key-0001"],
};
/** What else a variable needs to be used (the other half of a username/password pair). */
const COMPANIONS: Record<string, Record<string, string>> = {};
/**
 * P19: malformed values of a credential variable. Not destatis' trailing-space value: the
 * key is trimmed by design (a key read from a CRLF file), so "k " is a valid key here.
 */
const BAD_ENV_VALUES = ["TOKEN€", "a\nb-0001", "abc\u0001def"];
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

test("P19: help works whatever the base-URL variable holds", async (t) => {
  if (BASE_URL_ENV === undefined) return t.skip("this CLI reads no base-URL variable");
  for (const value of ["not a url", "http://x:99999", "ftp://h", " "]) {
    for (const argv of [["--help"], ["help"], ["help", ...SIMPLE_COMMAND], [...SIMPLE_COMMAND, "--help"]]) {
      const c = cli({ [BASE_URL_ENV]: value });
      const code = await run(argv, c.deps);
      assert.equal(code, 0, `${BASE_URL_ENV}=${JSON.stringify(value)} ${argv.join(" ")}: ${c.err.join("\n")}`);
    }
    // A command that uses it still fails as a usage error.
    const c = cli({ [BASE_URL_ENV]: value });
    assert.equal(await run(SIMPLE_COMMAND, c.deps), USAGE_EXIT);
  }
});

test("P19 (keyed): a malformed credential variable stops only the commands that use it", async (t) => {
  if (KEY_ENVS.length === 0) return t.skip("this CLI reads no credential variable");
  for (const name of KEY_ENVS) {
    for (const value of BAD_ENV_VALUES) {
      for (const argv of KEYLESS_ARGVS) {
        const c = cli({ [name]: value });
        const code = await run(argv, c.deps);
        assert.equal(code, 0, `${name}=${JSON.stringify(value)} ${argv.join(" ")}: ${c.err.join("\n")}`);
      }
      // A flag that overrides the variable wins, so the variable is never read.
      const flagged = cli({ [name]: value });
      const override = OVERRIDES[name] ?? [];
      assert.equal(await run([...override, ...KEYED_COMMAND], flagged.deps), 0, `${name} overridden: ${flagged.err.join("\n")}`);
      // A command that uses it fails as a usage error naming the variable, before any request.
      const used = cli({ [name]: value, ...(COMPANIONS[name] ?? {}) });
      assert.equal(await run(KEYED_COMMAND, used.deps), USAGE_EXIT, `${name} used: ${used.err.join("\n")}`);
      assert.equal(used.requests(), 0);
      assert.match(used.err.join("\n"), new RegExp(name));
    }
  }
});
