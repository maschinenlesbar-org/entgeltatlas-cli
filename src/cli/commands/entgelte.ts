// Command group for the Entgeltatlas CLI: the primary `entgelte` salary lookup,
// the live reference-list commands, and the offline `codes` table.

import type { Command } from "commander";
import type { CliDeps } from "../io.js";
import type { EntgeltatlasClient } from "../../client/client.js";
import type { EntgelteParams } from "../../client/types.js";
import { DIMENSION_FLAGS, action, parseDimensionCode, parseKldb, renderJson, type GlobalOptions } from "../shared.js";
import { DIMENSIONS } from "../../client/codes.js";

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
    .option("-l, --level <code>", "Anforderungsniveau 1–4 (see `codes`)", parseDimensionCode("l"))
    .option("-r, --region <code>", "Region 1–30 (see `codes`)", parseDimensionCode("r"))
    .option("-g, --gender <code>", "Geschlecht 1–3 (see `codes`)", parseDimensionCode("g"))
    .option("-a, --age <code>", "Alter 1–4 (see `codes`)", parseDimensionCode("a"))
    .option("-b, --branch <code>", "Branche 1–11 (see `codes`)", parseDimensionCode("b"))
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
    // No client and no key: `codes` is offline, so a malformed ENTGELTATLAS_API_KEY
    // (or any other client option) must not stop it.
    .action((...args: unknown[]) => {
      const command = args[args.length - 1] as Command;
      const global = command.optsWithGlobals() as GlobalOptions;
      // The library's tables, with each dimension's CLI flag after its param.
      renderJson(
        deps,
        global,
        DIMENSIONS.map(({ param, label, values }) => ({ param, flag: DIMENSION_FLAGS[param], label, values })),
      );
    });
}
