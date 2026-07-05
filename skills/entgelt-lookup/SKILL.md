---
name: entgelt-lookup
description: >
  Look up what a German occupation earns using the entgeltatlas-cli — median
  gross-monthly salary plus quartiles from the Bundesagentur für Arbeit
  Entgeltatlas. Trigger when the user asks "what does a Fachinformatiker earn in
  Germany?", "median salary for KldB 84304", "how much do nurses make by
  Bundesland?", "gross monthly pay for occupation X at Experten-level", or wants
  official BA earnings statistics for one occupation. Resolves the KldB code and
  dimension filters, fetches the figures, and reads them correctly (median not
  mean, suppression, censoring).
version: 1.0.0
userInvocable: true
---

# Entgelt Lookup

Turn "what does occupation X earn?" into the BA's official median gross-monthly
salary, sliced the way the user asked. The value of this skill is getting the
KldB code and dimension filters right and **reading the figures honestly** (they
are censored, suppressed statistics — not raw pay).

## Tooling

This skill drives the `entgeltatlas` command. **Before anything else, validate it is available** — run `command -v entgeltatlas` (or `entgeltatlas --version`). If it is not on your PATH, STOP and inform the user that the `entgeltatlas` CLI (`@maschinenlesbar.org/entgeltatlas-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

**An X-API-Key is required** for the data commands (not for `codes`). It is the BA's published community key; set `ENTGELTATLAS_API_KEY` (or pass `--api-key`). There is **no bundled key** — obtain it out of band (the repo's `npm run fetch-key`, or github.com/bundesAPI/entgeltatlas-api). **A 403 with an empty body is usually a WAF/IP block** (datacenter/VPN/cloud IPs are refused), NOT a bad key — if you hit one, tell the user to run from a residential connection rather than assuming the key is wrong. Use `--compact` for `jq`. Cite the source: © Statistik der Bundesagentur für Arbeit.

## Step 1 — Get the KldB code

The `entgelte` command needs a numeric **KldB-2010 code** (3–5 digits) — this API
has **no occupation-name search**. If the user gave a name:

- Ask them for the code, or resolve it via the **BERUFENET / DKZ** sibling APIs or
  the [Klassifikationsserver](https://www.klassifikationsserver.de/) — that
  resolution is out of scope for this CLI.
- Never guess a code from memory; a wrong code silently returns different data.

If the user already gave a code, skip ahead.

## Step 2 — Pick the dimension filters

```bash
entgeltatlas codes            # offline: all l/r/g/a/b tables (no key needed)
```

Map the user's intent to codes (omit a dimension to get its `1 = Gesamt`
aggregate):

| Flag | Dimension | Example |
|---|---|---|
| `-l` | Anforderungsniveau | 2 Fachkraft, 4 Experte |
| `-r` | Region | 1 Deutschland, 11 Baden-Württemberg, 29 München (irregular numbering!) |
| `-g` | Geschlecht | 2 Männer, 3 Frauen |
| `-a` | Alter | 3 = 25 bis unter 55 |
| `-b` | Branche | see `codes` |

## Step 3 — Fetch

```bash
entgeltatlas entgelte 84304 -l 4 -r 1 --compact
```

Returns a JSON array of observations; each has `entgelt` (median),
`entgeltQ25`/`entgeltQ75` (quartiles), `besetzung` (headcount), and the labelled
dimensions.

## Step 4 — Report the numbers honestly

```
Berufe in der Hochschullehre und -forschung (KldB 84304), Experten, Deutschland:
  Median: 6.500 €/Monat brutto (Vollzeit)
  Mittlere 50 %: 5.200 € (Q25) – 7.550 € (Q75)
  Fallzahl (besetzung): 12.345
Quelle: © Statistik der Bundesagentur für Arbeit.
```

Rules — state these when they apply:
- **It's a median, not a mean**, in EUR gross per month, full-time.
- **`null` (or an empty array) = suppressed** (too few cases) — say "keine
  Angabe / Fallzahl zu klein", **never** report it as 0 €.
- The upper end is **censored** at the social-insurance ceiling
  (`region.beitragsBemessungsGrenze`), so `entgelt`/Q75 can look flat at the top —
  flag it for high-paying occupations.

## Traps

- **No name search** — always a numeric KldB code.
- **Suppressed ≠ 0** — null-check `entgelt` before reporting.
- **Median ≠ mean** — don't call it "average".
- **Irregular region codes** — `r` is not 1..16 Bundesländer (it interleaves
  Bund/Ost/West and cities); verify against `codes`/`regionen`.
- **403 empty body = WAF/IP block**, usually not the key — advise a residential IP.
- German labels (`bezeichnung`) — pass through, don't translate.
