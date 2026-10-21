import { test } from "node:test";
import assert from "node:assert/strict";
import { EntgeltatlasClient, emptyAnswerNote, type EntgeltatlasClientOptions } from "../src/client.js";
import {
  EntgeltatlasParseError,
  EntgeltatlasSliceError,
  EntgeltatlasValidationError,
} from "../src/errors.js";
import { makeMockTransport, jsonResponse, rawResponse, queryOf, type MockTransport } from "./helpers.js";
import type { HttpRequest, HttpResponse } from "../src/http.js";
import * as fx from "./fixtures.js";

function client(
  responder: (req: HttpRequest) => HttpResponse,
  options: Omit<EntgeltatlasClientOptions, "transport"> = {},
): { c: EntgeltatlasClient; mt: MockTransport } {
  const mt = makeMockTransport(responder);
  const c = new EntgeltatlasClient({ ...options, transport: mt.transport });
  return { c, mt };
}

test("entgelte sends the X-API-Key, hits the KldB path, and forwards dimensions", async () => {
  const { c, mt } = client(() => jsonResponse(fx.entgelteResult), { apiKey: "KEY-UUID" });
  const res = await c.entgelte("84304", { l: 4, r: 1, g: 1, a: 1, b: 1 });
  assert.deepEqual(res, fx.entgelteResult);
  const req = mt.last();
  assert.equal(req.headers?.["X-API-Key"], "KEY-UUID");
  assert.equal(new URL(req.url).pathname, "/infosysbub/entgeltatlas/pc/v1/entgelte/84304");
  const q = queryOf(req);
  assert.equal(q.get("l"), "4");
  assert.equal(q.get("r"), "1");
  assert.equal(q.get("b"), "1");
});

test("entgelte omits dimension params that were not set", async () => {
  const { c, mt } = client(() => jsonResponse([]), { apiKey: "K" });
  await c.entgelte("84304", { r: 5 });
  const q = queryOf(mt.last());
  assert.equal(q.get("r"), "5");
  assert.equal(q.get("l"), null);
  assert.equal(q.get("g"), null);
});

test("entgelte rejects a non-numeric KldB code before any request", async () => {
  const { c, mt } = client(() => jsonResponse(fx.entgelteResult), { apiKey: "K" });
  await assert.rejects(() => c.entgelte("Softwareentwickler"), EntgeltatlasValidationError);
  assert.equal(mt.calls.length, 0);
});

test("entgelte rejects a body that is not an array of objects", async () => {
  const bodies: unknown[] = [fx.entgelteResult[0], { error: "not an array", status: 500 }, "hello", 42, null, ["x"], [null], [[]]];
  for (const body of bodies) {
    const { c } = client(() => jsonResponse(body), { apiKey: "K" });
    await assert.rejects(
      () => c.entgelte("84304"),
      (err) =>
        err instanceof EntgeltatlasParseError &&
        err.message.startsWith(
          "GET https://rest.arbeitsagentur.de/infosysbub/entgeltatlas/pc/v1/entgelte/84304: unexpected response shape: expected a JSON array of salary rows",
        ),
      JSON.stringify(body),
    );
  }
});

test("entgelte rejects an empty or 204 body instead of returning []", async () => {
  for (const status of [200, 204]) {
    const { c } = client(() => rawResponse("", "application/json", status), { apiKey: "K" });
    await assert.rejects(() => c.entgelte("84304"), EntgeltatlasParseError);
  }
});

test("entgelte returns [] for a suppressed/empty result", async () => {
  const { c } = client(() => jsonResponse([]), { apiKey: "K" });
  assert.deepEqual(await c.entgelte("84304"), []);
});

test("no apiKey means no X-API-Key header is sent", async () => {
  const { c, mt } = client(() => jsonResponse([]));
  await c.entgelte("84304");
  assert.equal(mt.last().headers?.["X-API-Key"], undefined);
});

test("a blank apiKey is treated as unset", async () => {
  const { c, mt } = client(() => jsonResponse([]), { apiKey: "   " });
  await c.entgelte("84304");
  assert.equal(mt.last().headers?.["X-API-Key"], undefined);
});

test("regionen hits the reference endpoint and returns the array", async () => {
  const { c, mt } = client(() => jsonResponse(fx.regionen), { apiKey: "K" });
  const res = await c.regionen();
  assert.deepEqual(res, fx.regionen);
  assert.equal(new URL(mt.last().url).pathname, "/infosysbub/entgeltatlas/pc/v1/regionen");
});

test("a reference endpoint returning a non-array is a parse error, not []", async () => {
  const bodies: unknown[] = [{ unexpected: true }, { _embedded: [{ id: 1, bezeichnung: "x" }] }, null, "x", [1]];
  for (const body of bodies) {
    const { c } = client(() => jsonResponse(body), { apiKey: "K" });
    await assert.rejects(
      () => c.branchen(),
      (err) =>
        err instanceof EntgeltatlasParseError &&
        /^GET https:\/\/rest\.arbeitsagentur\.de\/infosysbub\/entgeltatlas\/pc\/v1\/branchen: unexpected response shape: expected a JSON array of codes/.test(err.message),
      JSON.stringify(body),
    );
  }
  const { c } = client(() => rawResponse("", "application/json", 204), { apiKey: "K" });
  await assert.rejects(() => c.regionen(), EntgeltatlasParseError);
});

test("the client rejects a non-http(s) base URL before any request", () => {
  for (const baseUrl of ["file:///etc/passwd", "ftp://example.org"]) {
    const mt = makeMockTransport(() => jsonResponse([]));
    assert.throws(
      () => new EntgeltatlasClient({ baseUrl, apiKey: "KEY-UUID", transport: mt.transport }),
      EntgeltatlasValidationError,
      baseUrl,
    );
    assert.equal(mt.calls.length, 0);
  }
});

test("the client rejects an apiKey an HTTP header cannot carry", () => {
  for (const apiKey of ["abc\ndef", "ключ", "a\u007fb"]) {
    assert.throws(() => new EntgeltatlasClient({ apiKey }), EntgeltatlasValidationError, JSON.stringify(apiKey));
  }
});

test("P9: a salary row or a code without the documented fields is a parse error, and a reference list is never empty", async () => {
  const row = fx.entgelteResult[0]!;
  const badRows: unknown[] = [
    [{ ...row, kldb: 84304 }],
    [{ ...row, region: undefined }],
    [{ ...row, gender: { id: "3", bezeichnung: "Frauen" } }],
    [{ ...row, branche: { id: 1 } }],
    [{ error: "boom" }],
    [{ id: 1, bezeichnung: "Deutschland" }],
  ];
  for (const body of badRows) {
    const { c } = client(() => jsonResponse(body), { apiKey: "K" });
    await assert.rejects(() => c.entgelte("84304"), EntgeltatlasParseError, JSON.stringify(body));
  }
  for (const body of [[], [{ id: 1 }], [{ bezeichnung: "x" }], [{ id: 1.5, bezeichnung: "x" }], [row]]) {
    const { c } = client(() => jsonResponse(body), { apiKey: "K" });
    await assert.rejects(() => c.regionen(), EntgeltatlasParseError, JSON.stringify(body));
  }
  // An empty salary list is the documented suppressed answer, not an error.
  const { c } = client(() => jsonResponse([]), { apiKey: "K" });
  assert.deepEqual(await c.entgelte("84304"), []);
});

test("P10: allowUnknownFilters sends an extra parameter, never __proto__ and never an array", async () => {
  const { c, mt } = client(() => jsonResponse([]), { apiKey: "K" });
  await c.entgelte("84304", { l: 4, x: "1" } as never, { allowUnknownFilters: true });
  assert.equal(new URL(mt.last().url).search, "?l=4&x=1");
  // A string value is text (D8): sent trimmed and composed; a blank or invisible one, or an empty name, is refused.
  await c.entgelte("84304", { x: " Mu\u0308ller " } as never, { allowUnknownFilters: true });
  assert.equal(new URL(mt.last().url).searchParams.get("x"), "Müller");
  for (const params of [JSON.parse('{"__proto__": 1}'), { constructor: 1 }, { x: [1, 2] }, { x: { y: 1 } }, { "": "x" }, { x: "" }, { x: "  " }, { x: "\u200b" }, { x: "a\u001bb" }, { "x\u200b": "1" }]) {
    await assert.rejects(
      () => c.entgelte("84304", params as never, { allowUnknownFilters: true }),
      EntgeltatlasValidationError,
      JSON.stringify(params),
    );
  }
});

test("02#1: a row of another slice than the one requested is an EntgeltatlasSliceError, not the answer", async () => {
  // The repro: -r 11 -g 3 asked, the server answers the Deutschland / Gesamt row.
  const { c } = client(() => jsonResponse(fx.entgelteResult), { apiKey: "K" });
  await assert.rejects(
    () => c.entgelte("84304", { l: 4, r: 11, g: 3 }),
    (err) =>
      err instanceof EntgeltatlasSliceError &&
      err instanceof EntgeltatlasParseError &&
      err.param === "r" &&
      err.requested === 11 &&
      err.received === 1 &&
      err.message.startsWith("GET https://rest.arbeitsagentur.de/infosysbub/entgeltatlas/pc/v1/entgelte/84304?l=4&r=11&g=3: the API answered another slice") &&
      /r=11 was asked for, but row 0 has region.id 1 \("Deutschland"\)/.test(err.message),
  );
  // The matching slice passes, and an omitted dimension may come back as several rows.
  const row = fx.entgelteResult[0]!;
  const ages = [1, 2, 3, 4].map((id) => ({ ...row, ageCategory: { id, bezeichnung: `a${id}` } }));
  const ok = client(() => jsonResponse(ages), { apiKey: "K" });
  assert.equal((await ok.c.entgelte("84304", { l: 4, r: 1, g: 1, b: 1 })).length, 4);
  // One stray row among matching ones is enough to refuse the answer.
  const mixed = client(() => jsonResponse([...ages, { ...row, branche: { id: 7, bezeichnung: "Finanz" } }]), { apiKey: "K" });
  await assert.rejects(() => mixed.c.entgelte("84304", { b: 1 }), EntgeltatlasSliceError);
});

test("02#4: a figure that is not a number or null is a parse error; negative markers are data", async () => {
  const row = fx.entgelteResult[0]!;
  for (const bad of [{ entgelt: "6.123,00" }, { besetzung: "41234" }, { entgeltQ25: true }, { entgeltQ75: { v: 1 } }, { entgelt: [6123] }]) {
    const { c } = client(() => jsonResponse([{ ...row, ...bad }]), { apiKey: "K" });
    await assert.rejects(
      () => c.entgelte("84304"),
      (err) => err instanceof EntgeltatlasParseError && /is not a number or null/.test(err.message),
      JSON.stringify(bad),
    );
  }
  // The live markers (2026-10-06): -1 for a cell without a figure, -2 for a quartile above the ceiling.
  for (const ok of [{ entgelt: -1, entgeltQ25: -1, entgeltQ75: -1, besetzung: -42 }, { entgeltQ75: -2 }, { entgelt: null }]) {
    const { c } = client(() => jsonResponse([{ ...row, ...ok }]), { apiKey: "K" });
    assert.equal((await c.entgelte("84304")).length, 1, JSON.stringify(ok));
  }
});

test("a long server label in the slice error is cut, never inside a surrogate pair", async () => {
  const row = fx.entgelteResult[0]!;
  for (const label of ["\u{1f600}".repeat(60), "a" + "\u{1f600}".repeat(60)]) {
    const { c } = client(() => jsonResponse([{ ...row, region: { id: 1, bezeichnung: label } }]), { apiKey: "K" });
    await assert.rejects(
      () => c.entgelte("84304", { r: 11 }),
      (err: Error) => err instanceof EntgeltatlasSliceError && /…"\)/.test(err.message) && !/\\ud83d/.test(err.message),
      label.length.toString(),
    );
  }
});

test("a number the answer cannot carry exactly is a parse error, never a changed figure (bug 4, 2026-10-15)", async () => {
  // `"besetzung":12345678901234567890` printed as 12345678901234567000 and 9007199254740993 as
  // 9007199254740992, with exit 0; the row check accepted them because they are finite.
  const row = (extra: string) =>
    `[{"kldb":"84304","region":{"id":1,"bezeichnung":"D"},"gender":{"id":1,"bezeichnung":"G"},` +
    `"ageCategory":{"id":1,"bezeichnung":"A"},"performanceLevel":{"id":4,"bezeichnung":"L"},` +
    `"branche":{"id":1,"bezeichnung":"B"},"entgelt":5731,${extra}}]`;
  for (const n of ["12345678901234567890", "9007199254740993", "-9007199254740993"]) {
    const mt = makeMockTransport(() => rawResponse(row(`"besetzung":${n}`), "application/json"));
    await assert.rejects(new EntgeltatlasClient({ apiKey: "k", transport: mt.transport }).entgelte("84304"), (err) => {
      assert.ok(err instanceof EntgeltatlasParseError, n);
      assert.match(err.message, new RegExp(`the number ${n} cannot be represented exactly\\.$`));
      return true;
    });
  }
  const list = makeMockTransport(() => rawResponse('[{"id":12345678901234567890,"bezeichnung":"x"}]', "application/json"));
  await assert.rejects(new EntgeltatlasClient({ apiKey: "k", transport: list.transport }).regionen(), /cannot be represented exactly/);
  // Exact values pass, digits inside strings included.
  const ok = makeMockTransport(() => rawResponse(row('"besetzung":9007199254740991,"note":"12345678901234567890"'), "application/json"));
  const rows = await new EntgeltatlasClient({ apiKey: "k", transport: ok.transport }).entgelte("84304");
  assert.equal(rows[0]!.besetzung, 9007199254740991);
});

test("an apiKey with whitespace inside is refused at construction (bug 1, 2026-10-15)", () => {
  for (const key of ["infosys\tbub-ega", "infosys bub-ega", "a b"]) {
    assert.throws(() => new EntgeltatlasClient({ apiKey: key }), (err) => {
      assert.ok(err instanceof EntgeltatlasValidationError, JSON.stringify(key));
      assert.match(err.message, /a key is one token/);
      return true;
    });
  }
  assert.doesNotThrow(() => new EntgeltatlasClient({ apiKey: "  infosysbub-ega \t" }), "surrounding whitespace is trimmed");
});

test("02 Bug 5: a row of another occupation (kldb) is an EntgeltatlasSliceError, not the answer", async () => {
  const row = fx.entgelteResult[0]!;
  for (const other of ["99999", "843", "infosysbub"]) {
    const { c } = client(() => jsonResponse([{ ...row, kldb: other }]), { apiKey: "K" });
    await assert.rejects(
      () => c.entgelte("84304", { l: 4, r: 1, g: 1, a: 1, b: 1 }),
      (err) =>
        err instanceof EntgeltatlasSliceError &&
        err.param === "kldb" &&
        err.requested === "84304" &&
        err.received === other &&
        err.row === 0 &&
        err.message.includes(`kldb 84304 was asked for, but row 0 has kldb ${JSON.stringify(other)}`),
      other,
    );
  }
  // A 3-digit group answers rows of that group; a padded request is compared as it was sent.
  const group = client(() => jsonResponse([{ ...row, kldb: "434" }]), { apiKey: "K" });
  assert.equal((await group.c.entgelte(" 434 ")).length, 1);
});

test("01 Bug 1: emptyAnswerNote names Ost/West as never answered", () => {
  assert.match(emptyAnswerNote("84304", [], { r: 2 }) ?? "", /^no rows for region 2 \(Ostdeutschland\): /);
  assert.match(emptyAnswerNote("434", [], { r: 3 }) ?? "", /^no rows for region 3 \(Westdeutschland\): /);
  assert.equal(emptyAnswerNote("84304", [], { r: 17 }), undefined);
  assert.equal(emptyAnswerNote("84304", [{}], { r: 2 }), undefined);
  assert.equal(emptyAnswerNote("84304", []), undefined);
});

test("01 Bug 2: emptyAnswerNote names a level the 5-digit code contradicts and a branch crossed with gender or age", () => {
  assert.equal(
    emptyAnswerNote("84304", [], { l: 2 }),
    "no rows for KldB 84304 at level 2 (Fachkraft): the fifth digit of a 5-digit code is its level (4, Experte), " +
      "so the API answers no other. Leave -l out or give 4.",
  );
  assert.equal(emptyAnswerNote("84304", [], { l: 4 }), undefined);
  assert.equal(emptyAnswerNote("434", [], { l: 2 }), undefined, "a 3-digit group has every level");
  assert.equal(
    emptyAnswerNote("84304", [], { g: 2, b: 5 }),
    "no rows for branch 5 with gender 2 and age Gesamt: the API answers a branch other than Gesamt (b=1) only for " +
      "gender and age Gesamt (g=1, a=1); it does not cross a branch with gender or age.",
  );
  assert.match(emptyAnswerNote("84304", [], { a: 3, b: 2 }) ?? "", /^no rows for branch 2 with gender Gesamt and age 3: /);
  for (const params of [{ b: 5 }, { g: 1, a: 1, b: 5 }, { g: 2, b: 1 }, { g: 2 }]) {
    assert.equal(emptyAnswerNote("84304", [], params), undefined, JSON.stringify(params));
  }
  assert.equal(emptyAnswerNote("84304", [{}], { g: 2, b: 5 }), undefined);
});
