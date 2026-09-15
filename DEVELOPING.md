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
    http.ts      # Transport interface + default node:http/https transport
    engine.ts    # URL building, retry, redirect (+ credential stripping), JSON decode
    errors.ts    # Entgeltatlas{Error,ApiError,NetworkError,ValidationError,ParseError}
    client.ts    # EntgeltatlasClient — entgelte() + reference lists
    index.ts
  cli/
    io.ts        # injectable I/O + env seam (CliDeps); API_KEY_ENV_VAR
    shared.ts    # option parsers (incl. KldB + dimension-code), option->client map, render
    codes.ts     # static l/r/g/a/b dimension tables (offline `codes`)
    commands/    # entgelte + reference lists + codes
    program.ts   # assembles the commander program; seeds --api-key from env
    run.ts       # argv -> exit code (no process.exit; testable)
    index.ts     # #! bin shim
  index.ts       # library entry
scripts/
  fetch-api-key.mjs  # scrape the published X-API-Key from the bundesAPI README
```

Two seams keep everything testable in-process: **`Transport`** (the only HTTP
seam; tests inject a mock) and **`CliDeps`** (client factory + I/O + `env`).
`run.ts` returns an exit code rather than calling `process.exit`.

```bash
npm install
npm run build       # tsc -> dist/
npm run typecheck
npm test            # pretest builds, then node --test dist/test/*.test.js
npm run fetch-key   # print the published X-API-Key (network)
```

## Entgeltatlas-specific notes

### Auth — a static `X-API-Key`, not "none"

The candidate list marked this API `auth=none`; that is **wrong**. Every call
needs an `X-API-Key` header whose value is the BA's published community
`client_id` UUID (`c4f0d292-…`). It flows through `EngineOptions.defaultHeaders`
(set in `client.ts` from `apiKey`); the CLI seeds `--api-key` from
`ENTGELTATLAS_API_KEY` with precedence **flag > env > none**. No key is bundled —
`scripts/fetch-api-key.mjs` scrapes it from the bundesAPI README for CI. The
engine strips `x-api-key`/`authorization`/`oauthaccesstoken`/`cookie` on any
cross-origin redirect.

> **OAuth fallback (not implemented).** BA `infosysbub` also supports OAuth2
> client-credentials (POST `client_id`/`client_secret` to `/oauth/gettoken_cc`,
> then send the JWT in a **non-standard `OAuthAccessToken`** header — *not*
> `Authorization: Bearer`). The static X-API-Key works, so this is deferred; the
> credential-header set already lists `oauthaccesstoken` for the day it's added.

### One data endpoint, a bare array

`GET /infosysbub/entgeltatlas/pc/v1/entgelte/{kldb}` with optional integer query
dims `l,r,g,a,b`. It returns a **bare JSON array** (no envelope) of
`EntgeltEntry`. `client.entgelte()` validates the KldB (3–5 digits) and defends
against a single-object or null body by normalising to an array. The KldB is a
**path segment** (a string, to preserve leading zeros), not a query param.

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
the OpenAPI spec** (cross-referenced only). The `codes` command prints the same
tables from `codes.ts` offline (and covers `l`, which has no live endpoint) — a
reliable fallback if the live reference endpoints move.

## Live verification status (2026-07-03)

- `fetch-api-key.mjs` correctly scrapes the published key.
- The client builds the correct request (path, dims, `X-API-Key` header) —
  confirmed against the live gateway.
- **Response shape NOT live-verified.** `rest.arbeitsagentur.de` is behind an
  **Akamai WAF** that returns **HTTP 403 with an empty body** to
  datacenter/cloud/VPN IPs, regardless of the key. `run.ts` maps 401/403 → exit 3
  with a hint that a 403 is often the WAF, not a bad key. Verify the response
  shape from a **residential IP**. Tests use the mock `Transport` only — never the
  live API in CI.

## Conventions matched from the blueprint

- Zero runtime HTTP dependencies (only `commander`); strict TS + ESM.
- Exit codes (`run.ts`): 0 ok; 2 usage; 3 auth/WAF; 4 not-found; 6 network; 1 other.
- Transient `429`/`503` retried up to `maxRetries`. Rate limits are undocumented.
- `--base-url` accepts only `http:`/`https:`; redirects are followed with
  credential-header stripping on cross-origin hops.

## Website

The project website — <https://maschinenlesbar-org.github.io/entgeltatlas-cli/> in English and
<https://maschinenlesbar-org.github.io/entgeltatlas-cli/de/> in German — is built from `site/`
with [Jekyll](https://jekyllrb.com/), [banira](https://sebs.github.io/banira/) web components
and [Fylgja](https://fylgja.dev/) CSS, and deployed by `docs.yml` together with the TypeDoc API
reference under `/api/`. Its content comes from this repository: the README intro and quick
start, the command tree of the built CLI (`site/scripts/cli-reference.mjs`), `Usage.md`,
`GLOSSARY.md`, the skills, and the skill examples in `EXAMPLE.md` (German: `EXAMPLE.de.md`).
The only repo-specific files are `site/_config.yml` and `site/_data/project.yml` (the German
intro and the access requirements); the rest of `site/` is identical in every
maschinenlesbar.org CLI, so change it in all of them together. When the README intro changes,
update the German intro in `site/_data/project.yml`.

```bash
npm run build                        # the CLI, for the command reference
cd site && npm ci && bundle install  # once (Node >= 22.12, Ruby 3.4, Bundler)
npm run serve                        # http://127.0.0.1:4000/entgeltatlas-cli/
```
