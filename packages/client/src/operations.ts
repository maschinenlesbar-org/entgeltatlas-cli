// The use cases of the skills as library functions, built on the client: each composes the
// client's calls and carries the traps the skills document, so no caller (the CLI, the MCP
// server's use-case tools, a library user) has to know them.
// - lookupPay: one occupation's median and quartiles for a slice, the API's markers read as what
//   they are (entgelt-lookup);
// - comparePay: one dimension varied, every other held, with the gap to the first value
//   (entgelt-gap-analyzer);
// - findCodes: the dimension codes for a name, the code tables, the live reference lists, and why
//   an occupation needs its KldB code from elsewhere (entgelt-code-finder).
//
// Traps that hold for all of them: the API takes no names, only a KldB-2010 code (3 or 5 digits;
// every 4-digit code tried answered no rows) and integer dimension codes; region codes are
// irregular (1 Deutschland, 2 Ost, 3 West, 4-19 the Länder, 20-30 cities), and Ost/West answer no
// rows; there is no Gesamt level, and a 5-digit code's fifth digit is its level; a branch other
// than Gesamt is answered only with gender and age Gesamt; an omitted dimension answers one row
// per value of it, Gesamt included; a negative figure is a marker, never an amount (-1 suppressed,
// -2 above the contribution ceiling, -100 no figure), and null is no figure either; the figures are
// medians, censored at the contribution ceiling. Ambiguity is reported, never guessed; an empty
// answer says why when the request explains it.

import { emptyAnswerNote, type EntgeltatlasClient } from "./client.js";
import { DIMENSIONS, type CodeEntry, type DimensionParam } from "./codes.js";
import { EntgeltatlasValidationError, quoteValue } from "./errors.js";
import type { EntgeltEntry, EntgelteParams, ReferenceItem } from "./types.js";

/** What every operation answers: ok, ambiguous (ask which), or empty (with the reason). */
export type OperationStatus = "ok" | "ambiguous" | "empty";

// --- Shared ----------------------------------------------------------------------------------

/** The five dimensions by name, in the API's table order. */
export const DIMENSION_NAMES = ["level", "region", "gender", "age", "branch"] as const;
export type DimensionName = (typeof DIMENSION_NAMES)[number];

/** Each dimension's query parameter. */
export const PARAM_OF: Readonly<Record<DimensionName, DimensionParam>> = { level: "l", region: "r", gender: "g", age: "a", branch: "b" };

/** What the figures are. */
export const UNIT = "EUR gross per month, full-time employees subject to social insurance: the median and the quartiles (not the mean)";

/** Why an occupation needs its code from elsewhere: the API has no name search. */
export const NO_NAME_SEARCH =
  "The Entgeltatlas has no occupation-name search: it takes a KldB-2010 code, a 3-digit occupation group (434) or a 5-digit occupation (84304, its fifth digit is the level). " +
  "Take the code from the user, from BERUFENET (berufenet.arbeitsagentur.de) or from the Klassifikationsserver (https://www.klassifikationsserver.de/, KldB 2010); never guess one, " +
  "and confirm its title with the user: a wrong code answers real figures for another job.";

/** A code and its name. */
export interface Coded {
  code: number;
  name: string;
}

/** A dimension's value as a caller gives it: the code, or a name (German or English). */
export type DimensionValue = number | string;

/** Lower case, no accents or umlaut dots, ß as ss, single spaces: for matching names. */
export function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").replace(/ß/g, "ss").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Other names people use for a code: English, abbreviations (ISO 3166-2:DE for the Länder), short forms. */
const ALIASES: Readonly<Record<DimensionName, Readonly<Record<string, number>>>> = {
  level: { helper: 1, unskilled: 1, skilled: 2, "skilled worker": 2, specialist: 3, expert: 4 },
  region: {
    germany: 1, de: 1, bund: 1, ost: 2, east: 2, "east germany": 2, "eastern germany": 2, west: 3, "west germany": 3, "western germany": 3,
    sh: 4, hh: 5, ni: 6, "lower saxony": 6, hb: 7, nw: 8, nrw: 8, "north rhine-westphalia": 8, he: 9, hesse: 9, rp: 10, "rhineland-palatinate": 10,
    bw: 11, by: 12, bavaria: 12, sl: 13, be: 14, bb: 15, mv: 16, "mecklenburg-western pomerania": 16, sn: 17, saxony: 17, st: 18, "saxony-anhalt": 18,
    th: 19, thuringia: 19, frankfurt: 24, nuremberg: 25, hanover: 26, cologne: 27, munich: 29,
  },
  gender: { all: 1, total: 1, both: 1, men: 2, man: 2, male: 2, mannlich: 2, m: 2, women: 3, woman: 3, female: 3, weiblich: 3, w: 3, f: 3 },
  age: {
    all: 1, total: 1, "under 25": 2, "unter 25": 2, u25: 2, "<25": 2, "25-55": 3, "25 to 55": 3, "25 bis 55": 3, "25 bis unter 55": 3,
    "55+": 4, "over 55": 4, "55 and older": 4, "55 and over": 4, "ab 55": 4, "55 und alter": 4,
  },
  branch: {
    all: 1, total: 1, agriculture: 2, forestry: 2, fishing: 2, landwirtschaft: 2, manufacturing: 3, industry: 3, industrie: 3, construction: 4, bau: 4,
    trade: 5, retail: 5, handel: 5, transport: 5, logistics: 5, hospitality: 5, gastgewerbe: 5, it: 6, ict: 6, "information and communication": 6,
    finance: 7, banking: 7, insurance: 7, "real estate": 8, immobilien: 8, "business services": 9, "public sector": 10, "public administration": 10,
    health: 10, education: 10, "social work": 10, "other services": 11,
  },
};

/** The code table of one dimension. */
export function codeTable(dimension: DimensionName): readonly CodeEntry[] {
  return DIMENSIONS.find((d) => d.param === PARAM_OF[dimension])?.values ?? [];
}

/** The name of `code` in `dimension`'s table (the code itself when it has none). */
export function codeName(dimension: DimensionName, code: number): string {
  return codeTable(dimension).find((v) => v.id === code)?.bezeichnung ?? String(code);
}

const coded = (dimension: DimensionName, code: number): Coded => ({ code, name: codeName(dimension, code) });

/** What a name or code resolves to in one dimension. */
export type Resolved = { status: "ok"; value: Coded } | { status: "ambiguous"; candidates: Coded[] } | { status: "empty" };

/**
 * A dimension's value from a code (a number or digits) or a name: the table's name (any case, with
 * or without umlauts), an alias (English, an abbreviation), else the one name that contains it
 * (at least 3 letters). Several names containing it are ambiguous; an exact name wins over names
 * that contain it ("Sachsen", not "Sachsen-Anhalt"). An unknown code is a validation error.
 */
export function resolveCode(dimension: DimensionName, value: DimensionValue): Resolved {
  const table = codeTable(dimension);
  const asNumber = typeof value === "number" ? value : /^\s*\d{1,3}\s*$/.test(value) ? Number(value.trim()) : undefined;
  if (asNumber !== undefined) {
    if (!table.some((v) => v.id === asNumber)) {
      throw new EntgeltatlasValidationError(
        `Unknown ${dimension} code ${asNumber}: the codes are ${table.map((v) => `${v.id} ${v.bezeichnung}`).join(", ")}.`,
      );
    }
    return { status: "ok", value: coded(dimension, asNumber) };
  }
  const wanted = fold(String(value));
  if (wanted === "") throw new EntgeltatlasValidationError(`Invalid ${dimension}: a code or a name, not blank.`);
  const exact = table.find((v) => fold(v.bezeichnung) === wanted);
  if (exact !== undefined) return { status: "ok", value: coded(dimension, exact.id) };
  const alias = Object.entries(ALIASES[dimension]).find(([name]) => fold(name) === wanted)?.[1];
  if (alias !== undefined) return { status: "ok", value: coded(dimension, alias) };
  if (wanted.length < 3) return { status: "empty" };
  const containing = table.filter((v) => fold(v.bezeichnung).includes(wanted));
  if (containing.length === 1) return { status: "ok", value: coded(dimension, containing[0]!.id) };
  if (containing.length > 1) return { status: "ambiguous", candidates: containing.map((v) => coded(dimension, v.id)) };
  return { status: "empty" };
}

/** A KldB code checked for digits: undefined when it is an occupation name (the API has no name search). */
function kldbDigits(kldb: string): string | undefined {
  const trimmed = kldb.trim();
  return /^\d+$/.test(trimmed) ? trimmed : undefined;
}

/** What a KldB code is, by its length. */
export function kldbKind(kldb: string): string {
  if (kldb.length === 3) return "a 3-digit occupation group (Berufsgruppe): one row per level unless level is given";
  if (kldb.length === 4) return "a 4-digit occupation subgroup (Berufsuntergruppe): the API has answered every one tried with no rows";
  if (kldb.length === 5) {
    const own = Number(kldb[4]);
    return own >= 1 && own <= 4
      ? `a 5-digit occupation (Berufsgattung) at level ${own} (${codeName("level", own)}): its fifth digit is its level, the only one the API answers`
      : "a 5-digit occupation (Berufsgattung)";
  }
  return "a KldB-2010 code";
}

/** One slice's figures, read honestly. */
export interface PayRow {
  level: Coded;
  region: Coded;
  gender: Coded;
  age: Coded;
  branch: Coded;
  /** The median in EUR, or null: no amount (see notes). Never 0 for a missing figure. */
  median: number | null;
  q25: number | null;
  q75: number | null;
  /** How many employees the figures rest on; null when suppressed. */
  headcount: number | null;
  /** The region's contribution ceiling (Beitragsbemessungsgrenze) in EUR: pay above it is not recorded exactly. */
  ceiling?: number;
  /** True when a figure reaches the ceiling or lies above it: the top end is cut off. */
  censored?: boolean;
  /** Why a figure is missing, or what a figure means when it isn't an amount. */
  notes?: string[];
}

const PAY_FIELDS = [
  ["median", "entgelt"],
  ["q25", "entgeltQ25"],
  ["q75", "entgeltQ75"],
] as const;

/** A row of the API, its markers read: -1 suppressed, -2 above the ceiling, -100 no figure, null no figure. */
export function payRowOf(row: EntgeltEntry): PayRow {
  const label = (d: { id: number; bezeichnung: string }): Coded => ({ code: d.id, name: d.bezeichnung });
  const ceiling = typeof row.region.beitragsBemessungsGrenze === "number" && row.region.beitragsBemessungsGrenze > 0 ? row.region.beitragsBemessungsGrenze : undefined;
  const raw = PAY_FIELDS.map(([, field]) => row[field]);
  const notes: string[] = [];
  let censored = false;
  const allEqual = (marker: number): boolean => raw.every((v) => v === marker);
  if (allEqual(-1)) notes.push("suppressed: too few cases (keine Angabe, Fallzahl zu klein); not 0 EUR");
  else if (allEqual(-100)) notes.push("no figure for this slice (keine Angabe; the API marks it -100 and doesn't say why); not 0 EUR");
  else if (raw.every((v) => v === null || v === undefined)) notes.push("no figure for this slice (keine Angabe); not 0 EUR");
  else {
    PAY_FIELDS.forEach(([name], i) => {
      const v = raw[i];
      if (v === null || v === undefined) notes.push(`${name}: no figure (keine Angabe)`);
      else if (v === -2) {
        censored = true;
        notes.push(`${name}: above the contribution ceiling (über der Beitragsbemessungsgrenze${ceiling === undefined ? "" : `, ${ceiling} EUR`}): the value is unknown`);
      } else if (v === -1) notes.push(`${name}: suppressed, too few cases (keine Angabe)`);
      else if (v < 0) notes.push(`${name}: the API's marker ${v}, not an amount (undocumented)`);
      else if (ceiling !== undefined && v >= ceiling) {
        censored = true;
        notes.push(`${name}: at the contribution ceiling (${ceiling} EUR): the real value may be higher`);
      }
    });
  }
  const amount = (v: number | null | undefined): number | null => (typeof v === "number" && v >= 0 ? v : null);
  return {
    level: label(row.performanceLevel),
    region: label(row.region),
    gender: label(row.gender),
    age: label(row.ageCategory),
    branch: label(row.branche),
    median: amount(row.entgelt),
    q25: amount(row.entgeltQ25),
    q75: amount(row.entgeltQ75),
    headcount: amount(row.besetzung),
    ...(ceiling === undefined ? {} : { ceiling }),
    ...(censored ? { censored: true } : {}),
    ...(notes.length === 0 ? {} : { notes }),
  };
}

/** Why no rows came back when the request doesn't explain it. */
const NO_ROWS =
  "no rows: the slice is suppressed or the KldB code doesn't exist (the API answers both the same way). Check the code (findCodes explains where codes come from) or widen the slice (Deutschland, Gesamt).";

/** The dimension filters given, each resolved; the first that is ambiguous or unknown stops. */
type Filters = Partial<Record<DimensionName, DimensionValue | "all">>;

type ResolvedFilters =
  | { status: "ok"; values: Partial<Record<DimensionName, Coded | "all">> }
  | { status: "ambiguous"; dimension: DimensionName; given: string; candidates: Coded[] }
  | { status: "empty"; dimension: DimensionName; given: string; reason: string };

function resolveFilters(filters: Filters, defaults: Partial<Record<DimensionName, number | "all">>): ResolvedFilters {
  const values: Partial<Record<DimensionName, Coded | "all">> = {};
  for (const dimension of DIMENSION_NAMES) {
    const given = filters[dimension] ?? defaults[dimension];
    if (given === undefined) continue;
    if (typeof given === "string" && fold(given) === "all") {
      values[dimension] = "all";
      continue;
    }
    const found = resolveCode(dimension, given);
    if (found.status === "ambiguous") return { status: "ambiguous", dimension, given: String(given), candidates: found.candidates };
    if (found.status === "empty") {
      return {
        status: "empty",
        dimension,
        given: String(given),
        reason: `no ${dimension} called ${quoteValue(String(given))}: the ${dimension} codes are ${codeTable(dimension).map((v) => `${v.id} ${v.bezeichnung}`).join(", ")}.`,
      };
    }
    values[dimension] = found.value;
  }
  return { status: "ok", values };
}

/** The API's parameters for resolved filters: "all" and unset are left out (one row per value). */
function paramsOf(values: Partial<Record<DimensionName, Coded | "all">>): EntgelteParams {
  const params: EntgelteParams = {};
  for (const dimension of DIMENSION_NAMES) {
    const value = values[dimension];
    if (value !== undefined && value !== "all") params[PARAM_OF[dimension]] = value.code;
  }
  return params;
}

/**
 * Why a branch other than Gesamt can't be asked with this gender or age, or undefined: the API
 * answers a branch only for gender and age Gesamt (no rows otherwise), so no request is made.
 */
function branchCrossProblem(values: Partial<Record<DimensionName, Coded | "all">>, by?: DimensionName): string | undefined {
  const isGesamt = (v: Coded | "all" | undefined): boolean => v === undefined || (v !== "all" && v.code === 1);
  const branch = values.branch;
  const branchNotGesamt = by === "branch" || (branch !== undefined && branch !== "all" && branch.code !== 1);
  const crossed = by === "gender" || by === "age" || !isGesamt(values.gender) || !isGesamt(values.age);
  if (!branchNotGesamt || !crossed) return undefined;
  return "the API answers a branch other than Gesamt only for gender and age Gesamt: it does not cross a branch with gender or age (no rows). Ask for the branch with gender and age Gesamt, or for gender or age with branch Gesamt.";
}

// --- lookupPay (entgelt-lookup) --------------------------------------------------------------

export interface LookupPayInput {
  /** The KldB-2010 code: 3 digits (a group) or 5 (an occupation). */
  kldb: string;
  /** A code or a name; "all" for one row per value. Default: every level (one row each; a 5-digit code answers its own). */
  level?: DimensionValue | "all";
  /** Default 1 Deutschland. */
  region?: DimensionValue | "all";
  /** Default 1 Gesamt. */
  gender?: DimensionValue | "all";
  /** Default 1 Gesamt. */
  age?: DimensionValue | "all";
  /** Default 1 Gesamt. */
  branch?: DimensionValue | "all";
}

export interface PayLookup {
  status: OperationStatus;
  kldb?: string;
  /** What the code is (its length says). */
  occupation?: string;
  /** The slice asked for: each dimension's code and name, or "all". */
  searched?: Record<string, Coded | "all" | string>;
  unit?: string;
  rows?: PayRow[];
  reason?: string;
  /** For ambiguous: the dimension and its candidates. */
  dimension?: DimensionName;
  candidates?: Coded[];
}

/** The slice's defaults: Deutschland and Gesamt, every level. */
const LOOKUP_DEFAULTS: Partial<Record<DimensionName, number | "all">> = { region: 1, gender: 1, age: 1, branch: 1 };

/**
 * One occupation's pay for a slice: names resolved to codes, Deutschland and Gesamt by default,
 * every level unless one is given, one request; the markers read (payRowOf). An empty answer says
 * why when the request explains it (emptyAnswerNote: a 4-digit code, Ost/West, a level a 5-digit
 * code contradicts, a branch crossed with gender or age).
 */
export async function lookupPay(client: EntgeltatlasClient, input: LookupPayInput): Promise<PayLookup> {
  const kldb = kldbDigits(input.kldb);
  if (kldb === undefined) return { status: "empty", searched: { kldb: input.kldb }, reason: NO_NAME_SEARCH };
  const resolved = resolveFilters(input, LOOKUP_DEFAULTS);
  if (resolved.status === "ambiguous") {
    return { status: "ambiguous", kldb, dimension: resolved.dimension, candidates: resolved.candidates, reason: `${quoteValue(resolved.given)} names several ${resolved.dimension} codes: ask which.` };
  }
  if (resolved.status === "empty") return { status: "empty", kldb, dimension: resolved.dimension, reason: resolved.reason };
  const searched: Record<string, Coded | "all" | string> = { kldb, ...resolved.values };
  if (resolved.values.level === undefined) searched["level"] = "all";
  const cross = branchCrossProblem(resolved.values);
  if (cross !== undefined) return { status: "empty", kldb, occupation: kldbKind(kldb), searched, reason: cross };
  const params = paramsOf(resolved.values);
  const rows = await client.entgelte(kldb, params);
  if (rows.length === 0) {
    return { status: "empty", kldb, occupation: kldbKind(kldb), searched, reason: emptyAnswerNote(kldb, rows, params) ?? NO_ROWS };
  }
  return { status: "ok", kldb, occupation: kldbKind(kldb), searched, unit: UNIT, rows: rows.map(payRowOf) };
}

// --- comparePay (entgelt-gap-analyzer) -------------------------------------------------------

export interface ComparePayInput {
  kldb: string;
  /** The one dimension that varies. */
  by: DimensionName;
  /**
   * The values compared, the first is the base of every gap. Default: gender Männer, Frauen;
   * level 1-4; age the three bands; region the 16 Länder; branch the ten branches.
   */
  values?: DimensionValue[];
  /** The dimensions held (the `by` one is ignored): default Deutschland and Gesamt; level as in lookupPay. */
  level?: DimensionValue;
  region?: DimensionValue;
  gender?: DimensionValue;
  age?: DimensionValue;
  branch?: DimensionValue;
}

/** The most values one comparison takes. */
export const MAX_COMPARE_VALUES = 30;

const DEFAULT_VALUES: Readonly<Record<DimensionName, readonly number[]>> = {
  gender: [2, 3],
  level: [1, 2, 3, 4],
  age: [2, 3, 4],
  region: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
  branch: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

/** One value's figures in a comparison, with its gap to the base (same level). */
export interface ComparisonPoint extends PayRow {
  /** The compared value. */
  value: Coded;
  /** The median minus the base's, in EUR and in percent of the base's; only when both medians are amounts. */
  gap?: { eur: number; percent: number };
  /** Why there is no gap, or what to keep in mind about it. */
  gapNote?: string;
}

export interface PayComparison {
  status: OperationStatus;
  kldb?: string;
  occupation?: string;
  by?: DimensionName;
  /** The value every gap is measured against. */
  base?: Coded;
  /** The dimensions held. */
  held?: Record<string, Coded | "all">;
  unit?: string;
  points?: ComparisonPoint[];
  /** Values the API answered no row for, and why. */
  missing?: { value: Coded; level?: Coded; reason: string }[];
  reason?: string;
  dimension?: DimensionName;
  candidates?: Coded[];
  note?: string;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** The field of a PayRow that holds dimension `d`. */
const rowValue = (row: PayRow, d: DimensionName): Coded => row[d];

/**
 * One dimension varied, every other held: one request with that dimension left out (the API then
 * answers one row per value of it), the values picked by their label (never by position), and
 * the gap of each median to the base's within the same level. A gap needs two amounts: a
 * suppressed or missing side has none, and a censored side says the real gap may be larger. Ost
 * and West answer no rows; a branch is never crossed with gender or age (refused before any
 * request); a 5-digit code has one level, so levels compare in its 3-digit group.
 */
export async function comparePay(client: EntgeltatlasClient, input: ComparePayInput): Promise<PayComparison> {
  const kldb = kldbDigits(input.kldb);
  if (kldb === undefined) return { status: "empty", reason: NO_NAME_SEARCH };
  const by = input.by;
  if (!(DIMENSION_NAMES as readonly string[]).includes(by)) {
    throw new EntgeltatlasValidationError(`Invalid by ${quoteValue(String(by))}: one of ${DIMENSION_NAMES.join(", ")}.`);
  }
  if (by === "level" && kldb.length === 5) {
    return {
      status: "empty",
      kldb,
      occupation: kldbKind(kldb),
      by,
      reason: `a 5-digit code is one level (its fifth digit), so its levels can't be compared: compare the levels of its 3-digit group ${kldb.slice(0, 3)}.`,
    };
  }
  // The values compared.
  const given = input.values ?? DEFAULT_VALUES[by];
  if (given.length > MAX_COMPARE_VALUES) throw new EntgeltatlasValidationError(`Too many values: at most ${MAX_COMPARE_VALUES}.`);
  const values: Coded[] = [];
  for (const value of given) {
    const found = resolveCode(by, value);
    if (found.status === "ambiguous") {
      return { status: "ambiguous", kldb, by, dimension: by, candidates: found.candidates, reason: `${quoteValue(String(value))} names several ${by} codes: ask which.` };
    }
    if (found.status === "empty") {
      return { status: "empty", kldb, by, dimension: by, reason: `no ${by} called ${quoteValue(String(value))}: the ${by} codes are ${codeTable(by).map((v) => `${v.id} ${v.bezeichnung}`).join(", ")}.` };
    }
    if (!values.some((v) => v.code === found.value.code)) values.push(found.value);
  }
  if (values.length < 2) throw new EntgeltatlasValidationError(`Compare at least two different ${by} values.`);
  // The dimensions held.
  const heldInput: Filters = { level: input.level, region: input.region, gender: input.gender, age: input.age, branch: input.branch };
  delete heldInput[by];
  const defaults: Partial<Record<DimensionName, number | "all">> = { ...LOOKUP_DEFAULTS };
  delete defaults[by];
  const resolved = resolveFilters(heldInput, defaults);
  if (resolved.status === "ambiguous") {
    return { status: "ambiguous", kldb, by, dimension: resolved.dimension, candidates: resolved.candidates, reason: `${quoteValue(resolved.given)} names several ${resolved.dimension} codes: ask which.` };
  }
  if (resolved.status === "empty") return { status: "empty", kldb, by, dimension: resolved.dimension, reason: resolved.reason };
  const held: Record<string, Coded | "all"> = { ...resolved.values };
  if (by !== "level" && resolved.values.level === undefined) held["level"] = "all";
  const cross = branchCrossProblem(resolved.values, by);
  if (cross !== undefined) return { status: "empty", kldb, occupation: kldbKind(kldb), by, held, reason: cross };
  const params = paramsOf(resolved.values);
  const rows = (await client.entgelte(kldb, params)).map(payRowOf);
  if (rows.length === 0) {
    return { status: "empty", kldb, occupation: kldbKind(kldb), by, held, reason: emptyAnswerNote(kldb, [], params) ?? NO_ROWS };
  }
  // One group per level answered (when the level isn't held, a 3-digit group answers each).
  const levels: Coded[] = [];
  for (const row of rows) if (!levels.some((l) => l.code === row.level.code)) levels.push(row.level);
  const groupLevels = by === "level" ? [undefined] : levels;
  const points: ComparisonPoint[] = [];
  const missing: { value: Coded; level?: Coded; reason: string }[] = [];
  for (const level of groupLevels) {
    const inGroup = rows.filter((row) => level === undefined || row.level.code === level.code);
    const base = inGroup.find((row) => rowValue(row, by).code === values[0]!.code);
    for (const value of values) {
      const row = inGroup.find((r) => rowValue(r, by).code === value.code);
      if (row === undefined) {
        const reason =
          by === "region" && (value.code === 2 || value.code === 3)
            ? "the API answers no rows for Ostdeutschland (2) and Westdeutschland (3): it has no East/West aggregate; compare Länder instead"
            : by === "branch"
              ? "no row for this branch (the API answers a branch only for gender and age Gesamt; otherwise the cell is not published)"
              : "the API answered no row for this value";
        missing.push({ value, ...(level === undefined ? {} : { level }), reason });
        continue;
      }
      const point: ComparisonPoint = { value, ...row };
      if (row !== base) {
        if (base === undefined || base.median === null) point.gapNote = `no gap: the base (${values[0]!.name}) has no median here`;
        else if (row.median === null) point.gapNote = "no gap: this value has no median (see notes)";
        else {
          point.gap = { eur: row.median - base.median, percent: round1(((row.median - base.median) / base.median) * 100) };
          if (row.censored || base.censored) point.gapNote = "a median or quartile reaches the contribution ceiling: the real gap at the top may be larger than shown";
        }
      }
      points.push(point);
    }
  }
  return {
    status: points.length === 0 ? "empty" : "ok",
    kldb,
    occupation: kldbKind(kldb),
    by,
    base: values[0]!,
    held,
    unit: UNIT,
    points,
    ...(missing.length === 0 ? {} : { missing }),
    ...(points.length === 0 ? { reason: "none of the compared values has a row: see missing" } : {}),
    note: "Medians of full-time pay, not means and not adjusted for qualification, tenure, hours or bonuses: descriptive, not causal. Compare like with like; a small headcount makes a value unreliable.",
  };
}

// --- findCodes (entgelt-code-finder) ---------------------------------------------------------

export interface FindCodesInput {
  /** One dimension, or "occupation" for how to find a KldB code; default every dimension. */
  dimension?: DimensionName | "occupation";
  /** A name to find the code of ("Bayern", "Frauen", "Experte", "IT"). */
  name?: string;
  /** Read the region, gender, age or branch list from the API (the authoritative list) instead of the table. */
  live?: boolean;
}

export interface CodeList {
  dimension: DimensionName;
  /** The API's query parameter. */
  param: DimensionParam;
  label: string;
  codes: (Coded & { note?: string })[];
  /** True when read from the API now. */
  live?: boolean;
  /** Where the live list differs from the table this client checks codes against. */
  differences?: string[];
}

export interface CodesAnswer {
  status: OperationStatus;
  searched?: { dimension?: string; name?: string };
  matches?: (Coded & { dimension: DimensionName })[];
  candidates?: (Coded & { dimension: DimensionName })[];
  dimensions?: CodeList[];
  occupation?: string;
  reason?: string;
}

/** What a code means beyond its name. */
function codeNote(dimension: DimensionName, code: number): string | undefined {
  if (dimension === "region" && (code === 2 || code === 3)) return "answers no rows: no East/West aggregate";
  if (dimension === "level") return "a 5-digit KldB code ending in this digit is this level; there is no Gesamt level";
  return undefined;
}

const LIVE_LISTS: Partial<Record<DimensionName, (client: EntgeltatlasClient) => Promise<ReferenceItem[]>>> = {
  region: (client) => client.regionen(),
  gender: (client) => client.geschlechter(),
  age: (client) => client.alter(),
  branch: (client) => client.branchen(),
};

/**
 * The dimension codes: the table of one dimension or all, a name resolved (resolveCode) in one
 * dimension or every one, or, with `live`, the API's own lists (region, gender, age, branch; the
 * level has no list). An occupation is never resolved here: the API has no name search, and the
 * answer says where a KldB code comes from.
 */
export async function findCodes(client: EntgeltatlasClient, input: FindCodesInput = {}): Promise<CodesAnswer> {
  const { dimension, name, live = false } = input;
  if (dimension !== undefined && dimension !== "occupation" && !(DIMENSION_NAMES as readonly string[]).includes(dimension)) {
    throw new EntgeltatlasValidationError(`Invalid dimension ${quoteValue(String(dimension))}: one of ${DIMENSION_NAMES.join(", ")} or occupation.`);
  }
  const searched = { ...(dimension === undefined ? {} : { dimension }), ...(name === undefined ? {} : { name }) };
  if (dimension === "occupation") return { status: "ok", searched, occupation: NO_NAME_SEARCH };
  const scope: DimensionName[] = dimension === undefined ? [...DIMENSION_NAMES] : [dimension];
  if (name !== undefined) {
    if (/^\s*\d{3,5}\s*$/.test(name) && dimension === undefined) {
      return { status: "ok", searched, occupation: `${name.trim()} looks like a KldB code: ${kldbKind(name.trim())}. ${NO_NAME_SEARCH}` };
    }
    const matches: (Coded & { dimension: DimensionName })[] = [];
    const candidates: (Coded & { dimension: DimensionName })[] = [];
    for (const d of scope) {
      let found: Resolved;
      try {
        found = resolveCode(d, name);
      } catch (err) {
        // A number outside this dimension's table: a match elsewhere, or the error when it is the only one asked.
        if (dimension !== undefined) throw err;
        continue;
      }
      if (found.status === "ok") matches.push({ dimension: d, ...found.value });
      else if (found.status === "ambiguous") candidates.push(...found.candidates.map((c) => ({ dimension: d, ...c })));
    }
    if (matches.length > 0) return { status: "ok", searched, matches };
    if (candidates.length > 0) return { status: "ambiguous", searched, candidates, reason: `${quoteValue(name)} matches several codes: ask which.` };
    return {
      status: "empty",
      searched,
      reason: `no ${dimension ?? "dimension"} code called ${quoteValue(name)}. If it is an occupation: ${NO_NAME_SEARCH}`,
    };
  }
  const lists: CodeList[] = [];
  for (const d of scope) {
    const table = DIMENSIONS.find((t) => t.param === PARAM_OF[d])!;
    const read = live ? LIVE_LISTS[d] : undefined;
    if (read === undefined) {
      lists.push({
        dimension: d,
        param: table.param,
        label: table.label,
        codes: table.values.map((v) => {
          const note = codeNote(d, v.id);
          return { code: v.id, name: v.bezeichnung, ...(note === undefined ? {} : { note }) };
        }),
      });
      continue;
    }
    const items = await read(client);
    const differences: string[] = [];
    for (const item of items) {
      const known = table.values.find((v) => v.id === item.id);
      if (known === undefined) differences.push(`${item.id} ${item.bezeichnung}: not in the table (this client refuses it as a filter)`);
      else if (fold(known.bezeichnung) !== fold(item.bezeichnung)) differences.push(`${item.id}: the API names it ${quoteValue(item.bezeichnung)}, the table ${quoteValue(known.bezeichnung)}`);
    }
    for (const v of table.values) if (!items.some((item) => item.id === v.id)) differences.push(`${v.id} ${v.bezeichnung}: in the table, not in the API's list`);
    lists.push({
      dimension: d,
      param: table.param,
      label: table.label,
      live: true,
      codes: items.map((item) => {
        const note = codeNote(d, item.id);
        return { code: item.id, name: item.bezeichnung, ...(note === undefined ? {} : { note }) };
      }),
      ...(differences.length === 0 ? {} : { differences }),
    });
  }
  return { status: "ok", searched, dimensions: lists, ...(dimension === undefined ? { occupation: NO_NAME_SEARCH } : {}) };
}
