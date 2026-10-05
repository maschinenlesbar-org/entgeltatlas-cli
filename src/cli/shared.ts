// Shared helpers used across CLI command groups: option parsers, the global
// option resolver, and JSON rendering.

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import type { CliDeps } from "./io.js";
import type { EntgeltatlasClientOptions } from "../client/client.js";
import { EntgeltatlasError, EntgeltatlasValidationError } from "../client/errors.js";
import { API_KEY_ENV_VAR } from "../client/obtain-key.js";
import { DEFAULT_BASE_URL, cleartextCredentialsProblem } from "../client/engine.js";
import { dimensionCodeProblem, type DimensionParam } from "../client/codes.js";
import {
  baseUrlProblem,
  headerValueProblem,
  intRangeProblem,
  normalizeApiKey,
} from "../client/validate.js";

/**
 * commander value-parser: a plain base-10 non-negative integer.
 *
 * Uses a strict regex rather than `Number()` coercion, which would otherwise
 * accept empty/whitespace strings (`Number("") === 0`), hex/binary/scientific
 * literals (`0x10`, `0b10`, `1e3`), signs, padding and decimals.
 */
export function parseIntArg(value: string): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  return n;
}

/**
 * commander value-parser for a free-text value: reject a blank one (`""` or only
 * whitespace). A blank `--api-key` would otherwise replace the key seeded from
 * ENTGELTATLAS_API_KEY and send none at all.
 */
export function parseNonEmpty(value: string): string {
  if (value.trim() === "") {
    throw new InvalidArgumentError("Expected a non-empty value.");
  }
  return value;
}

/**
 * commander value-parser for `--api-key`. A blank flag would replace the key seeded
 * from ENTGELTATLAS_API_KEY and send none at all, so it is a usage error rather than
 * "unset" (the CLI's own rule). Otherwise the key gets the library's treatment —
 * trimmed by {@link normalizeApiKey}, then checked by {@link headerValueProblem} —
 * exactly as the env var and the client do.
 */
export function parseApiKey(value: string): string {
  parseNonEmpty(value);
  const key = normalizeApiKey(value) as string;
  const reason = headerValueProblem(key);
  if (reason !== undefined) throw new InvalidArgumentError(reason);
  return key;
}

/**
 * commander value-parser for a value that ends up in an HTTP header
 * (`--user-agent`). The rule is the library's {@link headerValueProblem} — blank,
 * control characters other than tab, and characters above U+00FF are rejected — so
 * a bad value is a usage error (exit 2) here, as it is in the client.
 */
export function parseHeaderValue(value: string): string {
  const reason = headerValueProblem(value);
  if (reason !== undefined) throw new InvalidArgumentError(reason);
  return value;
}

/**
 * Build a commander value-parser for an integer constrained to [min, max]: a plain
 * integer (parseIntArg), then the library's {@link intRangeProblem}, the rule the
 * engine applies to the same option.
 */
export function parseBoundedInt(min: number, max: number): (value: string) => number {
  const problem = intRangeProblem(min, max);
  return (value: string) => {
    const n = parseIntArg(value);
    const reason = problem(n);
    if (reason !== undefined) throw new InvalidArgumentError(reason);
    return n;
  };
}

/** The CLI flag of each dimension (the library's DIMENSIONS has no CLI names). */
export const DIMENSION_FLAGS: Record<DimensionParam, string> = {
  l: "--level",
  r: "--region",
  g: "--gender",
  a: "--age",
  b: "--branch",
};

/**
 * commander value-parser for one dimension (`l`, `r`, `g`, `a` or `b`): a plain
 * integer (parseIntArg), then the library's {@link dimensionCodeProblem} — a code
 * from that dimension's table, the one `entgeltatlas codes` prints — so the CLI
 * and the client accept the same codes. The reason names the flag.
 */
export function parseDimensionCode(param: DimensionParam): (value: string) => number {
  const problem = dimensionCodeProblem(param, {
    label: DIMENSION_FLAGS[param],
    hint: "see `entgeltatlas codes`",
  });
  return (value: string) => {
    const n = parseIntArg(value);
    const reason = problem(n);
    if (reason !== undefined) throw new InvalidArgumentError(reason);
    return n;
  };
}

/**
 * commander value-parser for a KldB-2010 occupation code: 3–5 ASCII digits.
 * Fails fast on an obviously-invalid code (e.g. an occupation name) before any
 * request is made.
 */
export function parseKldb(value: string): string {
  if (!/^[0-9]{3,5}$/.test(value)) {
    throw new InvalidArgumentError(
      "Expected a 3–5 digit KldB-2010 code (e.g. 84304). This API takes the numeric code, not an occupation name.",
    );
  }
  return value;
}

/**
 * commander value-parser for `--base-url`: the library's {@link baseUrlProblem}
 * (http(s) only, no query or fragment, no surrounding whitespace), so a bad value is
 * a usage error (exit 2) at parse time, as it is an EntgeltatlasValidationError in
 * the client. The CLI keeps no rules of its own.
 */
export function parseBaseUrl(value: string): string {
  const reason = baseUrlProblem(value);
  if (reason !== undefined) throw new InvalidArgumentError(reason);
  return value;
}

export interface GlobalOptions {
  baseUrl?: string;
  apiKey?: string;
  timeout?: number;
  userAgent?: string;
  maxRetries?: number;
  maxResponseBytes?: number;
  compact?: boolean;
}

/** Translate resolved global CLI options into client options. */
export function toEngineOptions(global: GlobalOptions): EntgeltatlasClientOptions {
  const options: EntgeltatlasClientOptions = {};
  if (global.baseUrl !== undefined) options.baseUrl = global.baseUrl;
  if (global.apiKey !== undefined) options.apiKey = global.apiKey;
  if (global.timeout !== undefined) options.timeoutMs = global.timeout;
  if (global.userAgent !== undefined) options.userAgent = global.userAgent;
  if (global.maxRetries !== undefined) options.maxRetries = global.maxRetries;
  if (global.maxResponseBytes !== undefined) options.maxResponseBytes = global.maxResponseBytes;
  return options;
}

/**
 * Escape the control characters JSON.stringify leaves raw. It escapes C0 (including
 * ESC) but not DEL or the C1 range U+0080–U+009F, and terminals may act on those —
 * U+009B is the 8-bit form of CSI. The output is server data, so escape them; the
 * result is equivalent, valid JSON (these characters only occur inside strings).
 * Checked by char code so the source stays free of control bytes.
 */
export function escapeControlChars(json: string): string {
  let result = "";
  let from = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (c >= 0x7f && c <= 0x9f) {
      result += json.slice(from, i) + "\\u" + c.toString(16).padStart(4, "0");
      from = i + 1;
    }
  }
  return from === 0 ? json : result + json.slice(from);
}

/**
 * JSON.stringify, pretty or compact. A deeply nested value (a hostile or broken
 * response) overflows the stack — the pretty form far sooner than the compact one,
 * which is why the message suggests --compact. The RangeError becomes an
 * EntgeltatlasError so the CLI prints a clear message instead of "Unexpected error:
 * Maximum call stack size exceeded".
 */
function stringifyJson(value: unknown, compact: boolean): string {
  try {
    return compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  } catch (err) {
    if (err instanceof RangeError) {
      throw new EntgeltatlasError(
        compact
          ? "The response is nested too deeply to print."
          : "The response is nested too deeply to pretty-print; try --compact.",
        { cause: err },
      );
    }
    throw err;
  }
}

/** Render a JSON value to stdout, pretty by default, compact with --compact. */
export function renderJson(deps: CliDeps, global: GlobalOptions, value: unknown): void {
  const text = escapeControlChars(stringifyJson(value, global.compact === true));
  deps.io.out(text);
}

export interface ActionContext {
  client: ReturnType<CliDeps["createClient"]>;
  global: GlobalOptions;
  /** This command's own parsed options. */
  opts: Record<string, unknown>;
}

/**
 * A key that came from ENTGELTATLAS_API_KEY (not from --api-key) is checked by the
 * library's rule (headerValueProblem) here, before the client is built, so the error
 * names the variable the user has to fix — `Invalid ENTGELTATLAS_API_KEY: …` rather
 * than the client's `Invalid apiKey: …` — and never repeats the value. Only commands
 * that build a client call this: help, `codes` and `obtain-key` never read the key.
 */
export function assertEnvKey(command: Command, global: GlobalOptions): void {
  if (global.apiKey === undefined || command.getOptionValueSourceWithGlobals("apiKey") !== "env") return;
  const reason = headerValueProblem(global.apiKey);
  if (reason !== undefined) throw new EntgeltatlasValidationError(`Invalid ${API_KEY_ENV_VAR}: ${reason}`);
}

/**
 * Wrap an async command action with consistent global-option resolution and
 * client construction. The callback receives a context (client + resolved global
 * options + this command's options) and the command's positional arguments.
 *
 * Commander invokes actions as (arg1, ..., argN, options, command); we slice off
 * the trailing options object and command instance to recover the positionals.
 */
export function action(
  deps: CliDeps,
  fn: (ctx: ActionContext, positionals: string[]) => Promise<void>,
): (...args: unknown[]) => Promise<void> {
  return async (...args: unknown[]) => {
    const command = args[args.length - 1] as Command;
    const positionals = args.slice(0, Math.max(0, args.length - 2)) as string[];
    const global = command.optsWithGlobals() as GlobalOptions;
    assertEnvKey(command, global);
    const options = toEngineOptions(global);
    const client = deps.createClient(options);
    // Built first, so a key the client rejects is a usage error before any warning.
    const cleartext = cleartextCredentialsProblem(options.baseUrl ?? DEFAULT_BASE_URL, options.apiKey !== undefined);
    if (cleartext !== undefined) deps.io.err(`warning: ${cleartext} Use an https base URL.`);
    await fn({ client, global, opts: command.opts() }, positionals);
  };
}
