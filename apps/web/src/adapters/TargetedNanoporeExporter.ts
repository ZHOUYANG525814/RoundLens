import {
  TARGETED_NANOPORE_METHODS,
  formatMethodsAsText,
  normalizeReference,
  resolveTargetSites,
  translateDna,
} from "@cdna/core";
import type {
  TargetedCallingSettings,
  TargetedLockedConfigImport,
  TargetedRoundForm,
  TargetedSiteForm,
} from "@/state/useTargetedNanoporeStore";
import type { TargetedNanoporeOutcome } from "@/worker/types";
import { NANOPORE_INPUT_LIMITS, validateNanoporeFileName } from "../tools/nanopore-targeted/inputValidation";
import { validateProjectName } from "../lib/validation";

export interface TargetedExportSnapshot {
  projectName: string;
  referenceSeq: string;
  cdsStart: number;
  cdsEnd: number;
  cdsStrand: "+" | "-";
  sites: TargetedSiteForm[];
  rounds: TargetedRoundForm[];
  settings: TargetedCallingSettings;
  reportHaplotypes: boolean;
  startedAt: number | null;
  finishedAt: number | null;
}

export const TARGETED_EXPORT_FILES = [
  ["Master_Enrichment_Matrix.csv.gz", "Complete per-target amino-acid count, RPM, round-to-baseline enrichment, variance and FDR matrix"],
  ["Combination_Enrichment_Matrix.csv.gz", "For 2+ targets, all target amino acids concatenated in confirmed target order and analyzed as one linked combination"],
  ["run_stats.json", "Machine-readable configuration, file QC, filter funnel, target callability and provenance"],
  ["QC_Summary_Report.txt", "Human-readable QC logic, abnormal-event handling, formulas and caveats"],
  ["locked_config.json", "Re-runnable configuration without sequencing files, paths, Drive IDs or credentials"],
] as const;

export async function exportTargetedOutcome(outcome: TargetedNanoporeOutcome, snapshot: TargetedExportSnapshot): Promise<void> {
  const base = sanitize(snapshot.projectName || "nanopore_run");
  const downloads: Array<[Blob, string]> = [];
  await addGzip(downloads, outcome.perSiteCsvBlob, `${base}_Master_Enrichment_Matrix.csv.gz`);
  await addGzip(downloads, outcome.haplotypeCsvBlob, `${base}_Combination_Enrichment_Matrix.csv.gz`);
  downloads.push(
    [jsonBlob(buildRunStats(outcome, snapshot)), `${base}_run_stats.json`],
    [textBlob(buildTargetedQcReport(outcome, snapshot), "text/plain;charset=utf-8"), `${base}_QC_Summary_Report.txt`],
    [jsonBlob(buildLockedConfig(snapshot)), `${base}_locked_config.json`],
  );
  for (const [blob, name] of downloads) downloadBlob(blob, name);
}

export function buildFilterFunnelCsv(outcome: TargetedNanoporeOutcome): string {
  const reasons = ["malformed_fastq", "duplicate_read_id", "low_read_q", "concatemer_or_chimera", "alignment_failed", "partial_reference", "low_alignment_identity", "low_protected_identity", "protected_indel"] as const;
  return csv([
    ["Round", "Total_Reads", "Aligned", "Full_QC_Passed", ...reasons],
    ...outcome.roundNames.map((round) => { const s = outcome.statsByRound[round]!; return [round, s.total_reads, s.aligned, s.full_qc_passed, ...reasons.map((reason) => s.primary_drop_reasons[reason])]; }),
  ]);
}

export function buildSiteCallabilityCsv(outcome: TargetedNanoporeOutcome): string {
  return csv([
    ["Round", "Target", "Callable_Total", "Callable_Full", "Callable_Rescued", "Reference_AA_Count", "Low_Target_Q", "Target_Indel", "Not_Covered", "Ambiguous", "Stop_Codon"],
    ...outcome.roundNames.flatMap((round) => outcome.siteNames.map((site) => { const s = outcome.statsByRound[round]!.sites[site]!; return [round, site, s.passed_qc, s.callable_full, s.callable_rescued, s.wt_count, s.low_quality, s.target_indel, s.not_covered, s.ambiguous, s.stop_codon]; })),
  ]);
}

export function buildFileQcCsv(outcome: TargetedNanoporeOutcome): string {
  const reasons = ["malformed_fastq", "duplicate_read_id", "low_read_q", "concatemer_or_chimera", "alignment_failed", "partial_reference", "low_alignment_identity", "low_protected_identity", "protected_indel"] as const;
  return csv([
    ["File", "Round", "Total_Reads", "Aligned", "Full_QC_Passed", "Rescued_Target_Calls", ...reasons],
    ...outcome.fileStats.map((f) => [f.name, f.round, f.totalReads, f.aligned, f.fullQcPassed, f.rescuedSiteCalls, ...reasons.map((reason) => f.primaryDropReasons[reason])]),
  ]);
}

export function buildRunStats(outcome: TargetedNanoporeOutcome, snapshot: TargetedExportSnapshot) {
  const statsByRound = Object.fromEntries(outcome.roundNames.map((round) => {
    const { sites, ...wholeRead } = outcome.statsByRound[round]!;
    const targets = Object.fromEntries(Object.entries(sites).map(([target, values]) => {
      const { wt_count, ...callability } = values;
      return [target, { ...callability, referenceAaCount: wt_count }];
    }));
    return [round, { ...wholeRead, targets }];
  }));
  return {
    schemaVersion: "targeted-nanopore-run/v3", generatedAt: new Date().toISOString(),
    project: snapshot.projectName, startedAt: toIso(snapshot.startedAt), finishedAt: toIso(snapshot.finishedAt),
    durationSeconds: snapshot.startedAt && snapshot.finishedAt ? (snapshot.finishedAt - snapshot.startedAt) / 1000 : null,
    rounds: outcome.roundNames, targets: outcome.targets, referenceDnaByTarget: outcome.wtBySite,
    effectiveSettings: { ...snapshot.settings, reportHaplotypes: snapshot.sites.length >= 2, rescueFlankBases: 30, concatemerLengthRatio: 1.5 },
    statsByRound, fileStats: outcome.fileStats,
    filterFunnel: outcome.roundNames.map((round) => ({ round, ...outcome.statsByRound[round]!.primary_drop_reasons })),
    targetCallability: outcome.roundNames.flatMap((round) => outcome.siteNames.map((target) => { const { wt_count, ...values } = outcome.statsByRound[round]!.sites[target]!; return { round, target, ...values, referenceAaCount: wt_count }; })),
    exactCodonCounts: outcome.exactCodonCounts,
    exactCombinationCounts: Object.fromEntries(outcome.roundNames.map((round) => [round,
      Object.entries(outcome.exactHaplotypeCounts[round] ?? {}).map(([joinedDna, count]) => ({
        combinationAa: outcome.siteNames.map((target, index) => `${target}${translateDna(joinedDna.split("_")[index] ?? "")}`).join("|"),
        combinationDna: joinedDna.replaceAll("_", "|"), count,
      })),
    ])),
    combinationStatistics: outcome.haplotypeStatistics,
    libraryMedianEnrichment: outcome.libraryMedianFitness, hitCounts: outcome.hitCounts,
    ...(outcome.provenance ? { provenance: outcome.provenance } : {}),
    statisticalModel: {
      level: "amino acid",
      referenceStateHandling: "analyzed as an ordinary AA state; never used as a special denominator",
      pseudocount: snapshot.settings.pseudocount,
      pseudocountUnit: "RPM",
      enrichment: "log2((RPM_round+p_RPM)/(RPM_Round0+p_RPM))",
      variance: "Enrich2-style four-term Poisson delta method with p_RPM converted per library to p_RPM * callable_total / 1e6 reads",
      pValue: "two-sided Wald z-test",
      fdr: "Benjamini-Hochberg per target/combination family",
      biologicalReplicatesModeled: false,
    },
  };
}

export function buildLockedConfig(snapshot: TargetedExportSnapshot) {
  return {
    schemaVersion: "targeted-nanopore-config/v4",
    calculationModel: "rpm-pseudocount-v1",
    pseudocountUnit: "RPM",
    project: snapshot.projectName,
    reference: snapshot.referenceSeq,
    cds: { start1: snapshot.cdsStart, end1: snapshot.cdsEnd, strand: snapshot.cdsStrand },
    targets: snapshot.sites.map(({ ntStart }) => ({ ntStart, length: 3 })),
    rounds: snapshot.rounds.map(({ round, files }) => ({
      round,
      expectedFileNames: files.flatMap((source) => {
        const name = source.file?.name ?? source.driveRef?.name ?? source.expectedFileName;
        return name ? [name] : [];
      }),
    })),
    settings: {
      ...snapshot.settings,
      rescueFlankBases: 30,
    },
    fixedSafeguards: { concatemerLengthRatio: 1.5 },
  };
}

export function parseLockedConfig(text: string): TargetedLockedConfigImport {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("Locked config is not valid JSON.");
  }
  const root = record(raw, "Locked config");
  const legacyV3 = root.schemaVersion === "targeted-nanopore-config/v3";
  if (!legacyV3 && root.schemaVersion !== "targeted-nanopore-config/v4") {
    throw new Error("Unsupported locked config schema.");
  }
  if (!legacyV3) {
    exactKeys(root, [
      "schemaVersion", "calculationModel", "pseudocountUnit", "project",
      "reference", "cds", "targets", "rounds", "settings", "fixedSafeguards",
    ], "Locked config");
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

  const referenceSeq = normalizeReference(stringValue(root.reference, "reference"));
  if (
    referenceSeq.length < NANOPORE_INPUT_LIMITS.minReferenceBases ||
    referenceSeq.length > NANOPORE_INPUT_LIMITS.maxReferenceBases
  ) {
    throw new Error("Locked reference length is outside supported limits.");
  }

  const cds = record(root.cds, "cds");
  if (!legacyV3) exactKeys(cds, ["start1", "end1", "strand"], "cds");
  const cdsStart = integer(cds.start1, "cds.start1");
  const cdsEnd = integer(cds.end1, "cds.end1");
  const cdsStrand = cds.strand;
  if (cdsStrand !== "+" && cdsStrand !== "-") throw new Error("cds.strand must be '+' or '-'.");
  if (cdsStart < 1 || cdsEnd > referenceSeq.length || cdsEnd < cdsStart || (cdsEnd - cdsStart + 1) % 3 !== 0) {
    throw new Error("Locked CDS interval is invalid.");
  }

  if (!Array.isArray(root.targets) || root.targets.length === 0 || root.targets.length > NANOPORE_INPUT_LIMITS.maxSites) {
    throw new Error("Locked targets are missing or exceed the supported limit.");
  }
  const sites = root.targets.map((value, index) => {
    const target = record(value, `targets[${index}]`);
    if (!legacyV3) exactKeys(target, ["ntStart", "length"], `targets[${index}]`);
    if (target.length !== 3) throw new Error(`targets[${index}] must be a 3-nt codon target.`);
    const ntStart = integer(target.ntStart, `targets[${index}].ntStart`);
    if (ntStart < cdsStart || ntStart + 2 > cdsEnd || (ntStart - cdsStart) % 3 !== 0) {
      throw new Error(`targets[${index}] is not on a CDS codon boundary.`);
    }
    return { ntStart };
  });
  resolveTargetSites(referenceSeq, sites.map(({ ntStart }, index) => ({
    name: `site_${String(index + 1).padStart(2, "0")}`,
    ntStart,
    length: 3,
  })));

  if (!Array.isArray(root.rounds) || root.rounds.length < 2 || root.rounds.length > NANOPORE_INPUT_LIMITS.maxRounds) {
    throw new Error("Locked config must contain Round 0 and at least one selected round.");
  }
  const rounds = root.rounds.map((value, index) => {
    const round = record(value, `rounds[${index}]`);
    if (!legacyV3) exactKeys(round, ["round", "expectedFileNames"], `rounds[${index}]`);
    if (integer(round.round, `rounds[${index}].round`) !== index) {
      throw new Error("Locked rounds must be consecutive from Round 0.");
    }
    if (!Array.isArray(round.expectedFileNames) || round.expectedFileNames.length === 0 ||
        round.expectedFileNames.length > NANOPORE_INPUT_LIMITS.maxFilesPerRound) {
      throw new Error(`Round ${index} expected filenames are missing or exceed the supported limit.`);
    }
    const expectedFileNames = round.expectedFileNames.map((name, fileIndex) => {
      const value = stringValue(name, `rounds[${index}].expectedFileNames[${fileIndex}]`);
      const check = validateNanoporeFileName(value, null);
      if (!check.ok) throw new Error(`Round ${index}: ${check.reason}`);
      return value;
    });
    return { round: index, expectedFileNames };
  });

  const sourceSettings = record(root.settings, "settings");
  if (!legacyV3) {
    exactKeys(sourceSettings, [
      "minReadQ", "minReferenceCoverage", "minAlignmentIdentity",
      "minProtectedIdentity", "maxProtectedIndelBases", "minTargetBaseQ",
      "minInputCountToScore", "pseudocount", "rescueFlankBases",
    ], "settings");
  }
  const settings: TargetedCallingSettings = {
    minReadQ: bounded(sourceSettings.minReadQ, "settings.minReadQ", 0, 30),
    minReferenceCoverage: bounded(sourceSettings.minReferenceCoverage, "settings.minReferenceCoverage", 0, 1),
    minAlignmentIdentity: bounded(sourceSettings.minAlignmentIdentity, "settings.minAlignmentIdentity", 0, 1),
    minProtectedIdentity: bounded(sourceSettings.minProtectedIdentity, "settings.minProtectedIdentity", 0, 1),
    maxProtectedIndelBases: bounded(sourceSettings.maxProtectedIndelBases, "settings.maxProtectedIndelBases", 0, 10_000),
    minTargetBaseQ: bounded(sourceSettings.minTargetBaseQ, "settings.minTargetBaseQ", 0, 40),
    minInputCountToScore: integer(sourceSettings.minInputCountToScore, "settings.minInputCountToScore"),
    pseudocount: bounded(sourceSettings.pseudocount, "settings.pseudocount", Number.MIN_VALUE, 100),
  };
  if (settings.minInputCountToScore < 0 || settings.minInputCountToScore > 100_000) {
    throw new Error("settings.minInputCountToScore is outside supported limits.");
  }
  if (
    legacyV3 &&
    sourceSettings.reportHaplotypes !== true &&
    sourceSettings.reportHaplotypes !== false
  ) {
    throw new Error("settings.reportHaplotypes must be boolean.");
  }
  const reportHaplotypes = sites.length >= 2;
  if (sourceSettings.rescueFlankBases !== 30) throw new Error("Unsupported rescueFlankBases.");
  const safeguards = record(root.fixedSafeguards, "fixedSafeguards");
  if (!legacyV3) exactKeys(safeguards, ["concatemerLengthRatio"], "fixedSafeguards");
  if (safeguards.concatemerLengthRatio !== 1.5) throw new Error("Unsupported concatemer safeguard.");

  return {
    projectName,
    referenceSeq,
    cdsStart,
    cdsEnd,
    cdsStrand,
    sites,
    settings,
    // v3 briefly allowed stale true/false values that disagreed with target
    // count. Migration discards that non-effective state; v4 is canonical.
    reportHaplotypes,
    rounds,
  };
}

export function buildTargetedQcReport(outcome: TargetedNanoporeOutcome, snapshot: TargetedExportSnapshot): string {
  const total = sum(outcome.roundNames, (r) => outcome.statsByRound[r]!.total_reads);
  const passed = sum(outcome.roundNames, (r) => outcome.statsByRound[r]!.full_qc_passed);
  const lines = [
    "=".repeat(85), "                RoundLens TARGETED NANOPORE QC & SUMMARY REPORT", "=".repeat(85), "",
    `Project Name    : ${snapshot.projectName || "(unnamed)"}`, `Generation Time : ${new Date().toISOString()}`, `Total Reads     : ${total.toLocaleString()}`, `Full-QC Reads   : ${passed.toLocaleString()} (${total ? (passed / total * 100).toFixed(2) : "0.00"}%)`, "",
    "--- 1. EXCLUSIVE WHOLE-READ FILTER FUNNEL ---", buildFilterFunnelCsv(outcome).trim(), "",
    "A read receives one primary whole-read drop reason. Overlapping diagnostic failures remain in run_stats.json. Target rescue is reported separately and is never subtracted twice.", "",
    "--- 2. TARGET CALLABILITY & READ PRESERVATION ---", buildSiteCallabilityCsv(outcome).trim(), "",
    "Callable_Total = Callable_Full + Callable_Rescued. Target denominators are independent: failure at A304 does not erase a valid R233 call. For 2+ targets, combinations use full-QC reads only.", "",
    "--- 3. MULTI-TARGET COMBINATION ENRICHMENT ---",
    ...(snapshot.sites.length >= 2
      ? [
          "Combination_AA is self-describing and formed in locked target order (for example R233W|A304V|G331D).",
          "A read enters this matrix only when every target codon is callable and the full read passes QC. Partial rescued calls are excluded because an incomplete read cannot establish linkage.",
          "Counts, RPM, log2((RPM_round+p)/(RPM_Round0+p)) enrichment, Enrich2-style four-term variance, p-value and BH-FDR reuse the NGS statistical helpers; combination rows form their own multiple-testing family.",
        ]
      : ["Not applicable: linked-combination analysis requires at least two targets."]),
    "",
    "--- 4. HOW SUBSTITUTIONS, INSERTIONS AND DELETIONS ARE HANDLED ---",
    "Substitution outside a target: retained while target-masked protected identity passes; accumulated mismatch can fail low_protected_identity.",
    "Substitution inside a target: called as a codon only when all three projected bases are unambiguous and meet target base Q. Intended target substitutions are excluded from protected-identity scoring.",
    "Insertion/deletion overlapping a target codon: that target enters target_indel and is non-callable; other covered targets remain eligible.",
    "Small indel outside targets: projected through CIGAR and tolerated up to the fixed protected-indel limit. Larger disruption fails protected_indel for the whole read.",
    "Partial read: may rescue one target only when both 30-nt flanks are covered and pass protected identity. It cannot create a linked combination.",
    "Complete high-quality target codons are counted without assuming the library construction. Stop codons are explicitly flagged and not silently removed.", "",
    "--- 5. INTERPRETATION LIMITS ---",
    "The primary enrichment matrix collapses synonymous codons to amino acids. The reference amino acid and reference combination are ordinary rows with their own enrichment; no WT/non-WT classification changes the statistics. Lossless exact-codon and exact target-combination counts remain in run_stats.json.",
    "Round 0 threshold gates inference only. It does not delete raw counts or RPM.",
    "Without biological replicates, Var/Z/p/FDR describe Poisson counting uncertainty and usually underestimate total experimental uncertainty. Use them for prioritization, not replicate-level claims.", "",
    formatMethodsAsText(TARGETED_NANOPORE_METHODS, { settings: methodSettings(snapshot), pseudocount: snapshot.settings.pseudocount, libraryMedian: outcome.libraryMedianFitness, hitCounts: outcome.hitCounts }),
  ];
  return lines.join("\n");
}

export function methodSettings(snapshot: TargetedExportSnapshot) { return [
  { label: "Minimum read Q", value: `≥ ${snapshot.settings.minReadQ}` }, { label: "Protected identity", value: `≥ ${snapshot.settings.minProtectedIdentity}` },
  { label: "Target base Q", value: `≥ ${snapshot.settings.minTargetBaseQ}` }, { label: "Round 0 score threshold", value: `≥ ${snapshot.settings.minInputCountToScore}` },
  { label: "Enrichment pseudocount (RPM)", value: snapshot.settings.pseudocount.toString() },
  { label: "Reference coverage (fixed)", value: `≥ ${snapshot.settings.minReferenceCoverage}` }, { label: "Alignment identity (fixed)", value: `≥ ${snapshot.settings.minAlignmentIdentity}` },
  { label: "Protected indel limit (fixed)", value: `≤ ${snapshot.settings.maxProtectedIndelBases} nt` }, { label: "Linked combinations", value: snapshot.sites.length >= 2 ? "full-QC reads" : "not applicable (<2 targets)" },
]; }

function csv(rows: ReadonlyArray<ReadonlyArray<string | number>>): string { return rows.map((row) => row.map((v) => `"${String(v).replaceAll('"', '""')}"`).join(",")).join("\n") + "\n"; }
function sum(rounds: string[], fn: (round: string) => number): number { return rounds.reduce((n, round) => n + fn(round), 0); }
function toIso(value: number | null): string | null { return value == null ? null : new Date(value).toISOString(); }
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  const missing = allowed.filter((key) => !(key in value));
  if (unknown.length > 0) throw new Error(`${label} contains unsupported field(s): ${unknown.join(", ")}.`);
  if (missing.length > 0) throw new Error(`${label} is missing field(s): ${missing.join(", ")}.`);
}
function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty string.`);
  return value;
}
function bounded(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} is outside supported limits.`);
  }
  return value;
}
function integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${label} must be an integer.`);
  return value;
}
function textBlob(text: string, type = "text/csv;charset=utf-8"): Blob { return new Blob([text], { type }); }
function jsonBlob(value: unknown): Blob { return new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }); }
function sanitize(value: string): string { return value.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80); }
async function gzipBlob(blob: Blob): Promise<Blob> { return new Response(blob.stream().pipeThrough(new CompressionStream("gzip"))).blob(); }
async function addGzip(out: Array<[Blob, string]>, blob: Blob | null, name: string) { if (blob) out.push([await gzipBlob(blob), name]); }
function downloadBlob(blob: Blob, name: string) { const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
