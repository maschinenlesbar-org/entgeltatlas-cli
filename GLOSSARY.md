# Glossary

Entgeltatlas concepts and the vocabulary this CLI exposes. The API answers one
question: *what does a given occupation earn?* — as a **median gross monthly
salary**, sliced by five dimensions.

## Occupations

| Term | Meaning |
|---|---|
| **KldB 2010** | *Klassifikation der Berufe 2010* — the BA's occupation code system. The `entgelte` command's required argument. Codes are 3–5 digits (e.g. `84304` = "Berufe in der Hochschullehre und -forschung – hoch komplexe Tätigkeiten"). Kept as a **string** (leading zeros matter). |
| **name → code** | This API has **no name search**. Resolve an occupation name to its KldB code via the BERUFENET / DKZ sibling APIs, or the [Klassifikationsserver](https://www.klassifikationsserver.de/). |

## The five dimensions

Pass each as a numeric code; run `entgeltatlas codes` for the full tables. Code
`1` is the `Gesamt` aggregate only for `-g`, `-a` and `-b`: for `-l` it is
`Helfer` (there is no Gesamt level) and for `-r` it is `Deutschland`. Omitting a
flag sends no parameter, so the server picks the slice; that has not been
verified against the live API. Pass the dimensions you mean and check the labels
in each returned row. A code that is not in its table (e.g. `-r 31`) is
rejected before any request, by the CLI and by the library (`DIMENSIONS` holds the
tables), because the API might ignore it and return the unfiltered slice.

| Flag | Param | Dimension | Codes |
|---|---|---|---|
| `-l` | `l` | **Anforderungsniveau** (requirement/performance level) | 1 Helfer · 2 Fachkraft · 3 Spezialist · 4 Experte |
| `-r` | `r` | **Region** | 1 Deutschland · 2 Ost · 3 West · 4–19 the 16 Länder · 20–30 eleven cities (**irregular** — not 1..16) |
| `-g` | `g` | **Geschlecht** | 1 Gesamt · 2 Männer · 3 Frauen |
| `-a` | `a` | **Alter** | 1 Gesamt · 2 unter 25 · 3 25 bis unter 55 · 4 ab 55 |
| `-b` | `b` | **Branche** (Wirtschaftszweig) | 1 Gesamt … 11 (see `codes`) |

## Reading the figures

| Field | Meaning |
|---|---|
| `entgelt` | **Median** gross monthly earnings, EUR, full-time. **Not** the arithmetic mean — the BA deliberately does not compute a mean (earnings above the ceiling are unknown). |
| `entgeltQ25` / `entgeltQ75` | Lower / upper quartile (25th / 75th percentile), EUR. |
| `besetzung` | The headcount the figures are based on — a **count of people, not a salary**. |
| `region.beitragsBemessungsGrenze` | The social-insurance contribution ceiling. Earnings above it are **censored**, so `entgelt`/`entgeltQ75` can look artificially flat at the top, or come back as the marker `-2` (see below). |

### Suppression (Datenschutz / kleine Fallzahl)

When a slice is based on too few observations, its figures are **suppressed** for data
protection. Recorded live on 2026-10-06, the API marks this with **negative numbers**,
not `null`: `entgelt`, `entgeltQ25` and `entgeltQ75` come back as `-1`, and `besetzung`
as a negative number too (`-42` in that answer). A quartile above the social-insurance
ceiling came back as `-2` (`entgeltQ75: -2` next to a real median): earnings above the
ceiling are not known, which the BA's web app shows as "> BBG". These meanings are read
from that answer and the web app's help texts, not from documentation, so the rule is
simple: **any negative figure is a marker, not an amount** — never report it in €,
never compute a gap or a mean with it. An **empty array** or **`null`** figures (from the
community spec; not seen live) mean the same: no figure — **never `0`**. The client and
CLI pass all of these through unchanged.

## Auth terms

- **X-API-Key** — the static header this API authenticates with. Its value is the
  public **`clientId`** the BA's own Entgeltatlas web app configures (an access
  identifier, not a per-user grant; a short name such as `infosysbub-ega`, no longer
  the UUID `client_id` the bundesAPI README still publishes — the gateway refuses that
  one since 2026). Obtain it with `entgeltatlas obtain-key`; never commit it — not even
  the public community key. Tests use obvious dummy values so the repo holds zero real
  credentials.
- **WAF / 403** — `rest.arbeitsagentur.de` answers with an **empty-body HTTP 403**
  for a wrong, stale or missing key and for a network its WAF refuses
  (datacenter/VPN/cloud IPs). The response alone can't tell these apart. Re-check the
  key with `entgeltatlas obtain-key` first — see [DEVELOPING.md](DEVELOPING.md). The
  upstream's OAuth client-credentials flow is not needed: the `X-API-Key` works.

## The log on stderr

- **Log record** — every diagnostic line the CLI writes to stderr: a timestamp, a level
  (`ERROR`, `WARN`, `INFO`) and a topic `entgeltatlas.<area>`, as text (log4j style) or
  with `--log-format jsonl` as one JSON object per line. The areas: `cli` (usage errors,
  commander's messages, unexpected errors, Node's process warnings), `api` (the API's answers: an error status and
  the 401/403 hint after it, and a malformed answer — bad JSON, the wrong shape, another
  slice than the one requested), `http` (the connection, the cleartext warning, and one WARN per retry before it waits),
  `config`, `obtain-key` and `output` (a failed write to stdout). A record is always one
  line; control characters in it are escaped.

See [DATA_LICENSE.md](DATA_LICENSE.md) for attribution and reuse terms.
