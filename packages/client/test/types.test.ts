// Compile-time checks of the exported library types, and the runtime rule they rely on.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EntgeltatlasClient, dimensionCodeProblem, obtainKey } from "../src/index.js";
import { jsonResponse, makeMockTransport, rawResponse } from "./helpers.js";
import { entgelteResult } from "./fixtures.js";

// Runs the TypeScript compiler over a consumer file.
const STARTS_A_PROCESS = { timeout: 30_000 };
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const INDEX = fileURLToPath(new URL("../src/index.js", import.meta.url));

test("a consumer with the strictest compiler settings can pass undefined for any option", STARTS_A_PROCESS, async () => {
  // Under exactOptionalPropertyTypes, `{ apiKey: process.env.ENTGELTATLAS_API_KEY }` fails to
  // compile against an option declared `?: string`, although the runtime treats undefined as omitted.
  const dir = mkdtempSync(join(tmpdir(), "entgeltatlas-types-"));
  try {
    writeFileSync(
      join(dir, "use.ts"),
      [
        `import { EntgeltatlasClient, dimensionCodeProblem, obtainKey, type DimensionCodeWording, type EngineOptions, type EntgeltatlasClientOptions, type EntgelteOptions, type EntgelteParams, type ObtainKeyOptions } from ${JSON.stringify(INDEX)};`,
        "declare function allUndefined<T>(): { [K in keyof T]-?: undefined };",
        "export const engine: EngineOptions = allUndefined<EngineOptions>();",
        "export const clientOptions: EntgeltatlasClientOptions = allUndefined<EntgeltatlasClientOptions>();",
        "export const params: EntgelteParams = allUndefined<EntgelteParams>();",
        "export const options: EntgelteOptions = allUndefined<EntgelteOptions>();",
        "export const keyOptions: ObtainKeyOptions = allUndefined<ObtainKeyOptions>();",
        "export const wording: DimensionCodeWording = allUndefined<DimensionCodeWording>();",
        "export const client = new EntgeltatlasClient({ apiKey: process.env.ENTGELTATLAS_API_KEY, baseUrl: process.env.X, timeoutMs: 15_000 });",
        "export const rows = (region?: number) => client.entgelte(\"84304\", { r: region }, { allowUnknownFilters: undefined });",
        "export const key = () => obtainKey({ sourceUrl: process.env.X, userAgent: undefined });",
        "export const rule = dimensionCodeProblem(\"r\", { label: process.env.X });",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          module: "nodenext",
          moduleResolution: "nodenext",
          target: "es2022",
          noEmit: true,
          skipLibCheck: false,
          types: ["node"],
          typeRoots: [join(ROOT, "node_modules/@types")],
        },
        files: ["use.ts"],
      }),
    );
    const tsc = join(ROOT, "node_modules/typescript/bin/tsc");
    const result = await new Promise<{ code: number; out: string }>((resolve) => {
      execFile(process.execPath, [tsc, "-p", join(dir, "tsconfig.json")], (err, stdout, stderr) =>
        resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: stdout + stderr }),
      );
    });
    assert.equal(result.code, 0, result.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an option given as undefined means its default, as an omitted one does", async () => {
  const mt = makeMockTransport(() => jsonResponse(entgelteResult));
  const client = new EntgeltatlasClient({
    apiKey: undefined,
    baseUrl: undefined,
    userAgent: undefined,
    defaultHeaders: undefined,
    timeoutMs: undefined,
    maxRetries: undefined,
    retryDelayMs: undefined,
    maxRedirects: undefined,
    maxResponseBytes: undefined,
    sleep: undefined,
    onRetry: undefined,
    transport: mt.transport,
  });
  await client.entgelte("84304", { l: undefined, r: undefined, g: undefined, a: undefined, b: undefined }, { allowUnknownFilters: undefined });
  assert.equal(mt.calls[0]!.url, "https://rest.arbeitsagentur.de/infosysbub/entgeltatlas/pc/v1/entgelte/84304");
  assert.equal(mt.calls[0]!.headers?.["X-API-Key"], undefined);
  assert.match(mt.calls[0]!.headers?.["User-Agent"] ?? "", /entgeltatlas/);

  const page = makeMockTransport(() => rawResponse("<script>window.config = { clientId: 'infosysbub-ega' };</script>", "text/html"));
  const obtained = await obtainKey({
    transport: page.transport,
    sourceUrl: undefined,
    timeoutMs: undefined,
    maxResponseBytes: undefined,
    maxRetries: undefined,
    retryDelayMs: undefined,
    sleep: undefined,
    userAgent: undefined,
  });
  assert.equal(obtained.key, "infosysbub-ega");
  assert.equal(page.calls[0]!.url, "https://web.arbeitsagentur.de/entgeltatlas/");

  assert.equal(dimensionCodeProblem("r", { label: undefined, hint: undefined })(31), "Unknown code 31: valid codes are 1–30.");
});
