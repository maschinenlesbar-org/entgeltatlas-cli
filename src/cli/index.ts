#!/usr/bin/env node
// Bin shim: parse argv, run the CLI, and set the process exit code. All real
// logic lives in run.ts (testable without spawning a subprocess).

import { handleOutputErrors } from "./io.js";
import { createLogger, logFormatFromArgv } from "./log.js";
import { run } from "./run.js";

const argv = process.argv.slice(2);
handleOutputErrors();
run(argv).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    // run() reports every error itself; this is the last resort, a record like the others.
    createLogger({ format: logFormatFromArgv(argv), write: (line) => process.stderr.write(line + "\n") }).error(
      "cli",
      `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
  },
);
