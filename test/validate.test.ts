import { test } from "node:test";
import assert from "node:assert/strict";
import { assertValid, type Problem } from "../src/client/validate.js";
import { EntgeltatlasError, EntgeltatlasValidationError } from "../src/client/errors.js";
import * as lib from "../src/index.js";
import { run } from "../src/cli/run.js";
import type { EntgeltatlasClient } from "../src/client/client.js";
import { parity, untimed } from "./helpers.js";

const notBlank: Problem = (v) => (v.trim() === "" ? "Expected a non-empty value." : undefined);

test("assertValid returns a valid value unchanged", () => {
  assert.equal(assertValid("kldb", "84304", notBlank), "84304");
});

test("assertValid throws EntgeltatlasValidationError naming the input and the reason", () => {
  assert.throws(
    () => assertValid("kldb", " ", notBlank),
    (err) =>
      err instanceof EntgeltatlasValidationError &&
      err instanceof EntgeltatlasError &&
      err.message === "Invalid kldb: Expected a non-empty value.",
  );
});

test("the validation layer is exported from the package root", () => {
  assert.equal(lib.assertValid, assertValid);
  assert.equal(lib.EntgeltatlasValidationError, EntgeltatlasValidationError);
});

test("run() maps an EntgeltatlasValidationError from an action to exit 2 with an ERROR record", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const fake = {
    regionen: async () => assertValid("kldb", " ", notBlank),
  } as unknown as EntgeltatlasClient;
  const code = await run(["regionen"], {
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    createClient: () => fake,
    env: {},
  });
  assert.equal(code, 2);
  assert.deepEqual(err.map(untimed), ["ERROR [entgeltatlas.cli] Invalid kldb: Expected a non-empty value."]);
  assert.deepEqual(out, []);
});

test("parity() drives the same input through the CLI and the library on one transport", async () => {
  const { cli, lib: l } = await parity(
    ["--api-key", "k", "entgelte", "84304", "--region", "11"],
    (transport) => new lib.EntgeltatlasClient({ transport, apiKey: "k" }).entgelte("84304", { r: 11 }),
  );
  assert.equal(cli.code, 0);
  assert.equal(l.ok, true);
  assert.equal(cli.requests.length, 1);
  assert.deepEqual(l.requests, cli.requests);
});

test("dimensionCodeProblem accepts exactly the codes of each table", () => {
  for (const d of lib.DIMENSIONS) {
    const problem = lib.dimensionCodeProblem(d.param);
    for (const { id } of d.values) assert.equal(problem(id), undefined, `${d.param} ${id}`);
  }
  const r = lib.dimensionCodeProblem("r");
  assert.equal(r(31), "Unknown code 31: valid codes are 1–30.");
  assert.equal(r(0), "Expected a positive integer (codes start at 1).");
  for (const bad of [NaN, Infinity, 1.5, -1, "2" as unknown as number]) {
    assert.equal(r(bad), "Expected a positive integer (codes start at 1).", String(bad));
  }
});

test("dimensionCodeProblem names the CLI flag and adds a hint when asked", () => {
  const problem = lib.dimensionCodeProblem("b", { label: "--branch", hint: "see `entgeltatlas codes`" });
  assert.equal(problem(12), "Unknown --branch code 12: valid codes are 1–11 (see `entgeltatlas codes`).");
});

test("intRangeProblem accepts safe integers in range, with the CLI's messages", () => {
  const p = lib.intRangeProblem(0, 10);
  assert.equal(p(0), undefined);
  assert.equal(p(10), undefined);
  assert.equal(p(-1), "Must be >= 0.");
  assert.equal(p(11), "Must be <= 10.");
  for (const bad of [NaN, Infinity, 1.5, "2" as unknown as number]) {
    assert.equal(p(bad), "Expected an integer from 0 to 10.", String(bad));
  }
});

test("the engine checks every numeric option, and 0 keeps its meaning", () => {
  assert.equal(lib.MAX_RETRIES, 10);
  assert.equal(lib.MAX_REDIRECTS, 10);
  const bad: lib.EngineOptions[] = [
    { retryDelayMs: -1 },
    { retryDelayMs: NaN },
    { maxRedirects: 11 },
    { maxRedirects: NaN },
    { maxRetries: -1 },
  ];
  for (const options of bad) {
    assert.throws(() => new lib.RequestEngine(options), EntgeltatlasValidationError, JSON.stringify(options));
  }
  assert.throws(
    () => new lib.RequestEngine({ timeoutMs: -1 }),
    (err) => err instanceof EntgeltatlasValidationError && err.message === "Invalid timeoutMs: Must be >= 0.",
  );
  new lib.RequestEngine({ timeoutMs: 0, maxRetries: 0, retryDelayMs: 0, maxRedirects: 0, maxResponseBytes: 0 });
});

test("headerValueProblem: blank, control characters and non-Latin-1 are invalid; tab and Latin-1 are fine", () => {
  const p = lib.headerValueProblem;
  assert.equal(p("Grüße\tbot"), undefined);
  assert.equal(p(""), "Expected a non-empty value.");
  assert.equal(p("  "), "Expected a non-empty value.");
  assert.equal(p("a\r\nb"), "Value contains control characters.");
  assert.equal(p("a" + String.fromCharCode(0x7f)), "Value contains control characters.");
  assert.equal(p("Bot €"), "Value contains characters outside Latin-1 (above U+00FF).");
  assert.equal(p(42 as unknown as string), "Expected a string, got number.");
});

test("the engine checks userAgent and every defaultHeaders name and value", () => {
  assert.throws(
    () => new lib.RequestEngine({ userAgent: "a\nb" }),
    (err) =>
      err instanceof EntgeltatlasValidationError &&
      err.message === "Invalid userAgent: Value contains control characters.",
  );
  assert.throws(() => new lib.RequestEngine({ defaultHeaders: { "X-A": "a\r\nb" } }), EntgeltatlasValidationError);
  assert.throws(() => new lib.RequestEngine({ defaultHeaders: { "Bad Name": "v" } }), EntgeltatlasValidationError);
  assert.equal(lib.assertHeaderValue("userAgent", "ok"), "ok");
});

test("baseUrlWhitespaceProblem rejects surrounding whitespace only", () => {
  const p = lib.baseUrlWhitespaceProblem;
  assert.equal(p("https://h.example/x"), undefined);
  for (const bad of [" https://h", "https://h ", "\thttps://h", "https://h\n", "https://h/ "]) {
    assert.equal(p(bad), "A base URL cannot have surrounding whitespace.", JSON.stringify(bad));
  }
  assert.throws(
    () => new lib.RequestEngine({ baseUrl: "https://h.example/ " }),
    (err) =>
      err instanceof EntgeltatlasValidationError &&
      err.message === "Invalid baseUrl: A base URL cannot have surrounding whitespace.",
  );
});

test("normalizeApiKey trims, maps blank to undefined, and is idempotent", () => {
  assert.equal(lib.normalizeApiKey(undefined), undefined);
  assert.equal(lib.normalizeApiKey("   "), undefined);
  assert.equal(lib.normalizeApiKey("k\r\n"), "k");
  assert.equal(lib.normalizeApiKey(lib.normalizeApiKey(" k ")), "k");
});

test("the client rejects a key an HTTP header cannot carry with the header rule's message", () => {
  assert.throws(
    () => new lib.EntgeltatlasClient({ apiKey: "a\nb" }),
    (err) =>
      err instanceof EntgeltatlasValidationError &&
      err.message === "Invalid apiKey: Value contains control characters.",
  );
});

test("baseUrlProblem: parse, scheme, query/fragment and whitespace, with the CLI's messages", () => {
  const p = lib.baseUrlProblem;
  assert.equal(p("https://h.example/prefix/"), undefined);
  assert.equal(p(""), 'Invalid URL "".');
  assert.equal(p("not a url"), 'Invalid URL "not a url".');
  assert.equal(p("ftp://h.example"), "Only http: and https: base URLs are supported.");
  assert.equal(p("http://h.example/?x=1"), "A base URL cannot have a query (?) or fragment (#).");
  assert.equal(p("http://h.example/#f"), "A base URL cannot have a query (?) or fragment (#).");
  assert.equal(p("http://h.example "), "A base URL cannot have surrounding whitespace.");
  assert.equal(p(42 as unknown as string), 'Invalid URL "42".');
  assert.equal(p(new URL("https://h.example") as unknown as string), 'Invalid URL "https://h.example/".');
});

test("validateBaseUrl strips trailing slashes and redacts credentials in its error", () => {
  assert.equal(lib.validateBaseUrl("https://h.example/x//"), "https://h.example/x");
  assert.throws(
    () => lib.validateBaseUrl("ftp://user:s3cret@h.example/"),
    (err) => err instanceof EntgeltatlasValidationError && !err.message.includes("s3cret"),
  );
});
