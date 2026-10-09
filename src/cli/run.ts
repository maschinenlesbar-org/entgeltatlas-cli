// Run the CLI and resolve to a process exit code. Kept separate from the bin
// shim so tests can call run() directly with injected deps and assert on the
// captured output and exit code without spawning a subprocess.

import { CommanderError, type Command } from "commander";
import { buildProgram, defaultDeps } from "./program.js";
import { logOf, type CliDeps } from "./io.js";
import { createLogger, logFormatFromArgv } from "./log.js";
import { API_KEY_ENV_VAR } from "./io.js";
import {
  EntgeltatlasApiError,
  EntgeltatlasError,
  EntgeltatlasKeySourceError,
  EntgeltatlasNetworkError,
  EntgeltatlasValidationError,
  credentialsIn,
  redactCredentials,
  redactSecrets,
} from "../client/errors.js";
import { looksLikeApiKey } from "../client/obtain-key.js";

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
  rejectRepeatedOptions(command);
  command.configureOutput({
    writeOut: (str) => deps.io.out(str.replace(/\n$/, "")),
    // commander's own messages are log records too: its "error: …" an ERROR, the help it
    // shows after one an INFO.
    writeErr: (str) => {
      const text = str.replace(/\n$/, "");
      // The blank line commander writes between an error and the help it shows after.
      if (text === "") return;
      if (text.startsWith("error: ")) logOf(deps).error("cli", text.slice("error: ".length));
      else logOf(deps).info("cli", text);
    },
    // The error message alone (help after an error goes through writeErr): escape it,
    // keeping the line break before commander's own "(Did you mean …?)" hint.
    outputError: (str, write) => write(escapeCommanderError(str.replace(/\n$/, ""))),
  });
  for (const child of command.commands) configureTree(child, deps);
}

/**
 * Make a repeated single-value option a usage error (P10). Commander keeps the last
 * value of `-g 2 -g 3` without a word, so a user comparing Männer and Frauen in one
 * call silently gets one slice. Every option of `command` that takes a value counts its
 * occurrences (commander emits `option:<name>` once per occurrence, after its value
 * parser); the second one throws — naming the option, never the value.
 */
function rejectRepeatedOptions(command: Command): void {
  for (const option of command.options) {
    if (!(option.required || option.optional) || option.variadic) continue;
    let seen = 0;
    command.on(`option:${option.name()}`, () => {
      seen += 1;
      if (seen > 1) {
        throw new EntgeltatlasValidationError(
          `option '${option.flags}' was given more than once; it takes one value` +
            (["level", "region", "gender", "age", "branch"].includes(option.name())
              ? " (run one call per slice)."
              : "."),
        );
      }
    });
  }
}

/**
 * Escape the characters a terminal acts on in one commander error message: C0 controls
 * (newline included, tab excepted), DEL, C1 and Unicode format characters (bidi
 * overrides, zero-width characters) become `\uXXXX`. Commander repeats a rejected
 * value raw (`option '--user-agent <ua>' argument '<value>' is invalid`), and an ESC
 * in it would clear the screen or set the window title.
 */
export function escapeTerminalText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]|\p{Cf}/gu, (ch) =>
    Array.from({ length: ch.length }, (_, i) => `\\u${ch.charCodeAt(i).toString(16).padStart(4, "0")}`).join(""),
  );
}

/**
 * escapeTerminalText for one commander error message, except for the
 * `\n(Did you mean …?)` line commander appends after an unknown command or option:
 * that hint is built from this CLI's own names and can only end the message.
 */
export function escapeCommanderError(message: string): string {
  const hint = /\n\(Did you mean [^\n]*\?\)$/.exec(message);
  if (hint === null) return escapeTerminalText(message);
  return escapeTerminalText(message.slice(0, hint.index)) + hint[0];
}

/** The options whose value is a secret on its own (no `@` to anchor a redaction on). */
const SECRET_FLAGS = ["--api-key"];

/**
 * `deps` with an `io` that keeps the secrets of this run out of everything it
 * prints. Commander echoes a rejected value in its usage errors (`option '--api-key
 * <key>' argument '<the key>' is invalid`) and names an unknown command or option as
 * typed, so whatever path a secret takes to the terminal it is replaced:
 *
 * - the userinfo of every URL-like argument and `--opt=value` value (as
 *   `credentialsIn` finds it, parseable or not) becomes `***@`, on stdout and stderr;
 * - the value of `--api-key` (both forms), the `ENTGELTATLAS_API_KEY` value and any
 *   argument shaped like a UUID key (`looksLikeApiKey`: a key typed without
 *   `--api-key`) become `***` on stderr. Not on stdout: `obtain-key` prints the key
 *   there, and it may well be the one already in `ENTGELTATLAS_API_KEY`.
 *
 * Each secret is matched as given, trimmed, terminal-escaped (commander's messages are
 * escaped first, see escapeTerminalText) and JSON-escaped. A pattern alone can't
 * delimit a password with spaces, quotes, `#`, `?` or `/`; the exact strings can.
 * Without secrets the output passes through unchanged.
 */
export function withRedactedOutput(deps: CliDeps, argv: readonly string[]): CliDeps {
  const env = deps.env ?? process.env;
  // An `--option=value` token is echoed as its value alone.
  const values = argv.map((token) =>
    token.startsWith("-") && token.includes("=") ? token.slice(token.indexOf("=") + 1) : token,
  );
  const envKey = env[API_KEY_ENV_VAR] ?? "";
  const forms = (value: string): string[] => [value, escapeTerminalText(value), JSON.stringify(value).slice(1, -1)];
  const userinfo = new Set<string>();
  for (const source of [...argv, ...values, envKey]) {
    for (const secret of credentialsIn(source)) for (const form of forms(secret)) userinfo.add(form);
  }
  const keys = new Set<string>();
  const addKey = (value: string | undefined): void => {
    if (value === undefined) return;
    for (const trimmed of [value, value.trim()]) for (const form of forms(trimmed)) keys.add(form);
  };
  addKey(envKey);
  argv.forEach((token, i) => {
    if (SECRET_FLAGS.includes(token)) addKey(argv[i + 1]);
    const eq = token.indexOf("=");
    if (eq > 0 && SECRET_FLAGS.includes(token.slice(0, eq))) addKey(token.slice(eq + 1));
  });
  for (const value of values) if (looksLikeApiKey(value)) addKey(value);
  if (userinfo.size === 0 && [...keys].every((k) => k.trim().length < 4)) return deps;
  const urlList = [...userinfo];
  // Longest first, so a key is never left half-replaced by one of its own substrings.
  const keyList = [...keys].sort((a, b) => b.length - a.length);
  const redactOut = (text: string): string => redactCredentials(text, urlList);
  const redactErr = (text: string): string => redactSecrets(redactOut(text), keyList);
  return {
    ...deps,
    io: { ...deps.io, out: (text) => deps.io.out(redactOut(text)), err: (text) => deps.io.err(redactErr(text)) },
  };
}

export async function run(argv: string[], deps: CliDeps = defaultDeps): Promise<number> {
  deps = withRedactedOutput(deps, argv);
  // Every record goes through the redacted `io.err`, so a secret is kept out of the
  // log in either format.
  const redacted = deps;
  deps = {
    ...deps,
    log: createLogger({ format: logFormatFromArgv(argv), write: (line) => redacted.io.err(line), ...(deps.now === undefined ? {} : { now: deps.now }) }),
  };
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
    const log = logOf(deps);
    // Client-side validation (e.g. a malformed KldB code) — a usage error.
    if (err instanceof EntgeltatlasValidationError) {
      log.error("cli", err.message);
      return EXIT.USAGE;
    }
    // obtain-key could not read the published key: a 404 is "not found", but a
    // 401/403 from the key source says nothing about an API key (so not exit 3).
    if (err instanceof EntgeltatlasKeySourceError) {
      log.error("obtain-key", err.message);
      return err.status === 404 ? EXIT.NOT_FOUND : EXIT.OTHER;
    }
    if (err instanceof EntgeltatlasApiError) {
      log.error("api", err.message);
      if (err.status === 404) return EXIT.NOT_FOUND;
      if (err.status === 401 || err.status === 403) {
        // A redirect to another origin (an http: base URL answered with https: is the
        // usual case) dropped the key: the message says so and what to do, and the
        // key itself is fine, so no key hint.
        if (err.credentialsDropped !== undefined) return EXIT.AUTH;
        // An empty-body 403 is ambiguous: the rest.arbeitsagentur.de gateway sends the
        // same text/plain 403 for a wrong, stale or missing X-API-Key and for a refused
        // network (WAF). The stale case is real: in 2026 the BA replaced the UUID
        // client_id the bundesAPI README still publishes, and the gateway refuses it
        // (investigated 2026-10-06). Say which key situation applies and name every
        // cause without ruling one out.
        const sentKey = typeof program.opts()["apiKey"] === "string";
        log.info(
          "api",
          sentKey
            ? `the API rejected the request (${err.status}). Check --api-key / the ` +
                `${API_KEY_ENV_VAR} env var / the stored key (\`entgeltatlas config get api-key\`) ` +
                "against `entgeltatlas obtain-key`. An empty 403 " +
                "looks the same for a wrong key, a stale one and a refused network (WAF/IP block). " +
                "The BA changed the key in 2026: the UUID client_id the bundesAPI README still " +
                "publishes is refused, and `obtain-key` reads the current one from the BA web app. " +
                "See the README's 403 heads-up."
            : `the API rejected the request (${err.status}) and no X-API-Key was sent. ` +
                `Pass --api-key, set ${API_KEY_ENV_VAR}, or store it with \`entgeltatlas config set api-key\` ` +
                "(`entgeltatlas obtain-key` prints the published key).",
        );
        return EXIT.AUTH;
      }
      return EXIT.OTHER;
    }
    if (err instanceof EntgeltatlasNetworkError) {
      log.error("http", err.message);
      if (/maxResponseBytes/.test(err.message)) {
        log.info(
          "http",
          "the response exceeded the size cap. Raise it with --max-response-bytes <n> (0 = unlimited).",
        );
      }
      return EXIT.NETWORK;
    }
    if (err instanceof EntgeltatlasError) {
      log.error("cli", err.message);
      return EXIT.OTHER;
    }
    log.error("cli", `Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.OTHER;
  }
}
