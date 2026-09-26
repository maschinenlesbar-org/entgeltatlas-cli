---
name: entgelt-code-finder
description: >
  Find the numeric codes the Entgeltatlas needs — the KldB-2010 occupation code
  and the region/gender/age/branch dimension codes — using the entgeltatlas-cli.
  Trigger when the user asks "what's the region code for Bavaria?", "which code is
  Experte?", "what KldB code do I use for a nurse?", "list the branch codes", or is
  stuck because the salary lookup wants numbers, not names. Prints the offline
  code tables, queries the live reference lists, and explains how to resolve an
  occupation name to a KldB code (which this API cannot do itself).
compatibility: >
  Requires the `entgeltatlas` CLI (npm package
  @maschinenlesbar.org/entgeltatlas-cli) on PATH, installed by the user; the
  skill never installs it. Uses jq for JSON filtering. Network access to
  rest.arbeitsagentur.de. Needs the public API key via --api-key or
  ENTGELTATLAS_API_KEY (`entgeltatlas obtain-key` prints it).
---

# Entgelt Code Finder

The Entgeltatlas speaks in numbers: a KldB occupation code and integer dimension
codes. This skill resolves those numbers so the `entgelte` lookup can run — the
common blocker, since the API takes no names.

## Tooling

This skill drives the `entgeltatlas` command. **Before anything else, validate it is available** — run `command -v entgeltatlas` (or `entgeltatlas --version`). If it is not on your PATH, STOP and inform the user that the `entgeltatlas` CLI (`@maschinenlesbar.org/entgeltatlas-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

This skill also filters JSON with `jq`. **Validate it too** — run `command -v jq`. If it is missing, inform the user that `jq` is not installed — installing it is their responsibility; never install it yourself — and carry on without it: filter the CLI output with `node -e` instead (Node is already on your PATH, since the CLI runs on it).

**An X-API-Key is required** for the live reference commands (`regionen` etc.), but **`codes` works offline with no key**. The key is the BA's published community key; set `ENTGELTATLAS_API_KEY` (or pass `--api-key`) — obtain it with the CLI itself — `entgeltatlas obtain-key` prints the published key (stdout), reading it from github.com/bundesAPI/entgeltatlas-api at run time. **Keep that value for the rest of the session** and put it on later calls as `ENTGELTATLAS_API_KEY="<key>" entgeltatlas …`, since a shell `export` does not survive between separate commands. The key is public — name it when you report back — but never guess one if `obtain-key` fails. **A 403 with an empty body is ambiguous**: the gateway sends the same response for a wrong or missing key, for a refused network (WAF/IP block), and for a static key it no longer accepts — the published key got one on every Entgeltatlas endpoint on 2026-09-26, and upstream now documents an OAuth client-credentials flow this CLI does not implement. Have the user re-check the key with `entgeltatlas obtain-key` first; if it matches, tell them the API may no longer accept the published key (trying another network is only a secondary check), and never present a 403 as "no data". Use `--compact` for `jq`.

## Dimension codes (l / r / g / a / b)

Fastest and always available — the offline table:

```bash
entgeltatlas codes --compact | jq '.[] | select(.param=="r") | .values'
```

`codes` prints all five dimensions, including `l` (Anforderungsniveau), which has
**no** live endpoint. For the authoritative live lists there are also:

```bash
entgeltatlas regionen        # r codes
entgeltatlas geschlechter    # g codes
entgeltatlas alter           # a codes
entgeltatlas branchen        # b codes
```

Watch out: **region (`r`) numbering is irregular** — 1 Deutschland, 2 Ost, 3 West,
4–19 the sixteen Länder, 20–30 eleven cities. It is *not* 1..16, so never guess a
Bundesland by position; read it off `codes`/`regionen`.

## KldB occupation code

The `entgelte` command's argument is a **KldB-2010** code (3–5 digits). This API
has **no name search**, so resolve a name elsewhere:

- The **BERUFENET / DKZ** sibling BA APIs (name → KldB), or
- the **[Klassifikationsserver](https://www.klassifikationsserver.de/)** (browse
  the KldB tree by field and level).

Confirm the code's title with the user before running a salary lookup — a wrong
code returns real-looking data for the wrong job.

## Hand off

Once you have the code(s), assemble the command and hand off to **entgelt-lookup**
(single occupation) or **entgelt-gap-analyzer** (comparison):

```
KldB 84304 = "Berufe in der Hochschullehre und -forschung – hoch komplexe Tätigkeiten"
Region 11 = Baden-Württemberg · Level 4 = Experte
→ entgeltatlas entgelte 84304 -l 4 -r 11
```

## Traps

- **`codes` needs no key** — use it even when the API answers an empty 403.
- **Region codes are irregular** (not 1..16) — always verify.
- **A KldB code is mandatory** and must come from outside this API; don't fabricate
  one, and confirm its title before the user relies on the figures.
- Labels are German — keep them verbatim.
