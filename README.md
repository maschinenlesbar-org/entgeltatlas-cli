# entgeltatlas-cli

[![CI](https://github.com/maschinenlesbar-org/entgeltatlas-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/maschinenlesbar-org/entgeltatlas-cli/actions/workflows/ci.yml)
[![Release](https://github.com/maschinenlesbar-org/entgeltatlas-cli/actions/workflows/release.yml/badge.svg)](https://github.com/maschinenlesbar-org/entgeltatlas-cli/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/@maschinenlesbar.org/entgeltatlas-cli)](https://www.npmjs.com/package/@maschinenlesbar.org/entgeltatlas-cli)

**Website:** [English](https://maschinenlesbar-org.github.io/entgeltatlas-cli/) · [Deutsch](https://maschinenlesbar-org.github.io/entgeltatlas-cli/de/) — command reference, guides and API docs

A TypeScript **API client and CLI** for the **Bundesagentur für Arbeit
Entgeltatlas API** — German **median gross-monthly salary statistics** by
occupation ([KldB-2010](GLOSSARY.md)), sliced by requirement level, region,
gender, age, and industry.

Read-only, zero runtime HTTP dependencies (built on `node:http`/`https`), strict
TypeScript, ESM.

```bash
npm install -g @maschinenlesbar.org/entgeltatlas-cli
```

## API key

The API needs a static **`X-API-Key`** (the BA's published community `client_id`).
No key is bundled with this tool. Fetch the public key and set it:

```bash
export ENTGELTATLAS_API_KEY="$(npm run --silent fetch-key)"   # scrapes the bundesAPI README
# or pass --api-key <uuid> per call
```

Precedence is **`--api-key` flag > `ENTGELTATLAS_API_KEY` env var > none**. The
`codes` command works with no key at all.

> **Heads-up — an empty 403 is ambiguous.** `rest.arbeitsagentur.de` answers a wrong
> or missing key with **HTTP 403 (empty body)**, and its Akamai WAF sends the same
> response when it refuses a network (datacenter/cloud/VPN IPs). If you get one
> (exit code `3`), re-check the key against the bundesAPI README first; if it
> matches, try from another network, e.g. a residential connection. The CLI's 403
> message says as much.

## Quickstart

```bash
entgeltatlas codes                              # dimension code tables (offline, no key)
entgeltatlas entgelte 84304                     # salary stats for a KldB occupation
entgeltatlas entgelte 84304 -l 4 -r 1 -g 1      # Experte, Deutschland, all genders
entgeltatlas regionen                           # live region codes
entgeltatlas entgelte 84304 --compact | jq '.[0].entgelt'
```

`entgelte <kldb>` takes the **numeric KldB-2010 code**, not an occupation name —
this API has **no name search**. Resolve a name to a code via the BERUFENET/DKZ
sibling APIs or the [KldB catalogue](https://www.klassifikationsserver.de/).

See **[Usage.md](Usage.md)** for the full command reference and
**[GLOSSARY.md](GLOSSARY.md)** for the dimensions, the KldB system, and how to
read censored/suppressed figures.

## Library use

```ts
import { EntgeltatlasClient } from "@maschinenlesbar.org/entgeltatlas-cli";

const ea = new EntgeltatlasClient({ apiKey: process.env.ENTGELTATLAS_API_KEY });
const rows = await ea.entgelte("84304", { l: 4, r: 1 });
// rows[0].entgelt is the MEDIAN gross monthly EUR — or null when suppressed.
```

Errors are typed (`EntgeltatlasApiError`, `EntgeltatlasNetworkError`,
`EntgeltatlasValidationError`, `EntgeltatlasParseError`).

## Read the numbers correctly

- `entgelt` is the **median** (not the mean), in **EUR gross per month**, full-time.
- Figures are **`null` when suppressed** (too few observations) — never treat as `0`.
- High earners are **censored** at the social-insurance ceiling
  (`region.beitragsBemessungsGrenze`), so the top can look artificially flat.

## Notes

- **The data is the BA's, not ours** — custom BA terms (attribution, no
  modification). See **[DATA_LICENSE.md](DATA_LICENSE.md)**. This is not an
  official API (community-reverse-engineered).
- **Code license:** AGPL-3.0-or-later **OR** commercial — see
  [LICENSING.md](LICENSING.md). External code contributions are not accepted
  ([CONTRIBUTING.md](CONTRIBUTING.md)); bug reports and forks are welcome.

## Development

```bash
npm install
npm run build      # tsc -> dist/
npm test           # builds, then node --test on dist/test
npm run typecheck
```

See [DEVELOPING.md](DEVELOPING.md) for architecture and API specifics.
