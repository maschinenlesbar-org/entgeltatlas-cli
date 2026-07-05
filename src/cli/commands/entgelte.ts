// Command group for the Entgeltatlas CLI: the primary `entgelte` salary lookup,
// the live reference-list commands, and the offline `codes` table.

import type { Command } from "commander";
import type { CliDeps } from "../io.js";
import type { EntgeltatlasClient } from "../../client/client.js";
import type { EntgelteParams } from "../../client/types.js";
import { action, parseCode, parseKldb, renderJson } from "../shared.js";
import { DIMENSIONS } from "../codes.js";

const REFERENCES: { name: string; desc: string; run: (c: EntgeltatlasClient) => Promise<unknown> }[] = [
  { name: "regionen", desc: "List region codes (the `r` dimension)", run: (c) => c.regionen() },
  { name: "geschlechter", desc: "List gender codes (the `g` dimension)", run: (c) => c.geschlechter() },
  { name: "alter", desc: "List age-band codes (the `a` dimension)", run: (c) => c.alter() },
  { name: "branchen", desc: "List branch/industry codes (the `b` dimension)", run: (c) => c.branchen() },
];

export function registerCommands(program: Command, deps: CliDeps): void {
  program
    .command("entgelte")
    .description("Gross-salary statistics for a KldB-2010 occupation code")
    .argument("<kldb>", "KldB-2010 occupation code (3–5 digits, e.g. 84304)", parseKldb)
    .option("-l, --level <code>", "Anforderungsniveau 1–4 (see `codes`)", parseCode)
    .option("-r, --region <code>", "Region 1–30 (see `codes`)", parseCode)
    .option("-g, --gender <code>", "Geschlecht 1–3 (see `codes`)", parseCode)
    .option("-a, --age <code>", "Alter 1–4 (see `codes`)", parseCode)
    .option("-b, --branch <code>", "Branche 1–11 (see `codes`)", parseCode)
    .action(
      action(deps, async ({ client, global, opts }, [kldb]) => {
        const params: EntgelteParams = {};
        if (opts["level"] !== undefined) params.l = opts["level"] as number;
        if (opts["region"] !== undefined) params.r = opts["region"] as number;
        if (opts["gender"] !== undefined) params.g = opts["gender"] as number;
        if (opts["age"] !== undefined) params.a = opts["age"] as number;
        if (opts["branch"] !== undefined) params.b = opts["branch"] as number;
        renderJson(deps, global, await client.entgelte(kldb!, params));
      }),
    );

  for (const ref of REFERENCES) {
    program
      .command(ref.name)
      .description(ref.desc)
      .action(
        action(deps, async ({ client, global }) => {
          renderJson(deps, global, await ref.run(client));
        }),
      );
  }

  program
    .command("codes")
    .description("Print the dimension code tables (l/r/g/a/b) — works offline, no API key")
    .action(
      action(deps, async ({ global }) => {
        renderJson(deps, global, DIMENSIONS);
      }),
    );
}
