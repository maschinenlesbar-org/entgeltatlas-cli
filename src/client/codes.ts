// Static tables of the Entgeltatlas dimension codes (l/r/g/a/b), transcribed from
// the API documentation. The client checks every dimension filter of entgelte()
// against them before any request (dimensionCodeProblem), and the CLI's `codes`
// command prints them, so the numeric codes are discoverable offline — including
// the `l` (performance level) dimension, which has no reference endpoint. The live
// `regionen`/`geschlechter`/`alter`/`branchen` endpoints are the authoritative lists.

import type { Problem } from "./validate.js";

/** The query-parameter letters of the five dimensions, in table order. */
export const DIMENSION_PARAMS = ["l", "r", "g", "a", "b"] as const;

/** One dimension's query-parameter letter. */
export type DimensionParam = (typeof DIMENSION_PARAMS)[number];

export interface CodeEntry {
  id: number;
  bezeichnung: string;
}

export interface Dimension {
  /** The query-parameter letter (l/r/g/a/b). */
  param: DimensionParam;
  /** German name of the dimension. */
  label: string;
  values: CodeEntry[];
}

/** The code table of every dimension, in DIMENSION_PARAMS order. */
export const DIMENSIONS: readonly Dimension[] = [
  {
    param: "l",
    label: "Anforderungsniveau (Leistungsgruppe)",
    values: [
      { id: 1, bezeichnung: "Helfer" },
      { id: 2, bezeichnung: "Fachkraft" },
      { id: 3, bezeichnung: "Spezialist" },
      { id: 4, bezeichnung: "Experte" },
    ],
  },
  {
    param: "r",
    label: "Region (Bund/Ost/West, Länder, Städte)",
    values: [
      { id: 1, bezeichnung: "Deutschland" },
      { id: 2, bezeichnung: "Ostdeutschland" },
      { id: 3, bezeichnung: "Westdeutschland" },
      { id: 4, bezeichnung: "Schleswig-Holstein" },
      { id: 5, bezeichnung: "Hamburg" },
      { id: 6, bezeichnung: "Niedersachsen" },
      { id: 7, bezeichnung: "Bremen" },
      { id: 8, bezeichnung: "Nordrhein-Westfalen" },
      { id: 9, bezeichnung: "Hessen" },
      { id: 10, bezeichnung: "Rheinland-Pfalz" },
      { id: 11, bezeichnung: "Baden-Württemberg" },
      { id: 12, bezeichnung: "Bayern" },
      { id: 13, bezeichnung: "Saarland" },
      { id: 14, bezeichnung: "Berlin" },
      { id: 15, bezeichnung: "Brandenburg" },
      { id: 16, bezeichnung: "Mecklenburg-Vorpommern" },
      { id: 17, bezeichnung: "Sachsen" },
      { id: 18, bezeichnung: "Sachsen-Anhalt" },
      { id: 19, bezeichnung: "Thüringen" },
      { id: 20, bezeichnung: "Dresden" },
      { id: 21, bezeichnung: "Düsseldorf" },
      { id: 22, bezeichnung: "Dortmund" },
      { id: 23, bezeichnung: "Essen" },
      { id: 24, bezeichnung: "Frankfurt am Main" },
      { id: 25, bezeichnung: "Nürnberg" },
      { id: 26, bezeichnung: "Hannover" },
      { id: 27, bezeichnung: "Köln" },
      { id: 28, bezeichnung: "Leipzig" },
      { id: 29, bezeichnung: "München" },
      { id: 30, bezeichnung: "Stuttgart" },
    ],
  },
  {
    param: "g",
    label: "Geschlecht",
    values: [
      { id: 1, bezeichnung: "Gesamt" },
      { id: 2, bezeichnung: "Männer" },
      { id: 3, bezeichnung: "Frauen" },
    ],
  },
  {
    param: "a",
    label: "Alter",
    values: [
      { id: 1, bezeichnung: "Gesamt" },
      { id: 2, bezeichnung: "unter 25 Jahre" },
      { id: 3, bezeichnung: "25 bis unter 55 Jahre" },
      { id: 4, bezeichnung: "55 Jahre und älter" },
    ],
  },
  {
    param: "b",
    label: "Branche (Wirtschaftszweig)",
    values: [
      { id: 1, bezeichnung: "Gesamt" },
      { id: 2, bezeichnung: "Land- und Forstwirtschaft, Fischerei" },
      { id: 3, bezeichnung: "Produzierendes Gewerbe ohne Baugewerbe" },
      { id: 4, bezeichnung: "Baugewerbe" },
      { id: 5, bezeichnung: "Handel, Verkehr und Lagerei, Gastgewerbe" },
      { id: 6, bezeichnung: "Information und Kommunikation" },
      { id: 7, bezeichnung: "Finanz- und Versicherungsdienstleistungen" },
      { id: 8, bezeichnung: "Grundstücks- und Wohnungswesen" },
      { id: 9, bezeichnung: "Erbringung von wirtschaftlichen Dienstleistungen" },
      { id: 10, bezeichnung: "Öffentliche Verwaltung, Schul-, Gesundheits- und Sozialwesen" },
      { id: 11, bezeichnung: "Sonstige Dienstleistungen" },
    ],
  },
];

/** Keys that must never be sent or read as a filter (they reach Object.prototype). */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Why a key of `entgelte()`'s params is not a filter the API takes, or undefined. The
 * API documents five: `l`, `r`, `g`, `a`, `b`. It ignores any other parameter and
 * answers the unfiltered slice — so `{ region: 11 }` (the CLI's flag name) or `{ L: 4 }`
 * would silently return Deutschland / Gesamt with HTTP 200. `allowUnknown` (the
 * `allowUnknownFilters` option) lets a parameter the API adds later through; `__proto__`,
 * `constructor` and `prototype` never pass.
 */
export function filterKeyProblem(key: string, allowUnknown = false): string | undefined {
  if (FORBIDDEN_KEYS.has(key)) return `${JSON.stringify(key)} is not a filter.`;
  if ((DIMENSION_PARAMS as readonly string[]).includes(key) || allowUnknown) return undefined;
  return (
    `Unknown filter ${JSON.stringify(key)}: the API takes l, r, g, a and b (see DIMENSIONS), and ` +
    "ignores any other parameter, answering the unfiltered slice. Pass { allowUnknownFilters: true } " +
    "to send a parameter the API added after this release."
  );
}

/** How a dimension-code reason names the code: a label (e.g. a CLI flag) and a hint. */
export interface DimensionCodeWording {
  /** Put before "code" ("Unknown --region code 31"); omitted by default. */
  label?: string;
  /** Appended in parentheses after the valid range. */
  hint?: string;
}

/**
 * The rule for one dimension filter (`l`, `r`, `g`, `a` or `b`): a code from that
 * dimension's table in DIMENSIONS. What the API does with an unknown code is not
 * live-verified — if it ignored the parameter, the caller would silently get the
 * unfiltered slice — so an unknown code is rejected rather than sent. Anything but
 * a positive safe integer (NaN, Infinity, a fraction, a string) is rejected too.
 */
export function dimensionCodeProblem(
  param: DimensionParam,
  wording: DimensionCodeWording = {},
): Problem<number> {
  const dimension = DIMENSIONS.find((d) => d.param === param);
  if (dimension === undefined) throw new Error(`No dimension "${String(param)}" in codes.ts`);
  const ids = dimension.values.map((v) => v.id);
  const label = wording.label === undefined ? "" : `${wording.label} `;
  const hint = wording.hint === undefined ? "" : ` (${wording.hint})`;
  return (code) => {
    if (!Number.isSafeInteger(code) || code < 1) return "Expected a positive integer (codes start at 1).";
    if (ids.includes(code)) return undefined;
    return `Unknown ${label}code ${code}: valid codes are ${ids[0]}–${ids[ids.length - 1]}${hint}.`;
  };
}
