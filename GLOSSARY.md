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

Pass each as a numeric code; run `entgeltatlas codes` for the full tables. Omitting
a dimension gives its `1 = Gesamt` aggregate.

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
| `region.beitragsBemessungsGrenze` | The social-insurance contribution ceiling. Earnings above it are **censored**, so `entgelt`/`entgeltQ75` can look artificially flat at the top. |

### Suppression (Datenschutz / kleine Fallzahl)

When a slice is based on too few observations, the cell is **suppressed** for data
protection: the response is an **empty array** or the numeric fields come back
**`null`**. This means **"not available / n too small" — never `0`**. The client
and CLI preserve `null` faithfully; do not treat it as zero earnings.

## Auth terms

- **X-API-Key** — the static header this API authenticates with. Its value is the
  BA's published community **`client_id`** UUID (an access identifier, not a
  per-user grant). Fetch it with `npm run fetch-key`; never commit it — not even
  the public community key. Tests use an obvious dummy UUID
  (`00000000-0000-4000-8000-000000000000`) so the repo holds zero real credentials.
- **WAF / 403** — `rest.arbeitsagentur.de` sits behind an Akamai WAF that blocks
  datacenter/VPN/cloud IPs with an **empty-body HTTP 403**, even with a valid key.
  A 403 is therefore often an IP block, not an auth failure — see
  [DEVELOPING.md](DEVELOPING.md).

See [DATA_LICENSE.md](DATA_LICENSE.md) for attribution and reuse terms.
