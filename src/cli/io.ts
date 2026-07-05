// I/O seam for the CLI. Everything the CLI writes goes through a CliIO object so
// tests can capture output instead of hitting the real stdout/stderr.

import type { EntgeltatlasClient, EntgeltatlasClientOptions } from "../client/client.js";

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
}

export interface CliDeps {
  io: CliIO;
  /** Build a client from the resolved global options (injectable for tests). */
  createClient(options: EntgeltatlasClientOptions): EntgeltatlasClient;
  /**
   * Environment variables the CLI reads (currently ENTGELTATLAS_API_KEY).
   * Injected so env-driven precedence is testable without mutating process.env.
   */
  env: Record<string, string | undefined>;
}

export const defaultIO: CliIO = {
  out: (text) => process.stdout.write(text + "\n"),
  err: (text) => process.stderr.write(text + "\n"),
};

/** Name of the environment variable that supplies the X-API-Key. */
export const API_KEY_ENV_VAR = "ENTGELTATLAS_API_KEY";
