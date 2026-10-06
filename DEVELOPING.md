# Developing `entgeltatlas-cli`

This repo follows the shared `*-cli` two-layer blueprint (a typed,
dependency-free client + a commander CLI, both driven through injectable seams).
It was scaffolded from `ausbildungssuche-cli`, its closest sibling — both wrap BA
`infosysbub` APIs on the `rest.arbeitsagentur.de` gateway with the same static
`X-API-Key` auth. This document records what is **specific** to the Entgeltatlas
API — read it alongside [GLOSSARY.md](GLOSSARY.md).

## Layout

```
src/
  client/        # typed API client, usable as a library independent of the CLI
    types.ts     # EntgeltEntry + dimension/reference interfaces (fully typed)
    query.ts     # dependency-free query-string builder
    validate.ts  # input rules (Problem functions) + assertValid, shared by library and CLI
    codes.ts     # static l/r/g/a/b dimension tables (DIMENSIONS) + dimensionCodeProblem
    http.ts      # Transport interface + default node:http/https transport
    engine.ts    # URL building, retry, redirect (+ credential stripping), JSON decode
    errors.ts    # Entgeltatlas{Error,ApiError,NetworkError,ValidationError,ParseError}
    client.ts    # EntgeltatlasClient — entgelte() + reference lists
    index.ts
  cli/
    io.ts        # injectable I/O + env seam (CliDeps); API_KEY_ENV_VAR
    shared.ts    # option parsers (incl. KldB + dimension-code), the dimension flag names, render
    commands/    # entgelte + reference lists + codes
    program.ts   # assembles the commander program; seeds --api-key from env
    run.ts       # argv -> exit code (no process.exit; testable)
    index.ts     # #! bin shim
  index.ts       # library entry
```

Requires Node.js 22.12+ (`engines`); CI type-checks, builds and tests on Node 22/24.

Two seams keep everything testable in-process: **`Transport`** (the only HTTP
seam; tests inject a mock) and **`CliDeps`** (client factory + I/O + `env`).
`run.ts` returns an exit code rather than calling `process.exit`.

**The transport contract is enforced by the engine (P5)**, so the documented limits
hold for any transport a library user writes (fetch, a node:http wrapper, a test
double), not only the built-in one. `callWithDeadline` races the transport against
`timeoutMs` and passes an `AbortSignal` (`HttpRequest.signal`, honoured by the built-in
transport) that fires at the deadline; `checkResponse` requires an integer status
100–599 (a `NaN` status is never read as success), an object of headers (a `Headers`
object, a `Map` or any name case is normalised by `plainHeaders`, so `Retry-After` and
`Location` are always seen) and a byte body (any `ArrayBuffer` view, an `ArrayBuffer`
or a string, from any realm), and applies `maxResponseBytes` to the body it got back
(`sizeLimitMessage` names the option and `--max-response-bytes`). Whatever a transport
throws becomes an `EntgeltatlasNetworkError` with the original as `cause`
(`transportError`), and a reset (`ECONNRESET`, `EPIPE`, `ECONNABORTED`, undici's
`UND_ERR_SOCKET`, anywhere in the `cause` chain) of a GET is retried like a 503. A
redirect to a non-http(s) target (`file:`, `data:`, `javascript:`) is never handed to
the transport. `obtainKey()` uses the same helpers.
`test/conformance-p5-transport-contract.test.ts` is the shared check.

```bash
npm install
npm run build       # tsc -> dist/
npm run typecheck
npm test            # pretest builds, then node --test dist/test/*.test.js
npm run obtain-key  # print the published X-API-Key (network; needs a build)
```

## Entgeltatlas-specific notes

### Auth — a static `X-API-Key`, not "none"

The candidate list marked this API `auth=none`; that is **wrong**. Every call
needs an `X-API-Key` header whose value is the public `clientId` the BA's own
Entgeltatlas web app configures (`infosysbub-ega` on 2026-10-06). The UUID
`client_id` (`c4f0d292-…`) that the bundesAPI README and OpenAPI still publish is
refused with an empty 403 since 2026 (investigated on 2026-10-06, see
`.reviews/2026-10-05-exploratory/entgeltatlas-cli/auth-investigation-2026-10-06.md` in
the workspace). It flows through `EngineOptions.defaultHeaders`
(set in `client.ts` from `apiKey`); the CLI seeds `--api-key` from
`ENTGELTATLAS_API_KEY` with precedence **flag > env > none**. Flag, env var and
`apiKey` share one rule: `normalizeApiKey` trims the key (blank = no key), then
`headerValueProblem` checks the trimmed value (`Invalid apiKey: Value contains control
characters.`); only a blank `--api-key` flag is a CLI-only usage error, because it
would override the env key. The CLI seeds the env key with the source `"env"` and checks
it only in a command that builds a client (`assertEnvKey` in `shared.ts`, the library's
rule, the message naming `ENTGELTATLAS_API_KEY`), so help, `codes` (which builds no
client) and `obtain-key` work whatever the variable holds (P19). No key is bundled —
`obtain-key` (src/client/obtain-key.ts) reads it from the web app's page
(`KEY_SOURCE_URL`, `https://web.arbeitsagentur.de/entgeltatlas/`) at run time, with the client's limits and retry policy (30 s timeout, 100 MiB cap,
`DEFAULT_MAX_RETRIES` retries of a transient 429/503 via the shared
`transientRetryDelay`, all range-checked like the client's; the CLI passes `--timeout`,
`--max-response-bytes`, `--max-retries` and `--user-agent`) and up to `MAX_KEY_SOURCE_REDIRECTS`
(5) same-origin redirects — a redirect to another host is not followed. It takes the
value of the inline configuration's `clientId: '…'` (also double-quoted or with a
quoted name). The value must match `KEY_FORMAT` (3–64 lower-case letters, digits and
inner hyphens; a UUID fits too); a page stating no `clientId`, two different ones, or
one that isn't shaped like a key is an error, never a guess, and the value is never
printed (a placeholder, `--help`, escape sequences). A redirect it does not follow
(another origin, a non-http(s) target, past the limit) is named in the error with its
reason (`location` set), and a "no key" error names the page actually read after a
same-origin redirect. The skills pass the key on each call but don't repeat it in
their answer (P17). One-digit placeholder UUIDs
(`00000000-…`) are ignored. The engine strips `x-api-key`/`authorization`/`oauthaccesstoken`/`cookie` on any
cross-origin redirect.

> **OAuth (not needed, not implemented).** BA `infosysbub` also supports OAuth2
> client-credentials (POST `client_id`/`client_secret` to `/oauth/gettoken_cc`,
> then send the JWT in a **non-standard `OAuthAccessToken`** header — *not*
> `Authorization: Bearer`). The bundesAPI README presents it as the primary way in,
> with the UUID credentials the gateway now refuses. The `X-API-Key` path works with
> the web app's `clientId`, so OAuth stays unimplemented. The credential-header set
> lists `oauthaccesstoken` anyway, for a library user who sends one.

### Error classes (P13)

Every rejected input is an `EntgeltatlasValidationError`, never a raw `TypeError`: an
options argument that isn't an object (`optionsObject`; `null` counts as none), a
`transport` or `sleep` that isn't a function (`functionOption`), `defaultHeaders` that
isn't an object, a header value that isn't a string (`Expected a string, got number.`),
a KldB that isn't a string, `entgelte()` params that aren't an object. Every failure is
an `EntgeltatlasError` subclass. Server text in a message (`detail`, a transport's
error text) is cut at 500 characters; `EntgeltatlasApiError.body` keeps it all.
`test/conformance-p8-p9-p13-responses-and-errors.test.ts` is the shared check (with the
P8 charset and P9 shape cases).

### Secrets in the CLI's output

`withRedactedOutput` in `run.ts`: commander echoes a rejected value in its usage
error and names an unknown command or option as typed, so `run()` wraps `deps.io`
first. The userinfo of every URL-like argument and of `ENTGELTATLAS_API_KEY`
(`credentialsIn`, which finds it whether the value parses or not, then
`redactCredentials`) becomes `***@` on stdout and stderr; the `--api-key` value, the
`ENTGELTATLAS_API_KEY` value and any argument shaped like a UUID key
(`looksLikeApiKey`) become `***` on stderr (`redactSecrets`). Not on stdout, where
`obtain-key` prints the key. Commander's error message is terminal-escaped first
(`escapeTerminalText`: C0, DEL, C1 and format characters become `\uXXXX`), so an ESC
in `--user-agent` can't reach the terminal; the secrets are matched in their raw,
escaped and JSON-escaped forms. `test/conformance-p1-cli-redaction.test.ts` is the
shared check (ten passwords, seven URL shapes, every echo path, plus the key by flag,
by environment and typed without its flag).

### Secrets in the library's objects and errors

The engine keeps the base URL and the default headers (with the API key) in real
`#private` fields, and the client its engine, so `console.log(client)`,
`util.inspect` and `JSON.stringify` never show them. The base URL's userinfo (raw
and percent-decoded, `userinfoForms`) and the key are scrubbed from error bodies and
details, from transport error text and from the `cause` chain (`scrub` /
`scrubCause`). `redactUrl` cuts the userinfo out of a URL that doesn't parse too, so a
validation message (`Invalid baseUrl: Invalid URL "https://***@host:99999".`) and the
built-in transport's `Invalid URL: …` never repeat a password. `obtainKey` names a
source URL without its userinfo, in its errors and in `ObtainedKey.sourceUrl`.
`test/conformance-p2-library-redaction.test.ts` is the shared check.

### Input validation (library)

[`validate.ts`](src/client/validate.ts): the library owns every rule about what a
request may contain. A rule is a pure, exported `…Problem(value)` function that
returns the reason a value is invalid (or `undefined`); `assertValid(name, value,
problem)` turns a reason into an `EntgeltatlasValidationError` with the message
`Invalid <name>: <reason>`. Client methods check their input before any request
(a method that returns a promise rejects rather than throwing synchronously;
constructors throw). The CLI's value-parsers call the same functions, and `run.ts`
maps an `EntgeltatlasValidationError` to exit `2` (`Error: <message>`), so CLI and
library accept and reject the same inputs.

The engine options are range-checked in the `RequestEngine` constructor (and the
same way in `obtainKey()`): `timeoutMs` 0..`MAX_TIMEOUT_MS`, `maxRetries`
0..`MAX_RETRIES` (10), `maxRedirects` 0..`MAX_REDIRECTS` (10), `retryDelayMs` and
`maxResponseBytes` any non-negative safe integer; 0 keeps its documented meaning.
`NaN`, a negative or fractional value or one past the bound throws an
`EntgeltatlasValidationError` (`Invalid timeoutMs: Must be >= 0.`), instead of
silently switching the timeout or size cap off. The CLI's `--timeout`,
`--max-retries` and `--max-response-bytes` parsers use the same `intRangeProblem`
and constants.

Header values are checked the same way in the `RequestEngine` constructor and in
`obtainKey()`: `userAgent` and every `defaultHeaders` value go through
`headerValueProblem` / `assertHeaderValue` (blank, a control character other than tab,
or a character above U+00FF is an `EntgeltatlasValidationError`, e.g. `Invalid
userAgent: Value contains control characters.`), header names must be RFC 9110
tokens. Only an omitted `userAgent` selects `DEFAULT_USER_AGENT`; a blank one is an
error in both entry points, as `--user-agent ''` is in the CLI, whose parser calls the
same rule.

The `RequestEngine` constructor checks `baseUrl` with `validateBaseUrl` /
`baseUrlProblem` on the raw value, before the trailing-slash strip: unparseable
(including `""`), a scheme other than `http:`/`https:`, a query or fragment, a `%`
in the user name or password that isn't an escape (`userinfoEscapeProblem`: Node would
throw "URI malformed" at request time; a literal `%` is `%25`), or
surrounding whitespace (rejected, not trimmed: `new URL()` would trim it silently
while the engine joins the raw string to every path) throws an
`EntgeltatlasValidationError` (`Invalid baseUrl: Only http: and https: base URLs are
supported.`), never an `EntgeltatlasNetworkError`: it is a configuration error, not
an outage. `obtainKey()`'s `sourceUrl` gets the same class (`httpUrlProblem`).
`EntgeltatlasNetworkError` stays for the default transport's per-hop scheme check
and for redirect targets. `--base-url` calls the same `baseUrlProblem`.

`test/validate.test.ts` holds the unit tests and `test/parity.test.ts` the parity
tests: `parity()` in `test/helpers.ts` runs one input through `run()` and through the
library on one recording mock transport, and a test asserts both reject without a
request, or both send the identical request.

### One data endpoint, a bare array

`GET /infosysbub/entgeltatlas/pc/v1/entgelte/{kldb}` with optional integer query
dims `l,r,g,a,b`. It returns a **bare JSON array** (no envelope) of
`EntgeltEntry`. `client.entgelte()` validates the KldB (3–5 digits) and checks the
documented shape (P9): `entgelte` must answer a JSON array of **salary rows** (each
with a `kldb` string and the five dimension objects `region`, `gender`, `ageCategory`,
`performanceLevel`, `branche`, each `{ id: <integer>, bezeichnung: <string> }`, and the
figures `entgelt`, `entgeltQ25`, `entgeltQ75`, `besetzung` each a JSON number or `null`
— a string such as `"6.123,00"` is refused; negative numbers are the API's markers and
pass, see GLOSSARY.md), and a
reference endpoint a **non-empty** array of such codes. Anything else — a single
object, an error object sent with a 200, a string, a HAL `_embedded` envelope, a salary
row where a code was expected, an empty reference list — is an `EntgeltatlasParseError`
(`Unexpected response shape from <path>: expected a JSON array of salary rows; element 0
has no kldb text.`), and an empty or 204 body is one too
(`Empty response body from <path>`), never `[]`: an empty array is the documented
"suppressed" answer, so the client must not produce one by coercion. The KldB is a
**path segment** (a string, to preserve leading zeros), not a query param.

**The requested slice (result 02, Bug 1).** Every row carries the ids of its slice, and
`entgelte()` compares them with the dimension filters it sent
(`assertRequestedSlice`): a row whose `performanceLevel`/`region`/`gender`/`ageCategory`/
`branche` id differs from `l`/`r`/`g`/`a`/`b` is an `EntgeltatlasSliceError` (an
`EntgeltatlasParseError` with `param`, `requested`, `received`, `row`; CLI exit 1, nothing
on stdout). A server that ignores a filter would otherwise hand back the Deutschland /
Gesamt figure as the answer. An omitted dimension is not checked: the API then answers one
row per value of it.

### Read the figures defensively

- `entgelt` is the **median** gross monthly EUR (BA does not compute a mean).
- Every numeric field is `number | null`: a **suppressed** small cell yields
  `null`/empty — the client and CLI never coerce it to `0`.
- High earners are **censored** at `region.beitragsBemessungsGrenze`.
- The types are fully concrete (no `JsonObject`), but marked nullable because the
  OpenAPI spec is **community-reverse-engineered** and suppression behaviour is
  unverified.

### Reference vs. static codes

`regionen`/`geschlechter`/`alter`/`branchen` hit live endpoints that are **not in
the OpenAPI spec** (cross-referenced only). The library exports the same tables as
`DIMENSIONS` (`src/client/codes.ts`, `DIMENSION_PARAMS` for the letters), and the
`codes` command prints them offline with each dimension's CLI flag added (and covers
`l`, which has no live endpoint) — a reliable fallback if the live reference
endpoints move.

`client.entgelte()` checks every given `l`/`r`/`g`/`a`/`b` against its table with
`dimensionCodeProblem` before any request and rejects anything else with an
`EntgeltatlasValidationError` (`Invalid r: Unknown code 31: valid codes are 1–30.`;
`NaN`, `Infinity`, fractions, `0` and negatives get `Expected a positive integer
(codes start at 1).`). What the API does with an unknown code is not live-verified:
if it ignored the parameter, the caller would silently get the unfiltered slice. The
CLI's `--level/--region/--gender/--age/--branch` parsers call the same rule, with
the flag in the message.

**Strict filters (P10).** `client.entgelte(kldb, params, options)` takes only the five
documented keys: any other key — `{ region: 11 }` (the CLI's flag name), `{ L: 4 }`,
`constructor`, a JSON-parsed `__proto__` — is an `EntgeltatlasValidationError`
(`filterKeyProblem`) before any request, because the API ignores an unknown parameter
and answers the unfiltered slice with HTTP 200. `{ allowUnknownFilters: true }` (dip-bundestag's
shape) sends a parameter the API adds later, as a string, finite number or boolean;
`__proto__`, `constructor` and `prototype` never go out. A dimension value must be one
integer code (an array, `NaN`, a string or `null` is rejected). In the CLI, a single-value
option given twice (`-g 2 -g 3`, `--timeout 1 --timeout 2`) is a usage error naming the
option (`rejectRepeatedOptions` in `run.ts`), not "last one wins".
`test/conformance-p10-strict-filters.test.ts` (from marktstammdatenregister-cli) is the
shared check.

## Live verification status

- **2026-10-06:** the cause of the empty 403s below is found: the BA replaced the
  UUID key. With the web app's `clientId` as `X-API-Key`, `regionen` and `entgelte`
  answer 200 with data from the same machine, and `obtain-key` now reads that value.
  The response shape is live-verified: `entgelte` returns one row per slice, an
  omitted dimension can return several rows (all age bands for an omitted `-a`), every
  row carries the dimension ids, and the figures are JSON numbers — negative ones are
  markers, not amounts (see GLOSSARY.md).
- 2026-07-03: `obtain-key` read the then-published key from the bundesAPI README.
- The client builds the correct request (path, dims, `X-API-Key` header) —
  confirmed against the live gateway.
- **Response shape NOT live-verified.** `rest.arbeitsagentur.de` is behind an
  **Akamai WAF** that returns **HTTP 403 with an empty body** to
  datacenter/cloud/VPN IPs, regardless of the key. A wrong or missing key gets the
  identical response (text/plain, one-space body; seen again on 2026-09-15, when
  the fetched key and a wrong UUID both got it while the Ausbildungssuche API on
  the same gateway answered 200 for its own key). `run.ts` maps 401/403 → exit 3
  with a hint naming every cause (or saying that no key was sent).
- **2026-09-26:** the obtained key (it matches the upstream README's `client_id`)
  got an empty 403 on `entgelte`, `regionen` and `geschlechter`; a wrong UUID and a
  browser User-Agent got the same, while the Ausbildungssuche API on the same
  gateway answered 200 from the same IP — the UUID was no longer accepted (confirmed
  2026-10-06, above). `obtain-key` says in its stderr note that it did not check the
  key. Tests use the mock `Transport` only — never the live API in CI.

## Conventions matched from the blueprint

- Zero runtime HTTP dependencies (only `commander`); strict TS + ESM.
- Exit codes (`run.ts`): 0 ok; 2 usage; 3 auth/WAF; 4 not-found; 6 network; 1 other.
- Closed pipes (`handleOutputErrors` in `io.ts`, installed by the bin shim before
  `run()`): an EPIPE on stdout (`| head`, a `jq` that exits early) exits 0 quietly; an
  EPIPE on stderr is ignored, so a failed run keeps its own exit code (`2>&1 | true` no
  longer turns a usage error into 0). `test/conformance-p7-pipes-exit-codes.test.ts`
  spawns the built bin to check both.
- Transient `429`/`503`, and a reset connection of a GET, retried up to `maxRetries` (0..`MAX_RETRIES` = 10, default 2). Each retry
  waits `retryDelayMs × attempt` (the floor; `retryDelayMs` 0..`MAX_RETRY_AFTER_MS`), or the
  response's `Retry-After` (delay-seconds or IMF-fixdate, `parseRetryAfter`) when that is
  longer — `Retry-After: 0` or a past date never makes a zero-delay burst. A value above
  `MAX_RETRY_AFTER_MS` (30 s) is not retried at all: the error surfaces at once and names the
  requested wait (`retryAfterTooLong`, "the server asked to wait 120 s (Retry-After) … try
  again later"). `obtainKey()` shares the policy (`transientRetryDelay`).
  `test/conformance-p6-retry-policy.test.ts` is the shared check. Rate limits are undocumented.
- A body is decoded by the charset its Content-Type declares (`decodeBody`, UTF-8 when it
  names none; a leading BOM is dropped; an unknown label is an `EntgeltatlasParseError`
  naming it), in the client and in `obtainKey()`.
- `--base-url` (and the library's `baseUrl`) accepts only `http:`/`https:`; redirects (301/302/303/307/308 with a
  usable http(s) Location, up to `maxRedirects` = 5) are followed by the engine, never
  by the transport (`HttpRequest.redirect` is `"manual"`; a response whose `url` shows
  the transport went to another origin is an `EntgeltatlasNetworkError`). Credentials —
  the credential headers and the base URL's userinfo, sent as `Authorization: Basic`
  (`splitUserinfo`), never in the URL the transport sees — are attached per hop and go
  to the start URL's origin only: a same-origin redirect (absolute `Location` included)
  keeps them, one to another scheme, host or port (http→https included) drops them for
  the rest of the chain, and `RawResponse.credentialsDropped` /
  `EntgeltatlasApiError.credentialsDropped` record it. A 401/403 after that names the
  redirect ("use an https base URL (…)" for http→https, `credentialsDroppedHint`) and the
  CLI prints it without the key hint (exit 3). A base URL on plain `http:` to a host other
  than loopback (`localhost`, `127.0.0.0/8`, `::1`) gets one stderr warning per run, before
  the first request (`cleartextProblem`, exported): `warning: requests to <host> are sent
  unencrypted (http:, not https:)`, or naming "the API key" / "the base URL's credentials"
  when they travel — never their value. Help, version and usage errors never warn;
  `cleartextCredentialsProblem` stays as a deprecated alias.
  `test/conformance-p20-cleartext-warning.test.ts` is the shared check (P20).
  `obtainKey` sends a source's userinfo the same way and refuses an answer from another
  origin. `test/conformance-p3-redirect-credentials.test.ts` is the shared check. Any other 3xx, a missing or malformed Location, or
  the limit surface as `EntgeltatlasApiError` (exit 1) naming the target:
  `redirect to <url> not followed (stopped after 5 redirects)` /
  `redirect not followed (no Location header)`.

## Website

The project website — <https://maschinenlesbar-org.github.io/entgeltatlas-cli/> in English and
<https://maschinenlesbar-org.github.io/entgeltatlas-cli/de/> in German — is built from `site/`
with [Jekyll](https://jekyllrb.com/), [banira](https://sebs.github.io/banira/) web components
and [Fylgja](https://fylgja.dev/) CSS, and deployed by `docs.yml` together with the TypeDoc API
reference under `/api/`. Its content comes from this repository: the README intro and quick
start, the command tree of the built CLI (`site/scripts/cli-reference.mjs`), `Usage.md`,
`GLOSSARY.md` and its German version `GLOSSARY.de.md`, the skills, and the skill examples in
`EXAMPLE.md` and `EXAMPLE.de.md`. The only repo-specific files are `site/_config.yml` and
`site/_data/project.yml` (the German intro and the access requirements); the rest of `site/` is
identical in every maschinenlesbar.org CLI, so change it in all of them together. When the
README intro changes, update the German intro in `site/_data/project.yml`.

```bash
npm run build                        # the CLI, for the command reference
cd site && npm ci && bundle install  # once (Node >= 22.12, Ruby 3.4, Bundler)
npm run serve                        # http://127.0.0.1:4000/entgeltatlas-cli/
```
