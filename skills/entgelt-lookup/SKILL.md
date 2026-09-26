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
compatibility: >
  Requires the `entgeltatlas` CLI (npm package
  @maschinenlesbar.org/entgeltatlas-cli) on PATH, installed by the user; the
  skill never installs it. Uses jq for JSON filtering. Network access to
  rest.arbeitsagentur.de. Needs the public API key via --api-key or
  ENTGELTATLAS_API_KEY (`entgeltatlas obtain-key` prints it).
---

# Entgelt Lookup

Turn "what does occupation X earn?" into the BA's official median gross-monthly
salary, sliced the way the user asked. The value of this skill is getting the
KldB code and dimension filters right and **reading the figures honestly** (they
are censored, suppressed statistics — not raw pay).

## Tooling

This skill drives the `entgeltatlas` command. **Before anything else, validate it is available** — run `command -v entgeltatlas` (or `entgeltatlas --version`). If it is not on your PATH, STOP and inform the user that the `entgeltatlas` CLI (`@maschinenlesbar.org/entgeltatlas-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

This skill also filters JSON with `jq`. **Validate it too** — run `command -v jq`. If it is missing, inform the user that `jq` is not installed — installing it is their responsibility; never install it yourself — and carry on without it: filter the CLI output with `node -e` instead (Node is already on your PATH, since the CLI runs on it).

**An X-API-Key is required** for the data commands (not for `codes`). It is the BA's published community key; set `ENTGELTATLAS_API_KEY` (or pass `--api-key`). There is **no bundled key** — obtain it with the CLI itself — `entgeltatlas obtain-key` prints the published key (stdout), reading it from github.com/bundesAPI/entgeltatlas-api at run time. **Keep that value for the rest of the session** and put it on later calls as `ENTGELTATLAS_API_KEY="<key>" entgeltatlas …`, since a shell `export` does not survive between separate commands. The key is public — name it when you report back — but never guess one if `obtain-key` fails. **A 403 with an empty body is ambiguous**: the gateway sends the same response for a wrong or missing key, for a refused network (WAF/IP block), and for a static key it no longer accepts — the published key got one on every Entgeltatlas endpoint on 2026-09-26, and upstream now documents an OAuth client-credentials flow this CLI does not implement. Have the user re-check the key with `entgeltatlas obtain-key` first; if it matches, tell them the API may no longer accept the published key (trying another network is only a secondary check), and never present a 403 as "no data". Use `--compact` for `jq`. Cite the source: © Statistik der Bundesagentur für Arbeit.

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

Map the user's intent to codes. Code `1` is `Gesamt` only for `-g`, `-a` and `-b`;
for `-l` it is Helfer (there is no Gesamt level) and for `-r` Deutschland. An
omitted flag sends no parameter and the server picks the slice, which hasn't been
checked live, so pass every dimension the answer depends on (e.g. `-r 1` for
Germany) and read the labels back in Step 3:

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
dimensions (`region`, `gender`, `ageCategory`, `performanceLevel`, `branche`, each
`{id, bezeichnung}`). Before reporting a row, check that its labels match the slice
you asked for; if the array holds several rows, pick by label, not by position.

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
- **403 with an empty body is ambiguous** — a wrong key, a refused network and a static
  key the API no longer accepts look the same (see the API-key paragraph above).
- German labels (`bezeichnung`) — pass through, don't translate.
