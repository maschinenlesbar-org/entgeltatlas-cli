# entgeltatlas-cli

[![CI](https://github.com/maschinenlesbar-org/entgeltatlas-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/maschinenlesbar-org/entgeltatlas-cli/actions/workflows/ci.yml)
[![Release](https://github.com/maschinenlesbar-org/entgeltatlas-cli/actions/workflows/release.yml/badge.svg)](https://github.com/maschinenlesbar-org/entgeltatlas-cli/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/@maschinenlesbar.org/entgeltatlas-cli)](https://www.npmjs.com/package/@maschinenlesbar.org/entgeltatlas-cli)

**Website:** [English](https://maschinenlesbar-org.github.io/entgeltatlas-cli/) · [Deutsch](https://maschinenlesbar-org.github.io/entgeltatlas-cli/de/) — command reference, guides and API docs

A TypeScript **API client and CLI** for the **Bundesagentur für Arbeit
Entgeltatlas API** — German **median gross-monthly salary statistics** by
occupation ([KldB-2010](https://github.com/maschinenlesbar-org/entgeltatlas-cli/blob/main/GLOSSARY.md)), sliced by requirement level, region,
gender, age, and industry.

Read-only, zero runtime HTTP dependencies (built on `node:http`/`https`), strict
TypeScript, ESM.

```bash
npm install -g @maschinenlesbar.org/entgeltatlas-cli
```

This installs the **`entgeltatlas`** command. Requires **Node.js 22.12+**. If the shell
can't find it, run `npm prefix -g` and add its `bin/` subdirectory to your `PATH` (on
Windows, the directory itself).

## API key

The API needs a static **`X-API-Key`** (the public `clientId` of the BA's own
Entgeltatlas web app).
No key is bundled with this tool — see **[Obtain key](#obtain-key)** below.

**Or store it once**, in a credentials file of its own (the same mechanism as
[openka-cli](https://github.com/maschinenlesbar-org/openka-cli)'s `ka config`):

```bash
entgeltatlas config set api-key                         # typed at a prompt, without echo
entgeltatlas obtain-key | entgeltatlas config set api-key   # or the published key, piped in
entgeltatlas config get api-key                         # masked: info…-ega (--reveal prints it whole)
entgeltatlas config list                                # what is stored, and where
entgeltatlas config unset api-key
```

The value is never taken from the command line, so it reaches neither shell history
nor `ps`. The file is `$XDG_CONFIG_HOME/entgeltatlas/credentials` (else
`~/.config/entgeltatlas/credentials`): mode 0600 in a directory of mode 0700, replaced
atomically, and not read at all while anyone else could read it. It is consulted only
when neither `--api-key` nor `ENTGELTATLAS_API_KEY` gives a key. A value edited into the
file by hand that `config set` would refuse (blank, whitespace inside, a line break, an
escape sequence) is refused when it is read — by the data commands, `config get` and
`config list` alike — naming the file (exit `1`).

Precedence is **`--api-key` flag > `ENTGELTATLAS_API_KEY` env var > the credentials
file > none**. The
`codes` command works with no key at all — and, like `--help` and `obtain-key`, also
when `ENTGELTATLAS_API_KEY` holds something malformed; only the commands that send a
request check the variable (`Invalid ENTGELTATLAS_API_KEY: …`, exit 2).

A `--base-url` on plain `http:` to a host other than loopback (`localhost`, `127.0.0.0/8`,
`::1`) gets one warning on stderr before the first request, a `WARN` record of
`entgeltatlas.http` — `… WARN  [entgeltatlas.http] the API key is sent
unencrypted to mirror.example (http:, not https:)`, or `requests to … are sent unencrypted`
when no key or `user:password@` travels. Neither value is ever printed; stdout and the exit
code are unchanged.

## Obtain key

The Bundesagentur für Arbeit publishes one community key for public use. It is
**not a secret** — the same value for everyone, stated as `clientId` in the page of
its own [Entgeltatlas web app](https://web.arbeitsagentur.de/entgeltatlas/) — but
finding and copying it shouldn't be your job either. `obtain-key` reads it from that
page at run time and prints it:

```bash
entgeltatlas obtain-key      # -> a short name such as infosysbub-ega  (provenance note on stderr)
```

The UUID `client_id` that the community docs at
[bundesAPI/entgeltatlas-api](https://github.com/bundesAPI/entgeltatlas-api) still
print is **no longer accepted** (an empty 403 since 2026); don't use it.

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

> **Heads-up — an empty 403.** `rest.arbeitsagentur.de` answers with **HTTP 403 (empty
> body)** for a wrong, stale or missing key and for a network its WAF refuses
> (datacenter/cloud/VPN IPs). The stale case is real: in 2026 the BA replaced the UUID
> `client_id` (still printed by the bundesAPI README and in releases of this CLI up to
> 0.1.0, which read the key from there) with the short `clientId` its web app uses, and
> the gateway refuses the UUID. If you get an empty 403 (exit code `3`), re-run
> `entgeltatlas obtain-key` and retry with what it prints; if a freshly obtained key
> still gets the 403, your network is the likelier cause. The upstream's OAuth
> client-credentials flow is not needed. `codes` keeps working offline.

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

Each dimension flag takes one value; a repeated one (`-g 2 -g 3`) is a usage error, so
compare slices with one call each. In the library, `entgelte()` rejects any params key
other than `l`, `r`, `g`, `a`, `b` (the API would ignore it and answer the unfiltered
slice).

`entgelte <kldb>` takes the **numeric KldB-2010 code**, not an occupation name —
this API has **no name search**. Resolve a name to a code via the BERUFENET/DKZ
sibling APIs or the [KldB catalogue](https://www.klassifikationsserver.de/).

See **[Usage.md](https://github.com/maschinenlesbar-org/entgeltatlas-cli/blob/main/Usage.md)** for the full command reference and
**[GLOSSARY.md](https://github.com/maschinenlesbar-org/entgeltatlas-cli/blob/main/GLOSSARY.md)** for the dimensions, the KldB system, and how to
read censored/suppressed figures.

Data goes to stdout; errors, warnings and notes go to stderr. Each line on stderr is a
**log record**: a timestamp (UTC), a level (`ERROR`, `WARN`, `INFO`) and a topic, the
program and the area it comes from (`entgeltatlas.cli` for usage errors,
`entgeltatlas.api` for the API's answers and the 401/403 hint, `entgeltatlas.http` for
the connection, `entgeltatlas.config`, `entgeltatlas.obtain-key`). By default it is
written log4j style; `--log-format jsonl` writes one JSON object per line instead:

```text
2026-10-09T14:03:12.481Z WARN  [entgeltatlas.http] the API key is sent unencrypted to mirror.example (http:, not https:)
2026-10-09T14:03:12.902Z ERROR [entgeltatlas.api] HTTP 403 for GET https://rest.arbeitsagentur.de/infosysbub/entgeltatlas/pc/v1/entgelte/84304
```

```bash
entgeltatlas --log-format jsonl entgelte 84304 2>log.jsonl   # {"ts":"…","level":"ERROR","topic":"entgeltatlas.api","msg":"HTTP 403 …"}
```

## Library use

```ts
import { EntgeltatlasClient } from "@maschinenlesbar.org/entgeltatlas-cli";

const ea = new EntgeltatlasClient({ apiKey: process.env.ENTGELTATLAS_API_KEY });
// Pass every dimension for exactly one row: an omitted one comes back as one row per value.
const rows = await ea.entgelte("84304", { l: 4, r: 1, g: 1, a: 1, b: 1 });
// rows[0].entgelt is the MEDIAN gross monthly EUR — unless negative: then it is a marker
// (-1 suppressed, -2 above the contribution ceiling), not an amount.
```

Errors are typed (`EntgeltatlasApiError`, `EntgeltatlasNetworkError`,
`EntgeltatlasValidationError`, `EntgeltatlasParseError`). A row of another slice than
the one requested — e.g. a `Deutschland` row for `r: 11`, as from a server that ignored
the filter — is an `EntgeltatlasSliceError` (an `EntgeltatlasParseError`; CLI exit 1),
never the answer. A custom `transport` (e.g. one
built on `fetch`) gets the same guarantees as the built-in one: the engine enforces
`timeoutMs` (passing an `AbortSignal` in `request.signal`) and `maxResponseBytes`, reads
`Headers` objects and any header case, accepts any byte-array body, and turns whatever
the transport throws or returns malformed into an `EntgeltatlasNetworkError`. A transport
must not follow redirects (`request.redirect` is `"manual"`): the engine follows them and
sends the key only to the base URL's origin.

## Read the numbers correctly

- `entgelt` is the **median** (not the mean), in **EUR gross per month**, full-time.
- **A negative figure is a marker, not an amount.** Recorded live, a suppressed slice
  (too few observations) comes back as `-1` (`besetzung` negative too), and a quartile
  above the contribution ceiling as `-2`. `null` or an empty array mean the same: no
  figure. Never report these as € or treat them as `0`; see [GLOSSARY.md](https://github.com/maschinenlesbar-org/entgeltatlas-cli/blob/main/GLOSSARY.md).
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

Three [Agent Skills](https://github.com/maschinenlesbar-org/entgeltatlas-cli/blob/main/SKILLS.md) teach Claude Code to use this CLI for real questions:
look up what an occupation earns (**entgelt-lookup**), compare salaries by gender, region or
level (**entgelt-gap-analyzer**), and resolve the codes the API needs
(**entgelt-code-finder**). Install them from the maschinenlesbar.org marketplace:

```
/plugin marketplace add maschinenlesbar-org/plugins
/plugin install entgeltatlas@maschinenlesbar
```

See **[SKILLS.md](https://github.com/maschinenlesbar-org/entgeltatlas-cli/blob/main/SKILLS.md)** for details.

## Development

```bash
npm install
npm run build      # tsc -> dist/
npm test           # builds, then node --test on dist/test
npm run typecheck
```

See [DEVELOPING.md](https://github.com/maschinenlesbar-org/entgeltatlas-cli/blob/main/DEVELOPING.md) for architecture and API specifics.
