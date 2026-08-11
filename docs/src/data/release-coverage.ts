export type SurfaceRelease = {
  version: string;
  publishedAt: string;
  source: "manifest" | "reconstructed";
  total: number;
  staticEntries: number;
  dynamicEntries: number;
  unsupportedEntries: number;
  changeLabel: string;
  promotedToStatic: number;
  newStatic: number;
  newEntries: number;
  manifestUrl: string | null;
  releaseUrl: string;
  corpus: ReleaseCorpus;
};

export type ReleaseCorpus = {
  statements: number;
  staticStatements: number;
  dynamicStatements: number;
  blockedStatements: number;
  staticPrograms: number;
  dynamicPrograms: number;
  totalPrograms: number;
  unanalyzablePrograms: number;
};

type ReleaseSeed = Omit<
  SurfaceRelease,
  "changeLabel" | "manifestUrl" | "releaseUrl" | "source"
> & {
  source?: SurfaceRelease["source"];
};

function release(seed: ReleaseSeed): SurfaceRelease {
  const source = seed.source ?? "manifest";
  const staticChange = seed.promotedToStatic + seed.newStatic;
  return {
    ...seed,
    source,
    changeLabel:
      source === "reconstructed"
        ? "Backfilled baseline"
        : staticChange > 0
          ? `+${staticChange} static entries`
          : "No surface change",
    manifestUrl:
      source === "manifest"
        ? `https://github.com/vercel-labs/scriptc/releases/download/v${seed.version}/surface-manifest.json`
        : null,
    releaseUrl: `https://github.com/vercel-labs/scriptc/releases/tag/v${seed.version}`,
  };
}

export const releaseHistoryMetadata = {
  generatedAt: "2026-08-11T06:52:41.584Z",
  nodeVersion: "26.4.0",
  platform: "macOS arm64",
  firstManifestVersion: "0.0.3",
  policy:
    "Programs rejected by the typecheck gate use their latest known statement count and count every statement as blocked.",
};

export const surfaceReleases: SurfaceRelease[] = [
  release({
    version: "0.0.2",
    publishedAt: "2026-07-23T03:08:01Z",
    source: "reconstructed",
    total: 302,
    staticEntries: 207,
    dynamicEntries: 30,
    unsupportedEntries: 65,
    promotedToStatic: 0,
    newStatic: 0,
    newEntries: 0,
    corpus: { statements: 86, staticStatements: 62, dynamicStatements: 4, blockedStatements: 20, staticPrograms: 7, dynamicPrograms: 10, totalPrograms: 20, unanalyzablePrograms: 1 },
  }),
  release({
    version: "0.0.3",
    publishedAt: "2026-07-23T03:33:42Z",
    total: 302,
    staticEntries: 207,
    dynamicEntries: 30,
    unsupportedEntries: 65,
    promotedToStatic: 0,
    newStatic: 0,
    newEntries: 0,
    corpus: { statements: 86, staticStatements: 62, dynamicStatements: 4, blockedStatements: 20, staticPrograms: 7, dynamicPrograms: 10, totalPrograms: 20, unanalyzablePrograms: 1 },
  }),
  release({
    version: "0.0.4",
    publishedAt: "2026-07-23T14:31:33Z",
    total: 312,
    staticEntries: 216,
    dynamicEntries: 30,
    unsupportedEntries: 66,
    promotedToStatic: 0,
    newStatic: 9,
    newEntries: 10,
    corpus: { statements: 86, staticStatements: 62, dynamicStatements: 4, blockedStatements: 20, staticPrograms: 7, dynamicPrograms: 10, totalPrograms: 20, unanalyzablePrograms: 1 },
  }),
  release({
    version: "0.0.5",
    publishedAt: "2026-07-23T18:04:45Z",
    total: 312,
    staticEntries: 216,
    dynamicEntries: 30,
    unsupportedEntries: 66,
    promotedToStatic: 0,
    newStatic: 0,
    newEntries: 0,
    corpus: { statements: 86, staticStatements: 62, dynamicStatements: 4, blockedStatements: 20, staticPrograms: 7, dynamicPrograms: 10, totalPrograms: 20, unanalyzablePrograms: 1 },
  }),
  release({
    version: "0.0.6",
    publishedAt: "2026-07-23T19:39:50Z",
    total: 312,
    staticEntries: 216,
    dynamicEntries: 30,
    unsupportedEntries: 66,
    promotedToStatic: 0,
    newStatic: 0,
    newEntries: 0,
    corpus: { statements: 86, staticStatements: 62, dynamicStatements: 4, blockedStatements: 20, staticPrograms: 7, dynamicPrograms: 10, totalPrograms: 20, unanalyzablePrograms: 1 },
  }),
  release({
    version: "0.0.7",
    publishedAt: "2026-07-23T21:08:49Z",
    total: 312,
    staticEntries: 216,
    dynamicEntries: 30,
    unsupportedEntries: 66,
    promotedToStatic: 0,
    newStatic: 0,
    newEntries: 0,
    corpus: { statements: 86, staticStatements: 62, dynamicStatements: 4, blockedStatements: 20, staticPrograms: 7, dynamicPrograms: 10, totalPrograms: 20, unanalyzablePrograms: 1 },
  }),
  release({
    version: "0.0.8",
    publishedAt: "2026-07-24T00:14:51Z",
    total: 317,
    staticEntries: 216,
    dynamicEntries: 30,
    unsupportedEntries: 71,
    promotedToStatic: 0,
    newStatic: 0,
    newEntries: 5,
    corpus: { statements: 86, staticStatements: 62, dynamicStatements: 4, blockedStatements: 20, staticPrograms: 7, dynamicPrograms: 10, totalPrograms: 20, unanalyzablePrograms: 1 },
  }),
  release({
    version: "0.0.9",
    publishedAt: "2026-07-24T05:35:00Z",
    total: 318,
    staticEntries: 217,
    dynamicEntries: 30,
    unsupportedEntries: 71,
    promotedToStatic: 0,
    newStatic: 1,
    newEntries: 1,
    corpus: { statements: 86, staticStatements: 63, dynamicStatements: 4, blockedStatements: 19, staticPrograms: 7, dynamicPrograms: 10, totalPrograms: 20, unanalyzablePrograms: 1 },
  }),
  release({
    version: "0.0.10",
    publishedAt: "2026-07-24T15:07:45Z",
    total: 318,
    staticEntries: 217,
    dynamicEntries: 30,
    unsupportedEntries: 71,
    promotedToStatic: 0,
    newStatic: 0,
    newEntries: 0,
    corpus: { statements: 86, staticStatements: 63, dynamicStatements: 4, blockedStatements: 19, staticPrograms: 7, dynamicPrograms: 10, totalPrograms: 20, unanalyzablePrograms: 1 },
  }),
  release({
    version: "0.0.11",
    publishedAt: "2026-07-24T18:10:16Z",
    total: 347,
    staticEntries: 244,
    dynamicEntries: 28,
    unsupportedEntries: 75,
    promotedToStatic: 2,
    newStatic: 25,
    newEntries: 29,
    corpus: { statements: 86, staticStatements: 64, dynamicStatements: 4, blockedStatements: 18, staticPrograms: 7, dynamicPrograms: 10, totalPrograms: 20, unanalyzablePrograms: 1 },
  }),
  release({
    version: "0.0.12",
    publishedAt: "2026-07-24T23:31:24Z",
    total: 347,
    staticEntries: 244,
    dynamicEntries: 28,
    unsupportedEntries: 75,
    promotedToStatic: 0,
    newStatic: 0,
    newEntries: 0,
    corpus: { statements: 86, staticStatements: 64, dynamicStatements: 4, blockedStatements: 18, staticPrograms: 7, dynamicPrograms: 10, totalPrograms: 20, unanalyzablePrograms: 1 },
  }),
  release({
    version: "0.0.13",
    publishedAt: "2026-07-25T02:34:56Z",
    total: 383,
    staticEntries: 247,
    dynamicEntries: 28,
    unsupportedEntries: 108,
    promotedToStatic: 0,
    newStatic: 3,
    newEntries: 36,
    corpus: { statements: 86, staticStatements: 64, dynamicStatements: 4, blockedStatements: 18, staticPrograms: 7, dynamicPrograms: 10, totalPrograms: 20, unanalyzablePrograms: 1 },
  }),
  release({
    version: "0.0.14",
    publishedAt: "2026-07-25T04:37:06Z",
    total: 383,
    staticEntries: 247,
    dynamicEntries: 28,
    unsupportedEntries: 108,
    promotedToStatic: 0,
    newStatic: 0,
    newEntries: 0,
    corpus: { statements: 86, staticStatements: 64, dynamicStatements: 4, blockedStatements: 18, staticPrograms: 7, dynamicPrograms: 10, totalPrograms: 20, unanalyzablePrograms: 1 },
  }),
  release({
    version: "0.0.15",
    publishedAt: "2026-07-25T18:01:24Z",
    total: 383,
    staticEntries: 247,
    dynamicEntries: 28,
    unsupportedEntries: 108,
    promotedToStatic: 0,
    newStatic: 0,
    newEntries: 0,
    corpus: { statements: 86, staticStatements: 64, dynamicStatements: 4, blockedStatements: 18, staticPrograms: 7, dynamicPrograms: 10, totalPrograms: 20, unanalyzablePrograms: 1 },
  }),
  release({
    version: "0.0.16",
    publishedAt: "2026-07-26T15:35:25Z",
    total: 383,
    staticEntries: 247,
    dynamicEntries: 28,
    unsupportedEntries: 108,
    promotedToStatic: 0,
    newStatic: 0,
    newEntries: 0,
    corpus: { statements: 86, staticStatements: 64, dynamicStatements: 4, blockedStatements: 18, staticPrograms: 7, dynamicPrograms: 10, totalPrograms: 20, unanalyzablePrograms: 1 },
  }),
  release({
    version: "0.0.17",
    publishedAt: "2026-07-27T02:22:50Z",
    total: 383,
    staticEntries: 248,
    dynamicEntries: 27,
    unsupportedEntries: 108,
    promotedToStatic: 1,
    newStatic: 0,
    newEntries: 0,
    corpus: { statements: 86, staticStatements: 64, dynamicStatements: 4, blockedStatements: 18, staticPrograms: 7, dynamicPrograms: 10, totalPrograms: 20, unanalyzablePrograms: 1 },
  }),
  release({
    version: "0.0.18",
    publishedAt: "2026-07-30T14:40:47Z",
    total: 387,
    staticEntries: 252,
    dynamicEntries: 27,
    unsupportedEntries: 108,
    promotedToStatic: 0,
    newStatic: 4,
    newEntries: 4,
    corpus: { statements: 86, staticStatements: 64, dynamicStatements: 4, blockedStatements: 18, staticPrograms: 7, dynamicPrograms: 10, totalPrograms: 20, unanalyzablePrograms: 1 },
  }),
  release({
    version: "0.0.19",
    publishedAt: "2026-07-30T18:53:57Z",
    total: 387,
    staticEntries: 252,
    dynamicEntries: 27,
    unsupportedEntries: 108,
    promotedToStatic: 0,
    newStatic: 0,
    newEntries: 0,
    corpus: { statements: 86, staticStatements: 64, dynamicStatements: 4, blockedStatements: 18, staticPrograms: 7, dynamicPrograms: 10, totalPrograms: 20, unanalyzablePrograms: 1 },
  }),
  release({
    version: "0.0.20",
    publishedAt: "2026-07-30T21:42:37Z",
    total: 387,
    staticEntries: 252,
    dynamicEntries: 27,
    unsupportedEntries: 108,
    promotedToStatic: 0,
    newStatic: 0,
    newEntries: 0,
    corpus: { statements: 86, staticStatements: 64, dynamicStatements: 4, blockedStatements: 18, staticPrograms: 7, dynamicPrograms: 10, totalPrograms: 20, unanalyzablePrograms: 1 },
  }),
  release({
    version: "0.0.21",
    publishedAt: "2026-07-31T04:41:57Z",
    total: 387,
    staticEntries: 252,
    dynamicEntries: 27,
    unsupportedEntries: 108,
    promotedToStatic: 0,
    newStatic: 0,
    newEntries: 0,
    corpus: { statements: 86, staticStatements: 64, dynamicStatements: 4, blockedStatements: 18, staticPrograms: 7, dynamicPrograms: 10, totalPrograms: 20, unanalyzablePrograms: 1 },
  }),
  release({
    version: "0.0.22",
    publishedAt: "2026-08-03T06:33:45Z",
    total: 500,
    staticEntries: 300,
    dynamicEntries: 36,
    unsupportedEntries: 164,
    promotedToStatic: 0,
    newStatic: 48,
    newEntries: 113,
    corpus: { statements: 86, staticStatements: 64, dynamicStatements: 4, blockedStatements: 18, staticPrograms: 7, dynamicPrograms: 10, totalPrograms: 20, unanalyzablePrograms: 1 },
  }),
  release({
    version: "0.0.23",
    publishedAt: "2026-08-09T13:12:43Z",
    total: 519,
    staticEntries: 326,
    dynamicEntries: 36,
    unsupportedEntries: 157,
    promotedToStatic: 7,
    newStatic: 19,
    newEntries: 19,
    corpus: { statements: 86, staticStatements: 68, dynamicStatements: 4, blockedStatements: 14, staticPrograms: 7, dynamicPrograms: 10, totalPrograms: 20, unanalyzablePrograms: 0 },
  }),
  release({
    version: "0.0.24",
    publishedAt: "2026-08-10T19:44:59Z",
    total: 527,
    staticEntries: 334,
    dynamicEntries: 36,
    unsupportedEntries: 157,
    promotedToStatic: 0,
    newStatic: 8,
    newEntries: 8,
    corpus: { statements: 86, staticStatements: 68, dynamicStatements: 4, blockedStatements: 14, staticPrograms: 7, dynamicPrograms: 10, totalPrograms: 20, unanalyzablePrograms: 0 },
  }),
  release({
    version: "0.0.25",
    publishedAt: "2026-08-11T04:10:04Z",
    total: 527,
    staticEntries: 334,
    dynamicEntries: 36,
    unsupportedEntries: 157,
    promotedToStatic: 0,
    newStatic: 0,
    newEntries: 0,
    corpus: { statements: 86, staticStatements: 68, dynamicStatements: 4, blockedStatements: 14, staticPrograms: 7, dynamicPrograms: 10, totalPrograms: 20, unanalyzablePrograms: 0 },
  }),
];

export type CorpusStatus = "match" | "blocked";

export type CorpusCase = {
  id: string;
  name: string;
  category: "Language" | "Standard library" | "Node.js" | "npm" | "Dynamic JS";
  staticStatus: CorpusStatus;
  dynamicStatus: CorpusStatus;
  diagnostic: string | null;
};

export const corpusCases: CorpusCase[] = [
  {
    id: "01",
    name: "Arithmetic and control flow",
    category: "Language",
    staticStatus: "blocked",
    dynamicStatus: "match",
    diagnostic: "SC2012",
  },
  {
    id: "02",
    name: "Strings and Unicode",
    category: "Standard library",
    staticStatus: "blocked",
    dynamicStatus: "match",
    diagnostic: "SC2012",
  },
  {
    id: "03",
    name: "Array higher-order functions",
    category: "Standard library",
    staticStatus: "match",
    dynamicStatus: "match",
    diagnostic: null,
  },
  {
    id: "04",
    name: "Objects and destructuring",
    category: "Language",
    staticStatus: "match",
    dynamicStatus: "match",
    diagnostic: null,
  },
  {
    id: "05",
    name: "Classes and inheritance",
    category: "Language",
    staticStatus: "blocked",
    dynamicStatus: "blocked",
    diagnostic: "SC1090",
  },
  {
    id: "06",
    name: "Closures and recursion",
    category: "Language",
    staticStatus: "match",
    dynamicStatus: "match",
    diagnostic: null,
  },
  {
    id: "07",
    name: "Async and Promise.all",
    category: "Language",
    staticStatus: "blocked",
    dynamicStatus: "blocked",
    diagnostic: "SC2002",
  },
  {
    id: "08",
    name: "Exceptions",
    category: "Language",
    staticStatus: "match",
    dynamicStatus: "match",
    diagnostic: null,
  },
  {
    id: "09",
    name: "JSON round trip",
    category: "Standard library",
    staticStatus: "match",
    dynamicStatus: "match",
    diagnostic: null,
  },
  {
    id: "10",
    name: "Regular expressions",
    category: "Standard library",
    staticStatus: "blocked",
    dynamicStatus: "blocked",
    diagnostic: "SC2020",
  },
  {
    id: "11",
    name: "Date mutation",
    category: "Standard library",
    staticStatus: "blocked",
    dynamicStatus: "blocked",
    diagnostic: "SC2020",
  },
  {
    id: "12",
    name: "BigInt",
    category: "Standard library",
    staticStatus: "blocked",
    dynamicStatus: "blocked",
    diagnostic: "SC2001",
  },
  {
    id: "13",
    name: "Map and Set iteration",
    category: "Standard library",
    staticStatus: "blocked",
    dynamicStatus: "blocked",
    diagnostic: "SC2020",
  },
  {
    id: "14",
    name: "Typed arrays",
    category: "Standard library",
    staticStatus: "blocked",
    dynamicStatus: "blocked",
    diagnostic: "SC2020",
  },
  {
    id: "15",
    name: "node:path and node:url",
    category: "Node.js",
    staticStatus: "blocked",
    dynamicStatus: "blocked",
    diagnostic: "SC1012",
  },
  {
    id: "16",
    name: "node:crypto",
    category: "Node.js",
    staticStatus: "match",
    dynamicStatus: "match",
    diagnostic: null,
  },
  {
    id: "17",
    name: "node:fs",
    category: "Node.js",
    staticStatus: "match",
    dynamicStatus: "match",
    diagnostic: null,
  },
  {
    id: "18",
    name: "picocolors package",
    category: "npm",
    staticStatus: "blocked",
    dynamicStatus: "match",
    diagnostic: "SC2013",
  },
  {
    id: "19",
    name: "Proxy and Reflect",
    category: "Dynamic JS",
    staticStatus: "blocked",
    dynamicStatus: "blocked",
    diagnostic: "SC2020",
  },
  {
    id: "20",
    name: "Function constructor",
    category: "Dynamic JS",
    staticStatus: "blocked",
    dynamicStatus: "blocked",
    diagnostic: "SC2020",
  },
];

export const corpusSummary = {
  release: "0.0.25",
  nodeVersion: "26.4.0",
  platform: "macOS arm64",
  statements: 86,
  staticStatements: 68,
  dynamicStatements: 4,
  blockedStatements: 14,
  staticPrograms: 7,
  dynamicPrograms: 10,
  totalPrograms: 20,
  silentMismatches: 0,
  generatedAt: "2026-08-11T05:44:49.616Z",
};

export const blockerSummary = [
  { code: "SC2020", sites: 8, label: "Missing standard-library lowering" },
  { code: "SC2012", sites: 2, label: "Dynamic engine site" },
  { code: "SC1090", sites: 2, label: "Unsupported syntax lowering" },
  { code: "SC2013", sites: 2, label: "npm dynamic boundary" },
];
