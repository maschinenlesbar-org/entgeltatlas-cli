// `entgeltatlas config` and the credentials file: the API key kept apart from argv and
// the environment, the same mechanism as openka-cli's `ka config`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { run } from "../src/cli/run.js";
import { EntgeltatlasClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import { readSecretFrom } from "../src/cli/io.js";
import { CredentialStore, maskCredential, resolveCredentialsPath } from "../src/cli/credentials.js";
import { makeMockTransport, jsonResponse, rawResponse, untimed } from "./helpers.js";
import * as fx from "./fixtures.js";

const KEY = "c003a37f-024f-462a-b36d-b001be4cd24a";
const MASKED = "c003…d24a";

/** A CLI whose credentials file lives in a temporary directory, and whose secret prompt answers `secret`. */
function makeCli(options: { env?: Record<string, string | undefined>; secret?: string; credentials?: boolean; status?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "entgeltatlas-config-"));
  const store = new CredentialStore(join(dir, "entgeltatlas", "credentials"));
  const out: string[] = [];
  const err: string[] = [];
  const mt = makeMockTransport(() =>
    options.status === undefined ? jsonResponse(fx.entgelteResult) : rawResponse("", "text/plain", options.status),
  );
  const deps: CliDeps = {
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      ...(options.secret === undefined ? {} : { readSecret: async () => options.secret as string }),
    },
    createClient: (opts) => new EntgeltatlasClient({ ...opts, transport: mt.transport }),
    env: options.env ?? {},
    ...(options.credentials === false ? {} : { credentials: () => store }),
  };
  return { deps, out, err, mt, store, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("config set stores the key from the prompt, mode 0600 in a 0700 directory, and shows it masked", async () => {
  const cli = makeCli({ secret: `${KEY}\n` });
  try {
    assert.equal(await run(["config", "set", "api-key"], cli.deps), 0);
    assert.equal(cli.store.get("api-key"), KEY);
    assert.equal(statSync(cli.store.path).mode & 0o777, 0o600);
    assert.equal(statSync(join(cli.dir, "entgeltatlas")).mode & 0o777, 0o700);
    assert.match(untimed(cli.err.join("\n")), new RegExp(`^INFO  \\[entgeltatlas\\.config\\] Stored api-key \\(${MASKED}\\) in `));
    assert.ok(!(cli.err.join("\n") + cli.out.join("\n")).includes(KEY));

    cli.out.length = 0;
    assert.equal(await run(["config", "get", "api-key"], cli.deps), 0);
    assert.deepEqual(cli.out, [MASKED]);
    cli.out.length = 0;
    assert.equal(await run(["config", "get", "api-key", "--reveal"], cli.deps), 0);
    assert.deepEqual(cli.out, [KEY]);
    cli.out.length = 0;
    cli.err.length = 0;
    assert.equal(await run(["config", "list"], cli.deps), 0);
    assert.deepEqual(cli.out, [`api-key  ${MASKED}`]);
    assert.match(untimed(cli.err.join("\n")), new RegExp(`^INFO  \\[entgeltatlas\\.config\\] Credentials file: ${cli.store.path}`));

    assert.equal(await run(["config", "unset", "api-key"], cli.deps), 0);
    assert.equal(cli.store.get("api-key"), undefined);
    assert.equal(await run(["config", "unset", "api-key"], cli.deps), 1);
    assert.equal(await run(["config", "get", "api-key"], cli.deps), 1);
  } finally {
    cli.cleanup();
  }
});

test("config set never takes the value from the command line, and never repeats it", async () => {
  // Not shaped like a UUID, so the run's own redaction (looksLikeApiKey) does not hide it.
  const secret = "plain-token-1234567890";
  const cli = makeCli({ secret: KEY });
  try {
    assert.equal(await run(["config", "set", "api-key", secret], cli.deps), 2);
    assert.match(cli.err.join("\n"), /takes the name only/);
    assert.ok(!(cli.err.join("\n") + cli.out.join("\n")).includes(secret));
    assert.equal(cli.store.get("api-key"), undefined);
    assert.equal(await run(["config", "set", "password"], cli.deps), 2, "an unknown name");
  } finally {
    cli.cleanup();
  }
});

test("config set refuses a blank value, one with whitespace inside or one no header can carry, and stores nothing", async () => {
  for (const secret of ["", "   ", "two words", "schlüssel€"]) {
    const cli = makeCli({ secret });
    try {
      assert.equal(await run(["config", "set", "api-key"], cli.deps), 2, JSON.stringify(secret));
      assert.match(cli.err.join("\n"), /Nothing was stored/);
      assert.equal(cli.store.get("api-key"), undefined);
    } finally {
      cli.cleanup();
    }
  }
});

test("the stored key is sent when neither --api-key nor ENTGELTATLAS_API_KEY gives one, and only then", async () => {
  const cli = makeCli({ secret: KEY });
  const fromEnv = makeCli({ env: { ENTGELTATLAS_API_KEY: "ENVKEY12345" } });
  try {
    await run(["config", "set", "api-key"], cli.deps);
    assert.equal(await run(["entgelte", "84304"], cli.deps), 0);
    assert.equal(cli.mt.last().headers?.["X-API-Key"], KEY);
    // The env var and the flag come first.
    const viaEnv = { ...fromEnv.deps, credentials: () => cli.store };
    assert.equal(await run(["entgelte", "84304"], viaEnv), 0);
    assert.equal(fromEnv.mt.last().headers?.["X-API-Key"], "ENVKEY12345");
    assert.equal(await run(["--api-key", "FLAGKEY1234", "entgelte", "84304"], viaEnv), 0);
    assert.equal(fromEnv.mt.last().headers?.["X-API-Key"], "FLAGKEY1234");
  } finally {
    fromEnv.cleanup();
    cli.cleanup();
  }
});

test("a 403 with a stored key gets the hint for a key that was sent, naming config", async () => {
  const cli = makeCli({ status: 403 });
  try {
    cli.store.set("api-key", KEY);
    assert.equal(await run(["entgelte", "84304"], cli.deps), 3);
    assert.match(cli.err.join("\n"), /the stored key \(`entgeltatlas config get api-key`\)/);
    assert.doesNotMatch(cli.err.join("\n"), /no X-API-Key was sent/);
  } finally {
    cli.cleanup();
  }
  const none = makeCli({ status: 403 });
  try {
    assert.equal(await run(["entgelte", "84304"], none.deps), 3);
    assert.match(none.err.join("\n"), /no X-API-Key was sent.*entgeltatlas config set api-key/);
  } finally {
    none.cleanup();
  }
});

test("a credentials file others can read is refused, and only when it is needed", async () => {
  const cli = makeCli();
  try {
    cli.store.set("api-key", KEY);
    chmodSync(cli.store.path, 0o644);
    assert.equal(await run(["entgelte", "84304"], cli.deps), 1);
    assert.match(cli.err.join("\n"), /can be read by others \(mode 644\).*chmod 600/);
    assert.equal(cli.mt.calls.length, 0);
    // A key given another way does not read the file at all, nor does `codes`.
    assert.equal(await run(["--api-key", "FLAGKEY1234", "entgelte", "84304"], cli.deps), 0);
    assert.equal(await run(["codes"], { ...cli.deps, env: {} }), 0);
  } finally {
    cli.cleanup();
  }
});

test("commands that need no key never read the credentials file", async () => {
  let reads = 0;
  const cli = makeCli();
  try {
    const deps: CliDeps = {
      ...cli.deps,
      transport: makeMockTransport(() => rawResponse("", "text/plain", 404)).transport,
      credentials: () => {
        reads += 1;
        return cli.store;
      },
    };
    assert.equal(await run(["codes"], deps), 0);
    await run(["obtain-key"], deps);
    await run(["--help"], deps);
    assert.equal(reads, 0);
  } finally {
    cli.cleanup();
  }
});

test("a stored key the library would refuse is an error naming the file, not the key", async () => {
  const cli = makeCli();
  try {
    mkdirSync(join(cli.dir, "entgeltatlas"), { mode: 0o700 });
    writeFileSync(cli.store.path, JSON.stringify({ "api-key": "schlüssel€" }), { mode: 0o600 });
    assert.equal(await run(["entgelte", "84304"], cli.deps), 1);
    assert.match(cli.err.join("\n"), /Invalid api-key in .*credentials/);
    assert.ok(!cli.err.join("\n").includes("schlüssel€"));
    assert.equal(cli.mt.calls.length, 0);
  } finally {
    cli.cleanup();
  }
});

test("deps without a credentials store never read a credentials file", async () => {
  const cli = makeCli({ credentials: false, env: { XDG_CONFIG_HOME: "/nonexistent" } });
  try {
    assert.equal(await run(["entgelte", "84304"], cli.deps), 0);
    assert.equal(cli.mt.last().headers?.["X-API-Key"], undefined);
    assert.equal(await run(["config", "list"], cli.deps), 1);
  } finally {
    cli.cleanup();
  }
});

test("the credentials file: where it is, what it refuses, and how it masks", () => {
  assert.equal(resolveCredentialsPath({ XDG_CONFIG_HOME: "/x" }), "/x/entgeltatlas/credentials");
  assert.equal(resolveCredentialsPath({ XDG_CONFIG_HOME: "relative", HOME: "/home/me" }), "/home/me/.config/entgeltatlas/credentials");
  assert.equal(resolveCredentialsPath({ HOME: "/home/me" }), "/home/me/.config/entgeltatlas/credentials");
  assert.equal(maskCredential("short"), "****");
  const dir = mkdtempSync(join(tmpdir(), "entgeltatlas-store-"));
  try {
    const path = join(dir, "credentials");
    writeFileSync(path, "{ not json", { mode: 0o600 });
    assert.throws(() => new CredentialStore(path).get("api-key"), /not valid JSON/);
    writeFileSync(path, JSON.stringify({ "api-key": 5 }), { mode: 0o600 });
    assert.throws(() => new CredentialStore(path).get("api-key"), /not an object of names and strings/);
    mkdirSync(join(dir, "real"));
    writeFileSync(join(dir, "real", "credentials"), JSON.stringify({ "api-key": KEY }), { mode: 0o600 });
    symlinkSync(join(dir, "real", "credentials"), join(dir, "link"));
    assert.throws(() => new CredentialStore(join(dir, "link")).get("api-key"), /not a regular file/);
    const store = new CredentialStore(join(dir, "fresh", "credentials"));
    store.set("api-key", KEY);
    assert.deepEqual(JSON.parse(readFileSync(store.path, "utf8")), { "api-key": KEY });
    assert.throws(() => store.set("API KEY", KEY), /Not a credential name/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a secret piped in is read whole, one trailing newline dropped", async () => {
  assert.equal(await readSecretFrom(Readable.from([`${KEY}\n`]), { write: () => true }, "api-key: "), KEY);
  assert.equal(await readSecretFrom(Readable.from([Buffer.from("abc"), Buffer.from("def\r\n")]), { write: () => true }, "api-key: "), "abcdef");
});

test("an unwritable config location names the credentials file, for set and for the last unset (C4)", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) return t.skip("needs POSIX permissions and a non-root user");
  const cli = makeCli({ secret: KEY });
  try {
    // The parent of the program's directory cannot be written: mkdir fails.
    const parent = join(cli.dir, "entgeltatlas");
    mkdirSync(cli.dir, { recursive: true });
    chmodSync(cli.dir, 0o500);
    assert.equal(await run(["config", "set", "api-key"], cli.deps), 1);
    assert.match(cli.err.join("\n"), /Could not write the credentials file .*credentials: EACCES/);
    assert.doesNotMatch(cli.err.join("\n"), /Unexpected error/);
    chmodSync(cli.dir, 0o700);

    // The last name removed from a file in a directory that cannot be written: rm fails.
    cli.err.length = 0;
    cli.store.set("api-key", KEY);
    chmodSync(parent, 0o500);
    assert.equal(await run(["config", "unset", "api-key"], cli.deps), 1);
    assert.match(cli.err.join("\n"), /Could not write the credentials file .*credentials: EACCES/);
    assert.doesNotMatch(cli.err.join("\n"), /Unexpected error/);
    chmodSync(parent, 0o700);
    assert.equal(cli.store.get("api-key"), KEY, "nothing was lost");
  } finally {
    chmodSync(cli.dir, 0o700);
    cli.cleanup();
  }
});
