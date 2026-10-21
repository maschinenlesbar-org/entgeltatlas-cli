import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { renderJson } from "../src/cli/shared.js";
import { EntgeltatlasClient } from "@maschinenlesbar.org/entgeltatlas-client/internal/client";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "@maschinenlesbar.org/entgeltatlas-client/internal/http";
import { makeMockTransport, jsonResponse, rawResponse, queryOf, untimed } from "./helpers.js";
import * as fx from "@maschinenlesbar.org/entgeltatlas-client/test/fixtures";
import { EntgeltatlasNetworkError, credentialsIn } from "@maschinenlesbar.org/entgeltatlas-client/internal/errors";

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

test("a blank --api-key or --user-agent exits 2 before any request (does not cancel the env key)", async () => {
  for (const args of [["--api-key", ""], ["--api-key", "  "], ["--user-agent", ""], ["--user-agent", " "]]) {
    const cli = makeCli(() => jsonResponse(fx.entgelteResult), { ENTGELTATLAS_API_KEY: "envkey" });
    const code = await run([...args, "entgelte", "84304"], cli.deps);
    assert.equal(code, 2, args.join(" "));
    assert.equal(cli.mt.calls.length, 0, args.join(" "));
    assert.match(cli.err.join("\n"), /Expected a non-empty value/);
  }
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

test("a --base-url with a query, fragment or surrounding whitespace exits 2 before any request", async () => {
  for (const url of ["http://127.0.0.1:1/echo?token=abc", "http://127.0.0.1:1/echo#frag", "http://127.0.0.1:1/echo ", " http://127.0.0.1:1"]) {
    const cli = makeCli(() => jsonResponse(fx.entgelteResult));
    const code = await run([...KEY, "--base-url", url, "entgelte", "84304"], cli.deps);
    assert.equal(code, 2, url);
    assert.equal(cli.mt.calls.length, 0, url);
  }
  // A path prefix (a mirror) still works.
  const cli = makeCli(() => jsonResponse(fx.entgelteResult));
  assert.equal(await run([...KEY, "--base-url", "http://mirror.test/ba/", "entgelte", "84304"], cli.deps), 0);
  assert.equal(cli.mt.last().url, "http://mirror.test/ba/infosysbub/entgeltatlas/pc/v1/entgelte/84304");
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

test("bidi controls in server data are escaped in the JSON output, so they can't reorder the terminal", async () => {
  // A right-to-left override (U+202E) in a label reached the terminal raw and reordered the line on screen.
  const bidi = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];
  const entry = fx.entgelteResult[0]!;
  const served = [
    {
      ...entry,
      region: { ...entry.region, bezeichnung: `Deutschland${String.fromCharCode(0x202e)}dnalnetieW` },
      gender: { id: 1, bezeichnung: String.fromCharCode(...bidi) },
    },
  ];
  for (const format of [[], ["--compact"]]) {
    const cli = makeCli(() => jsonResponse(served));
    assert.equal(await run([...KEY, ...format, "entgelte", "84304"], cli.deps), 0);
    const text = cli.out.join("\n");
    assert.match(text, /Deutschland\\u202ednalnetieW/, format.join(" "));
    assert.deepEqual([...text].filter((c) => bidi.includes(c.charCodeAt(0))), [], format.join(" "));
    assert.deepEqual(JSON.parse(text), served);
  }
});

test("a refused connection names the request in its ERROR record and exits 6", async () => {
  const cli = makeCli(() => {
    throw new EntgeltatlasNetworkError("connect ECONNREFUSED 127.0.0.1:443");
  });
  const code = await run([...KEY, "regionen"], cli.deps);
  assert.equal(code, 6);
  assert.match(
    untimed(cli.err.join("\n")),
    /^ERROR \[entgeltatlas\.http\] GET https:\/\/rest\.arbeitsagentur\.de\/infosysbub\/entgeltatlas\/pc\/v1\/regionen failed: connect ECONNREFUSED 127\.0\.0\.1:443$/,
  );
  assert.deepEqual(cli.out, []);
});

test("a 403 exits 3 with a hint that names both a wrong key and a refused network", async () => {
  // The gateway answers a wrong key with the same one-space text/plain 403 as a WAF block.
  const cli = makeCli(() => rawResponse(" ", "text/plain", 403));
  const code = await run([...KEY, "entgelte", "84304"], cli.deps);
  assert.equal(code, 3);
  const err = cli.err.join("\n");
  assert.match(err, /the API rejected the request \(403\) with the key from --api-key\. Check it against `entgeltatlas obtain-key`/);
  assert.doesNotMatch(err, /config get api-key|ENTGELTATLAS_API_KEY/);
  assert.match(err, /looks the same for a wrong key, a stale one and a refused network \(WAF\/IP block\)/);
  assert.match(err, /UUID client_id the bundesAPI README still publishes is refused/);
  assert.doesNotMatch(err, /not a bad key/);
});

test("a 403 without any key says that no key was sent", async () => {
  const cli = makeCli(() => rawResponse(" ", "text/plain", 403));
  const code = await run(["entgelte", "84304"], cli.deps);
  assert.equal(code, 3);
  assert.match(untimed(cli.err.join("\n")), /^INFO  \[entgeltatlas\.api\] the API rejected the request \(403\) and no X-API-Key was sent\. Pass --api-key, set ENTGELTATLAS_API_KEY, or store it with `entgeltatlas config set api-key`/m);
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
  assert.match(cli.err.join("\n"), /GET https:\/\/rest\.arbeitsagentur\.de\/\S*entgelte\/84304: unexpected response shape: expected a JSON array of salary rows/);
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

test("header-invalid --api-key / --user-agent values exit 2 before any request", async () => {
  const cases: [string, string, RegExp][] = [
    ["--api-key", "ключ", /outside Latin-1/],
    ["--api-key", "abc\ndef", /control characters/],
    ["--user-agent", "x\r\nX-Evil: 1", /control characters/],
    ["--user-agent", "x" + String.fromCharCode(0x7f), /control characters/],
  ];
  for (const [flag, value, message] of cases) {
    const cli = makeCli(() => jsonResponse(fx.entgelteResult));
    const code = await run([flag, value, "entgelte", "84304"], cli.deps);
    assert.equal(code, 2, JSON.stringify(value));
    assert.equal(cli.mt.calls.length, 0);
    assert.match(cli.err.join("\n"), message);
  }
  // Tab and Latin-1 are fine in a User-Agent.
  const cli = makeCli(() => jsonResponse(fx.entgelteResult));
  assert.equal(await run([...KEY, "--user-agent", "Grüße\tbot", "entgelte", "84304"], cli.deps), 0);
});

test("a header-invalid ENTGELTATLAS_API_KEY is a usage error, not 'Unexpected error'", async () => {
  const cli = makeCli(() => jsonResponse(fx.entgelteResult), { ENTGELTATLAS_API_KEY: "abc\ndef" });
  const code = await run(["regionen"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
  // The env path names the variable to fix; the reason is the library's.
  assert.equal(untimed(cli.err.join("\n")), "ERROR [entgeltatlas.cli] Invalid ENTGELTATLAS_API_KEY: Value contains control characters.");
});

test("an answer nested too deeply is a clean error; it suggests --compact only where --compact prints it (D7)", async () => {
  // A hostile or broken answer: JSON.parse reads it, the pretty printer's recursion can't. Whether
  // the compact printer can depends on the Node version (iterative from Node 26) and the stack:
  // probed here, never assumed. Deep nesting inside an extra field of a valid observation (a bare
  // nested array is already a shape error): [{...row, "x":[[[...]]]}]
  const depth = 200_000;
  const row = JSON.stringify(fx.entgelteResult[0]);
  const body = "[" + row.slice(0, -1) + ',"x":' + "[".repeat(depth) + "]".repeat(depth) + "}]";
  let compactPrints = true;
  try {
    JSON.stringify(JSON.parse(body));
  } catch {
    compactPrints = false;
  }
  const deep = () => rawResponse(body, "application/json");
  const pretty = makeCli(deep);
  assert.equal(await run([...KEY, "entgelte", "84304"], pretty.deps), 1);
  assert.deepEqual(pretty.out, []);
  assert.equal(
    untimed(pretty.err.join("\n")),
    `ERROR [entgeltatlas.output] The answer is nested too deeply to pretty-print${compactPrints ? "; try --compact" : ""}.`,
  );
  const compact = makeCli(deep);
  assert.equal(await run([...KEY, "--compact", "entgelte", "84304"], compact.deps), compactPrints ? 0 : 1);
  if (compactPrints) assert.equal(compact.out.join("").length, body.length);
  else assert.equal(untimed(compact.err.join("\n")), "ERROR [entgeltatlas.output] The answer is nested too deeply to print.");
});

test("an answer too large to print is called too large, not too deep; the hint only where --compact prints (D7)", (t) => {
  const { deps } = makeCli(() => jsonResponse([]));
  const real = JSON.stringify;
  // V8's own error for a text past its longest string, stood in for: a real one needs 512 MB.
  const tooLarge = (gap: unknown): boolean => gap === 2 || gap === "big";
  t.mock.method(JSON, "stringify", (value: unknown, replacer: never, gap: unknown) => {
    if (tooLarge(gap) || (gap === undefined && (value as { all?: boolean }).all === true)) throw new RangeError("Invalid string length");
    return real(value, replacer, gap as number);
  });
  assert.throws(() => renderJson(deps, {}, { id: "a1" }), (err: Error) =>
    /^The answer is too large \(more than \d+ characters of JSON\) to pretty-print; try --compact\.$/.test(err.message));
  assert.throws(() => renderJson(deps, {}, { all: true }), (err: Error) =>
    /^The answer is too large \(more than \d+ characters of JSON\) to pretty-print\.$/.test(err.message));
  assert.throws(() => renderJson(deps, { compact: true }, { all: true }), (err: Error) =>
    /^The answer is too large \(more than \d+ characters of JSON\) to print\.$/.test(err.message));
});

test("--compact takes the gap path only for an answer holding a huge string, the fast path otherwise", (t) => {
  // On Node 26 V8's fast stringifier (no gap) aborts the process on a ~250 MB string that
  // JSON.parse made ("Zone Allocation failed", exit 134); the gap path prints it. Only the fast
  // path is iterative there, though, and prints nesting the gap path refuses at ~7,000 levels.
  // So the path is chosen per answer. Too big a body for this suite: this pins the calls.
  const { deps, out } = makeCli(() => jsonResponse([]));
  const stringify = t.mock.method(JSON, "stringify", () => '"stub"');
  const huge = "x".repeat(64 * 1024 * 1024);
  renderJson(deps, { compact: true }, { id: "a1", text: huge });
  renderJson(deps, { compact: true }, { id: "a1", x: [[["Rede"]]], text: huge.slice(1) });
  renderJson(deps, { compact: true }, { [huge]: 1 });
  renderJson(deps, { compact: true }, [[huge]]);
  renderJson(deps, {}, { id: "a1" });
  const calls = stringify.mock.calls.map((call) => call.arguments);
  stringify.mock.restore();
  assert.deepEqual(calls.map((args) => (args.length >= 3 ? args[2] : "none")), ["", "none", "", "", 2]);
  assert.deepEqual(out, ['"stub"', '"stub"', '"stub"', '"stub"', '"stub"']);
});

test("a dimension code outside the documented table exits 2 before any request", async () => {
  const cases: [string, string, string][] = [
    ["-l", "5", "Unknown --level code 5: valid codes are 1–4"],
    ["-l", "999999999999", "Unknown --level code 999999999999"],
    ["-r", "31", "Unknown --region code 31: valid codes are 1–30"],
    ["-g", "4", "Unknown --gender code 4: valid codes are 1–3"],
    ["-a", "5", "Unknown --age code 5: valid codes are 1–4"],
    ["-b", "12", "Unknown --branch code 12: valid codes are 1–11"],
  ];
  for (const [flag, value, message] of cases) {
    const cli = makeCli(() => jsonResponse(fx.entgelteResult));
    const code = await run([...KEY, "entgelte", "84304", flag, value], cli.deps);
    assert.equal(code, 2, `${flag} ${value}`);
    assert.equal(cli.mt.calls.length, 0);
    assert.ok(cli.err.join("\n").includes(message), cli.err.join("\n"));
  }
  const cli = makeCli(() => jsonResponse([]));
  const args = ["entgelte", "84304", "-l", "4", "-r", "30", "-g", "3", "-a", "4", "-b", "11"];
  assert.equal(await run([...KEY, ...args], cli.deps), 0);
  assert.equal(new URL(cli.mt.last().url).search, "?l=4&r=30&g=3&a=4&b=11");
});

test("--help states the --max-retries range and default", async () => {
  const cli = makeCli(() => jsonResponse([]));
  assert.equal(await run(["--help"], cli.deps), 0);
  assert.match(cli.out.join("\n").replace(/\s+/g, " "), /--max-retries <n> retries for transient 429\/503 responses \(0\.\.10, default 2;/);
});

test("P3: a key sent to a plain-http host other than loopback gets a warning", async () => {
  const remote = makeCli(() => jsonResponse(fx.regionen));
  assert.equal(await run(["--base-url", "http://mirror.example", ...KEY, "regionen"], remote.deps), 0);
  assert.match(untimed(remote.err.join("\n")), /^WARN  \[entgeltatlas\.http\] the API key is sent unencrypted to mirror\.example \(http:, not https:\)$/m);
  const loopback = makeCli(() => jsonResponse(fx.regionen));
  assert.equal(await run(["--base-url", "http://127.0.0.1:20230", ...KEY, "regionen"], loopback.deps), 0);
  assert.deepEqual(loopback.err, []);
});

test("P10: a repeated dimension flag is a usage error naming the flag, before any request", async () => {
  const cli = makeCli(() => jsonResponse([]));
  assert.equal(await run([...KEY, "entgelte", "84304", "-g", "2", "-g", "3"], cli.deps), 2);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /option '-g, --gender <code>' was given more than once; it takes one value \(run one call per slice\)/);
});

test("02#1: entgelte prints nothing and exits 1 when the API answers another slice", async () => {
  const cli = makeCli(() => jsonResponse(fx.entgelteResult)); // always Deutschland / Gesamt
  assert.equal(await run([...KEY, "--compact", "entgelte", "84304", "-l", "4", "-r", "11", "-g", "3"], cli.deps), 1);
  assert.deepEqual(cli.out, []);
  // A malformed answer, the API's: a record of entgeltatlas.api (fix plan 2026-10-09, L9).
  assert.match(untimed(cli.err.join("\n")), /^ERROR \[entgeltatlas\.api\] GET https:\/\/rest\.arbeitsagentur\.de\/\S+: the API answered another slice than the one requested/m);
});

test("a rejected --api-key holding DEL or a bidi control is masked in jsonl as in text (result 04 d19, C6)", async () => {
  for (const key of ["my secret\u007fkey-Value99", "Abc\u2066SecretValue99", "MyS3cretKey\u202eTail"]) {
    for (const format of ["text", "jsonl"]) {
      const cli = makeCli(() => jsonResponse(fx.regionen));
      assert.equal(await run(["--log-format", format, "--api-key", key, "regionen"], cli.deps), 2, `${format} ${JSON.stringify(key)}`);
      const all = cli.err.join("\n");
      assert.match(all, /\*\*\*/, `${format}: ${all}`);
      assert.doesNotMatch(all, /Value99|S3cretKey|SecretValue/, `${format}: ${all}`);
    }
  }
});

test("an a:b@c argument (here a User-Agent) is neither a credential in the log nor rewritten in the JSON on stdout (L14)", async () => {
  const cli = makeCli(() => jsonResponse([{ id: 1, bezeichnung: "run:2026-10-09@x" }]));
  assert.equal(await run([...KEY, "--user-agent", "run:2026-10-09@x", "regionen"], cli.deps), 0);
  assert.match(cli.out.join("\n"), /"bezeichnung": "run:2026-10-09@x"/);
  assert.deepEqual(credentialsIn("run:2026-10-09@x"), []);
  assert.deepEqual(credentialsIn("https://alice:pw@host"), ["alice:pw"]);
});

test("a command group without its subcommand, or no command at all, logs an ERROR before the help (L5)", async () => {
  for (const argv of [["config"], ["--log-format", "text"]]) {
    const cli = makeCli(() => jsonResponse(fx.regionen));
    assert.equal(await run(argv, cli.deps), 2, argv.join(" "));
    const records = cli.err.map(untimed);
    assert.match(records[0] ?? "", /^ERROR \[entgeltatlas\.cli\] missing command: `entgeltatlas( config)? <subcommand>`$/, records.join("\n"));
    assert.ok(records.slice(1).every((line) => /^INFO  \[entgeltatlas\.cli\] .*\S/.test(line)), records.join("\n"));
  }
});

test("a parse error is logged in the format commander would have parsed: the first --log-format, an option's value skipped", async () => {
  // --user-agent takes "--log-format" as its value; "jsonl" is then an unknown command, logged in text.
  const ua = makeCli(() => jsonResponse(fx.regionen));
  assert.equal(await run(["--user-agent", "--log-format", "jsonl", "regionen"], ua.deps), 2);
  assert.match(ua.err[0] ?? "", /^\S+ ERROR \[entgeltatlas\.cli\] unknown command 'jsonl'/);
  // A repeated --log-format is refused; the refusal is in the first one's format.
  const twice = makeCli(() => jsonResponse(fx.regionen));
  assert.equal(await run(["--log-format", "jsonl", "--log-format", "text", "regionen"], twice.deps), 2);
  const record = JSON.parse(twice.err[0] ?? "") as Record<string, unknown>;
  assert.equal(record["topic"], "entgeltatlas.cli");
  assert.match(record["msg"] as string, /--log-format <format>' was given more than once/);
});

test("a subcommand's value option does not swallow the program's --log-format, in a parse error too (L6)", async () => {
  // commander takes the program's --log-format out of argv first; --level is left without its value.
  const cli = makeCli(() => jsonResponse(fx.regionen));
  assert.equal(await run(["entgelte", "84304", "--level", "--log-format", "jsonl"], cli.deps), 2);
  assert.ok(cli.err.length > 0 && cli.err.every((line) => line.startsWith("{")), cli.err.join("\n"));
  assert.match((JSON.parse(cli.err[0] ?? "") as Record<string, unknown>)["msg"] as string, /--level <code>' argument missing/);
});

test("a key with whitespace inside is a usage error from the flag and from the env var (bug 1, 2026-10-15)", async () => {
  // A tab or space inside a pasted key went out as `X-API-Key: infosys\tbub-ega` and ended in the
  // empty 403 that looks like a network block; the credentials file already refused it.
  for (const [argv, env, name] of [
    [["--api-key", "infosys\tbub-ega", "entgelte", "84304"], {}, /option '--api-key <key>'/],
    [["--api-key", "infosys bub-ega", "entgelte", "84304"], {}, /option '--api-key <key>'/],
    [["entgelte", "84304"], { ENTGELTATLAS_API_KEY: "infosys\tbub-ega" }, /Invalid ENTGELTATLAS_API_KEY/],
  ] as const) {
    const cli = makeCli(() => jsonResponse(fx.entgelteResult), { ...env });
    assert.equal(await run([...argv], cli.deps), 2, JSON.stringify(argv));
    assert.equal(cli.mt.calls.length, 0, "nothing is sent");
    const text = untimed(cli.err.join("\n"));
    assert.match(text, name);
    assert.match(text, /a key is one token/);
    assert.doesNotMatch(text, /bub-ega/, "the key is never repeated");
  }
});

test("--api-key followed by a command name says the key is missing, and the help stays readable (bug 2, 2026-10-15)", async () => {
  // `entgeltatlas --api-key $KEY entgelte 84304` with an empty, unquoted variable took `entgelte` as
  // the key: "unknown command (not shown …)", and the help showed *** for `entgelte`.
  for (const argv of [["--api-key", "entgelte", "84304"], ["--api-key", "regionen"], ["--api-key=codes"]]) {
    const cli = makeCli(() => jsonResponse(fx.entgelteResult));
    assert.equal(await run(argv, cli.deps), 2, argv.join(" "));
    assert.equal(cli.mt.calls.length, 0);
    const text = untimed(cli.err.join("\n"));
    const name = argv[0] === "--api-key" ? argv[1]! : argv[0]!.slice("--api-key=".length);
    assert.match(text, new RegExp(`^ERROR \\[entgeltatlas\\.cli\\] .*"${name}" is an entgeltatlas command, not a key`, "m"));
    assert.doesNotMatch(text, /\*\*\*/, "the command name is not redacted");
    assert.doesNotMatch(text, /unknown command/);
  }
});

test("COMMAND_NAMES lists exactly the program's commands", async () => {
  const { COMMAND_NAMES } = await import("../src/cli/shared.js");
  const { buildProgram } = await import("../src/cli/program.js");
  const program = buildProgram(makeCli(() => jsonResponse([])).deps);
  assert.deepEqual([...COMMAND_NAMES].sort(), [...program.commands.map((c) => c.name()), "help"].sort());
});

test("an empty answer for a 4-digit KldB code is explained in a WARN record (bug 3, 2026-10-15)", async () => {
  // 8430, 4341 and 8431 answered [] with exit 0 and nothing on stderr — what README reads as "no
  // figure" — while their 3-digit groups and 5-digit codes have data.
  const empty = makeCli(() => jsonResponse([]));
  assert.equal(await run([...KEY, "--compact", "entgelte", "8430"], empty.deps), 0);
  assert.deepEqual(empty.out, ["[]"], "stdout is unchanged");
  assert.equal(
    untimed(empty.err.join("\n")),
    "WARN  [entgeltatlas.api] no rows for the 4-digit KldB code 8430: the API has answered every 4-digit code tried " +
      "with none, though the 3-digit group (843) and the 5-digit codes (8430x) have figures. Ask for one of those.",
  );
  // A 3- or 5-digit code without rows, and a 4-digit code with rows, get no such note.
  // (A row carries the code it answers, as the 3- and 5-digit answers do live.)
  for (const [code, rows] of [["843", []], ["84304", []], ["8430", fx.entgelteResult.map((r) => ({ ...r, kldb: "8430" }))]] as const) {
    const cli = makeCli(() => jsonResponse(rows));
    assert.equal(await run([...KEY, "entgelte", code], cli.deps), 0);
    assert.deepEqual(cli.err, [], code);
  }
});

test("terminal controls are escaped in chunks: the same text as one pass, across chunk edges (D7)", () => {
  const DEL = String.fromCharCode(0x7f);
  const C1 = String.fromCharCode(0x9b);
  const RLO = String.fromCharCode(0x202e);
  // Controls right before, at and after the 64 Ki edges, and a run of them.
  const text = ["a".repeat(65535), DEL, C1, "b".repeat(65534), RLO, DEL.repeat(70000), "ü😀", C1].join("");
  const { deps, out } = makeCli(() => jsonResponse([]));
  renderJson(deps, { compact: true }, { text });
  const expected = JSON.stringify({ text }).replace(/[\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
  assert.equal(out[0], expected);
  assert.deepEqual(JSON.parse(out[0]!), { text });
});

test("02 Bug 5: entgelte prints nothing and exits 1 when a row is of another occupation", async () => {
  const cli = makeCli(() => jsonResponse([{ ...fx.entgelteResult[0]!, kldb: "99999" }]));
  assert.equal(await run([...KEY, "--compact", "entgelte", "84304", "-l", "4", "-r", "1", "-g", "1", "-a", "1", "-b", "1"], cli.deps), 1);
  assert.deepEqual(cli.out, []);
  assert.match(untimed(cli.err.join("\n")), /^ERROR \[entgeltatlas\.api\] GET \S+: the API answered another slice than the one requested: kldb 84304 was asked for, but row 0 has kldb "99999"/m);
});

test("01 Bug 1: an empty answer for Ost (-r 2) or West (-r 3) says the API has no rows for them, not 'suppressed'", async () => {
  for (const [r, label] of [["2", "Ostdeutschland"], ["3", "Westdeutschland"]] as const) {
    const cli = makeCli(() => jsonResponse([]));
    assert.equal(await run([...KEY, "--compact", "entgelte", "71402", "-r", r, "-g", "1", "-a", "1", "-b", "1"], cli.deps), 0);
    assert.deepEqual(cli.out, ["[]"], "stdout is unchanged");
    assert.equal(
      untimed(cli.err.join("\n")),
      `WARN  [entgeltatlas.api] no rows for region ${r} (${label}): the API has answered every request for ` +
        "Ostdeutschland (2) and Westdeutschland (3) with none, and leaves both out of an answer for all regions; " +
        "this is not a suppressed figure. Compare Länder (4–19) or cities (20–30) instead.",
    );
  }
  // Rows for them, or another region without rows: no such note.
  const rows = makeCli(() => jsonResponse(fx.entgelteResult.map((row) => ({ ...row, region: { ...row.region, id: 2, bezeichnung: "Ostdeutschland" } }))));
  assert.equal(await run([...KEY, "entgelte", "84304", "-r", "2"], rows.deps), 0);
  assert.deepEqual(rows.err, []);
  const other = makeCli(() => jsonResponse([]));
  assert.equal(await run([...KEY, "entgelte", "84304", "-r", "17"], other.deps), 0);
  assert.deepEqual(other.err, []);
});

test("01 Bug 2: an empty answer the request explains (a contradicting level, a branch by gender) gets a WARN note", async () => {
  const level = makeCli(() => jsonResponse([]));
  assert.equal(await run([...KEY, "--compact", "entgelte", "84304", "-l", "2", "-r", "1", "-g", "1", "-a", "1", "-b", "1"], level.deps), 0);
  assert.deepEqual(level.out, ["[]"]);
  assert.match(untimed(level.err.join("\n")), /^WARN  \[entgeltatlas\.api\] no rows for KldB 84304 at level 2 \(Fachkraft\): the fifth digit/);
  const branch = makeCli(() => jsonResponse([]));
  assert.equal(await run([...KEY, "--compact", "entgelte", "84304", "-l", "4", "-r", "1", "-g", "2", "-a", "1", "-b", "5"], branch.deps), 0);
  assert.match(untimed(branch.err.join("\n")), /^WARN  \[entgeltatlas\.api\] no rows for branch 5 with gender 2 and age Gesamt: /);
});
