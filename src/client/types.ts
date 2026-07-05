// Domain types for the Bundesagentur für Arbeit Entgeltatlas API
// (rest.arbeitsagentur.de/infosysbub/entgeltatlas).
//
// Unlike the HAL/large-object BA siblings, the Entgeltatlas response is small,
// flat and fully known, so it is typed with concrete interfaces. The salary
// endpoint returns a bare JSON ARRAY of observations (no wrapping envelope).
//
// Caveats baked into the types (the OpenAPI spec is community-authored /
// reverse-engineered, and small-cell suppression behaviour is unverified):
//   - every salary figure is `number | null` — a suppressed cell (too few
//     observations, Datenschutz) yields null/absent, NEVER 0;
//   - `kldb` is a string (preserves leading zeros);
//   - `oberRegion*` are optional/nullable (the spec types the id as a string
//     while sibling ids are integers — a real inconsistency, so defend).

/** A labelled dimension value (region / gender / age / level / branch). */
export interface EntgeltDimension {
  id: number;
  bezeichnung: string;
}

/** The region dimension carries extra geographic + statistical metadata. */
export interface EntgeltRegion extends EntgeltDimension {
  schluessel?: string;
  /** Spec types this as a string though sibling ids are integers — keep loose. */
  oberRegionId?: string | number | null;
  oberRegionBezeichnung?: string | null;
  /** Social-insurance contribution ceiling; earnings above it are censored. */
  beitragsBemessungsGrenze?: number | null;
}

/** One earnings observation for a (KldB × region × gender × age × level × branch) slice. */
export interface EntgeltEntry {
  /** KldB-2010 occupation code (string — preserves leading zeros). */
  kldb: string;
  region: EntgeltRegion;
  gender: EntgeltDimension;
  ageCategory: EntgeltDimension;
  performanceLevel: EntgeltDimension;
  branche: EntgeltDimension;
  /** Median gross monthly earnings in EUR (NOT the mean); null when suppressed. */
  entgelt: number | null;
  /** Lower quartile (Q25) in EUR; null when suppressed. */
  entgeltQ25: number | null;
  /** Upper quartile (Q75) in EUR; null when suppressed. */
  entgeltQ75: number | null;
  /** Headcount the figures are based on (NOT a salary); null when suppressed. */
  besetzung: number | null;
}

/** Optional dimension filters for the salary lookup (all integer codes). */
export interface EntgelteParams {
  /** l — performance/requirement level (1 Helfer .. 4 Experte). */
  l?: number;
  /** r — region (1 Deutschland .. 30; irregular numbering, see `codes`). */
  r?: number;
  /** g — gender (1 Gesamt, 2 Männer, 3 Frauen). */
  g?: number;
  /** a — age band (1 Gesamt, 2 <25, 3 25–<55, 4 ≥55). */
  a?: number;
  /** b — branch/industry (1 Gesamt .. 11). */
  b?: number;
}

/** An item from a reference/catalogue endpoint (/regionen, /geschlechter, ...). */
export interface ReferenceItem {
  id: number;
  bezeichnung: string;
  [key: string]: unknown;
}
