"use client";

import { useState } from "react";
import {
  blockerSummary,
  corpusCases,
  corpusSummary,
  releaseHistoryMetadata,
  surfaceReleases,
  type CorpusStatus,
  type ReleaseCorpus,
  type SurfaceRelease,
} from "@/data/release-coverage";

const latestRelease = surfaceReleases.at(-1)!;
const firstRelease = surfaceReleases[0]!;
const dateFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

function percentage(value: number, total: number): string {
  return `${((value / total) * 100).toFixed(1)}%`;
}

function SurfaceComposition({ release }: { release: SurfaceRelease }) {
  const segments = [
    {
      label: "Static",
      value: release.staticEntries,
      className: "bg-blue-700 dark:bg-blue-900",
    },
    {
      label: "Dynamic only",
      value: release.dynamicEntries,
      className: "bg-amber-700 dark:bg-amber-900",
    },
    {
      label: "Unsupported",
      value: release.unsupportedEntries,
      className: "bg-gray-500",
    },
  ];

  return (
    <figure className="mt-8">
      <div
        className="flex h-3 w-full overflow-hidden rounded-full bg-gray-alpha-200"
        role="img"
        aria-label={`${release.version}: ${release.staticEntries} static, ${release.dynamicEntries} dynamic-only, ${release.unsupportedEntries} unsupported entries`}
      >
        {segments.map((segment) => (
          <span
            key={segment.label}
            className={segment.className}
            style={{ width: percentage(segment.value, release.total) }}
          />
        ))}
      </div>
      <figcaption className="mt-4 grid gap-3 text-sm text-gray-900 sm:grid-cols-3">
        {segments.map((segment) => (
          <span key={segment.label} className="flex items-baseline justify-between gap-3 sm:block">
            <span className="inline-flex items-center gap-2">
              <span aria-hidden="true" className={`h-2 w-2 rounded-full ${segment.className}`} />
              {segment.label}
            </span>
            <span className="ml-2 tabular-nums text-gray-1000">
              {segment.value} · {percentage(segment.value, release.total)}
            </span>
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

function CorpusStatusText({ status }: { status: CorpusStatus }) {
  const matched = status === "match";
  return (
    <span
      className={`inline-flex items-center gap-2 text-sm ${
        matched
          ? "text-green-900 dark:text-green-1000"
          : "text-red-900 dark:text-red-1000"
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          matched ? "bg-green-700 dark:bg-green-900" : "bg-red-700 dark:bg-red-900"
        }`}
      />
      {matched ? "Match" : "Blocked"}
    </span>
  );
}

function ReleaseHistory({
  selectedIndex,
  onSelect,
}: {
  selectedIndex: number;
  onSelect: (index: number) => void;
}) {
  const width = 1000;
  const height = 260;
  const left = 42;
  const right = 86;
  const top = 18;
  const bottom = 36;
  const chartWidth = width - left - right;
  const chartHeight = height - top - bottom;
  const maxValue = Math.max(...surfaceReleases.map((release) => release.total));
  const xFor = (index: number) => left + (index / (surfaceReleases.length - 1)) * chartWidth;
  const yFor = (value: number) => top + chartHeight - (value / maxValue) * chartHeight;
  const pathFor = (key: "total" | "staticEntries") =>
    surfaceReleases
      .map(
        (release, index) =>
          `${index === 0 ? "M" : "L"} ${xFor(index).toFixed(2)} ${yFor(release[key]).toFixed(2)}`,
      )
      .join(" ");
  const selectedRelease = surfaceReleases[selectedIndex]!;
  const selectedX = xFor(selectedIndex);
  const ticks = [0, 250, 500];

  return (
    <div className="mt-6">
      <figure>
        <div className="overflow-x-auto border-y border-gray-alpha-400 py-5">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            className="min-w-[46rem]"
            role="img"
            aria-labelledby="release-history-title release-history-description"
          >
            <title id="release-history-title">Published and static surface entries by release</title>
            <desc id="release-history-description">
              The published surface grows from 302 to 527 entries while static entries grow from
              207 to 334 between versions 0.0.2 and 0.0.25.
            </desc>
            {ticks.map((tick) => (
              <g key={tick}>
                <line
                  x1={left}
                  x2={left + chartWidth}
                  y1={yFor(tick)}
                  y2={yFor(tick)}
                  className="stroke-gray-alpha-400"
                  strokeWidth="1"
                />
                <text
                  x={left - 10}
                  y={yFor(tick) + 4}
                  textAnchor="end"
                  className="fill-gray-900 text-[11px] tabular-nums"
                >
                  {tick}
                </text>
              </g>
            ))}
            <line
              x1={selectedX}
              x2={selectedX}
              y1={top}
              y2={top + chartHeight}
              className="stroke-gray-600"
              strokeDasharray="3 4"
            />
            <path
              d={pathFor("total")}
              fill="none"
              className="stroke-gray-700 dark:stroke-gray-800"
              strokeWidth="2"
            />
            <path
              d={pathFor("staticEntries")}
              fill="none"
              className="stroke-blue-700 dark:stroke-blue-900"
              strokeWidth="3"
            />
            <circle
              cx={selectedX}
              cy={yFor(selectedRelease.total)}
              r="4"
              className="fill-gray-700 stroke-background-100"
              strokeWidth="2"
            />
            <circle
              cx={selectedX}
              cy={yFor(selectedRelease.staticEntries)}
              r="5"
              className="fill-blue-700 stroke-background-100 dark:fill-blue-900"
              strokeWidth="2"
            />
            <text
              x={left + chartWidth + 12}
              y={yFor(latestRelease.total) + 4}
              className="fill-gray-900 text-xs tabular-nums"
            >
              {latestRelease.total} total
            </text>
            <text
              x={left + chartWidth + 12}
              y={yFor(latestRelease.staticEntries) + 4}
              className="fill-blue-900 text-xs tabular-nums dark:fill-blue-1000"
            >
              {latestRelease.staticEntries} static
            </text>
            <text x={left} y={height - 8} className="fill-gray-900 font-mono text-[11px]">
              v{firstRelease.version}
            </text>
            <text
              x={left + chartWidth}
              y={height - 8}
              textAnchor="end"
              className="fill-gray-900 font-mono text-[11px]"
            >
              v{latestRelease.version}
            </text>
          </svg>
        </div>
        <figcaption className="mt-3 max-w-3xl copy-13 text-gray-900">
          Manifest scope expanded alongside compiler support. Static share is not a fixed-denominator
          progress score because new projected entries enter the manifest over time.
        </figcaption>
      </figure>

      <div className="mt-8 grid gap-5 sm:grid-cols-[1fr_auto] sm:items-end">
        <label htmlFor="release-history" className="block">
          <span className="block text-sm font-medium text-gray-1000">Explore release history</span>
          <input
            id="release-history"
            type="range"
            min={0}
            max={surfaceReleases.length - 1}
            step={1}
            value={selectedIndex}
            onInput={(event) => onSelect(Number.parseInt(event.currentTarget.value, 10))}
            className="mt-4 h-11 w-full cursor-pointer accent-blue-700 dark:accent-blue-900"
          />
        </label>
        <div className="sm:min-w-44 sm:text-right">
          <label htmlFor="release-version" className="sr-only">
            Release version
          </label>
          <select
            id="release-version"
            value={selectedIndex}
            onChange={(event) => onSelect(Number.parseInt(event.currentTarget.value, 10))}
            className="h-10 rounded-md border border-gray-alpha-400 bg-background-100 px-3 font-mono text-sm text-gray-1000 focus:outline-none"
          >
            {surfaceReleases.map((release, index) => (
              <option key={release.version} value={index}>
                v{release.version}
              </option>
            ))}
          </select>
          <div className="mt-1 text-sm text-gray-900">
            {dateFormatter.format(new Date(selectedRelease.publishedAt))}
          </div>
        </div>
      </div>
    </div>
  );
}

function CorpusComposition({ corpus }: { corpus: ReleaseCorpus }) {
  const segments = [
    {
      label: "Static",
      value: corpus.staticStatements,
      className: "bg-blue-700 dark:bg-blue-900",
    },
    {
      label: "Dynamic",
      value: corpus.dynamicStatements,
      className: "bg-amber-700 dark:bg-amber-900",
    },
    {
      label: "Blocked",
      value: corpus.blockedStatements,
      className: "bg-red-700 dark:bg-red-900",
    },
  ];

  return (
    <figure className="mt-8">
      <div
        className="flex h-3 overflow-hidden rounded-full bg-gray-alpha-200"
        role="img"
        aria-label={`${corpus.staticStatements} static, ${corpus.dynamicStatements} dynamic, ${corpus.blockedStatements} blocked statements`}
      >
        {segments.map((segment) => (
          <span
            key={segment.label}
            className={segment.className}
            style={{ width: percentage(segment.value, corpus.statements) }}
          />
        ))}
      </div>
      <figcaption className="mt-4 grid gap-3 text-sm text-gray-900 sm:grid-cols-3">
        {segments.map((segment) => (
          <span key={segment.label} className="flex items-baseline justify-between gap-3 sm:block">
            <span className="inline-flex items-center gap-2">
              <span aria-hidden="true" className={`h-2 w-2 rounded-full ${segment.className}`} />
              {segment.label}
            </span>
            <span className="ml-2 tabular-nums text-gray-1000">
              {segment.value} · {percentage(segment.value, corpus.statements)}
            </span>
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

export function CoverageDashboard() {
  const [selectedIndex, setSelectedIndex] = useState(surfaceReleases.length - 1);
  const [showAllCases, setShowAllCases] = useState(false);
  const selectedRelease = surfaceReleases[selectedIndex] ?? latestRelease;
  const selectedCorpus = selectedRelease.corpus;
  const visibleCases = showAllCases ? corpusCases : corpusCases.slice(0, 9);
  const staticEntriesToLatest = latestRelease.staticEntries - selectedRelease.staticEntries;
  const projectedEntriesToLatest = latestRelease.total - selectedRelease.total;
  const corpusStaticToLatest =
    latestRelease.corpus.staticStatements - selectedRelease.corpus.staticStatements;

  return (
    <div className="not-prose">
      <section aria-labelledby="release-coverage-heading" className="py-12 sm:py-16">
        <div className="grid gap-10 lg:grid-cols-12 lg:gap-12">
          <div className="min-w-0 lg:col-span-8">
            <div className="flex flex-wrap items-center justify-between gap-4 text-sm text-gray-900">
              <span>
                Release <code className="text-gray-1000">v{selectedRelease.version}</code>
              </span>
              <a
                href={selectedRelease.manifestUrl ?? selectedRelease.releaseUrl}
                className="font-medium text-gray-1000 underline decoration-gray-500 underline-offset-4 transition-colors hover:decoration-gray-1000"
              >
                {selectedRelease.manifestUrl ? "Open surface manifest" : "View release notes"}
              </a>
            </div>
            <h2
              id="release-coverage-heading"
              className="mt-6 max-w-3xl text-4xl font-medium tracking-[-0.04em] text-gray-1000 sm:text-5xl sm:leading-[1.05]"
            >
              {percentage(selectedRelease.staticEntries, selectedRelease.total)} of the published
              surface compiles statically.
            </h2>
            <p className="mt-5 max-w-2xl copy-16 text-gray-900">
              {selectedRelease.staticEntries} of {selectedRelease.total} entries compile without an
              embedded engine.{" "}
              {selectedRelease.source === "manifest"
                ? "The release manifest is the auditable source of record."
                : "This baseline is reconstructed from v0.0.3, the reporting-only release that introduced manifests."}
            </p>
            <SurfaceComposition release={selectedRelease} />
          </div>

          <dl className="grid content-start divide-y divide-gray-alpha-400 border-y border-gray-alpha-400 lg:col-span-4">
            <div className="py-4">
              <dt className="text-sm text-gray-900">Release change</dt>
              <dd className="mt-1 text-xl font-medium tracking-tight text-gray-1000">
                {selectedRelease.changeLabel}
              </dd>
            </div>
            <div className="grid grid-cols-2 gap-6 py-4">
              <div>
                <dt className="text-sm text-gray-900">Promoted</dt>
                <dd className="mt-1 text-xl font-medium tabular-nums text-gray-1000">
                  {selectedRelease.promotedToStatic}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-gray-900">New static</dt>
                <dd className="mt-1 text-xl font-medium tabular-nums text-gray-1000">
                  {selectedRelease.newStatic}
                </dd>
              </div>
            </div>
            <div className="py-4">
              <dt className="text-sm text-gray-900">Published</dt>
              <dd className="mt-1 text-base text-gray-1000">
                {dateFormatter.format(new Date(selectedRelease.publishedAt))}
              </dd>
            </div>
            <div className="py-4">
              <dt className="text-sm text-gray-900">Evolution to latest</dt>
              <dd className="mt-2 grid grid-cols-2 gap-4 text-sm text-gray-1000">
                <span>
                  <strong className="block text-xl font-medium tabular-nums">
                    +{staticEntriesToLatest}
                  </strong>
                  static entries
                </span>
                <span>
                  <strong className="block text-xl font-medium tabular-nums">
                    +{corpusStaticToLatest}
                  </strong>
                  corpus statements
                </span>
              </dd>
              <p className="mt-3 text-sm text-gray-900">
                +{projectedEntriesToLatest} projected entries by v{latestRelease.version}
              </p>
            </div>
          </dl>
        </div>

        <div className="mt-16">
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
            <div>
              <h3 className="heading-20 text-gray-1000">Static surface by release</h3>
              <p className="mt-2 copy-14 text-gray-900">
                All {surfaceReleases.length} public releases, from v{firstRelease.version} to v
                {latestRelease.version}.
              </p>
            </div>
            <p className="text-sm tabular-nums text-gray-900">
              +{latestRelease.staticEntries - firstRelease.staticEntries} static entries overall
            </p>
          </div>
          <ReleaseHistory selectedIndex={selectedIndex} onSelect={setSelectedIndex} />
        </div>
      </section>

      <section
        aria-labelledby="reference-corpus-heading"
        className="border-t border-gray-alpha-400 py-12 sm:py-16"
      >
        <div className="grid gap-6 lg:grid-cols-12 lg:gap-12">
          <h2 id="reference-corpus-heading" className="heading-32 text-gray-1000 lg:col-span-5">
            The same corpus, at every release.
          </h2>
          <div className="lg:col-span-7">
            <p className="copy-16 text-gray-900">
              Twenty deterministic TypeScript programs were analyzed with v{selectedRelease.version}.
              The selected release changes both the surface metrics above and the corpus metrics
              below.
            </p>
            <p className="mt-3 copy-16 text-gray-1000">
              {selectedCorpus.unanalyzablePrograms > 0
                ? `${selectedCorpus.unanalyzablePrograms} program hit the typecheck gate and counts as fully blocked.`
                : "All 20 programs passed the typecheck gate."}
            </p>
          </div>
        </div>

        <dl className="mt-12 grid grid-cols-2 gap-px border-y border-gray-alpha-400 bg-gray-alpha-400 lg:grid-cols-4">
          <div className="bg-background-100 px-4 py-5 sm:px-5">
            <dt className="text-sm text-gray-900">Static statements</dt>
            <dd className="mt-2 text-3xl font-medium tracking-tight tabular-nums text-gray-1000">
              {percentage(selectedCorpus.staticStatements, selectedCorpus.statements)}
            </dd>
            <p className="mt-1 text-sm text-gray-900">
              {selectedCorpus.staticStatements} of {selectedCorpus.statements}
            </p>
          </div>
          <div className="bg-background-100 px-4 py-5 sm:px-5">
            <dt className="text-sm text-gray-900">Fully static programs</dt>
            <dd className="mt-2 text-3xl font-medium tracking-tight tabular-nums text-gray-1000">
              {selectedCorpus.staticPrograms}/{selectedCorpus.totalPrograms}
            </dd>
            <p className="mt-1 text-sm text-gray-900">No engine required</p>
          </div>
          <div className="bg-background-100 px-4 py-5 sm:px-5">
            <dt className="text-sm text-gray-900">Build with dynamic</dt>
            <dd className="mt-2 text-3xl font-medium tracking-tight tabular-nums text-gray-1000">
              {selectedCorpus.dynamicPrograms}/{selectedCorpus.totalPrograms}
            </dd>
            <p className="mt-1 text-sm text-gray-900">Engine allowed</p>
          </div>
          <div className="bg-background-100 px-4 py-5 sm:px-5">
            <dt className="text-sm text-gray-900">Blocked statements</dt>
            <dd className="mt-2 text-3xl font-medium tracking-tight tabular-nums text-gray-1000">
              {selectedCorpus.blockedStatements}
            </dd>
            <p className="mt-1 text-sm text-gray-900">No compiler tier yet</p>
          </div>
        </dl>

        <CorpusComposition corpus={selectedCorpus} />

        <div className="mt-10 grid gap-4 border-y border-gray-alpha-400 py-5 text-sm sm:grid-cols-2">
          <p className="text-gray-900">
            Historical corpus values come from each published CLI&apos;s coverage analysis on Node{" "}
            {releaseHistoryMetadata.nodeVersion} and {releaseHistoryMetadata.platform}. Typecheck
            failures use the fixed statement baseline and count as blocked.
          </p>
          <p className="text-gray-1000 sm:text-right">
            The latest release was also compiled, executed, and compared byte for byte with Node{" "}
            {corpusSummary.nodeVersion}: {corpusSummary.silentMismatches} silent mismatches.
          </p>
        </div>

        <div className="mt-16">
          <div className="max-w-2xl">
            <h3 className="heading-20 text-gray-1000">Latest differential results</h3>
            <p className="mt-2 copy-14 text-gray-900">
              These per-case outcomes are from v{corpusSummary.release}. Static and dynamic builds
              were executed separately against Node, and a blocked program never counts as a match.
            </p>
          </div>
          <div className="mt-6 overflow-hidden rounded-xl border border-gray-alpha-400 bg-background-200">
            <div className="overflow-x-auto px-3 pt-3 sm:px-5 sm:pt-5">
              <table
                id="latest-differential-results"
                className="mb-0! w-full min-w-[48rem] table-fixed border-separate border-spacing-x-0 border-spacing-y-1 text-sm"
              >
                <caption className="sr-only">
                  Reference corpus results for ScriptC v{corpusSummary.release}
                </caption>
                <colgroup>
                  <col className="w-[40%]" />
                  <col className="w-[20%]" />
                  <col className="w-[14%]" />
                  <col className="w-[14%]" />
                  <col className="w-[12%]" />
                </colgroup>
                <thead>
                  <tr>
                    {["Program", "Area", "Static", "Dynamic", "Fence"].map((heading) => (
                      <th
                        key={heading}
                        scope="col"
                        className="border-b border-gray-alpha-400 px-4 py-3 text-left text-sm font-medium tracking-normal text-gray-900 normal-case"
                      >
                        {heading}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visibleCases.map((corpusCase) => (
                    <tr
                      key={corpusCase.id}
                      className="transition-colors odd:bg-gray-alpha-100 hover:bg-gray-alpha-200 [&>*:first-child]:rounded-l-md [&>*:last-child]:rounded-r-md"
                    >
                      <th
                        scope="row"
                        className="border-0 px-4 py-3 text-left text-sm font-normal tracking-normal normal-case"
                      >
                        <span className="grid grid-cols-[1.75rem_1fr] items-baseline gap-3">
                          <span className="font-mono text-xs tabular-nums text-gray-700">
                            {corpusCase.id}
                          </span>
                          <span className="text-gray-1000">{corpusCase.name}</span>
                        </span>
                      </th>
                      <td className="border-0 px-4 py-3 text-gray-900">
                        {corpusCase.category}
                      </td>
                      <td className="border-0 px-4 py-3">
                        <CorpusStatusText status={corpusCase.staticStatus} />
                      </td>
                      <td className="border-0 px-4 py-3">
                        <CorpusStatusText status={corpusCase.dynamicStatus} />
                      </td>
                      <td className="border-0 px-4 py-3">
                        {corpusCase.diagnostic ? (
                          <code className="text-xs text-gray-1000">{corpusCase.diagnostic}</code>
                        ) : (
                          <span className="text-gray-700">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div
              className={
                showAllCases
                  ? "flex justify-center border-t border-gray-alpha-400 px-5 py-4"
                  : "relative -mt-14 flex h-28 items-end justify-center bg-linear-to-t from-background-200 via-background-200/95 to-transparent px-5 pb-4"
              }
            >
              <button
                type="button"
                aria-expanded={showAllCases}
                aria-controls="latest-differential-results"
                onClick={() => setShowAllCases((current) => !current)}
                className="inline-flex h-10 items-center gap-2 rounded-full border border-gray-alpha-500 bg-background-100 px-5 text-sm font-medium text-gray-1000 transition-colors hover:bg-gray-alpha-100"
              >
                {showAllCases ? "Show less" : `Show ${corpusCases.length - visibleCases.length} more`}
                <svg
                  aria-hidden="true"
                  viewBox="0 0 16 16"
                  className={`h-4 w-4 transition-transform ${showAllCases ? "rotate-180" : ""}`}
                  fill="none"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="1.5"
                >
                  <path d="m4 6 4 4 4-4" />
                </svg>
              </button>
            </div>
          </div>
        </div>

        <div className="mt-14 grid gap-8 lg:grid-cols-12 lg:gap-12">
          <div className="lg:col-span-4">
            <h3 className="heading-20 text-gray-1000">Top blocker groups</h3>
            <p className="mt-2 copy-14 text-gray-900">
              One blocker can stop an otherwise mostly static program, so sites and complete
              programs are tracked separately.
            </p>
          </div>
          <dl className="border-t border-gray-alpha-400 lg:col-span-8">
            {blockerSummary.map((blocker) => (
              <div
                key={blocker.code}
                className="grid gap-2 border-b border-gray-alpha-400 py-4 sm:grid-cols-[6rem_1fr_auto] sm:items-baseline sm:gap-6"
              >
                <dt>
                  <code className="text-sm text-gray-1000">{blocker.code}</code>
                </dt>
                <dd className="text-sm text-gray-900">{blocker.label}</dd>
                <dd className="text-sm tabular-nums text-gray-1000">{blocker.sites} sites</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>
    </div>
  );
}
