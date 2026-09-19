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
compatibility: >
  Requires the `entgeltatlas` CLI (npm package
  @maschinenlesbar.org/entgeltatlas-cli) on PATH, installed by the user; the
  skill never installs it. Uses jq for JSON filtering. Network access to
  rest.arbeitsagentur.de. Needs the public API key via --api-key or
  ENTGELTATLAS_API_KEY (`entgeltatlas obtain-key` prints it).
---

# Entgelt Gap Analyzer

Answer comparative pay questions the single API call can't — gender gap, regional
spread, level progression — by fetching one slice per comparison point and
tabulating the medians side by side. The API returns one occupation × one slice;
the whole job of this skill is the loop and the honest comparison.

## Tooling

This skill drives the `entgeltatlas` command. **Before anything else, validate it is available** — run `command -v entgeltatlas` (or `entgeltatlas --version`). If it is not on your PATH, STOP and inform the user that the `entgeltatlas` CLI (`@maschinenlesbar.org/entgeltatlas-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

This skill also filters JSON with `jq`. **Validate it too** — run `command -v jq`. If it is missing, inform the user that `jq` is not installed — installing it is their responsibility; never install it yourself — and carry on without it: filter the CLI output with `node -e` instead (Node is already on your PATH, since the CLI runs on it).

**An X-API-Key is required** for the data commands (not for `codes`). It is the BA's published community key; set `ENTGELTATLAS_API_KEY` (or pass `--api-key`). There is **no bundled key** — obtain it with the CLI itself — `entgeltatlas obtain-key` prints the published key (stdout), reading it from github.com/bundesAPI/entgeltatlas-api at run time. **Keep that value for the rest of the session** and put it on later calls as `ENTGELTATLAS_API_KEY="<key>" entgeltatlas …`, since a shell `export` does not survive between separate commands. The key is public — name it when you report back — but never guess one if `obtain-key` fails. **A 403 with an empty body is ambiguous**: the gateway sends the same response for a wrong or missing key as when it refuses your network (WAF/IP block). Don't rule either out — have the user re-check the key with `entgeltatlas obtain-key` first, and if it matches, try from another network (e.g. a residential connection). Use `--compact` for `jq`. Cite the source: © Statistik der Bundesagentur für Arbeit.

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
entgeltatlas entgelte 84304 -l 4 -r 1 -g 2 --compact   # Männer, Deutschland
entgeltatlas entgelte 84304 -l 4 -r 1 -g 3 --compact   # Frauen, Deutschland
```

Pull `entgelt` (median) from the row whose labels (`region`, `gender`, `ageCategory`,
`performanceLevel`, `branche`) match the slice; don't assume `[0]` is it, since an
omitted flag leaves the slice to the server. Keep `besetzung` (headcount) — a tiny
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
- **403 with an empty body is ambiguous** — a wrong key and a refused network look the
  same. Re-check the key against the bundesAPI README, then try another network.
- Don't over-claim causation — these are descriptive statistics, not adjusted for
  qualification, tenure, or hours.
