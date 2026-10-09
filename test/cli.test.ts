import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { EntgeltatlasClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { makeMockTransport, jsonResponse, rawResponse, queryOf, untimed } from "./helpers.js";
import * as fx from "./fixtures.js";
import { credentialsIn } from "../src/client/errors.js";

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
  assert.match(cli.err.join("\n"), /Unexpected response shape from .*expected a JSON array of salary rows/);
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

test("a deeply nested response fails pretty-printing cleanly and still prints with --compact", async () => {
  // Deep nesting inside an extra field of a valid observation (a bare nested array is
  // already a shape error): [{...row, "x":[[[...]]]}]
  const depth = 200_000;
  const row = JSON.stringify(fx.entgelteResult[0]);
  const body = "[" + row.slice(0, -1) + ',"x":' + "[".repeat(depth) + "]".repeat(depth) + "}]";
  const deep = () => rawResponse(body, "application/json");
  const pretty = makeCli(deep);
  assert.equal(await run([...KEY, "entgelte", "84304"], pretty.deps), 1);
  assert.deepEqual(pretty.out, []);
  assert.equal(untimed(pretty.err.join("\n")), "ERROR [entgeltatlas.cli] The response is nested too deeply to pretty-print; try --compact.");

  // Compact serialisation goes much deeper (it prints this one on current Node);
  // should a runtime's stack still be too small, it must fail just as cleanly.
  const compact = makeCli(deep);
  const code = await run([...KEY, "--compact", "entgelte", "84304"], compact.deps);
  if (code === 0) assert.equal(compact.out.join("").length, body.length);
  else assert.equal(untimed(compact.err.join("\n")), "ERROR [entgeltatlas.cli] The response is nested too deeply to print.");
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
  assert.match(untimed(cli.err.join("\n")), /^ERROR \[entgeltatlas\.cli\] The API answered another slice than the one requested/m);
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
