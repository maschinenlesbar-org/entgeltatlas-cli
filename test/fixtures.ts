// Canned Entgeltatlas response bodies used across the unit tests. Shapes mirror
// the live API (a bare JSON array of observations; reference lists of
// {id, bezeichnung}), trimmed to the fields the tests assert on.

import type { EntgeltEntry, ReferenceItem } from "../src/client/types.js";

/** A populated salary observation (KldB 84304, Deutschland, all-dimensions Gesamt). */
export const entgelteResult: EntgeltEntry[] = [
  {
    kldb: "84304",
    region: {
      id: 1,
      bezeichnung: "Deutschland",
      schluessel: "DG",
      oberRegionId: null,
      beitragsBemessungsGrenze: 7550,
    },
    gender: { id: 1, bezeichnung: "Gesamt" },
    ageCategory: { id: 1, bezeichnung: "Gesamt" },
    performanceLevel: { id: 4, bezeichnung: "Experte" },
    branche: { id: 1, bezeichnung: "Gesamt" },
    entgelt: 6500,
    entgeltQ25: 5200,
    entgeltQ75: 7550,
    besetzung: 12345,
  },
];

/** A suppressed cell: numeric fields null (too few observations) — NEVER treat as 0. */
export const suppressedResult: EntgeltEntry[] = [
  {
    kldb: "84304",
    region: { id: 1, bezeichnung: "Deutschland" },
    gender: { id: 3, bezeichnung: "Frauen" },
    ageCategory: { id: 2, bezeichnung: "unter 25 Jahre" },
    performanceLevel: { id: 4, bezeichnung: "Experte" },
    branche: { id: 1, bezeichnung: "Gesamt" },
    entgelt: null,
    entgeltQ25: null,
    entgeltQ75: null,
    besetzung: null,
  },
];

/** Reference list of region codes. */
export const regionen: ReferenceItem[] = [
  { id: 1, bezeichnung: "Deutschland" },
  { id: 5, bezeichnung: "Hamburg" },
];
