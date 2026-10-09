// `entgeltatlas config` and the credentials file: the API key kept apart from argv and
// the environment, the same mechanism as openka-cli's `ka config`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { run } from "../src/cli/run.js";
import { EntgeltatlasClient } from "../src/client/client.js";
import { EntgeltatlasError } from "../src/client/errors.js";
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

test("a 403 hint names the source of the rejected key: the credentials file, the env var or the flag (02-1)", async () => {
  const cli = makeCli({ status: 403 });
  try {
    cli.store.set("api-key", KEY);
    assert.equal(await run(["entgelte", "84304"], cli.deps), 3);
    const hint = untimed(cli.err.join("\n"));
    assert.match(hint, /INFO  \[entgeltatlas\.api\] the API rejected the request \(403\) with the API key stored in .*credentials\./);
    assert.match(hint, /`entgeltatlas obtain-key \| entgeltatlas config set api-key` stores the current one/);
    assert.doesNotMatch(hint, /no X-API-Key was sent/);
    // With a key in ENTGELTATLAS_API_KEY too, that one was sent: the hint names it, not the file (02-1).
    cli.err.length = 0;
    assert.equal(await run(["entgelte", "84304"], { ...cli.deps, env: { ENTGELTATLAS_API_KEY: "envkey-1234567" } }), 3);
    assert.equal(cli.mt.last().headers?.["X-API-Key"], "envkey-1234567");
    assert.match(cli.err.join("\n"), /with the key from the ENTGELTATLAS_API_KEY env var\./);
    assert.doesNotMatch(cli.err.join("\n"), /stored|config get/);
    // And a key from the flag: the hint names the flag.
    cli.err.length = 0;
    assert.equal(await run(["--api-key", "flagkey-1234567", "entgelte", "84304"], { ...cli.deps, env: { ENTGELTATLAS_API_KEY: "envkey-1234567" } }), 3);
    assert.match(cli.err.join("\n"), /with the key from --api-key\./);
    assert.doesNotMatch(cli.err.join("\n"), /stored|ENTGELTATLAS_API_KEY/);
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
    assert.match(cli.err.join("\n"), /The api-key stored in .*credentials cannot be used/);
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

/** Write the credentials file by hand, as a user editing it would. */
function handEdit(store: CredentialStore, content: Record<string, string>): void {
  mkdirSync(join(store.path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(store.path, JSON.stringify(content), { mode: 0o600 });
}

test("a hand-edited value config set would refuse is refused on read, naming the file (01-2, 05-1)", async () => {
  for (const value of ["", "   ", "abc\u001b[31mRED-ghijklmnop", "abcdefg\rhijklmn", "ab\tcdefghijklm", "abc def ghi jkl", "AbCdEfG.euro€-abcdefghijkl"]) {
    const cli = makeCli();
    try {
      handEdit(cli.store, { "api-key": value });
      const label = JSON.stringify(value);
      // A request: no key sent, no "the API key is sent" warning, no usage error.
      assert.equal(await run(["--base-url", "http://192.0.2.10", "entgelte", "84304"], cli.deps), 1, label);
      assert.equal(cli.mt.calls.length, 0, `${label}: no request`);
      const err = untimed(cli.err.join("\n"));
      assert.match(err, /ERROR \[entgeltatlas\.cli\] The api-key stored in .*credentials cannot be used: .* entgeltatlas config set api-key replaces it\./, label);
      assert.doesNotMatch(err, /Invalid apiKey|sent unencrypted/, label);
      // config get and config list: the same refusal, nothing raw on stdout — so the skills'
      // check (`config get api-key` exits 0) means a usable key is stored.
      for (const argv of [["config", "get", "api-key"], ["config", "get", "api-key", "--reveal"], ["config", "list"]]) {
        cli.out.length = 0;
        assert.equal(await run(argv, cli.deps), 1, `${label} ${argv.join(" ")}`);
        assert.deepEqual(cli.out, [], `${label} ${argv.join(" ")}`);
      }
      // set and unset still repair it.
      assert.equal(await run(["config", "unset", "api-key"], cli.deps), 0, label);
    } finally {
      cli.cleanup();
    }
  }
});

test("a hand-edited value with surrounding spaces is used trimmed", async () => {
  const cli = makeCli();
  try {
    handEdit(cli.store, { "api-key": `  ${KEY}  ` });
    assert.equal(await run(["entgelte", "84304"], cli.deps), 0);
    assert.equal(cli.mt.last().headers?.["X-API-Key"], KEY);
  } finally {
    cli.cleanup();
  }
});

test("config list refuses a hand-edited name that is not a credential name", async () => {
  const cli = makeCli();
  try {
    handEdit(cli.store, { "api-key": KEY, "x\u001b[31m": "abcdefghijklmnop" });
    assert.equal(await run(["config", "list"], cli.deps), 1);
    assert.deepEqual(cli.out, []);
    assert.match(cli.err.join("\n"), /holds "x\\u001b\[31m", which is not a credential name/);
  } finally {
    cli.cleanup();
  }
});

test("config list refuses a hand-edited value with control characters under any name (01-2)", async () => {
  const cli = makeCli();
  try {
    handEdit(cli.store, { "api-key": KEY, zzz: "\u001b]0;pwned\u0007tail" });
    assert.equal(await run(["config", "list"], cli.deps), 1);
    assert.deepEqual(cli.out, []);
    assert.ok(!cli.err.join("\n").includes("\u001b"), "nothing raw on stderr");
  } finally {
    cli.cleanup();
  }
});

test("maskCredential: a key shows its ends only from 20 characters, a password never (C7)", () => {
  assert.equal(maskCredential("Somm3r2026!x"), "****");
  assert.equal(maskCredential("a".repeat(19)), "****");
  assert.equal(maskCredential("infosysbub-ega", "api-key"), "****", "the published key is 14 characters");
  assert.equal(maskCredential("abcd0123456789ab wxyz".replace(" ", "")), "abcd…wxyz");
  assert.equal(maskCredential(KEY, "api-key"), MASKED);
  assert.equal(maskCredential("a-very-long-password-of-40-characters!!!", "password"), "****");
});

test("a key typed in place of the name is never echoed, by any config command (C2)", async () => {
  const cli = makeCli({ secret: KEY });
  try {
    const typed = "abcSECRET-personal-key-123";
    for (const argv of [
      ["config", "set", typed],
      ["config", "get", typed],
      ["config", "get", typed, "--reveal"],
      ["config", "unset", typed],
      ["config", "get", "api-key", typed],
      ["config", "unset", "api-key", typed],
      ["config", "list", typed],
      ["--log-format", "jsonl", "config", "set", typed],
    ]) {
      cli.err.length = 0;
      assert.equal(await run(argv, cli.deps), 2, argv.join(" "));
      const err = cli.err.join("\n");
      assert.ok(!err.includes("SECRET"), `${argv.join(" ")}:\n${err}`);
      assert.match(err, /ERROR.*entgeltatlas\.cli/, argv.join(" "));
    }
    cli.err.length = 0;
    assert.equal(await run(["config", "get", typed], cli.deps), 2);
    assert.match(cli.err.join("\n"), /Not a credential name this program knows: expected api-key\./);
  } finally {
    cli.cleanup();
  }
});

test("an unknown option to a config command is refused without repeating it (C2, result 01 a23)", async () => {
  const cli = makeCli({ secret: KEY });
  try {
    for (const argv of [
      ["config", "set", "api-key", "--value=topSECRETvalue99"],
      ["config", "set", "--value=topSECRETvalue99", "api-key"],
      ["config", "get", "api-key", "--value=topSECRETvalue99"],
      ["config", "unset", "api-key", "--value=topSECRETvalue99"],
      ["config", "list", "--value=topSECRETvalue99"],
    ]) {
      cli.err.length = 0;
      assert.equal(await run(argv, cli.deps), 2, argv.join(" "));
      const err = cli.err.join("\n");
      assert.ok(!err.includes("SECRET"), `${argv.join(" ")}:\n${err}`);
      assert.match(err, /ERROR.*entgeltatlas\.cli/, argv.join(" "));
    }
    assert.equal(cli.store.get("api-key"), undefined, "nothing was stored");
  } finally {
    cli.cleanup();
  }
});

test("config set refuses a key given with --api-key instead of silently storing stdin (01-1)", async () => {
  const flagKey = "flagvalue12345-abcdefgh";
  for (const argv of [
    ["config", "set", "api-key", "--api-key", flagKey],
    ["--api-key", flagKey, "config", "set", "api-key"],
    ["config", "set", "api-key", `--api-key=${flagKey}`],
  ]) {
    const cli = makeCli({ secret: "stdinvalue12345-abcdefgh" });
    try {
      assert.equal(await run(argv, cli.deps), 2, argv.join(" "));
      assert.equal(cli.store.get("api-key"), undefined, `${argv.join(" ")}: nothing stored`);
      const err = cli.err.join("\n");
      assert.match(err, /takes the name only.*--api-key is not read here.*shell history/, argv.join(" "));
      assert.ok(!err.includes(flagKey), "the flag's value is not repeated");
    } finally {
      cli.cleanup();
    }
  }
  // ENTGELTATLAS_API_KEY is not a value given on the command line: config set reads stdin as before.
  const env = makeCli({ secret: KEY, env: { ENTGELTATLAS_API_KEY: "envkey-1234567" } });
  try {
    assert.equal(await run(["config", "set", "api-key"], env.deps), 0);
    assert.equal(env.store.get("api-key"), KEY);
  } finally {
    env.cleanup();
  }
});

test("a secret read from stdin stops at 64 KiB and is refused, an endless input included (C3)", async () => {
  await assert.rejects(readSecretFrom(Readable.from([Buffer.alloc(70 * 1024, "a")]), { write: () => true }, "api-key: "), /longer than 64 KiB; nothing was stored/);
  let chunks = 0;
  async function* zero() {
    for (;;) {
      chunks++;
      yield Buffer.alloc(16 * 1024);
    }
  }
  await assert.rejects(readSecretFrom(Readable.from(zero()), { write: () => true }, "api-key: "), /longer than 64 KiB/);
  assert.ok(chunks < 10, `read ${chunks} chunks`);
  const exact = "a".repeat(64 * 1024);
  assert.equal(await readSecretFrom(Readable.from([exact + "\n"]), { write: () => true }, "api-key: "), exact);
});

/** A terminal as far as readSecretFrom needs one: raw mode, data events. */
class FakeTty extends EventEmitter {
  readonly isTTY = true;
  raw = false;
  setRawMode(on: boolean): this {
    this.raw = on;
    return this;
  }
  resume(): this {
    return this;
  }
  pause(): this {
    return this;
  }
}

/** What the prompt returns for keystrokes arriving in `reads` (one data event each). */
async function typed(...reads: string[]): Promise<string> {
  const tty = new FakeTty();
  const result = readSecretFrom(tty as unknown as NodeJS.ReadStream, { write: () => true }, "api-key: ");
  for (const read of reads) tty.emit("data", Buffer.from(read));
  return result;
}

test("the prompt drops escape sequences and keeps what was typed (C1)", async () => {
  assert.equal(await typed("abc\u001b[A\u001b[Ddef\r"), "abcdef", "arrow keys");
  assert.equal(await typed("\u001bOAabc\r"), "abc", "SS3");
  assert.equal(await typed("\u001b[200~infosysbub-ega\u001b[201~\r"), "infosysbub-ega", "bracketed paste");
  assert.equal(await typed("\u001b[1;5Cabc\r"), "abc", "a CSI with parameters");
  assert.equal(await typed("abc\u001b", "[Adef\r"), "abcdef", "a sequence split across reads");
  assert.equal(await typed("abcdefgh\u001b[Dijklmnop\r"), "abcdefghijklmnop", "the report's arrow key");
  assert.equal(await typed("abcd\u007f\r"), "abc", "Backspace");
  assert.equal(await typed("key\r\n"), "key", "CR LF is one line break");
  // A tab is kept, so config set refuses it like the same value from a pipe.
  assert.equal(await typed("abc\tdef\r"), "abc\tdef");
  await assert.rejects(typed("abc\u0003"), /Interrupted; nothing was stored/);
});

test("the prompt refuses a paste with more after its first line break (C1)", async () => {
  for (const read of ["key\nsecondline\n", "key\rsecondline\r", "key\r\nmore", "first-half-1234\nsecond-half-5678\r"]) {
    await assert.rejects(typed(read), /The value holds a line break; nothing was stored\./, JSON.stringify(read));
  }
});

test("set and unset take credentials.lock: a held lock fails after 2 s, a stale one is taken over (C8)", () => {
  const dir = mkdtempSync(join(tmpdir(), "entgeltatlas-lock-"));
  try {
    let clock = 1_000_000;
    const waits: number[] = [];
    const options = { now: () => clock, sleep: (ms: number) => { waits.push(ms); clock += ms; } };
    const path = join(dir, "entgeltatlas", "credentials");
    const store = new CredentialStore(path, options);
    store.set("api-key", KEY);
    assert.equal(existsSync(`${path}.lock`), false, "the lock is released");

    // Another writer holds the lock: retried for 2 s, then refused, nothing changed.
    writeFileSync(`${path}.lock`, "4242");
    utimesSync(`${path}.lock`, clock / 1000, clock / 1000);
    assert.throws(() => store.set("api-key", "other-key-abcdefghijklmnopqrstuvwxyz"), /Another entgeltatlas config is writing .*credentials; try again\./);
    assert.ok(waits.length > 1 && waits.reduce((a, b) => a + b, 0) >= 2000, `waited ${waits.join(",")}`);
    assert.throws(() => store.unset("api-key"), /Another entgeltatlas config is writing/);
    assert.equal(store.get("api-key"), KEY);

    // A lock older than 30 s is left over from a crash: taken over.
    clock += 31_000;
    store.set("api-key", "other-key-abcdefghijklmnopqrstuvwxyz");
    assert.equal(store.get("api-key"), "other-key-abcdefghijklmnopqrstuvwxyz");
    assert.equal(existsSync(`${path}.lock`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a held lock fails config set with exit 1 and the stored value kept (C8)", async () => {
  const cli = makeCli({ secret: "other-key-abcdefghijklmnopqrstuvwxyz" });
  try {
    cli.store.set("api-key", KEY);
    writeFileSync(`${cli.store.path}.lock`, "4242");
    const store = new CredentialStore(cli.store.path, { sleep: () => undefined, now: (() => { let t = Date.now(); return () => (t += 500); })() });
    assert.equal(await run(["config", "set", "api-key"], { ...cli.deps, credentials: () => store }), 1);
    assert.match(cli.err.join("\n"), /ERROR \[entgeltatlas\.cli\] Another entgeltatlas config is writing/);
    assert.equal(cli.store.get("api-key"), KEY);
  } finally {
    cli.cleanup();
  }
});

test("the stored key is a secret of the run the moment it is read: no record shows it (C5)", async () => {
  const personal = "personal-key-of-another-shape-0123";
  const cli = makeCli();
  try {
    cli.store.set("api-key", personal);
    for (const format of ["text", "jsonl"]) {
      cli.err.length = 0;
      // Whatever path the key takes to a message — here a client that quotes it.
      const deps: CliDeps = { ...cli.deps, createClient: (opts) => { throw new EntgeltatlasError(`could not use ${String(opts.apiKey)}`); } };
      assert.equal(await run(["--log-format", format, "regionen"], deps), 1);
      assert.match(cli.err.join("\n"), /could not use \*\*\*/, format);
      assert.ok(!cli.err.join("\n").includes("personal-key"), `${format}: ${cli.err.join("\n")}`);
    }
  } finally {
    cli.cleanup();
  }
});
