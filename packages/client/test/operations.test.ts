// The skills' use cases (src/operations.ts) against recorded answers (recorded.ts): each trap the
// skills document is a test here. No request reaches the network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EntgeltatlasClient } from "../src/client.js";
import { EntgeltatlasSliceError, EntgeltatlasValidationError } from "../src/errors.js";
import { comparePay, findCodes, lookupPay, NO_NAME_SEARCH, resolveCode } from "../src/operations.js";
import type { EntgeltEntry } from "../src/types.js";
import { jsonResponse, makeMockTransport, type MockTransport } from "./helpers.js";
import {
  KLDB_434_L2_GENDERS,
  KLDB_434_L2_REGIONS,
  KLDB_434_LEVELS,
  KLDB_81302_SAARLAND_WOMEN_U25,
  KLDB_814_LEVELS,
  KLDB_84304_DE_GESAMT,
  REGIONEN,
} from "./recorded.js";

/** A mock of the API: `entgelte` answers by the code and the query, the reference lists by name. */
function api(entgelte: (kldb: string, query: URLSearchParams) => unknown, lists: Record<string, unknown> = { regionen: REGIONEN }): MockTransport {
  return makeMockTransport((request) => {
    const url = new URL(request.url);
    const kldb = url.pathname.match(/\/entgelte\/(\d+)$/)?.[1];
    if (kldb !== undefined) return jsonResponse(entgelte(kldb, url.searchParams));
    const list = lists[url.pathname.split("/").pop() ?? ""];
    return list === undefined ? jsonResponse({ message: "no such path" }, 404) : jsonResponse(list);
  });
}

const client = (mock: MockTransport): EntgeltatlasClient => new EntgeltatlasClient({ transport: mock.transport, apiKey: "test-key-only" });
const query = (mock: MockTransport, i = 0): Record<string, string> => Object.fromEntries(new URL(mock.calls[i]!.url).searchParams);
const answering = (rows: unknown) => api(() => rows);

test("lookupPay: Deutschland and Gesamt by default, every level unless given; one request; the figures as amounts", async () => {
  const mock = answering(KLDB_84304_DE_GESAMT);
  const answer = await lookupPay(client(mock), { kldb: " 84304 " });
  assert.equal(mock.calls.length, 1);
  assert.deepEqual(query(mock), { r: "1", g: "1", a: "1", b: "1" });
  assert.equal(answer.status, "ok");
  assert.match(answer.occupation ?? "", /5-digit occupation .* level 4 \(Experte\)/);
  assert.equal(answer.searched?.["level"], "all");
  assert.deepEqual(answer.rows?.[0], {
    level: { code: 4, name: "Experte" },
    region: { code: 1, name: "Deutschland" },
    gender: { code: 1, name: "Gesamt" },
    age: { code: 1, name: "Gesamt" },
    branch: { code: 1, name: "Gesamt" },
    median: 5731,
    q25: 5138,
    q75: 6903,
    headcount: 125551,
    ceiling: 8050,
  });
});

test("lookupPay: names are resolved to codes (German, English, the Länder's abbreviations), never sent as names", async () => {
  const mock = answering([]);
  await lookupPay(client(mock), { kldb: "434", level: "Fachkraft", region: "Bavaria", gender: "Frauen", age: "under 25" });
  await lookupPay(client(mock), { kldb: "434", region: "BY", gender: "women" });
  await lookupPay(client(mock), { kldb: "434", region: "Sachsen" });
  assert.deepEqual(query(mock, 0), { l: "2", r: "12", g: "3", a: "2", b: "1" });
  assert.deepEqual(query(mock, 1), { r: "12", g: "3", a: "1", b: "1" });
  assert.equal(query(mock, 2)["r"], "17", "the exact name wins over Sachsen-Anhalt, which contains it");
});

test("lookupPay: an occupation name is no KldB code: the answer says where codes come from, without a request", async () => {
  const mock = answering([]);
  const answer = await lookupPay(client(mock), { kldb: "Fachinformatiker" });
  assert.equal(answer.status, "empty");
  assert.equal(answer.reason, NO_NAME_SEARCH);
  assert.match(answer.reason ?? "", /no occupation-name search.*never guess/);
  assert.equal(mock.calls.length, 0);
});

test("lookupPay: a name matching several codes is ambiguous, with candidates, without a request", async () => {
  const mock = answering([]);
  const answer = await lookupPay(client(mock), { kldb: "434", region: "burg" });
  assert.equal(answer.status, "ambiguous");
  assert.equal(answer.dimension, "region");
  assert.deepEqual(answer.candidates?.map((c) => c.name), ["Hamburg", "Brandenburg", "Mecklenburg-Vorpommern"]);
  assert.equal(mock.calls.length, 0);
});

test("lookupPay: an unknown name is empty naming the codes; an unknown code is a validation error", async () => {
  const mock = answering([]);
  const answer = await lookupPay(client(mock), { kldb: "434", gender: "divers" });
  assert.equal(answer.status, "empty");
  assert.match(answer.reason ?? "", /no gender called "divers": the gender codes are 1 Gesamt, 2 Männer, 3 Frauen/);
  await assert.rejects(lookupPay(client(mock), { kldb: "434", region: 31 }), (err: unknown) => err instanceof EntgeltatlasValidationError && /Unknown region code 31/.test(err.message));
  assert.equal(mock.calls.length, 0);
});

test("lookupPay: a negative figure is a marker, never an amount: -100 no figure, -1 suppressed, -2 above the ceiling", async () => {
  const levels = await lookupPay(client(answering(KLDB_434_LEVELS)), { kldb: "434" });
  const helfer = levels.rows?.[0];
  assert.equal(helfer?.level.name, "Helfer");
  assert.deepEqual([helfer?.median, helfer?.q25, helfer?.q75, helfer?.headcount], [null, null, null, null]);
  assert.match(helfer?.notes?.[0] ?? "", /no figure .*-100.*not 0 EUR/);
  assert.equal(levels.rows?.[1]?.median, 4612);

  const suppressed = await lookupPay(client(answering(KLDB_81302_SAARLAND_WOMEN_U25)), { kldb: "81302", region: "Saarland", gender: "Frauen", age: "unter 25" });
  const row = suppressed.rows?.[0];
  assert.deepEqual([row?.median, row?.headcount], [null, null], "besetzung -42 is no headcount");
  assert.deepEqual(row?.notes, ["suppressed: too few cases (keine Angabe, Fallzahl zu klein); not 0 EUR"]);

  const doctors = await lookupPay(client(answering(KLDB_814_LEVELS)), { kldb: "814" });
  const experte = doctors.rows?.[3];
  assert.equal(experte?.median, 7846);
  assert.equal(experte?.q75, null);
  assert.equal(experte?.censored, true);
  assert.deepEqual(experte?.notes, ["q75: above the contribution ceiling (über der Beitragsbemessungsgrenze, 8050 EUR): the value is unknown"]);
});

test("lookupPay: null figures are no figure either, and a median at the ceiling is flagged as censored", async () => {
  const base = KLDB_84304_DE_GESAMT[0]!;
  const nulls = await lookupPay(client(answering([{ ...base, entgelt: null, entgeltQ25: null, entgeltQ75: null, besetzung: null }])), { kldb: "84304" });
  assert.equal(nulls.rows?.[0]?.median, null);
  assert.match(nulls.rows?.[0]?.notes?.[0] ?? "", /no figure for this slice \(keine Angabe\); not 0 EUR/);
  const capped = await lookupPay(client(answering([{ ...base, entgelt: 8050, entgeltQ75: -2 }])), { kldb: "84304" });
  assert.equal(capped.rows?.[0]?.censored, true);
  assert.match(capped.rows?.[0]?.notes?.join(" ") ?? "", /median: at the contribution ceiling \(8050 EUR\): the real value may be higher/);
});

test("lookupPay: an empty answer says why when the request explains it: a 4-digit code, Ost/West, the level a 5-digit code contradicts", async () => {
  const four = await lookupPay(client(answering([])), { kldb: "8430" });
  assert.equal(four.status, "empty");
  assert.match(four.reason ?? "", /4-digit KldB code 8430/);
  const east = await lookupPay(client(answering([])), { kldb: "434", region: "Ost" });
  assert.match(east.reason ?? "", /region 2 \(Ostdeutschland\).*not a suppressed figure/);
  const level = await lookupPay(client(answering([])), { kldb: "84304", level: "Fachkraft" });
  assert.match(level.reason ?? "", /fifth digit of a 5-digit code is its level/);
  const unknown = await lookupPay(client(answering([])), { kldb: "99999" });
  assert.match(unknown.reason ?? "", /suppressed or the KldB code doesn't exist/);
});

test("lookupPay: a branch is never crossed with gender or age (the API answers no rows): refused without a request", async () => {
  const mock = answering([]);
  const answer = await lookupPay(client(mock), { kldb: "434", branch: "IT", gender: "Frauen" });
  assert.equal(answer.status, "empty");
  assert.match(answer.reason ?? "", /only for gender and age Gesamt/);
  assert.equal(mock.calls.length, 0);
});

test("lookupPay: another slice than the one asked for is an error, never its figures", async () => {
  await assert.rejects(lookupPay(client(answering(KLDB_84304_DE_GESAMT)), { kldb: "84304", region: "Bayern" }), EntgeltatlasSliceError);
});

test("comparePay by gender: one request with gender left out, Männer the base, the rows picked by label, the gap in EUR and percent", async () => {
  const mock = answering(KLDB_434_L2_GENDERS);
  const answer = await comparePay(client(mock), { kldb: "434", by: "gender", level: "Fachkraft" });
  assert.equal(mock.calls.length, 1);
  assert.deepEqual(query(mock), { l: "2", r: "1", a: "1", b: "1" });
  assert.equal(answer.status, "ok");
  assert.deepEqual(answer.base, { code: 2, name: "Männer" });
  assert.deepEqual(answer.points?.map((p) => [p.value.name, p.median, p.gap]), [
    ["Männer", 4629, undefined],
    ["Frauen", 4499, { eur: -130, percent: -2.8 }],
  ]);
  assert.match(answer.note ?? "", /not means.*not causal/);
});

test("comparePay by region: Ost and West have no rows (said so), a suppressed side has no gap, present sides do", async () => {
  const mock = answering(KLDB_434_L2_REGIONS);
  const answer = await comparePay(client(mock), { kldb: "434", by: "region", level: 2, values: ["Bayern", "Sachsen", "Thüringen", "Ost"] });
  assert.deepEqual(query(mock), { l: "2", g: "1", a: "1", b: "1" });
  assert.deepEqual(answer.points?.map((p) => [p.value.name, p.median, p.gap?.eur ?? p.gapNote]), [
    ["Bayern", 4632, undefined],
    ["Sachsen", 4172, -460],
    ["Thüringen", null, "no gap: this value has no median (see notes)"],
  ]);
  assert.equal(answer.missing?.[0]?.value.name, "Ostdeutschland");
  assert.match(answer.missing?.[0]?.reason ?? "", /no East\/West aggregate; compare Länder/);
});

test("comparePay by region: by default the 16 Länder, cities left out", async () => {
  const answer = await comparePay(client(answering(KLDB_434_L2_REGIONS)), { kldb: "434", by: "region", level: 2 });
  assert.deepEqual(answer.points?.map((p) => p.value.code), [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  assert.equal(answer.base?.name, "Schleswig-Holstein");
  assert.equal(answer.points?.[1]?.value.name, "Hamburg");
  assert.equal(answer.points?.[1]?.gap, undefined, "the stand-in base has no gap to itself");
  assert.deepEqual(answer.points?.[2]?.gap, { eur: 4086 - 4776, percent: -14.4 });
  assert.deepEqual(answer.points?.[2]?.gapTo, { code: 5, name: "Hamburg" }, "Schleswig-Holstein is suppressed: the gaps are measured against Hamburg, and say so");
});

test("comparePay by level: a 5-digit code is one level, refused without a request; a 3-digit group compares its levels", async () => {
  const mock = answering(KLDB_434_LEVELS);
  const five = await comparePay(client(mock), { kldb: "84304", by: "level" });
  assert.equal(five.status, "empty");
  assert.match(five.reason ?? "", /compare the levels of its 3-digit group 843/);
  assert.equal(mock.calls.length, 0);
  const group = await comparePay(client(mock), { kldb: "434", by: "level", values: ["Fachkraft", "Experte", "Helfer"] });
  assert.deepEqual(query(mock), { r: "1", g: "1", a: "1", b: "1" });
  assert.deepEqual(group.points?.map((p) => [p.value.name, p.gap?.percent ?? p.gapNote]), [
    ["Fachkraft", undefined],
    ["Experte", 37.6],
    ["Helfer", "no gap: this value has no median (see notes)"],
  ]);
  const defaults = await comparePay(client(mock), { kldb: "434", by: "level" });
  assert.deepEqual(defaults.points?.map((p) => [p.value.name, p.gap?.percent ?? p.gapNote, p.gapTo?.name]), [
    ["Helfer", "no gap: this value has no median (see notes)", undefined],
    ["Fachkraft", undefined, undefined],
    ["Spezialist", 36.9, "Fachkraft"],
    ["Experte", 37.6, "Fachkraft"],
  ], "Helfer has no figure (-100): the gaps are measured against Fachkraft, not left empty");
});

test("comparePay: with the level not held, a 3-digit group is compared within each level, never across", async () => {
  const rows: EntgeltEntry[] = KLDB_434_LEVELS.flatMap((row) => [2, 3].map((g) => ({ ...row, gender: { id: g, bezeichnung: g === 2 ? "Männer" : "Frauen" }, entgelt: row.entgelt! < 0 ? row.entgelt : row.entgelt! - (g === 3 ? 100 : 0) })));
  const answer = await comparePay(client(answering(rows)), { kldb: "434", by: "gender" });
  assert.equal(answer.held?.["level"], "all");
  const gaps = answer.points?.filter((p) => p.gap !== undefined).map((p) => [p.level.name, p.gap?.eur]);
  assert.deepEqual(gaps, [["Fachkraft", -100], ["Spezialist", -100], ["Experte", -100]]);
});

test("comparePay: a censored side says the real gap may be larger", async () => {
  const [m, f] = [2, 3].map((g) => ({ ...KLDB_814_LEVELS[3]!, gender: { id: g, bezeichnung: g === 2 ? "Männer" : "Frauen" }, entgelt: g === 2 ? 7900 : 7400 }));
  const answer = await comparePay(client(answering([m, f])), { kldb: "814", by: "gender", level: 4 });
  assert.deepEqual(answer.points?.[1]?.gap, { eur: -500, percent: -6.3 });
  assert.match(answer.points?.[1]?.gapNote ?? "", /real gap at the top may be larger/);
});

test("comparePay by branch with gender or age held other than Gesamt: refused without a request", async () => {
  const mock = answering([]);
  const answer = await comparePay(client(mock), { kldb: "434", by: "branch", gender: "Frauen" });
  assert.equal(answer.status, "empty");
  assert.match(answer.reason ?? "", /does not cross a branch with gender or age/);
  const age = await comparePay(client(mock), { kldb: "434", by: "age", branch: "Baugewerbe" });
  assert.equal(age.status, "empty");
  assert.equal(mock.calls.length, 0);
});

test("comparePay: fewer than two values is a validation error; an ambiguous value is reported, not guessed", async () => {
  const mock = answering([]);
  await assert.rejects(comparePay(client(mock), { kldb: "434", by: "gender", values: ["Frauen", "women"] }), EntgeltatlasValidationError);
  const answer = await comparePay(client(mock), { kldb: "434", by: "region", values: ["Bayern", "burg"] });
  assert.equal(answer.status, "ambiguous");
  assert.equal(mock.calls.length, 0);
});

test("findCodes: a name in every dimension, an English one too; offline, no request", async () => {
  const mock = answering([]);
  assert.deepEqual((await findCodes(client(mock), { name: "Bavaria" })).matches, [{ dimension: "region", code: 12, name: "Bayern" }]);
  assert.deepEqual((await findCodes(client(mock), { name: "Experte" })).matches, [{ dimension: "level", code: 4, name: "Experte" }]);
  const gesamt = await findCodes(client(mock), { name: "Gesamt" });
  assert.deepEqual(gesamt.matches?.map((m) => m.dimension), ["gender", "age", "branch"]);
  assert.deepEqual((await findCodes(client(mock), { dimension: "branch", name: "IT" })).matches, [{ dimension: "branch", code: 6, name: "Information und Kommunikation" }]);
  assert.equal(mock.calls.length, 0);
});

test("findCodes: an occupation is never resolved here: where a KldB code comes from, and what a code's length means", async () => {
  const mock = answering([]);
  const nurse = await findCodes(client(mock), { name: "Krankenpfleger" });
  assert.equal(nurse.status, "empty");
  assert.match(nurse.reason ?? "", /If it is an occupation: The Entgeltatlas has no occupation-name search/);
  assert.equal((await findCodes(client(mock), { dimension: "occupation" })).occupation, NO_NAME_SEARCH);
  assert.match((await findCodes(client(mock), { name: "84304" })).occupation ?? "", /5-digit occupation .* level 4 \(Experte\)/);
  assert.equal(mock.calls.length, 0);
});

test("findCodes: the tables mark the traps: region codes are irregular, Ost and West answer no rows", async () => {
  const answer = await findCodes(client(answering([])), { dimension: "region" });
  const codes = answer.dimensions?.[0]?.codes ?? [];
  assert.equal(codes.length, 30);
  assert.deepEqual(codes.find((c) => c.code === 12), { code: 12, name: "Bayern" });
  assert.equal(codes.find((c) => c.code === 3)?.note, "answers no rows: no East/West aggregate");
  assert.equal((await findCodes(client(answering([])))).dimensions?.length, 5);
});

test("findCodes live: the API's list, one request, and where it differs from the table", async () => {
  const mock = api(() => [], { regionen: REGIONEN, alter: [{ id: 1, bezeichnung: "Gesamt" }, { id: 2, bezeichnung: "unter 25" }, { id: 3, bezeichnung: "25 bis unter 55 Jahre" }, { id: 4, bezeichnung: "55 Jahre und älter" }] });
  const regions = await findCodes(client(mock), { dimension: "region", live: true });
  assert.equal(regions.dimensions?.[0]?.live, true);
  assert.equal(regions.dimensions?.[0]?.differences, undefined);
  const ages = await findCodes(client(mock), { dimension: "age", live: true });
  assert.deepEqual(ages.dimensions?.[0]?.differences, ['2: the API names it "unter 25", the table "unter 25 Jahre"']);
  assert.equal(mock.calls.length, 2);
  const levels = await findCodes(client(mock), { dimension: "level", live: true });
  assert.equal(levels.dimensions?.[0]?.live, undefined, "the level has no list upstream: the table");
  assert.equal(mock.calls.length, 2);
});

test("resolveCode: digits are codes, short unknown words find nothing rather than a guess", () => {
  assert.deepEqual(resolveCode("region", "29"), { status: "ok", value: { code: 29, name: "München" } });
  assert.deepEqual(resolveCode("region", "Munich"), { status: "ok", value: { code: 29, name: "München" } });
  assert.deepEqual(resolveCode("region", "xy"), { status: "empty" });
  assert.deepEqual(resolveCode("region", "frankfurt"), { status: "ok", value: { code: 24, name: "Frankfurt am Main" } });
});
