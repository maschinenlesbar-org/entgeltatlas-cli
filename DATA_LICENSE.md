# Data license

> **This tool does not include, host, or redistribute any data.**
> `entgeltatlas-cli` is a *client*. It only accesses data served live by the
> **Statistik der Bundesagentur für Arbeit** via the Entgeltatlas API. That data
> is the BA's and is governed by **their** terms, summarized below. The license of
> this CLI's own source code is a separate matter — see [LICENSING.md](LICENSING.md).

| | |
|---|---|
| **Data provider** | Statistik der Bundesagentur für Arbeit |
| **API / source** | `https://rest.arbeitsagentur.de/infosysbub/entgeltatlas` · docs: https://github.com/bundesAPI/entgeltatlas-api |
| **Data license** | **Custom BA Nutzungsbedingungen** — attribution required, no modification. No SPDX / CC / `dl-de` identifier declared for this dataset. |
| **Terms** | https://statistik.arbeitsagentur.de/DE/Home/Service/Impressum/impressum_node.html |
| **Attribution** | **Required.** |
| **Commercial use** | Not explicitly licensed — a grey zone (see below). |
| **Redistribution** | Allowed, with source attribution and **unaltered**. |

## Attribution

Quote the source label verbatim:

```
© Statistik der Bundesagentur für Arbeit
```

For web publication, render it as a link to
[statistik.arbeitsagentur.de](https://statistik.arbeitsagentur.de). If you derive
your own calculations from the figures, label them as your own — do not attribute
derived numbers to the BA.

The BA's own wording on reuse:

> „Informationen dürfen (auch auszugsweise) gespeichert und mit Quellenangabe
> weitergegeben, vervielfältigt und verbreitet werden.“
> „Die Inhalte dürfen nicht verändert oder verfälscht werden.“

## Notes & caveats

- **Not an official API.** The Entgeltatlas REST endpoint and its OpenAPI spec are
  community-reverse-engineered (bundesAPI); the BA offers *„keine offizielle
  API“*. Field names may change without notice. This tool wraps it best-effort.
- **The credential is a published community `client_id`.** It is an access
  identifier, **not** a per-user reuse grant, and is never bundled here (fetch it
  via `npm run fetch-key`). No published rate-limit or non-sharing clause was found.
- **Redistribution covers the figures, not the prose.** The reuse grant applies to
  the factual earnings statistics the API returns. BA methodology/quality reports
  and other copyrightable works require explicit prior BA permission — do not
  re-badge them.
- **Commercial use is unclear.** The Impressum is silent on commercial reuse and
  the BA sells fee-based *Sonderauswertungen*; treat commercial repackaging as a
  grey zone and seek BA confirmation first.
- **The figures are censored/suppressed statistics**, not raw pay: earnings are a
  **median** (not mean), high earners are capped at the social-insurance ceiling,
  and small cells are suppressed. See [GLOSSARY.md](GLOSSARY.md). Present them as
  what they are.

## Sources

- https://statistik.arbeitsagentur.de/DE/Home/Service/Impressum/impressum_node.html — BA Statistik terms
- https://github.com/bundesAPI/entgeltatlas-api — community API docs / OpenAPI spec

---

*Good-faith summary compiled 2026-07-03; not legal advice. The provider's terms
are authoritative and can change — verify at the source before relying on the
data, especially for any commercial or redistribution use.*
