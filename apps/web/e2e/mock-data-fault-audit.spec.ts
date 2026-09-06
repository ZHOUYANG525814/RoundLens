import { expect, test, type Download, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";

const MOCK_ROOT = resolve(import.meta.dirname, "../../../../mock_data");
const HAS_LOCAL_AUDIT_DATA = existsSync(resolve(MOCK_ROOT, "fault_audit_cases.json"));

async function importConfig(page: Page, relativePath: string): Promise<void> {
  await page.locator('input[type="file"][accept*="application/json"]').setInputFiles(
    resolve(MOCK_ROOT, relativePath),
  );
  await expect(page.getByText(/Locked config imported/)).toBeVisible();
}

async function collectFiveDownloads(page: Page): Promise<Map<string, Buffer>> {
  const downloads: Download[] = [];
  const listener = (download: Download) => downloads.push(download);
  page.on("download", listener);
  try {
    await page.getByRole("button", { name: "Download all" }).click();
    await expect.poll(() => downloads.length, { timeout: 30_000 }).toBe(5);
    const files = new Map<string, Buffer>();
    for (const download of downloads) {
      const path = await download.path();
      if (!path) throw new Error(`Browser did not retain ${download.suggestedFilename()}.`);
      files.set(download.suggestedFilename(), await readFile(path));
    }
    return files;
  } finally {
    page.off("download", listener);
  }
}

function artifact(files: Map<string, Buffer>, suffix: string): Buffer {
  const match = [...files].find(([name]) => name.endsWith(suffix));
  if (!match) throw new Error(`Missing downloaded artifact ending in ${suffix}.`);
  return match[1];
}

test("browser NGS fault audit preserves intended QC buckets and accepted special sequences", async ({ page }) => {
  test.skip(!HAS_LOCAL_AUDIT_DATA, "Outer mock_data directory is intentionally local and was not generated.");
  test.setTimeout(180_000);

  await page.goto("/");
  await importConfig(page, "FIXED_CONFIG/NGS_MULTIPLEXED_FIXED_CONFIG.json");
  await page.locator('input[type="file"][multiple]').setInputFiles(
    resolve(MOCK_ROOT, "NGS/fault_audit/multiplexed/NGS_FAULT_AUDIT.fastq"),
  );
  await page.getByRole("button", { name: /^Continue$/ }).click();
  await page.getByRole("button", { name: /Continue to Analyze/ }).click();
  await page.getByRole("button", { name: /^Run analysis$/ }).click();
  await expect(page.getByRole("heading", { name: "Downloads" })).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText("76", { exact: true }).first()).toBeVisible();

  const files = await collectFiveDownloads(page);
  const stats = JSON.parse(artifact(files, "_run_stats.json").toString("utf8"));
  expect(stats.global_unassigned).toBe(24);
  expect(stats.unassigned_breakdown).toEqual({
    ambiguous: 0,
    barcode_mismatch: 4,
    low_quality: 4,
    malformed_fastq: 8,
    no_anchor: 8,
  });
  for (const round of ["Round_0", "Round_1", "Round_2", "Round_3"]) {
    expect(stats.rounds[round]).toEqual({
      discard_length_indel: 0,
      discard_low_quality_cds: 1,
      discard_stop_codon: 1,
      discard_truncated: 1,
      passed_qc: 10,
      total_assigned: 13,
    });
  }

  const master = gunzipSync(artifact(files, "_Master_Enrichment_Matrix.csv.gz")).toString("utf8");
  const rows = master.trim().split(/\r?\n/);
  expect(rows).toHaveLength(6); // header + five accepted DNA/peptide states
  expect(master).toContain("AAAAAAAAAAAAAAAAAAA");
  expect(master).toContain("EAAAAAAAAAAAAAAAAAA");
  expect(master).toContain("AXAAAAAAAAAAAAAAAAA"); // high-Q N is retained as X
  expect(master).toContain("AAASCCCCCCCCCCCCCCC"); // insertion frame artifact, documented
  expect(master).toContain("AAALLLLLLLLLLLLLLLL"); // deletion frame artifact, documented
  expect(master).not.toContain("*AAAAAAAAAAAAAAAAAA"); // stop-filtered sequence must be absent

  const combination = gunzipSync(artifact(files, "_Combination_Enrichment_Matrix.csv.gz"));
  expect(combination.equals(Buffer.from(master))).toBe(true);
});

test("browser Nanopore fault audit exports exact codons, indel QC, rescue and deduplication", async ({ page }) => {
  test.skip(!HAS_LOCAL_AUDIT_DATA, "Outer mock_data directory is intentionally local and was not generated.");
  test.setTimeout(240_000);

  await page.goto("/");
  await page.getByRole("button", { name: "Nanopore" }).click();
  await expect(page.getByRole("heading", { name: "RoundLens" })).toBeVisible();
  // The banner updates before the lazily loaded tool body. Waiting for this
  // Nanopore-only control prevents uploading the config into the outgoing
  // NGS input during the brief module transition.
  await expect(page.getByRole("button", { name: "Load demo" })).toBeVisible();
  await importConfig(page, "FIXED_CONFIG/NANOPORE_SEPARATED_ROUNDS_FIXED_CONFIG.json");
  const inputs = page.locator('input[type="file"][multiple]');
  await expect(inputs).toHaveCount(3);
  for (let round = 0; round < 3; round++) {
    await inputs.nth(round).setInputFiles(resolve(
      MOCK_ROOT,
      `NANOPORE/fault_audit/Round_${round}/NANOPORE_FAULT_AUDIT.fastq`,
    ));
  }
  await page.getByRole("button", { name: "Continue to Design" }).click();
  await page.getByRole("button", { name: "Continue to Analyze" }).click();
  await page.getByRole("button", { name: /^Run analysis$/ }).click();
  await expect(page.getByRole("heading", { name: "Downloads" })).toBeVisible({ timeout: 180_000 });
  await expect(page.getByText("66", { exact: true }).first()).toBeVisible();

  const files = await collectFiveDownloads(page);
  const stats = JSON.parse(artifact(files, "_run_stats.json").toString("utf8"));
  const selectedCodons = ["GTT", "TTG", "TGG"];
  for (let roundIndex = 0; roundIndex < 3; roundIndex++) {
    const round = `Round ${roundIndex}`;
    const roundStats = stats.statsByRound[round];
    expect(roundStats.total_reads).toBe(22);
    expect(roundStats.duplicate_read_ids).toBe(1);
    expect(roundStats.aligned).toBe(17);
    expect(roundStats.full_qc_passed).toBe(14);
    expect(roundStats.primary_drop_reasons).toEqual({
      alignment_failed: 1,
      concatemer_or_chimera: 1,
      duplicate_read_id: 1,
      low_alignment_identity: 0,
      low_protected_identity: 0,
      low_read_q: 1,
      malformed_fastq: 1,
      partial_reference: 2,
      protected_indel: 1,
    });

    const targets = Object.keys(stats.exactCodonCounts[round]);
    expect(targets).toHaveLength(5);
    expect(stats.exactCodonCounts[round][targets[0]]).toEqual({ TAT: 13, [selectedCodons[roundIndex]]: 2 });
    expect(stats.exactCodonCounts[round][targets[1]]).toEqual({ AAC: 15 });
    expect(stats.exactCodonCounts[round][targets[2]]).toEqual({ GGC: 13 });
    expect(stats.exactCodonCounts[round][targets[3]]).toEqual({ AAC: 13 });
    expect(stats.exactCodonCounts[round][targets[4]]).toEqual({ CTG: 14, TAG: 1, TGG: 1 });

    const calls = stats.targetCallability.filter((item: { round: string }) => item.round === round);
    expect(calls.map((item: Record<string, number>) => ({
      callable: item.passed_qc,
      rescued: item.callable_rescued,
      targetIndel: item.target_indel,
      lowQ: item.low_quality,
      ambiguous: item.ambiguous,
      stop: item.stop_codon,
    }))).toEqual([
      { callable: 15, rescued: 2, targetIndel: 2, lowQ: 0, ambiguous: 0, stop: 0 },
      { callable: 15, rescued: 2, targetIndel: 1, lowQ: 0, ambiguous: 0, stop: 0 },
      { callable: 13, rescued: 0, targetIndel: 0, lowQ: 1, ambiguous: 0, stop: 0 },
      { callable: 13, rescued: 0, targetIndel: 1, lowQ: 0, ambiguous: 1, stop: 0 },
      { callable: 16, rescued: 2, targetIndel: 0, lowQ: 0, ambiguous: 0, stop: 1 },
    ]);
  }

  const master = gunzipSync(artifact(files, "_Master_Enrichment_Matrix.csv.gz")).toString("utf8");
  const combinations = gunzipSync(artifact(files, "_Combination_Enrichment_Matrix.csv.gz")).toString("utf8");
  expect(master).toContain(",TAG,"); // stop state is retained and explicitly counted
  expect(master).not.toContain(",CCC,"); // duplicate UUID's rejected codon must not leak into output
  expect(combinations).toContain("TAT|AAC|GGC|AAC|TAG");
  expect(combinations).not.toContain("CCC|AAC|GGC|AAC|CTG");
});
