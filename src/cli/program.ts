// Assemble the full commander program. The program is built around an injectable
// CliDeps so the entire CLI can be driven in tests with a mocked client and
// captured output.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import type { CliDeps } from "./io.js";
import { defaultIO, API_KEY_ENV_VAR } from "./io.js";
import { EntgeltatlasClient } from "../client/client.js";
import { parseIntArg, parseBaseUrl } from "./shared.js";
import { registerCommands } from "./commands/entgelte.js";

/**
 * Single source of truth for the version: read from package.json at runtime
 * rather than duplicating a literal that can silently drift after a release bump.
 * From the compiled location (dist/src/cli/program.js) package.json is three
 * directories up; the same offset holds for the source under src/cli.
 */
function readVersion(): string {
  try {
    const pkgUrl = new URL("../../../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION = readVersion();

/** Default dependencies: real client + real stdout/stderr + real env. */
export const defaultDeps: CliDeps = {
  io: defaultIO,
  createClient: (options) => new EntgeltatlasClient(options),
  env: process.env,
};

export function buildProgram(deps: CliDeps = defaultDeps): Command {
  const program = new Command();

  program
    .name("entgeltatlas")
    .description(
      "CLI for the Bundesagentur für Arbeit Entgeltatlas API " +
        "(rest.arbeitsagentur.de/infosysbub/entgeltatlas) — median gross-monthly " +
        "salary statistics by KldB-2010 occupation. Requires an X-API-Key: pass " +
        `--api-key or set ${API_KEY_ENV_VAR} (a public key is published at ` +
        "github.com/bundesAPI/entgeltatlas-api; fetch it with `npm run fetch-key`). " +
        "This API takes numeric KldB codes, not occupation names, and has no name search.",
    )
    .version(VERSION)
    .option("--base-url <url>", "API base URL", parseBaseUrl, "https://rest.arbeitsagentur.de")
    .option("--api-key <key>", `X-API-Key header value (env: ${API_KEY_ENV_VAR})`)
    .option("--timeout <ms>", "per-request timeout in milliseconds", parseIntArg)
    .option("--user-agent <ua>", "User-Agent header value")
    .option("--max-retries <n>", "retries for transient 429/503 responses", parseIntArg)
    .option(
      "--max-response-bytes <n>",
      "cap response body size in bytes (0 = unlimited; default 100 MiB)",
      parseIntArg,
    )
    .option("--compact", "print JSON on a single line instead of pretty-printed")
    .showHelpAfterError();

  // Seed --api-key from ENTGELTATLAS_API_KEY (trimmed; blank treated as unset).
  // commander treats this as the option's value, which an explicit --api-key on
  // the command line overrides during parse: flag > env var > none.
  const envKey = deps.env[API_KEY_ENV_VAR];
  if (typeof envKey === "string" && envKey.trim().length > 0) {
    program.setOptionValue("apiKey", envKey.trim());
  }

  registerCommands(program, deps);

  return program;
}
