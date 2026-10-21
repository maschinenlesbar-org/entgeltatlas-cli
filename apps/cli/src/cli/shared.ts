// Shared helpers used across CLI command groups: option parsers, the global
// option resolver, and JSON rendering.

import { constants } from "node:buffer";
import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import { logOf, type CliDeps } from "./io.js";
import type { EntgeltatlasClientOptions } from "@maschinenlesbar.org/entgeltatlas-client/internal/client";
import { EntgeltatlasError, EntgeltatlasValidationError } from "@maschinenlesbar.org/entgeltatlas-client/internal/errors";
import { API_KEY_ENV_VAR } from "@maschinenlesbar.org/entgeltatlas-client/internal/obtain-key";
import { API_KEY_PHRASE, DEFAULT_BASE_URL, cleartextProblem, isBidiControl, type RetryEvent } from "@maschinenlesbar.org/entgeltatlas-client/internal/engine";
import { dimensionCodeProblem, type DimensionParam } from "@maschinenlesbar.org/entgeltatlas-client/internal/codes";
import {
  apiKeyProblem,
  baseUrlProblem,
  headerValueProblem,
  intRangeProblem,
  normalizeApiKey,
} from "@maschinenlesbar.org/entgeltatlas-client/internal/validate";

/** The name the API key is stored under in the credentials file (`entgeltatlas config set api-key`). */
export const API_KEY_CREDENTIAL = "api-key";

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
 * The program's command names (`program.commands` and commander's `help`; a test keeps the list in
 * step). Never a key: `--api-key` refuses one, and the run's redaction leaves one alone.
 */
export const COMMAND_NAMES = [
  "obtain-key",
  "config",
  "entgelte",
  "regionen",
  "geschlechter",
  "alter",
  "branchen",
  "codes",
  "help",
] as const;

/**
 * commander value-parser for `--api-key`. A blank flag would replace the key seeded
 * from ENTGELTATLAS_API_KEY and send none at all, so it is a usage error rather than
 * "unset" (the CLI's own rule). Otherwise the key gets the library's treatment —
 * trimmed by {@link normalizeApiKey}, then checked by {@link headerValueProblem} —
 * exactly as the env var and the client do.
 */
export function parseApiKey(value: string): string {
  parseNonEmpty(value);
  // `entgeltatlas --api-key $KEY entgelte 84304` with an empty, unquoted variable hands commander
  // the command as the key's value: say that, rather than "unknown command".
  if ((COMMAND_NAMES as readonly string[]).includes(value)) {
    throw new InvalidArgumentError(
      `"${value}" is an entgeltatlas command, not a key: --api-key needs the key after it (an empty or ` +
        `unset variable leaves it out). Pass the key, or leave --api-key out to use ${API_KEY_ENV_VAR} or the credentials file.`,
    );
  }
  const key = normalizeApiKey(value) as string;
  const reason = apiKeyProblem(key);
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
 * Escape the characters JSON.stringify leaves raw although a terminal acts on them. It
 * escapes C0 (including ESC) but not DEL, the C1 range U+0080–U+009F (U+009B is the 8-bit
 * form of CSI) or the bidi formatting characters (isBidiControl), which reorder the text that
 * follows. The output is server data, so escape them; the result is equivalent, valid JSON
 * (these characters only occur inside strings). Checked by char code so the source stays
 * free of control bytes.
 */
export function escapeControlChars(json: string): string {
  let result = "";
  let from = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if ((c >= 0x7f && c <= 0x9f) || isBidiControl(c)) {
      result += json.slice(from, i) + "\\u" + c.toString(16).padStart(4, "0");
      from = i + 1;
    }
  }
  return from === 0 ? json : result + json.slice(from);
}

/**
 * Writing the output failed: an answer too deeply nested or too large to print. An ERROR
 * record of `entgeltatlas.output`, exit 1.
 */
export class OutputError extends EntgeltatlasError {}

/** The longest string V8 makes (2^29 - 24 characters on 64-bit): a longer JSON text can't be printed at once. */
const MAX_TEXT_LENGTH = constants.MAX_STRING_LENGTH;

/**
 * JSON.stringify, pretty or compact. Printing can fail two ways, both an OutputError (exit 1)
 * that names the cause, never "Unexpected error":
 * - an answer nested too deeply (hostile or broken) overflows the stack: "nested too deeply";
 * - a text longer than V8's longest string ("Invalid string length"): "too large to print".
 * "try --compact" is added only when the compact form of this very answer prints: it is probed,
 * not assumed, because whether compact output survives deep nesting depends on the Node version
 * (on Node 26 only the fast path is iterative) and on the machine's stack.
 *
 * Compact output takes V8's fast path (no gap) unless the answer holds a huge string: on Node 26
 * the fast path aborts the process ("Zone Allocation failed", exit 134, a native dump on stderr)
 * on a string of some 250 MB that JSON.parse made, while the gap path (an empty gap, the same
 * text) prints it. The fast path stays the default because on Node 26 only it is iterative and
 * prints nesting the gap path refuses (~7,000 levels).
 */
function stringifyJson(value: unknown, compact: boolean): string {
  try {
    return compact ? stringifyCompact(value) : JSON.stringify(value, null, 2);
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    const deep = /call stack/i.test(err.message);
    const cause = deep ? "nested too deeply" : `too large (more than ${MAX_TEXT_LENGTH} characters of JSON)`;
    const hint = !compact && compactPrints(value) ? "; try --compact" : "";
    throw new OutputError(`The answer is ${cause} to ${compact ? "print" : "pretty-print"}${hint}.`, { cause: err });
  }
}

/** Compact JSON: the fast path, or the gap path for an answer holding a huge string. */
function stringifyCompact(value: unknown): string {
  return holdsHugeString(value) ? JSON.stringify(value, null, "") : JSON.stringify(value);
}

/** Whether `--compact` prints this answer on this runtime (the hint after a failed pretty-print). */
function compactPrints(value: unknown): boolean {
  try {
    return stringifyCompact(value).length <= MAX_TEXT_LENGTH;
  } catch {
    return false;
  }
}

/** A string or key this long sends --compact through the gap path: a quarter of where Node 26's fast path aborts. */
const HUGE_STRING_LENGTH = 64 * 1024 * 1024;

/**
 * Whether `value` holds a string or key of HUGE_STRING_LENGTH or more. Iterative, so nesting
 * costs no stack, linear, and without an allocation per value: an array is walked by index, an
 * object by `for…in` (own keys only: an answer's objects have none inherited), and only nested
 * objects and arrays are kept for later. (`Object.entries` made a pair per element: on an array
 * of 48M numbers that took 7 GB and crashed.)
 */
function holdsHugeString(value: unknown): boolean {
  if (typeof value === "string") return value.length >= HUGE_STRING_LENGTH;
  const pending: object[] = [];
  if (typeof value === "object" && value !== null) pending.push(value);
  for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
    if (Array.isArray(item)) {
      for (let i = 0; i < item.length; i++) {
        const element: unknown = item[i];
        if (typeof element === "string") {
          if (element.length >= HUGE_STRING_LENGTH) return true;
        } else if (typeof element === "object" && element !== null) pending.push(element);
      }
      continue;
    }
    const record = item as Record<string, unknown>;
    for (const key in record) {
      if (key.length >= HUGE_STRING_LENGTH) return true;
      const element = record[key];
      if (typeof element === "string") {
        if (element.length >= HUGE_STRING_LENGTH) return true;
      } else if (typeof element === "object" && element !== null) pending.push(element);
    }
  }
  return false;
}

/** Render a JSON value to stdout, pretty by default, compact with --compact. */
export function renderJson(deps: CliDeps, global: GlobalOptions, value: unknown): void {
  const text = escapeControlChars(stringifyJson(value, global.compact === true));
  deps.io.out(text);
}

/** `HTTP 503 from host: retry 1 of 3 in 2 s` (host only; whole seconds, ms under 1 s). */
export function retryMessage(event: RetryEvent): string {
  let host: string;
  try {
    host = new URL(event.url).host;
  } catch {
    host = "the server";
  }
  const why = event.status === undefined ? "connection reset" : `HTTP ${event.status}`;
  const wait = event.delayMs < 1000 ? `${event.delayMs} ms` : `${Math.round(event.delayMs / 1000)} s`;
  return `${why} from ${host}: retry ${event.retry} of ${event.maxRetries} in ${wait}`;
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
  const reason = apiKeyProblem(global.apiKey);
  if (reason !== undefined) throw new EntgeltatlasValidationError(`Invalid ${API_KEY_ENV_VAR}: ${reason}`);
}

function rootOf(command: Command): Command {
  let root = command;
  while (root.parent !== null) root = root.parent;
  return root;
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
    // flag > ENTGELTATLAS_API_KEY > the credentials file (`entgeltatlas config set
    // api-key`) > none. The file is read only here, when no key came from the first
    // two, so a problem with it never stands in the way of a key given another way.
    // A stored value `config set` would refuse (the file edited by hand) is an
    // EntgeltatlasError naming the file, never repeating the value
    // (`CredentialStore.usable`).
    if (options.apiKey === undefined && deps.credentials !== undefined) {
      const store = deps.credentials();
      // A secret of the run the moment it is read, whatever happens to it next.
      const raw = store.get(API_KEY_CREDENTIAL);
      if (raw !== undefined) deps.addSecret?.(raw);
      const stored = store.usable(API_KEY_CREDENTIAL);
      if (stored !== undefined) {
        options.apiKey = stored;
        // The 401/403 hint in run.ts names the file the rejected key came from.
        deps.storedKeyPath = store.path;
        // On the program too, source "config": the 401/403 hint in run.ts asks the
        // program whether a key was sent, and from where.
        rootOf(command).setOptionValueWithSource("apiKey", stored, "config");
      }
    }
    options.onRetry = (event) => logOf(deps).warn("http", retryMessage(event));
    // An answer delivered changed (invalid text replaced with U+FFFD) is never silent.
    options.onWarning = (message) => logOf(deps).warn("api", message);
    const client = deps.createClient(options);
    // Built first, so a key the client rejects is a usage error before any warning. One
    // warning per run, before the first request, when the base URL is plain http: to a host
    // other than loopback; help, version and usage errors never get here.
    const cleartext = cleartextProblem(
      options.baseUrl ?? DEFAULT_BASE_URL,
      options.apiKey !== undefined ? [API_KEY_PHRASE] : [],
    );
    if (cleartext !== undefined) logOf(deps).warn("http", cleartext);
    await fn({ client, global, opts: command.opts() }, positionals);
  };
}
