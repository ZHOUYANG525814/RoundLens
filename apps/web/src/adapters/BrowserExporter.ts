// Local-download artifacts for a finished pipeline run. Mirrors what the
// desktop GUI writes to ~/Documents/cDNA_Analyzer_Workspace/<PIN>/...:
//   - Master_Enrichment_Matrix.csv
//   - Combination_Enrichment_Matrix.csv (full-length peptide alias for NGS)
//   - run_stats.json
//   - QC_Summary_Report.txt  (built here, see buildQcReport)
//   - locked_config.json     (all rerunnable settings; filenames only)
//
// All artifacts are emitted as separate browser downloads triggered by user
// interaction; modern browsers will not let a single click produce multiple
// downloads unless they happen synchronously, so all artifacts are prepared
// and triggered by the same user action.

import type { PipelineOutcome } from "../worker/types";
import { CDNA_METHODS, formatMethodsAsText } from "@cdna/core";
import {
  useRunStore,
  type CdnaLockedConfigImport,
  type PipelineMode,
  type RoundForm,
} from "../state/useRunStore";
import {
  LIMITS,
  validateCdsPair,
  validatePrimer,
  validateProjectName,
  validateReference,
  validateRoundName,
} from "../lib/validation";

export const CDNA_EXPORT_FILES = [
  ["Master_Enrichment_Matrix.csv.gz", "Full peptide count, RPM and enrichment matrix"],
  ["Combination_Enrichment_Matrix.csv.gz", "Full-length peptide combinations; for short-read NGS the complete translated CDS is the combination key"],
  ["run_stats.json", "Per-round demultiplex and QC counts"],
  ["QC_Summary_Report.txt", "Human-readable summary, methods and column reference"],
  ["locked_config.json", "Re-runnable settings without sequencing files, paths, Drive IDs or credentials"],
] as const;

export interface CdnaExportSnapshot {
  projectName: string;
  pipelineMode: PipelineMode;
  referenceSeq: string;
  localFiles: File[];
  driveFiles: Array<{ id: string; name: string; sizeBytes: number | null }>;
  expectedFileNames: string[];
  rounds: RoundForm[];
  filterStop: boolean;
  useWasm: boolean;
  minMeanPhred: number;
  minMeanPhredCds: number;
  pseudocount: number;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke after the click handler has had a chance to schedule the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export interface ExportOptions {
  /** Used as the file-name prefix for all downloads (sanitized). */
  projectName: string;
  /** If true, stream-compress the CSV with gzip and download as
   *  `<project>_Master_Enrichment_Matrix.csv.gz`. Compression runs via the
   *  browser-native `CompressionStream` API (Chrome 80+, Firefox 113+,
   *  Safari 16.4+) — zero bundle cost, streams natively so the main thread
   *  stays responsive on multi-GB CSVs. Pandas reads `.csv.gz` directly
   *  (`pd.read_csv("file.csv.gz")`). Typical compression ratio: ~6× for
   *  the enrichment matrix's repeated round names + numeric patterns. */
  gzipCsv?: boolean;
}

export async function exportOutcome(
  outcome: PipelineOutcome,
  opts: ExportOptions,
): Promise<void> {
  const base = sanitizeFilename(opts.projectName || "cdna_run");

  if (outcome.csvBlob) {
    if (opts.gzipCsv) {
      const gz = await gzipBlob(outcome.csvBlob);
      downloadBlob(gz, `${base}_Master_Enrichment_Matrix.csv.gz`);
      // In cDNA-display NGS each accepted read already resolves one complete
      // translated CDS. The full peptide is therefore the combination key;
      // reuse the compressed bytes instead of recalculating identical stats.
      downloadBlob(gz, `${base}_Combination_Enrichment_Matrix.csv.gz`);
    } else {
      // Already a Blob coming back from the worker — download directly,
      // no re-clone.
      downloadBlob(outcome.csvBlob, `${base}_Master_Enrichment_Matrix.csv`);
      downloadBlob(outcome.csvBlob, `${base}_Combination_Enrichment_Matrix.csv`);
    }
  }
  downloadBlob(
    new Blob([outcome.runStatsJson], { type: "application/json" }),
    `${base}_run_stats.json`,
  );
  downloadBlob(
    new Blob([buildQcReport(outcome, opts.projectName)], { type: "text/plain;charset=utf-8" }),
    `${base}_QC_Summary_Report.txt`,
  );
  downloadBlob(
    new Blob([JSON.stringify(buildCdnaLockedConfig(useRunStore.getState()), null, 2)], {
      type: "application/json",
    }),
    `${base}_locked_config.json`,
  );
}

/** Build a reproducible NGS configuration without retaining any read bytes,
 * local paths, Drive IDs, file sizes, timestamps or credentials. */
export function buildCdnaLockedConfig(snapshot: CdnaExportSnapshot) {
  const actualMultiplexedNames = [
    ...snapshot.localFiles.map((file) => file.name),
    ...snapshot.driveFiles.map((file) => file.name),
  ];
  return {
    schemaVersion: "cdna-display-config/v2",
    calculationModel: "rpm-pseudocount-v1",
    pseudocountUnit: "RPM",
    project: snapshot.projectName,
    pipelineMode: snapshot.pipelineMode,
    reference: snapshot.referenceSeq,
    sources: {
      expectedFileNames:
        snapshot.pipelineMode === "multiplexed"
          ? actualMultiplexedNames.length > 0
            ? actualMultiplexedNames
            : snapshot.expectedFileNames
          : [],
    },
    rounds: snapshot.rounds.map((round) => ({
      name: round.name,
      fwPrimer: round.fwPrimer,
      rvPrimer: round.rvPrimer,
      cdsStart: round.cdsStart,
      cdsEnd: round.cdsEnd,
      expectedFileNames:
        snapshot.pipelineMode === "per-round"
          ? round.sources.flatMap((source) => {
              const name = source.file?.name ?? source.driveRef?.name ?? source.expectedFileName;
              return name ? [name] : [];
            })
          : [],
    })),
    settings: {
      filterStop: snapshot.filterStop,
      useWasm: snapshot.useWasm,
      minMeanPhred: snapshot.minMeanPhred,
      minMeanPhredCds: snapshot.minMeanPhredCds,
      pseudocount: snapshot.pseudocount,
    },
    fixedSafeguards: { adaptivePrimerMatching: true },
  };
}

export function parseCdnaLockedConfig(text: string): CdnaLockedConfigImport {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("Locked config is not valid JSON.");
  }
  const root = record(raw, "Locked config");
  const legacyV1 = root.schemaVersion === "cdna-display-config/v1";
  if (!legacyV1 && root.schemaVersion !== "cdna-display-config/v2") {
    throw new Error("Unsupported locked config schema.");
  }
  if (root.calculationModel !== "rpm-pseudocount-v1") {
    throw new Error("Unsupported enrichment calculation model.");
  }
  if (root.pseudocountUnit !== "RPM") {
    throw new Error("Unsupported pseudocount unit.");
  }

  const projectName = stringValue(root.project, "project");
  const projectError = validateProjectName(projectName);
  if (projectError) throw new Error(projectError);

  if (root.pipelineMode !== "multiplexed" && root.pipelineMode !== "per-round") {
    throw new Error("pipelineMode must be multiplexed or per-round.");
  }
  const pipelineMode = root.pipelineMode;
  const referenceSeq = stringValue(root.reference, "reference");
  const referenceError = validateReference(referenceSeq);
  if (referenceError) throw new Error(referenceError);

  const sources = record(root.sources, "sources");
  if (!Array.isArray(sources.expectedFileNames) || sources.expectedFileNames.length > LIMITS.FASTQ_FILES_MAX) {
    throw new Error(`sources.expectedFileNames is invalid or exceeds ${LIMITS.FASTQ_FILES_MAX.toLocaleString()} files.`);
  }
  const expectedFileNames = sources.expectedFileNames.map((value, index) =>
    fastqFilename(value, `sources.expectedFileNames[${index}]`),
  );
  if (pipelineMode === "multiplexed" && expectedFileNames.length === 0) {
    throw new Error("Multiplexed locked config must include at least one expected FASTQ filename.");
  }
  if (pipelineMode === "per-round" && expectedFileNames.length !== 0) {
    throw new Error("Per-round locked config cannot contain multiplexed source filenames.");
  }

  if (!Array.isArray(root.rounds) || root.rounds.length === 0 || root.rounds.length > LIMITS.ROUND_COUNT_MAX) {
    throw new Error("Locked rounds are missing or exceed the supported limit.");
  }
  const rounds = root.rounds.map((value, index) => {
    const round = record(value, `rounds[${index}]`);
    const name = stringValue(round.name, `rounds[${index}].name`);
    const nameError = validateRoundName(name);
    if (nameError) throw new Error(`Round ${index}: ${nameError}`);
    const fwPrimer = stringValue(round.fwPrimer, `rounds[${index}].fwPrimer`);
    const fwError = validatePrimer(fwPrimer, "Forward");
    if (fwError) throw new Error(`Round ${index}: ${fwError}`);
    const rvPrimer = stringValue(round.rvPrimer, `rounds[${index}].rvPrimer`);
    const rvError = validatePrimer(rvPrimer, "Reverse");
    if (rvError) throw new Error(`Round ${index}: ${rvError}`);
    const cdsStart = integer(round.cdsStart, `rounds[${index}].cdsStart`);
    const cdsEnd = integer(round.cdsEnd, `rounds[${index}].cdsEnd`);
    const cdsError = validateCdsPair(cdsStart, cdsEnd);
    if (cdsError) throw new Error(`Round ${index}: ${cdsError}`);
    const rawExpected = legacyV1
      ? round.expectedFileName == null ? [] : [round.expectedFileName]
      : round.expectedFileNames;
    if (!Array.isArray(rawExpected) || rawExpected.length > LIMITS.FASTQ_FILES_MAX) {
      throw new Error(`Round ${index} expectedFileNames is invalid.`);
    }
    const expectedFileNames = rawExpected.map((filename, fileIndex) =>
      fastqFilename(filename, `rounds[${index}].expectedFileNames[${fileIndex}]`)
    );
    if (pipelineMode === "per-round" && expectedFileNames.length === 0) {
      throw new Error(`Round ${index} is missing its expected FASTQ filename(s).`);
    }
    if (pipelineMode === "multiplexed" && expectedFileNames.length !== 0) {
      throw new Error(`Round ${index} cannot contain per-round FASTQ filenames.`);
    }
    return { name, fwPrimer, rvPrimer, cdsStart, cdsEnd, expectedFileNames };
  });
  if (new Set(rounds.map((round) => round.name)).size !== rounds.length) {
    throw new Error("Round names must be unique.");
  }
  if (
    pipelineMode === "multiplexed" &&
    new Set(rounds.map((round) => round.fwPrimer)).size !== rounds.length
  ) {
    throw new Error("Multiplexed rounds must use distinct forward primers.");
  }

  const sourceSettings = record(root.settings, "settings");
  const settings = {
    filterStop: booleanValue(sourceSettings.filterStop, "settings.filterStop"),
    useWasm: booleanValue(sourceSettings.useWasm, "settings.useWasm"),
    minMeanPhred: bounded(sourceSettings.minMeanPhred, "settings.minMeanPhred", 0, 40),
    minMeanPhredCds: bounded(
      sourceSettings.minMeanPhredCds,
      "settings.minMeanPhredCds",
      0,
      40,
    ),
    pseudocount: bounded(
      sourceSettings.pseudocount,
      "settings.pseudocount",
      Number.MIN_VALUE,
      100,
    ),
  };
  const safeguards = record(root.fixedSafeguards, "fixedSafeguards");
  if (safeguards.adaptivePrimerMatching !== true) {
    throw new Error("Unsupported adaptive primer-matching safeguard.");
  }

  return {
    projectName,
    pipelineMode,
    referenceSeq,
    expectedFileNames,
    rounds,
    settings,
  };
}

/** Stream-gzip a Blob via the native CompressionStream API.
 *
 *  Why not fflate: CompressionStream operates on `ReadableStream` so the
 *  encoder never holds the full payload in memory — critical for 758 MB
 *  CSVs that would push V8's heap into GC-pause territory. Decode-side
 *  (pandas, gzip CLI) is universal. */
async function gzipBlob(blob: Blob): Promise<Blob> {
  // CompressionStream is supported in every browser in our target matrix
  // (Chrome 110+ per the plan). No feature detection needed; if it's
  // missing we want a hard error so the user knows to upgrade.
  const stream = blob.stream().pipeThrough(new CompressionStream("gzip"));
  return await new Response(stream).blob();
}

function sanitizeFilename(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${label} must be an integer.`);
  }
  return value;
}

function bounded(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} is outside supported limits.`);
  }
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (value !== true && value !== false) throw new Error(`${label} must be boolean.`);
  return value;
}

function fastqFilename(value: unknown, label: string): string {
  const name = stringValue(value, label);
  if (name.length > 255 || !/\.(fastq|fq)(?:\.gz)?$/i.test(name)) {
    throw new Error(`${label} must be a .fastq, .fq, .fastq.gz, or .fq.gz filename.`);
  }
  // Browser File.name has no path component. Enforce the same property for
  // imported hints so a config can never smuggle in a local or remote path.
  // eslint-disable-next-line no-control-regex
  if (name === "." || name === ".." || /[\x00-\x1f<>:"/\\|?*]/.test(name)) {
    throw new Error(`${label} contains an unsafe filename.`);
  }
  return name;
}

// QC report layout follows 01_scripts/app.py:421-525 — section 1 (per-round
// demultiplex yield) and the global unassigned breakdown. Sections 2 (library
// diversity) and 3 (top-20 candidates) need the analyzer rows, which we don't
// transfer across the worker boundary yet; skipped here, fold in when the
// browser UI starts surfacing per-peptide views.
export function buildQcReport(outcome: PipelineOutcome, projectName: string): string {
  const lines: string[] = [];
  const sep = "=".repeat(85);
  lines.push(sep);
  lines.push("                RoundLens NGS QC & SUMMARY REPORT");
  lines.push(sep);
  lines.push("");
  lines.push(`Project Name    : ${projectName || "(unnamed)"}`);
  lines.push(`Generation Time : ${new Date().toISOString().replace("T", " ").slice(0, 19)}`);
  lines.push("");

  lines.push("--- 1. DEMULTIPLEXING & SEQUENCE FILTERING TRACEABILITY ---");
  const u = outcome.unassignedBreakdown;
  lines.push(`[*] Global Pre-round Rejected/Unassigned Reads: ${outcome.globalUnassigned.toLocaleString()}`);
  lines.push(
    `    Breakdown — malformed_fastq: ${(u.malformed_fastq ?? 0).toLocaleString()}  ` +
      `low_quality: ${u.low_quality.toLocaleString()}  ` +
      `no_anchor: ${u.no_anchor.toLocaleString()}  ` +
      `ambiguous: ${u.ambiguous.toLocaleString()}  ` +
      `barcode_mismatch: ${u.barcode_mismatch.toLocaleString()}`,
  );
  lines.push("");
  const header =
    `${"Round".padEnd(10)} | ${"Total Assigned".padEnd(15)} | ${"Truncated".padEnd(10)} | ` +
    `${"Indel/Shift".padEnd(12)} | ${"Stop Codon".padEnd(11)} | ${"Passed QC".padEnd(12)} | ` +
    `${"Yield (%)".padEnd(10)}`;
  lines.push(header);
  lines.push("-".repeat(header.length));
  for (const rnd of outcome.roundNames) {
    const s = outcome.statsByRound[rnd];
    if (!s) continue;
    const yieldPct = s.total_assigned > 0 ? (s.passed_qc / s.total_assigned) * 100 : 0;
    lines.push(
      `${rnd.padEnd(10)} | ${s.total_assigned.toLocaleString().padEnd(15)} | ` +
        `${s.discard_truncated.toLocaleString().padEnd(10)} | ` +
        `${s.discard_length_indel.toLocaleString().padEnd(12)} | ` +
        `${s.discard_stop_codon.toLocaleString().padEnd(11)} | ` +
        `${s.passed_qc.toLocaleString().padEnd(12)} | ` +
        `${yieldPct.toFixed(2).padStart(6)}%`,
    );
  }
  lines.push("");
  lines.push("--- 2. COMBINATION ENRICHMENT SEMANTICS ---");
  lines.push("For short-read cDNA-display NGS, each accepted read yields one complete translated CDS peptide.");
  lines.push("Combination_Enrichment_Matrix therefore uses that full-length Peptide_Seq as its combination key and reuses the same tested enrichment statistics as the master matrix.");
  lines.push("");

  // --- Methods & column reference (Phase 6.14) ---------------------------
  // Append the static column documentation + the per-run parameters so the
  // QC_Summary_Report.txt artifact is self-contained: a user opening just
  // this file can understand every column in the CSV without other context.
  const s = useRunStore.getState();
  const settings: Array<{ label: string; value: string }> = [
    { label: "Pipeline mode", value: s.pipelineMode },
    { label: "WASM scoring", value: s.useWasm ? "on" : "off" },
    { label: "Min mean read Phred", value: `≥ ${s.minMeanPhred.toFixed(1)}` },
    { label: "Min mean CDS Phred", value: `≥ ${s.minMeanPhredCds.toFixed(1)}` },
    { label: "Discard premature stops", value: s.filterStop ? "yes" : "no" },
    { label: "Enrichment pseudocount (RPM)", value: s.pseudocount.toString() },
  ];
  const methodsText = formatMethodsAsText(CDNA_METHODS, {
    settings,
    pseudocount: s.pseudocount,
    libraryMedian: outcome.libraryMedianEnrich,
    hitCounts: outcome.hitCounts,
  });
  lines.push(methodsText);

  return lines.join("\n");
}
