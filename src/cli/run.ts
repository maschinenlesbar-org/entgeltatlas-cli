// Run the CLI and resolve to a process exit code. Kept separate from the bin
// shim so tests can call run() directly with injected deps and assert on the
// captured output and exit code without spawning a subprocess.

import { CommanderError, type Command } from "commander";
import { buildProgram, defaultDeps } from "./program.js";
import type { CliDeps } from "./io.js";
import { API_KEY_ENV_VAR } from "./io.js";
import {
  EntgeltatlasApiError,
  EntgeltatlasError,
  EntgeltatlasKeySourceError,
  EntgeltatlasNetworkError,
  EntgeltatlasValidationError,
} from "../client/errors.js";

/**
 * Process exit codes. Distinct codes let scripts tell apart a usage error, an
 * auth/WAF rejection, a missing resource, a transport failure, and a catch-all.
 */
const EXIT = {
  /** Usage / parse / client-side validation error. */
  USAGE: 2,
  /** 401/403 — the request was rejected (bad key OR a WAF/IP block). */
  AUTH: 3,
  /** 404 — resource not found. */
  NOT_FOUND: 4,
  /** Network / transport failure (DNS, connection, timeout, size-cap). */
  NETWORK: 6,
  /** Any other error. */
  OTHER: 1,
} as const;

/**
 * Apply exitOverride + output redirection to every command in the tree.
 * commander does not propagate these to subcommands, so a parse error on a
 * subcommand would otherwise call process.exit() and bypass our error handling.
 */
function configureTree(command: Command, deps: CliDeps): void {
  command.exitOverride();
  command.configureOutput({
    writeOut: (str) => deps.io.out(str.replace(/\n$/, "")),
    writeErr: (str) => deps.io.err(str.replace(/\n$/, "")),
  });
  for (const child of command.commands) configureTree(child, deps);
}

export async function run(argv: string[], deps: CliDeps = defaultDeps): Promise<number> {
  const program = buildProgram(deps);
  configureTree(program, deps);

  // A bare invocation (no command) is a help request, not an error: print help
  // to stdout and exit 0, matching `--help`.
  if (argv.length === 0) {
    deps.io.out(program.helpInformation().replace(/\n$/, ""));
    return 0;
  }

  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) {
      // Help/version requests exit 0; every genuine usage/parse error maps to a
      // single USAGE code (commander's own exitCode is 1, indistinguishable from
      // the catch-all).
      return err.exitCode === 0 ? 0 : EXIT.USAGE;
    }
    // Client-side validation (e.g. a malformed KldB code) — a usage error.
    if (err instanceof EntgeltatlasValidationError) {
      deps.io.err(`Error: ${err.message}`);
      return EXIT.USAGE;
    }
    // obtain-key could not read the published key: a 404 is "not found", but a
    // 401/403 from the key source says nothing about an API key (so not exit 3).
    if (err instanceof EntgeltatlasKeySourceError) {
      deps.io.err(`Error: ${err.message}`);
      return err.status === 404 ? EXIT.NOT_FOUND : EXIT.OTHER;
    }
    if (err instanceof EntgeltatlasApiError) {
      deps.io.err(`Error: ${err.message}`);
      if (err.status === 404) return EXIT.NOT_FOUND;
      if (err.status === 401 || err.status === 403) {
        // An empty-body 403 is ambiguous: the rest.arbeitsagentur.de gateway sends the
        // same text/plain one-space 403 for a wrong or missing X-API-Key, for a
        // refused network (WAF), and — seen on every Entgeltatlas endpoint in
        // 2026-09, while a sibling BA API on the same gateway answered — for the
        // published static key itself. Say which key situation applies and name
        // every cause without ruling one out.
        const sentKey = typeof program.opts()["apiKey"] === "string";
        deps.io.err(
          sentKey
            ? `Hint: the API rejected the request (${err.status}). Check --api-key / the ` +
                `${API_KEY_ENV_VAR} env var against \`entgeltatlas obtain-key\`. An empty 403 ` +
                "looks the same for a wrong key, a refused network (WAF/IP block) and a key the " +
                "API no longer accepts: the published static key has been answered this way, and " +
                "upstream documents an OAuth client-credentials flow this CLI does not implement. " +
                "See the README's 403 heads-up."
            : `Hint: the API rejected the request (${err.status}) and no X-API-Key was sent. ` +
                `Pass --api-key or set ${API_KEY_ENV_VAR} (\`entgeltatlas obtain-key\` prints ` +
                "the published key).",
        );
        return EXIT.AUTH;
      }
      return EXIT.OTHER;
    }
    if (err instanceof EntgeltatlasNetworkError) {
      deps.io.err(`Error: ${err.message}`);
      if (/maxResponseBytes/.test(err.message)) {
        deps.io.err(
          "Hint: the response exceeded the size cap. Raise it with --max-response-bytes <n> (0 = unlimited).",
        );
      }
      return EXIT.NETWORK;
    }
    if (err instanceof EntgeltatlasError) {
      deps.io.err(`Error: ${err.message}`);
      return EXIT.OTHER;
    }
    deps.io.err(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.OTHER;
  }
}
