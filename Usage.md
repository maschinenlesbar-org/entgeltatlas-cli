# Usage

`entgeltatlas <command> [options]`. Every command prints JSON (pretty by default,
single-line with `--compact`). The API needs an `X-API-Key` — see
[README](README.md) — except `codes`, which is offline.

## Global options

| Flag | Meaning |
|---|---|
| `--api-key <key>` | X-API-Key (env `ENTGELTATLAS_API_KEY`); a blank value is a usage error, not "no key" |
| `--base-url <url>` | API base (default `https://rest.arbeitsagentur.de`); `http:`/`https:` only, a path prefix is fine, a query (`?`), fragment (`#`) or surrounding whitespace is a usage error |
| `--timeout <ms>` · `--max-response-bytes <n>` | transport tuning |
| `--max-retries <n>` | retries for a transient 429/503, `0`–`10` (default 2); each waits the server's `Retry-After` (seconds or HTTP-date, up to 30 s — a longer one is not retried), else 200 ms × attempt |
| `--user-agent <ua>` | User-Agent header |

`--api-key` and `--user-agent` (and `ENTGELTATLAS_API_KEY`) must be sendable as an HTTP
header: a blank value, a control character (CR/LF, DEL; tab is fine) or a character above
U+00FF is a usage error (exit 2) before any request.
| `--compact` | single-line JSON |

## entgelte — salary statistics

```bash
entgeltatlas entgelte <kldb> [-l <n>] [-r <n>] [-g <n>] [-a <n>] [-b <n>]
```

`<kldb>` is the **numeric KldB-2010 code** (3–5 digits, e.g. `84304`) — not an
occupation name. Each dimension flag narrows the slice. Code `1` is `Gesamt` only
for `-g`, `-a` and `-b`; for `-l` it is Helfer and for `-r` Deutschland. An
omitted flag sends no parameter and leaves the slice to the server (not
live-verified), so pass the dimensions you mean and check each row's labels. Run
`entgeltatlas codes` to see all the numbers.

| Flag | Dimension | Values |
|---|---|---|
| `-l, --level <n>` | Anforderungsniveau | 1 Helfer · 2 Fachkraft · 3 Spezialist · 4 Experte |
| `-r, --region <n>` | Region | 1 Deutschland … 30 (irregular; see `codes`/`regionen`) |
| `-g, --gender <n>` | Geschlecht | 1 Gesamt · 2 Männer · 3 Frauen |
| `-a, --age <n>` | Alter | 1 Gesamt · 2 <25 · 3 25–<55 · 4 ≥55 |
| `-b, --branch <n>` | Branche | 1 Gesamt … 11 |

```bash
entgeltatlas entgelte 84304 -l 4 -r 11 -g 2      # Experte, Baden-Württemberg, Männer
```

Returns a JSON **array** of observations, each with `entgelt` (median),
`entgeltQ25`/`entgeltQ75` (quartiles), `besetzung` (headcount), and the labelled
dimensions. A suppressed cell has `entgelt: null` (or an empty array) — **not `0`**.

## Reference lists (live)

```bash
entgeltatlas regionen       # region codes (r)
entgeltatlas geschlechter   # gender codes (g)
entgeltatlas alter          # age-band codes (a)
entgeltatlas branchen       # branch codes (b)
```

Each returns an array of `{ id, bezeichnung }`. These are not in the official
spec — if one is unavailable, use `codes` instead.

## codes — offline dimension tables

```bash
entgeltatlas codes          # all of l/r/g/a/b, no API key, no network
```

Prints the static code tables (including `l`, which has no live endpoint). Use it
to look up the numbers for the `entgelte` flags.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success (help/version/bare invocation included) |
| `1` | other API or parse error (incl. a response that is not a JSON array of objects, or an empty body) |
| `2` | usage error (bad KldB code, bad flag) |
| `3` | 401/403 — no key sent, key rejected (the published static key may no longer be accepted), **or** a WAF/IP block (see README) |
| `4` | 404 — not found |
| `6` | network/transport failure (timeout, size cap) |

`obtain-key` talks only to the key source (the bundesAPI README), never to the API:
it exits `4` when the source answers 404, `6` on a network failure, and `1` for any
other failure (another status, no key stated, conflicting keys) — never `3`. Library
users get an `EntgeltatlasKeySourceError` (an `EntgeltatlasApiError` with `status`/`url`).

## Gotchas

- **No name search** — you must supply the numeric KldB code. Resolve names via
  the BERUFENET/DKZ sibling APIs or the KldB catalogue.
- **`entgelt` is a median, in EUR/month gross**, censored at the social-insurance
  ceiling — see [GLOSSARY.md](GLOSSARY.md).
- **Region numbering is irregular** (Bund/Ost/West + 16 states + 11 cities), not
  1..16 — check `codes`/`regionen`.
- **An empty 403 is ambiguous** — a wrong key, a WAF block of your network and a
  static key the API no longer accepts look the same. The published key got an empty
  403 on every endpoint on 2026-09-26 (upstream now documents an OAuth
  client-credentials flow this CLI does not implement). Re-check the key with
  `entgeltatlas obtain-key`; see the README's 403 heads-up.
