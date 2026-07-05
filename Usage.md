# Usage

`entgeltatlas <command> [options]`. Every command prints JSON (pretty by default,
single-line with `--compact`). The API needs an `X-API-Key` — see
[README](README.md) — except `codes`, which is offline.

## Global options

| Flag | Meaning |
|---|---|
| `--api-key <key>` | X-API-Key (env `ENTGELTATLAS_API_KEY`) |
| `--base-url <url>` | API base (default `https://rest.arbeitsagentur.de`) |
| `--timeout <ms>` · `--max-retries <n>` · `--max-response-bytes <n>` | transport tuning |
| `--user-agent <ua>` | User-Agent header |
| `--compact` | single-line JSON |

## entgelte — salary statistics

```bash
entgeltatlas entgelte <kldb> [-l <n>] [-r <n>] [-g <n>] [-a <n>] [-b <n>]
```

`<kldb>` is the **numeric KldB-2010 code** (3–5 digits, e.g. `84304`) — not an
occupation name. Each dimension flag narrows the slice; omit one to get its
`1 = Gesamt` aggregate. Run `entgeltatlas codes` to see all the numbers.

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
| `1` | other API / network / parse error |
| `2` | usage error (bad KldB code, bad flag) |
| `3` | 401/403 — key rejected **or** a WAF/IP block (see README) |
| `4` | 404 — not found |
| `6` | network/transport failure (timeout, size cap) |

## Gotchas

- **No name search** — you must supply the numeric KldB code. Resolve names via
  the BERUFENET/DKZ sibling APIs or the KldB catalogue.
- **`entgelt` is a median, in EUR/month gross**, censored at the social-insurance
  ceiling — see [GLOSSARY.md](GLOSSARY.md).
- **Region numbering is irregular** (Bund/Ost/West + 16 states + 11 cities), not
  1..16 — check `codes`/`regionen`.
- **403 is often the WAF**, not your key — try from a residential IP.
