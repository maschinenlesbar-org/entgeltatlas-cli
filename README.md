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
No key is bundled with this tool — see **[Obtain key](#obtain-key)** below.

Precedence is **`--api-key` flag > `ENTGELTATLAS_API_KEY` env var > none**. The
`codes` command works with no key at all.

## Obtain key

The Bundesagentur für Arbeit publishes one community `client_id` for public use.
It is **not a secret** — the same value for everyone, printed in the upstream
[bundesAPI/entgeltatlas-api](https://github.com/bundesAPI/entgeltatlas-api)
README — but finding and copying it shouldn't be your job either. `obtain-key`
reads it from that published source at run time and prints it:

```bash
entgeltatlas obtain-key      # -> a UUID  (provenance note on stderr)
```

**From obtaining the key to having it where it is used, in one line:**

```bash
# this shell only
eval "$(entgeltatlas obtain-key --export)"

# or keep it for later — appends one `export …` line to your shell profile
entgeltatlas obtain-key --export >> ~/.zshrc     # ~/.bashrc on bash
```

`--export` prints a single shell-quoted `export ENTGELTATLAS_API_KEY='…'` line on
stdout (the "obtained from …" note goes to stderr, so it never lands in your
profile). The plain form composes too:

```bash
export ENTGELTATLAS_API_KEY="$(entgeltatlas obtain-key)"
```

Because the key is fetched rather than compiled in, a rotated key needs no
release of this CLI. If the source is unreachable or stops publishing a key,
`obtain-key` fails loudly with a non-zero exit rather than printing a guess.
`obtain-key` does not check the key against the API, so a successfully obtained key
is no guarantee the API will answer: see the 403 heads-up below.

> **Heads-up — the published key may no longer be accepted.** `rest.arbeitsagentur.de`
> answers with **HTTP 403 (empty body)** for a wrong or missing key, for a network its
> WAF refuses (datacenter/cloud/VPN IPs), and — observed on 2026-09-26 — for the
> published static key itself: every Entgeltatlas endpoint answered it with an empty
> 403, while the Ausbildungssuche API on the same gateway answered 200 from the same
> machine, and a browser User-Agent changed nothing. The upstream README now presents
> an OAuth client-credentials flow (a token in an `OAuthAccessToken` header) as the
> primary way in; **this CLI does not implement it** and only sends the static
> `X-API-Key`. If you get an empty 403 (exit code `3`), re-check the key with
> `entgeltatlas obtain-key`; if it matches, the likeliest cause is that the static key
> is no longer accepted, and trying another network is a secondary check. `codes`
> keeps working offline.

## Quickstart

```bash
entgeltatlas codes                              # dimension code tables (offline, no key)
entgeltatlas entgelte 84304                     # salary stats; omitted dimensions are left to the server
entgeltatlas entgelte 84304 -l 4 -r 1 -g 1      # Experte, Deutschland, all genders
entgeltatlas regionen                           # live region codes
# every row with its labels — check them rather than assuming .[0] is the slice you meant
entgeltatlas entgelte 84304 -l 4 -r 1 -g 1 -a 1 -b 1 --compact \
  | jq '.[] | {level: .performanceLevel.bezeichnung, region: .region.bezeichnung, entgelt}'
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

## Claude Code skills

Three [Agent Skills](SKILLS.md) teach Claude Code to use this CLI for real questions:
look up what an occupation earns (**entgelt-lookup**), compare salaries by gender, region or
level (**entgelt-gap-analyzer**), and resolve the codes the API needs
(**entgelt-code-finder**). Install them from the maschinenlesbar.org marketplace:

```
/plugin marketplace add maschinenlesbar-org/plugins
/plugin install entgeltatlas@maschinenlesbar
```

See **[SKILLS.md](SKILLS.md)** for details.

## Development

```bash
npm install
npm run build      # tsc -> dist/
npm test           # builds, then node --test on dist/test
npm run typecheck
```

See [DEVELOPING.md](DEVELOPING.md) for architecture and API specifics.
