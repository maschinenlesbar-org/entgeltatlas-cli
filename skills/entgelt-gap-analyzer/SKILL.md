---
name: entgelt-gap-analyzer
description: >
  Compare German salaries across dimensions using the entgeltatlas-cli — the
  gender pay gap, East vs West or regional differences, or the pay progression
  from Helfer to Experte for one occupation. Trigger when the user asks "gender
  pay gap for nurses?", "does occupation X pay more in Bavaria than Saxony?",
  "how much more does an Experte earn than a Fachkraft?", "compare salaries for
  KldB 84304 across regions", or wants a comparison rather than a single figure.
  Runs several entgelte lookups (one per slice) and tabulates them, with the
  suppression/censoring caveats.
version: 1.0.0
userInvocable: true
---

# Entgelt Gap Analyzer

Answer comparative pay questions the single API call can't — gender gap, regional
spread, level progression — by fetching one slice per comparison point and
tabulating the medians side by side. The API returns one occupation × one slice;
the whole job of this skill is the loop and the honest comparison.

## Tooling

This skill drives the `entgeltatlas` command. **Before anything else, validate it is available** — run `command -v entgeltatlas` (or `entgeltatlas --version`). If it is not on your PATH, STOP and inform the user that the `entgeltatlas` CLI (`@maschinenlesbar.org/entgeltatlas-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

**An X-API-Key is required** for the data commands (not for `codes`). It is the BA's published community key; set `ENTGELTATLAS_API_KEY` (or pass `--api-key`). There is **no bundled key** — obtain it out of band (the repo's `npm run fetch-key`, or github.com/bundesAPI/entgeltatlas-api). **A 403 with an empty body is usually a WAF/IP block** (datacenter/VPN/cloud IPs are refused), NOT a bad key — if you hit one, tell the user to run from a residential connection rather than assuming the key is wrong. Use `--compact` for `jq`. Cite the source: © Statistik der Bundesagentur für Arbeit.

## Step 1 — Fix the occupation, vary ONE dimension

You need the numeric **KldB-2010 code** (no name search — see the entgelt-lookup
skill / BERUFENET to resolve a name). Hold every dimension constant except the one
being compared, so the medians are comparable. `entgeltatlas codes` lists the code
values.

- **Gender gap** → vary `-g` (2 Männer vs 3 Frauen), same `-l`/`-r`/`-a`/`-b`.
- **Regional** → vary `-r` (e.g. 2 Ost vs 3 West, or two Länder/cities).
- **Level progression** → vary `-l` (1 Helfer → 4 Experte).

## Step 2 — Fetch one slice per point

Run the calls sequentially (be gentle — the API throttles):

```bash
entgeltatlas entgelte 84304 -l 4 -g 2 --compact   # Männer
entgeltatlas entgelte 84304 -l 4 -g 3 --compact   # Frauen
```

Pull `entgelt` (median) from each `[0]`. Keep `besetzung` (headcount) — a tiny
`besetzung` makes a comparison unreliable, and a suppressed slice has no number
at all.

## Step 3 — Tabulate and compute the gap

```
Gehaltsvergleich — Berufe in der Hochschullehre (KldB 84304), Experten, Deutschland
  Männer:  6.700 €/Monat brutto  (n=8.900)
  Frauen:  6.100 €/Monat brutto  (n=3.400)
  Gap:     −600 € (−9,0 %) zu Ungunsten der Frauen
Quelle: © Statistik der Bundesagentur für Arbeit. Median-Bruttomonatsentgelte, Vollzeit.
```

Compute the gap only between two **present** medians. Report absolute and percent.

## Traps

- **Suppressed slice → no comparison.** If either side is `null`/empty (Fallzahl
  too small), say so and do **not** substitute 0 or invent a value.
- **Censoring hides top-end gaps.** Both medians are capped at the social-insurance
  ceiling (`beitragsBemessungsGrenze`); for high earners the *real* gap may be
  larger than the medians show — flag this.
- **Compare like with like.** Only vary the one dimension under study; a gender gap
  computed across different regions or levels is meaningless.
- **It's a median, not a mean.** Frame results as "median gross monthly", and note
  it does not account for hours beyond full-time, bonuses, or occupation mix.
- **403 empty body = WAF/IP block**, usually not the key — advise a residential IP.
- Don't over-claim causation — these are descriptive statistics, not adjusted for
  qualification, tenure, or hours.
