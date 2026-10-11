// Test helpers of the CLI: the log helpers and the CLI <-> library parity harness. The
// transport helpers (canned responses, the recording mock transport) live with the client,
// in packages/client/test/helpers.ts, and are re-exported here so every CLI test imports its
// helpers from one place.

import type { Transport, HttpRequest, HttpResponse } from "@maschinenlesbar.org/entgeltatlas-client/internal/http";
import { run } from "../src/cli/run.js";
import { EntgeltatlasClient } from "@maschinenlesbar.org/entgeltatlas-client/internal/client";
import { jsonResponse, makeMockTransport } from "@maschinenlesbar.org/entgeltatlas-client/test/helpers";

export * from "@maschinenlesbar.org/entgeltatlas-client/test/helpers";

// ---- the log on stderr -------------------------------------------------------

/**
 * stderr with each text record's timestamp taken off: `ERROR [entgeltatlas.api] HTTP 404 …`.
 * The format itself — timestamp, level, topic — is the conformance test's
 * (conformance-p23-log-format); the other tests check what was said, at which level
 * and under which topic.
 */
export function untimed(text: string): string {
  return text.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /gm, "");
}

/** One request as the parity helper records it. */
export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string> | undefined;
}

/** What `run()` did with one argv. */
export interface CliOutcome {
  code: number;
  out: string;
  err: string;
  requests: RecordedRequest[];
}

/** What one library call did. */
export interface LibOutcome {
  ok: boolean;
  value?: unknown;
  /** The thrown error, when `ok` is false. */
  error?: unknown;
  requests: RecordedRequest[];
}

export interface ParityOptions {
  /** Answers every request (both sides); defaults to `200 []`. */
  responder?: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>;
  /** The CLI's environment (ENTGELTATLAS_API_KEY); defaults to none. */
  env?: Record<string, string | undefined>;
}

function recorded(calls: readonly HttpRequest[]): RecordedRequest[] {
  return calls.map((c) => ({ method: c.method, url: c.url, headers: c.headers }));
}

/**
 * Drive one input through the CLI and through the library on ONE recording mock
 * transport, and return both outcomes so a test can assert they agree: either both
 * reject and send nothing, or both send the identical request.
 *
 * The CLI side runs `run(argv)` in-process with the real program; its client
 * factory and its `deps.transport` (obtain-key) both use the recording transport.
 * The library side gets the same transport and returns the call's promise, e.g.
 * `(transport) => new EntgeltatlasClient({ transport, apiKey: "k" }).entgelte("84304", { r: 31 })`.
 * A synchronous throw from the library call counts as a rejection too.
 */
export async function parity(
  argv: string[],
  libCall: (transport: Transport) => unknown,
  options: ParityOptions = {},
): Promise<{ cli: CliOutcome; lib: LibOutcome }> {
  // A valid answer for either endpoint kind: an empty (suppressed) salary list, or a
  // reference list, which is never empty.
  const mt = makeMockTransport(
    options.responder ??
      ((req) => jsonResponse(req.url.includes("/entgelte/") ? [] : [{ id: 1, bezeichnung: "Deutschland" }])),
  );
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    createClient: (opts) => new EntgeltatlasClient({ ...opts, transport: mt.transport }),
    env: options.env ?? {},
    transport: mt.transport,
  });
  const cliCalls = mt.calls.length;
  const cli: CliOutcome = {
    code,
    out: out.join("\n"),
    err: untimed(err.join("\n")),
    requests: recorded(mt.calls.slice(0, cliCalls)),
  };

  let lib: LibOutcome;
  try {
    const value = await libCall(mt.transport);
    lib = { ok: true, value, requests: recorded(mt.calls.slice(cliCalls)) };
  } catch (error) {
    lib = { ok: false, error, requests: recorded(mt.calls.slice(cliCalls)) };
  }
  return { cli, lib };
}
