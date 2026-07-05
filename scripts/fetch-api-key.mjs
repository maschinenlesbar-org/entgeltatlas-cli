#!/usr/bin/env node
// Fetch the public Entgeltatlas `X-API-Key` from the authoritative upstream
// source.
//
// The key is NOT bundled with the client or the CLI (see src/client/client.ts).
// This script exists so the key can be obtained out-of-band when one is genuinely
// needed — i.e. for CI / local integration runs that hit the live API. It MUST
// NOT be wired into the CLI or any production code path: resolve the key here,
// outside the program, and hand it in via `--api-key` or the ENTGELTATLAS_API_KEY
// environment variable. Typical CI usage:
//
//   ENTGELTATLAS_API_KEY="$(node scripts/fetch-api-key.mjs)" npm test
//
// The BA Entgeltatlas API authenticates with a static `X-API-Key` whose value is
// the published community `client_id` UUID. The bundesAPI README is the
// machine-readable source of truth (the api.bund.dev docs site is a JS SPA).
// Scraped with a simple regex on purpose — no HTML parser, no dependencies.
//
// NOTE: the live API sits behind an Akamai WAF that returns HTTP 403 to
// datacenter/cloud IPs even with a valid key — a fetched key is no guarantee the
// request will succeed from CI; run integration checks from a residential IP.

import { fileURLToPath } from "node:url";
import process from "node:process";

/** Authoritative, plain-text source of the public key. */
export const SOURCE_URL =
  "https://raw.githubusercontent.com/bundesAPI/entgeltatlas-api/main/README.md";

/** The key is a UUID, documented as an `X-API-Key` value or a `client_id`. */
const KEY_PATTERNS = [
  /X-API-Key[:=]\s*["'`]?([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/i,
  /client_id[":=\s]+["'`]?([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/i,
];

/**
 * Fetch the source and scrape the public key. Throws on a non-OK response or
 * when no key can be found (so callers/CI fail loudly).
 */
export async function fetchApiKey() {
  const res = await fetch(SOURCE_URL, {
    headers: { "User-Agent": "entgeltatlas-cli fetch-api-key" },
  });
  if (!res.ok) {
    throw new Error(`Could not fetch ${SOURCE_URL}: HTTP ${res.status}`);
  }
  const text = await res.text();
  for (const pattern of KEY_PATTERNS) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  throw new Error(`No X-API-Key / client_id UUID found in ${SOURCE_URL}`);
}

// Run as a script: print just the key to stdout (so it composes in shells and
// CI), or the error to stderr with a non-zero exit.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.stdout.write((await fetchApiKey()) + "\n");
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
