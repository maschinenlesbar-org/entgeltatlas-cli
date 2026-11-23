// How the MCP server reaches this repository's client. The server's generic files (server.ts,
// limiter.ts, config.ts, run.ts, result.ts, credentials.ts: the kit, the same in every
// repository) import the client only through this file, under the names below; the names on the
// right are this client's. Per repository, like tools.ts: a client whose names or functions differ
// adapts here.
//
// The Entgeltatlas API needs its public X-API-Key. No key is bundled: `findCredentials` (the kit's
// hook, credentials.ts) takes it, at the first tool call, from ENTGELTATLAS_API_KEY, else from the
// credentials file `entgeltatlas config set api-key` writes, else obtains the published key with
// the client's obtainKey, as `entgeltatlas obtain-key` does. Never from argv.

import { API_KEY_CREDENTIAL, CredentialStore } from "@maschinenlesbar.org/entgeltatlas-client/internal/credentials";
import { DEFAULT_BASE_URL } from "@maschinenlesbar.org/entgeltatlas-client";
import { API_KEY_ENV_VAR, obtainKey } from "@maschinenlesbar.org/entgeltatlas-client/internal/obtain-key";
import { EntgeltatlasError, EntgeltatlasValidationError } from "@maschinenlesbar.org/entgeltatlas-client/internal/errors";
import { apiKeyProblem } from "@maschinenlesbar.org/entgeltatlas-client/internal/validate";
import type { CredentialContext, FoundCredentials } from "./credentials.js";

export {
  EntgeltatlasClient as Client,
  EntgeltatlasError as ClientError,
  EntgeltatlasNetworkError as NetworkError,
  baseUrlProblem,
  DEFAULT_BASE_URL,
  MAX_TIMEOUT_MS,
  nodeHttpTransport,
  type HttpRequest,
  type HttpResponse,
  type Transport,
} from "@maschinenlesbar.org/entgeltatlas-client";
export { sizeLimitMessage } from "@maschinenlesbar.org/entgeltatlas-client/internal/http";
export { cutText, toWellFormed } from "@maschinenlesbar.org/entgeltatlas-client/internal/errors";

/** The service's path under the host: every endpoint is below it. */
export const SERVICE_PATH = "/infosysbub/entgeltatlas/pc/v1";

/** The API's base URL as a result's `source` starts with it (`--base-url`, else the default, and the service's path). */
export function apiBase(baseUrl: string | undefined): string {
  return `${(baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")}${SERVICE_PATH}`;
}

/** The longest obtainKey waits before a retry of its own in this server (ms); the limiter holds the rest of a 429's. */
const KEY_RETRY_WAIT_MS = 1000;

/**
 * The API key, in this order: ENTGELTATLAS_API_KEY from the server's environment (what an MCP
 * client's config sets), the credentials file (`entgeltatlas config set api-key`; only when the
 * server runs from its bin), or the public key obtained from the BA's Entgeltatlas web app. An
 * ENTGELTATLAS_API_KEY no header can carry, and a stored value the CLI would refuse too, are errors
 * naming the fix: never silently skipped. A key that can't be obtained says how to give one.
 * Every form of the key is a secret of the server from here on.
 */
export async function findCredentials(context: CredentialContext): Promise<FoundCredentials> {
  const fromEnv = context.env[API_KEY_ENV_VAR];
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    const key = fromEnv.trim();
    const problem = apiKeyProblem(key);
    if (problem !== undefined) throw new EntgeltatlasValidationError(`Invalid ${API_KEY_ENV_VAR} in the server's environment: ${problem}`);
    return { clientOptions: { apiKey: key }, secrets: [fromEnv, key], source: `the API key from the ${API_KEY_ENV_VAR} environment variable` };
  }
  if (context.credentialsFile) {
    const store = CredentialStore.fromEnv(context.env);
    const raw = store.get(API_KEY_CREDENTIAL);
    // A stored value the CLI would refuse is an error naming the file and the fix (usable()).
    const stored = store.usable(API_KEY_CREDENTIAL);
    if (stored !== undefined) {
      return { clientOptions: { apiKey: stored }, secrets: [raw ?? stored, stored], source: `the API key stored in ${store.path} (entgeltatlas config)` };
    }
  }
  try {
    const obtained = await obtainKey({
      transport: context.transport,
      timeoutMs: context.timeoutMs,
      userAgent: context.userAgent,
      maxResponseBytes: context.maxResponseBytes,
      // A 429's Retry-After is the server's limiter's to hold (the transport is the limited one):
      // it pauses the key source's origin, logs the hold, and fails at once a call it would hold
      // past its deadline. obtainKey's own wait, unseen by the limiter and the log, is kept short.
      sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, KEY_RETRY_WAIT_MS))),
    });
    return {
      clientOptions: { apiKey: obtained.key },
      secrets: [obtained.key],
      source: `the public API key obtained from ${obtained.sourceUrl} (${API_KEY_ENV_VAR} is not set${context.credentialsFile ? " and no key is stored" : ""})`,
    };
  } catch (err) {
    if (err instanceof EntgeltatlasError) {
      err.message = `${err.message} The server could not obtain the public API key; it tries again at the next call. Or set ${API_KEY_ENV_VAR} in the server's environment (\`entgeltatlas obtain-key\` prints the key) and restart it.`;
    }
    throw err;
  }
}
