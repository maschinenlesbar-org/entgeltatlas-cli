# entgeltatlas-mcp

An [MCP](https://modelcontextprotocol.io/) server for the
[Entgeltatlas](https://web.arbeitsagentur.de/entgeltatlas/) of the Bundesagentur für Arbeit (BA):
what an occupation earns in Germany, as the median gross monthly pay of full-time employees with
the quartiles, by level, region, gender, age and branch; pay gaps between them; and the codes the
statistics need, as tools for AI agents. Read-only. The API needs its public key, which the server
finds by itself (see API key). The figures are the BA's statistics under its own terms (see
Licence).

It is the MCP side of [entgeltatlas-cli](https://github.com/maschinenlesbar-org/entgeltatlas-cli),
built on the same typed client, and released with it.

## Install

```bash
npm i -g @maschinenlesbar.org/entgeltatlas-mcp
```

This installs the **`entgeltatlas-mcp`** command (Node.js 22.12+). Or run the container image, for
linux/amd64 and linux/arm64, which needs no Node.js:

```bash
docker run -i --rm ghcr.io/maschinenlesbar-org/entgeltatlas-mcp:latest
```

## API key

The API wants an `X-API-Key`: one public value, the same for everyone, which the BA's own
Entgeltatlas web app configures. **No key is bundled.** The server takes it, at the first tool
call, from:

1. `ENTGELTATLAS_API_KEY` in its environment (what an MCP client's config sets);
2. else the key stored with `entgeltatlas config set api-key` (the CLI's credentials file,
   `$XDG_CONFIG_HOME/entgeltatlas/credentials`, else `~/.config/entgeltatlas/credentials`; a file
   others can read is refused, naming the fix);
3. else it obtains the published key from the
   [Entgeltatlas web app](https://web.arbeitsagentur.de/entgeltatlas/), as `entgeltatlas obtain-key`
   does, so a rotated key needs no new release.

One INFO record on stderr says which, never the key. The key is replaced with `***` in every log
record, result and error (a key shorter than 16 characters only where it stands whole, not inside a
longer word of the data). The server takes no key on its command line. A lookup that fails (the web
app unreachable) is that call's error, and the next call tries again. In a container without network
access to web.arbeitsagentur.de, pass the key: `docker run -i --rm -e ENTGELTATLAS_API_KEY
ghcr.io/…`.

## Connect a client

The server speaks MCP on stdio by default.

**Claude Code**

```bash
claude mcp add entgeltatlas -- entgeltatlas-mcp
# or with the image:
claude mcp add entgeltatlas -- docker run -i --rm ghcr.io/maschinenlesbar-org/entgeltatlas-mcp:latest
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{ "mcpServers": { "entgeltatlas": { "command": "entgeltatlas-mcp" } } }
```

**VS Code** (`.vscode/mcp.json`)

```json
{ "servers": { "entgeltatlas": { "type": "stdio", "command": "entgeltatlas-mcp" } } }
```

To set the key yourself, add `"env": { "ENTGELTATLAS_API_KEY": "…" }` to the entry (the value
`entgeltatlas obtain-key` prints).

**Over HTTP** (Streamable HTTP, one endpoint `POST /mcp`):

```bash
entgeltatlas-mcp --transport http            # http://127.0.0.1:3000/mcp
claude mcp add --transport http entgeltatlas http://127.0.0.1:3000/mcp
```

The key is public, so HTTP needs no authentication for it. In a container, publish the port on
loopback only:
`docker run --rm -p 127.0.0.1:3000:3000 ghcr.io/maschinenlesbar-org/entgeltatlas-mcp:latest --transport http --host 0.0.0.0 --allowed-hosts localhost,127.0.0.1`.

For scripts and shared configs, pin a release and its digest from the
[release notes](https://github.com/maschinenlesbar-org/entgeltatlas-cli/releases) instead of
`latest`: `…/entgeltatlas-mcp:<version>@sha256:<digest>`. Check an image's provenance with
`gh attestation verify oci://ghcr.io/maschinenlesbar-org/entgeltatlas-mcp:<version> --repo maschinenlesbar-org/entgeltatlas-cli`.

## Tools

| Tool | What it answers |
|---|---|
| `lookupPay` | What one occupation (its KldB-2010 code) earns in a slice: the median, the quartiles and the headcount, with names resolved to codes (German or English, with or without umlauts, or with ae, oe, ue for them), Deutschland and Gesamt by default, "all" for one row per value (paged), and the API's markers read as what they are. |
| `comparePay` | One dimension varied (gender, region, level, age or branch), every other held, in one request: each value's median and its gap in EUR and percent to the base, within the same level: the first value with a median (`base`; when that differs per level, there is no `base` and each gap's `gapTo` names its own). Over the size cap the points are a page (`offset`, `nextOffset`). |
| `findCodes` | The codes of the five dimensions, a code found by name (German or English), the API's own lists on request with where they differ, and where an occupation's KldB code comes from. |

The tools carry the API's traps so a model doesn't have to: the API has no occupation-name search,
so an occupation word is answered with where KldB codes come from (BERUFENET, the
Klassifikationsserver), never with a guessed code, while a blank code or one with digits that isn't
3–5 ASCII digits (full-width digits, a path) is a tool error, never read as an occupation word; a 5-digit code's fifth digit is its level (another level is answered without a request), and
every 4-digit code tried answered no rows; region codes are irregular (1 Deutschland, 2 Ost, 3 West,
4-19 the Länder, 20-30 eleven cities), and Ost and West answer no rows, which is said, not passed
off as a suppressed figure; an omitted dimension answers one row per value of it, so every
dimension is held (Deutschland and Gesamt by default; in `comparePay` one value each, never "all")
and rows are picked by their labels, never by position (a compared value answered by several rows is
reported in `missing`); a negative figure is a marker, never an amount (-1 suppressed, too few cases; -2 above the
contribution ceiling; -100 no figure), and null is no figure either: never 0; the figures are
medians cut off at the contribution ceiling, so a censored value is flagged and a gap at the top may
be larger than shown; a branch is answered only with gender and age Gesamt, so crossing them is
refused before any request; an answer for another slice than the one asked for is an error, never
its figures. The `source` of `lookupPay` and `comparePay` is the request they sent; an answer that
made none (a name that matched nothing or several codes, a refused combination, an occupation word)
names only the salary endpoint.

Every tool only reads. An answer is JSON (`structuredContent` and the same as text), with the
`source` it came from (whole, never cut like the data; an answer a redirect fetched from another
host says so there: "… (answered by https://other.example after a redirect)", and a WARN record
names both) and the data licence. A text over 2000 characters is cut and ends in `…[cut, N
characters in all]`, and the answer says `truncated`. An answer over `--max-result-chars` first
loses entries from the end of its page (then `nextOffset` says where to go on), then has its longest
texts cut further (each with that mark) or, when that isn't enough, its other lists shortened
(`reason` names them); a list keeps its first entry, `notes` stay whole (as do the lists a tool
keeps whole, a part of which would be wrong data), and the answer says `truncated`. One that can't
be cut down so far is a tool error that says to ask for less. An answer from the source over 16 MiB,
the most the server reads, is a tool error that says so: narrower options don't make it smaller. A
failure is a tool error that says what to change (one over 5000 characters loses its middle, never
its end, where the reason is); the gateway's bare 403 (a wrong or outdated key, a refused network) says what
to check, a 404 that it is the gateway's (the API answers a code without figures with an empty list),
a 5xx and a request timeout that they are not "no data" and when to try again.

## Options

```
--transport <stdio|http>   stdio (default), or Streamable HTTP on POST /mcp
--host <address>           HTTP: the address to listen on (default 127.0.0.1)
--port <n>                 HTTP: the port (default 3000)
--allowed-hosts <list>     HTTP: Host header names to answer (default localhost,127.0.0.1,[::1])
--allowed-origins <list>   HTTP: browser origins allowed to call, exactly (https://app.example.org); none by default
--auth-token-file <path>   HTTP: a file with the bearer token every request must send (mode 600, 32+ characters)
--base-url <url>           API host (default https://rest.arbeitsagentur.de)
--timeout <ms>             per upstream request (default 30000)
--call-timeout <ms>        per tool call, retries included (default 45000)
--max-result-chars <n>     cap on one tool result's JSON (default 25000)
--max-pages <n>            pages a tool reads per list and call (default 10)
--user-agent <ua>          User-Agent header value (Latin-1, one line)
--log-format <text|jsonl>  the log records on stderr (default text)
```

## What it does and doesn't do

- **Read-only.** No tool changes anything, here or upstream.
- **No authentication** on HTTP unless you give one. It listens on loopback by default; it checks
  the `Host` header and, from a browser, the `Origin` (only the origins given with
  `--allowed-origins`, matched exactly) against DNS rebinding and other web pages; a page on one of
  those origins gets CORS (its preflight answered, the answers readable). With `--auth-token-file
  <path>` every request must send `Authorization: Bearer <token>` (the file holds one token of at
  least 32 characters, mode 600, owned by the user the server runs as, a regular file (a FIFO is
  refused at once, never waited on); read once at start; `(umask 077; openssl rand -hex 32 >
  mcp-token)` makes one); anything else is answered 401. Exposed beyond localhost (it logs a warning
  then), it belongs behind a proxy that authenticates or at least terminates TLS.
- **Gentle with the upstream.** One server process sends at most 2 requests at a time and 120 a
  minute to the API, pauses the requests to a host that answers HTTP 429 (as long as its Retry-After
  asks, at most 30 s; those to another host go on), and stops a tool call after its deadline (a tool
  that has read part of its answer by then may answer with that part, and says so). `lookupPay` and
  `comparePay` make one request each; `findCodes` none, or one per list with `live` (at most four);
  the first call also reads the key's source once when no key is set (a 429 from it is held like
  one from the API, and a call that ends meanwhile is told the key is being looked up). A request those limits would
  hold longer than it or its call may wait is not sent: the call fails at once, naming the limit and
  when to ask again (and the log says so).
- **Results are data.** Text from the API, keys included, is cleaned (control, bidi, zero-width, tag
  and other invisible characters removed, but an emoji keeps its joiners; the API key echoed with
  one inside is still replaced; a key that cleaning makes equal to another stays, as `name~2`), but
  it is still text from outside: a model can be told things in it. The server can't act on that (it
  has no tool that writes), but other tools in the same session could.
- **Stops cleanly.** On `docker stop` (SIGTERM) or Ctrl-C the HTTP server takes no new connection
  and lets calls in flight answer for up to 5 s, then exits 143 (130); a second signal ends it at
  once. On stdio a signal ends it at once; when stdin ends, it first answers the requests it has
  read (each within its call deadline), then exits.
- **In a container** it needs at least 12 processes and threads (`--pids-limit`) and about
  256 MB of memory.
- **Logs** go to stderr, one record per line; stdout carries only the protocol. A call that fails
  upstream or reaches its deadline leaves a WARN record naming the tool.
- **Never installs anything.**

## Licence

Code: AGPL-3.0-or-later or commercial
([LICENSING.md](https://github.com/maschinenlesbar-org/entgeltatlas-cli/blob/main/LICENSING.md)).
Data: the figures are the Statistik der Bundesagentur für Arbeit's, served live, under the BA's
own terms, not an open licence: they may be stored and passed on with the source
(© Statistik der Bundesagentur für Arbeit) and unaltered; calculations of your own (the gaps of
`comparePay` included) are to be labelled as yours, not the BA's; commercial reuse is not
explicitly licensed ([terms](https://statistik.arbeitsagentur.de/DE/Home/Service/Impressum/impressum_node.html),
[DATA_LICENSE.md](https://github.com/maschinenlesbar-org/entgeltatlas-cli/blob/main/DATA_LICENSE.md)).
Every result carries this note in its `licence` field. We provide the tool, not the data: running
the server as a service for others may need the BA's permission.
