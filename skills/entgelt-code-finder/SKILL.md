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
version: 1.0.0
userInvocable: true
---

# Entgelt Code Finder

The Entgeltatlas speaks in numbers: a KldB occupation code and integer dimension
codes. This skill resolves those numbers so the `entgelte` lookup can run — the
common blocker, since the API takes no names.

## Tooling

This skill drives the `entgeltatlas` command. **Before anything else, validate it is available** — run `command -v entgeltatlas` (or `entgeltatlas --version`). If it is not on your PATH, STOP and inform the user that the `entgeltatlas` CLI (`@maschinenlesbar.org/entgeltatlas-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

**An X-API-Key is required** for the live reference commands (`regionen` etc.), but **`codes` works offline with no key**. The key is the BA's published community key; set `ENTGELTATLAS_API_KEY` (or pass `--api-key`) — obtain it out of band (the repo's `npm run fetch-key`, or github.com/bundesAPI/entgeltatlas-api). **A 403 with an empty body is usually a WAF/IP block** (datacenter/VPN/cloud IPs are refused), NOT a bad key. Use `--compact` for `jq`.

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

- **`codes` needs no key** — use it even when the API key/WAF is a problem.
- **Region codes are irregular** (not 1..16) — always verify.
- **A KldB code is mandatory** and must come from outside this API; don't fabricate
  one, and confirm its title before the user relies on the figures.
- Labels are German — keep them verbatim.
