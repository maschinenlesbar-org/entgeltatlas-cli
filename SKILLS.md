# Skills

`entgeltatlas-cli` ships **Claude Code Agent Skills** as a plugin marketplace, so
Claude can drive the `entgeltatlas` CLI for common salary-statistics tasks. The
skills **validate** that the `entgeltatlas` CLI is on your PATH and tell you if it
is missing — they never install anything.

| Skill | Use it when you want to… |
|---|---|
| **entgelt-lookup** | Look up what one occupation earns — median gross-monthly salary + quartiles for a KldB code, sliced by level/region/gender/age/branch, read correctly. |
| **entgelt-gap-analyzer** | Compare salaries — the gender pay gap, East vs West, or Helfer→Experte progression — by fetching several slices and tabulating them. |
| **entgelt-code-finder** | Resolve the numeric codes the API needs — dimension codes (offline `codes`/live lists) and how to get a KldB occupation code (no name search). |

They compose: **code-finder → lookup**, or **code-finder → gap-analyzer**.

## Requirements

- The `entgeltatlas` CLI on PATH: `npm install -g @maschinenlesbar.org/entgeltatlas-cli`.
- **An X-API-Key** for the data commands (not `codes`): the BA's published
  community key. Set `ENTGELTATLAS_API_KEY` or pass `--api-key`. No key is bundled
  — fetch it via `npm run fetch-key` (from the repo) or
  [github.com/bundesAPI/entgeltatlas-api](https://github.com/bundesAPI/entgeltatlas-api).
- **Note:** `rest.arbeitsagentur.de` blocks datacenter/VPN IPs with an empty-body
  **403** — run from a residential connection if you hit one.

## Installing the plugin

This repo is a Claude Code plugin marketplace (`.claude-plugin/marketplace.json`
+ `.claude-plugin/plugin.json` + `skills/`). Add it as a marketplace in Claude
Code to enable the three skills. The `skills/` and `.claude-plugin/` files are
**not** shipped in the npm tarball — the published package is the client/CLI only.

The data these skills surface is the BA's, under custom BA terms — see
[DATA_LICENSE.md](DATA_LICENSE.md). Cite © Statistik der Bundesagentur für Arbeit.
