// This server's tools against a mock of the Entgeltatlas API (the client's answers recorded live
// on 2026-11-20), with the skills' traps as cases: each tool answers through the protocol (its
// structuredContent checked by the SDK against its output schema); names are resolved to codes or
// reported as ambiguous; an occupation word is no KldB code; a negative figure is never an amount;
// a comparison is one request with the varied dimension left out; Ost/West and a branch crossed
// with gender are explained; a refused key says what to check; every request carries the key and
// every result the BA's terms. The rules every server follows are the conformance tests (M1–M11).

import { test } from "node:test";
import assert from "node:assert/strict";
import { listTools } from "../src/mcp/server.js";
import { connect } from "./harness.js";
import { entgeltatlasApi, jsonResponse, KLDB_434_L2_REGIONS, makeMockTransport, TEST_KEY } from "./helpers.js";

const API = "https://rest.arbeitsagentur.de/infosysbub/entgeltatlas/pc/v1";
const queryOf = (call: { url: string }): Record<string, string> => Object.fromEntries(new URL(call.url).searchParams);

test("three tools: the three use cases, which reach every endpoint", () => {
  assert.deepEqual(listTools().map((t) => t.name), ["lookupPay", "comparePay", "findCodes"]);
});

test("lookupPay: the figures, the request as the source, the key sent, the BA's terms", async () => {
  const upstream = entgeltatlasApi();
  const connection = await connect({ transport: upstream });
  const result = await connection.call("lookupPay", { kldb: "84304" });
  const content = result.structuredContent ?? {};
  assert.equal(content["status"], "ok", result.content[0]?.text);
  const row = (content["rows"] as { median: number; q25: number; q75: number; headcount: number }[])[0];
  assert.deepEqual([row?.median, row?.q25, row?.q75, row?.headcount], [5731, 5138, 6903, 125551]);
  assert.equal(content["source"], `${API}/entgelte/84304?r=1&g=1&a=1&b=1`);
  assert.match(String(content["licence"]), /^© Statistik der Bundesagentur für Arbeit \(Entgeltatlas\)\. Custom terms.*unaltered.*impressum_node\.html$/);
  assert.equal(upstream.calls.length, 1);
  assert.equal(upstream.calls[0]?.headers?.["X-API-Key"], TEST_KEY);
  await connection.close();
});

test("lookupPay: names become codes (the source shows them); -100 and -1 are no amount, with the reason", async () => {
  const upstream = entgeltatlasApi();
  const connection = await connect({ transport: upstream });
  const levels = (await connection.call("lookupPay", { kldb: "434" })).structuredContent ?? {};
  const helfer = (levels["rows"] as { median: unknown; notes: string[] }[])[0];
  assert.equal(helfer?.median, null);
  assert.match(helfer?.notes[0] ?? "", /no figure.*not 0 EUR/);
  const women = (await connection.call("lookupPay", { kldb: "81302", region: "Saarland", gender: "women", age: "under 25" })).structuredContent ?? {};
  assert.equal(women["source"], `${API}/entgelte/81302?r=13&g=3&a=2&b=1`);
  assert.match(((women["rows"] as { notes: string[] }[])[0]?.notes ?? []).join(), /suppressed: too few cases/);
  await connection.close();
});

test("lookupPay: an occupation word is no KldB code: empty with where codes come from, no request", async () => {
  const upstream = entgeltatlasApi();
  const connection = await connect({ transport: upstream });
  const content = (await connection.call("lookupPay", { kldb: "Pflegefachkraft" })).structuredContent ?? {};
  assert.equal(content["status"], "empty");
  assert.match(String(content["reason"]), /no occupation-name search.*BERUFENET.*never guess/);
  assert.equal(content["source"], `${API}/entgelte`);
  assert.equal(upstream.calls.length, 0);
  await connection.close();
});

test("an answer that made no request cites no request: source is the endpoint, never the URL of another slice", async () => {
  const upstream = entgeltatlasApi();
  const connection = await connect({ transport: upstream });
  const cases: [string, Record<string, unknown>][] = [
    ["lookupPay", { kldb: "84304", region: "Atlantis" }],
    ["lookupPay", { kldb: "84304", region: "burg" }],
    ["lookupPay", { kldb: "84304", branch: "IT", gender: "Frauen" }],
    ["lookupPay", { kldb: "84304", level: 2 }],
    ["comparePay", { kldb: "84304", by: "gender", region: "Atlantis" }],
    ["comparePay", { kldb: "434", by: "branch", gender: "Frauen" }],
  ];
  for (const [tool, args] of cases) {
    const content = (await connection.call(tool, args)).structuredContent ?? {};
    assert.notEqual(content["status"], "ok", JSON.stringify(args));
    assert.equal(content["source"], `${API}/entgelte`, JSON.stringify(args));
  }
  assert.equal(upstream.calls.length, 0);
  const made = (await connection.call("comparePay", { kldb: "434", by: "region", level: 2, values: ["Bayern", "Muenchen"] })).structuredContent ?? {};
  assert.equal(made["source"], `${API}/entgelte/434?l=2&g=1&a=1&b=1`, "a request made is cited as it was sent");
  assert.equal(upstream.calls[0]?.url, made["source"]);
  await connection.close();
});

test("lookupPay: Ost answers no rows, and the answer says it is not a suppressed figure", async () => {
  const connection = await connect({ transport: entgeltatlasApi({ entgelte: () => [] }) });
  const content = (await connection.call("lookupPay", { kldb: "434", region: "Ost" })).structuredContent ?? {};
  assert.equal(content["status"], "empty");
  assert.match(String(content["reason"]), /Ostdeutschland.*not a suppressed figure/);
  await connection.close();
});

test("comparePay by gender: one request with gender left out, the gap of Frauen to Männer", async () => {
  const upstream = entgeltatlasApi();
  const connection = await connect({ transport: upstream });
  const content = (await connection.call("comparePay", { kldb: "434", by: "gender", level: "Fachkraft" })).structuredContent ?? {};
  assert.equal(content["status"], "ok", JSON.stringify(content).slice(0, 300));
  assert.equal(upstream.calls.length, 1);
  assert.deepEqual(queryOf(upstream.calls[0]!), { l: "2", r: "1", a: "1", b: "1" });
  assert.equal(content["source"], `${API}/entgelte/434?l=2&r=1&a=1&b=1`);
  const points = content["points"] as { value: { name: string }; gap?: { eur: number; percent: number } }[];
  assert.deepEqual(points.map((p) => [p.value.name, p.gap]), [["Männer", undefined], ["Frauen", { eur: -130, percent: -2.8 }]]);
  await connection.close();
});

test("comparePay by region: a suppressed Land has no gap; West is missing with the reason", async () => {
  const connection = await connect({ transport: entgeltatlasApi() });
  const content = (await connection.call("comparePay", { kldb: "434", by: "region", level: 2, values: ["Bayern", "Bremen", "West"] })).structuredContent ?? {};
  const points = content["points"] as { value: { name: string }; gapNote?: string }[];
  assert.deepEqual(points.map((p) => p.value.name), ["Bayern", "Bremen"]);
  assert.match(points[1]?.gapNote ?? "", /no gap/);
  assert.match(JSON.stringify(content["missing"]), /Westdeutschland.*no East\/West aggregate/);
  await connection.close();
});

test("comparePay over the size cap: the points are a page, and offset fetches the rest, every level included", async () => {
  const LEVELS = ["Helfer", "Fachkraft", "Spezialist", "Experte"];
  const rows = LEVELS.flatMap((name, i) => KLDB_434_L2_REGIONS.map((row) => ({ ...row, performanceLevel: { id: i + 1, bezeichnung: name } })));
  const upstream = entgeltatlasApi({ entgelte: () => rows });
  const connection = await connect({ transport: upstream, config: { maxResultChars: 20_000 } });
  const values = [1, ...Array.from({ length: 27 }, (_, i) => i + 4)];
  const points: { level: { name: string }; value: { code: number } }[] = [];
  let offset: number | undefined = 0;
  let total = 0;
  for (let page = 0; offset !== undefined && page < 20; page++) {
    const content: Record<string, unknown> = (await connection.call("comparePay", { kldb: "434", by: "region", values, offset })).structuredContent ?? {};
    assert.equal(content["status"], "ok", JSON.stringify(content).slice(0, 300));
    if (page === 0) assert.equal(content["truncated"], true, "the first page is cut");
    total = content["total"] as number;
    points.push(...(content["points"] as typeof points));
    offset = content["nextOffset"] as number | undefined;
  }
  assert.ok(total > 100, String(total));
  assert.equal(points.length, total, "every point once");
  assert.deepEqual([...new Set(points.map((p) => p.level.name))], LEVELS, "Experte included");
  await connection.close();
});

test("comparePay by branch with gender Frauen: refused without a request", async () => {
  const upstream = entgeltatlasApi();
  const connection = await connect({ transport: upstream });
  const content = (await connection.call("comparePay", { kldb: "434", by: "branch", gender: "Frauen" })).structuredContent ?? {};
  assert.equal(content["status"], "empty");
  assert.match(String(content["reason"]), /does not cross a branch with gender or age/);
  assert.equal(upstream.calls.length, 0);
  await connection.close();
});

test("findCodes: a name across the dimensions, an ambiguous one with candidates, offline", async () => {
  const upstream = entgeltatlasApi();
  const connection = await connect({ transport: upstream });
  const bavaria = (await connection.call("findCodes", { name: "Bavaria" })).structuredContent ?? {};
  assert.deepEqual(bavaria["matches"], [{ dimension: "region", code: 12, name: "Bayern" }]);
  assert.equal(bavaria["source"], "https://github.com/bundesAPI/entgeltatlas-api");
  const burg = (await connection.call("findCodes", { dimension: "region", name: "burg" })).structuredContent ?? {};
  assert.equal(burg["status"], "ambiguous");
  assert.equal(upstream.calls.length, 0);
  await connection.close();
});

test("findCodes live: the API's region list, its path as the source", async () => {
  const upstream = entgeltatlasApi();
  const connection = await connect({ transport: upstream });
  const content = (await connection.call("findCodes", { dimension: "region", live: true })).structuredContent ?? {};
  assert.equal(content["status"], "ok");
  assert.equal(content["source"], `${API}/regionen`);
  assert.equal(((content["dimensions"] as { codes: unknown[] }[])[0]?.codes ?? []).length, 30);
  assert.equal(upstream.calls.length, 1);
  await connection.close();
});

test("a refused key (the gateway's bare 403) is a tool error that says what to check", async () => {
  const connection = await connect({ transport: makeMockTransport(() => ({ ...jsonResponse({}), status: 403, headers: { "content-type": "text/plain" }, body: Buffer.from(" ") })) });
  const result = await connection.call("lookupPay", { kldb: "84304" });
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? "", /403.*a wrong or outdated API key.*entgeltatlas obtain-key/s);
  assert.ok(!(result.content[0]?.text ?? "").includes(TEST_KEY));
  await connection.close();
});
