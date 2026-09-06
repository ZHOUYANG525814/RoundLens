// Column-by-column documentation for the analyzer CSVs. The same structured
// data feeds two consumers:
//
//   - Text formatter `formatMethodsAsText(doc)` — appended to the
//     QC_Summary_Report.txt download so the artifact is self-documenting.
//   - React component `<MethodsCard>` on the Results page — shows formulas
//     next to the data so users don't have to dig for definitions.
//
// Kept in `packages/core/` (not the web app) so the desktop CLI and any
// future server-side build can render the same documentation.
//
// Each `ColumnDoc` carries:
//   - name:    column name in the CSV
//   - summary: one-line plain-English explanation
//   - formula: math expression in Unicode (renders cleanly in monospace)
//   - notes:   optional caveats / pointers
//
// Documentation strings are intentionally written as I'd want them to read
// in a manuscript's methods section. The summary is for skim; the formula
// is for precision; the notes are for "when does this break or surprise me."

export interface ColumnDoc {
  /** Column name with `<r>` placeholder for round-name interpolation. */
  name: string;
  /** Plain-English one-line summary. */
  summary: string;
  /** Math expression (Unicode operators, monospace-friendly). Optional —
   *  some columns (Peptide_Seq, Count_<r>) are self-explanatory. */
  formula?: string;
  /** Caveats, edge cases, or pointers to related output. */
  notes?: string[];
}

export interface MethodsDocument {
  /** Short tool name for the document header. */
  toolName: string;
  /** Product default pseudocount. The actual per-run value can override this
   *  and is always recorded in exported methods/provenance. */
  pseudocount: number;
  /** Name + short description of the p-value test. */
  pvalueMethod: string;
  /** Name + short description of the multiple-testing adjustment. */
  fdrMethod: string;
  /** Centering scheme for the tier-3 score. */
  centeringMethod: string;
  /** Grouped column documentation. */
  sections: { title: string; columns: ColumnDoc[] }[];
  /** Recommended (X, y, weight) triple for downstream ML / PLM workflows.
   *  Rendered as a dedicated section in both the text summary and the
   *  MethodsCard. Optional — older tools without an ML story can omit it. */
  mlRecipe?: {
    /** Plain-English summary of how to feed this CSV to a model. */
    description: string;
    /** Input column for a transformer / PLM. */
    inputColumn: string;
    /** Regression / classification target. */
    targetColumn: string;
    /** Sample-weight column. */
    weightExpr: string;
    /** Optional pandas one-liner to lift the (X, y, w) triple. */
    snippet?: string;
  };
  /** Method-level caveats every user should see. */
  caveats: string[];
}

// ============================================================================
// cDNA-DISPLAY methods document
// ============================================================================

export const CDNA_METHODS: MethodsDocument = {
  toolName: "RoundLens",
  pseudocount: 0.5,
  pvalueMethod:
    "Two-sided Wald z-test on log2((RPM_destination+p)/(RPM_source+p)), using an Enrich2-style four-term Poisson delta-method SE",
  fdrMethod: "Benjamini-Hochberg per round (independently across all variants in that round)",
  centeringMethod: "Library median of Enrich_Global at each round (robust against hit outliers)",
  sections: [
    {
      title: "Variant identity",
      columns: [
        {
          name: "Peptide_Seq",
          summary: "Translated amino-acid sequence of the CDS region using the standard genetic code.",
          formula: "Peptide_Seq = translate(Dominant_DNA_Seq)",
          notes: [
            "Translation is codon-by-codon (3 bp → 1 AA); a trailing partial codon maps to 'X'.",
            "Stop codons translate to '*'. With \"Discard CDS with premature stop\" on (default), no '*' appears.",
          ],
        },
        {
          name: "Dominant_DNA_Seq",
          summary:
            "The DNA codon variant most frequently observed for this peptide, summed across all rounds.",
          formula:
            "Dominant_DNA_Seq = argmax over { distinct DNAs encoding this peptide } of (total count across rounds)",
          notes: [
            "Ties are broken by first-seen order in the demultiplex stream (matches Python's max() semantics).",
            "Multiple synonymous codons may encode the same peptide; we keep just the dominant one for CSV readability.",
          ],
        },
      ],
    },
    {
      title: "Raw and normalized counts",
      columns: [
        {
          name: "Count_<r>",
          summary: "Reads passing every QC filter that translate to this peptide in round <r>.",
          notes: [
            "This is the raw data. Every other numeric column derives from it.",
            "Filter chain: valid FASTQ record → mean read Phred ≥ threshold → Fw anchor exact 10-bp match → barcode score ≤ 1.0 → ambiguity margin ≥ 1.0 → CDS slice in-bounds → CDS-region mean Phred ≥ threshold → frame check → stop check (if enabled). Malformed records enter their own pre-round rejection bucket.",
          ],
        },
        {
          name: "RPM_<r>",
          summary: "Reads per million, normalized by the round's passed-QC count.",
          formula: "RPM_<r> = (Count_<r> / passed_qc_<r>) × 10⁶",
          notes: [
            "passed_qc_<r> is the per-round QC-passing total (see run_stats.json → rounds.<r>.passed_qc).",
            "Use RPM (not Count) to compare across rounds with different sequencing depths.",
          ],
        },
      ],
    },
    {
      title: "Enrichment (fold-change)",
      columns: [
        {
          name: "Enrich_Step_<curr>_vs_<prev>",
          summary: "log2 fold-change between two consecutive rounds.",
          formula: "Enrich_Step = log₂[(RPM_<curr>+p)/(RPM_<prev>+p)]",
          notes: [
            "p is the RPM-unit pseudocount recorded for this run.",
            "Useful for \"did this variant suddenly jump between rounds 2 and 3?\" diagnostics.",
          ],
        },
        {
          name: "Centered_Enrich_<r>_vs_<first>",
          summary:
            "Library-median-centered log₂ fold-change vs the first round — the canonical fold-change column and the CSV's primary sort key. Corrects systematic library-wide drift (sequencing depth, PCR yield, etc.).",
          formula:
            "Centered_Enrich = log₂[(RPM_<r>+p)/(RPM_<first>+p)] − median(that quantity)",
          notes: [
            "Median (not mean) so a small number of strong hits doesn't pull the offset and falsely flatten them.",
            "Raw (un-centered) log₂ fold-change is recoverable as `Centered_Enrich + libraryMedian` (the per-round median is reported above).",
            "CAVEAT: under stringent selection where most variants drop out, the library median itself is strongly negative — Centered_Enrich over-corrects and makes everything look enriched. Treat with skepticism when the median is < −1 (flagged with ⚠ in the diagnostic above).",
          ],
        },
      ],
    },
    {
      title: "Statistical inference (Z / p-value / FDR / Var)",
      columns: [
        {
          name: "Z_Enrich_<r>_vs_<first>",
          summary:
            "Z-statistic — how many standard errors the log₂ fold-change is from zero.",
          formula:
            "Z = log₂FC / SE, where SE = (1/ln 2)·√[1/(Count_<r>+q_r)+1/(N_<r>+q_r)+1/(Count_<first>+q_0)+1/(N_<first>+q_0)], q_i=p×N_i/10⁶",
          notes: [
            "Poisson delta-method SE; Z always uses the raw (un-centered) log₂ fold-change. Centering changes the numerator, so Centered_Enrich must not be substituted into the Z formula.",
            "Anti-conservative for counts below ~5; pseudocount mitigates but doesn't fully fix.",
            "Rule of thumb: |Z| > 2 → suggestive; |Z| > 3 → confidence; |Z| > 5 → strong (modulo multiple testing — use FDR_q).",
          ],
        },
        {
          name: "Pval_Enrich_<r>_vs_<first>",
          summary: "Two-sided z-test p-value under the null hypothesis log₂FC = 0.",
          formula: "P = 2 · (1 − Φ(|Z|)),  Φ = standard normal CDF",
          notes: [
            "Two-sided because the test is \"is the variant changing\", not \"is it specifically enriching\".",
            "−log₁₀(P) is one CSV column away from any consumer who needs it (volcano-plot Y-axis); we no longer emit it as a separate column.",
          ],
        },
        {
          name: "FDR_q_<r>_vs_<first>",
          summary:
            "Benjamini-Hochberg adjusted q-value — the false-discovery-rate threshold at which this variant is significant.",
          formula:
            "Sort all variants ascending by p. For rank i (1-based), q[i] = min over k ≥ i of (p[k] · m / k). Cap at 1. Monotonicity correction applied from the largest rank downward.",
          notes: [
            "Use q < 0.05 as the conventional significance cutoff for hit-calling.",
            "Computed independently per round — q for R3 vs R0 is separate from q for R2 vs R0.",
            "FDR controls the *expected fraction* of false positives among called hits. With 100 hits at q<0.05, expect ≤ 5 to be false discoveries.",
          ],
        },
        {
          name: "Var_Enrich_<r>_vs_<first>",
          summary:
            "σ² of the log₂ fold-change (Poisson δ-method). Use 1/Var as the per-row inverse-variance weight for downstream ML training.",
          formula:
            "Var_Enrich = (1/ln 2)²·[1/(Count_<r>+q_r)+1/(N_<r>+q_r)+1/(Count_<first>+q_0)+1/(N_<first>+q_0)], q_i=p×N_i/10⁶",
          notes: [
            "p is specified in RPM; q_i converts it to the equivalent number of reads separately for each library. This keeps score and variance in the same units.",
            "Four terms contribute: the variant count and passed-QC library total in each of the two rounds.",
            "Mathematically: Var_Enrich = SE²  ⇔  Z = log₂FC / √Var_Enrich. The same σ² is used internally to derive Z.",
            "For ML: `weight = 1 / Var_Enrich`. Variants with rare counts get small weights automatically — their fold-change estimate has high σ², so the model trusts them less.",
          ],
        },
      ],
    },
  ],
  mlRecipe: {
    description:
      "This CSV is shaped to feed a transformer-based protein language model (ESM-2, ProtBERT) for downstream variant-effect prediction. The (X, y, weight) triple below is the canonical regression setup.",
    inputColumn: "Peptide_Seq — feed through ESM-2; mean-pool the L × 1280 residue embedding to one vector per peptide (or use per-residue for sequence-output heads).",
    targetColumn:
      "Centered_Enrich_<lastRound>_vs_<firstRound> — already corrected for systematic library shift, roughly symmetric around 0.",
    weightExpr:
      "1 / Var_Enrich_<lastRound>_vs_<firstRound> — inverse-variance weighting; rare variants are automatically down-weighted.",
    snippet:
      'df = pd.read_csv("Master_Enrichment_Matrix.csv")\n' +
      'df = df[df.Count_<firstRound> >= 5]              # confidence filter\n' +
      'y = df["Centered_Enrich_<lastRound>_vs_<firstRound>"]\n' +
      'w = 1.0 / df["Var_Enrich_<lastRound>_vs_<firstRound>"]\n' +
      "X = esm2.embed(df.Peptide_Seq.tolist()).mean(dim=1)  # → (N, 1280)\n" +
      "model.fit(X, y, sample_weight=w)",
  },
  caveats: [
    "The selected pseudocount p is in RPM units and is used consistently in the score and variance. For variance, q_i=p×passed_qc_i/10⁶ converts it to the equivalent raw-count pseudocount. Default p=0.5 RPM; p=1.0 RPM reproduces the historical RPM+1 score.",
    "All Z / p-values are Wald-type (score / SE) from a Poisson delta-method. The Wald approximation is anti-conservative at very low counts. For publication-grade extremes, a Fisher's exact CI or beta-binomial test would be more rigorous; we can add either later.",
    "Centered_Enrich assumes \"most variants are neutral\". When stringent selection eliminates most variants, the library median is shifted away from zero and the centered score over-corrects. Library median is reported above so users can detect this regime.",
    "Enrich_Global (the raw, un-centered log₂ fold-change) was emitted as a separate column in earlier versions but is now derivable as `Centered_Enrich + libraryMedian`. NegLog10Pval was likewise dropped — `−log₁₀(Pval)` is one column away. Both removals make room for Var_Enrich without growing CSV width.",
    "FDR and rank are computed across the *full library* at each round, not just over the rows in the CSV. (The analyzer always processes every observed peptide.)",
  ],
};

// ============================================================================
// Nanopore SSM methods document
// ============================================================================
//
// Differences from cDNA:
//   - Variable region is called "ROI" (between two flanking anchors), not "CDS".
//   - WT counter is available → tier-2 score (Fitness_vs_WT) is an RPM+p
//     variant/reference ratio. Anchors all statistical inference on this column.
//   - Dual-anchor scoring uses banded approximate matching (Wagner-Fischer) to
//     tolerate Nanopore's per-base error rate.

export const NANOPORE_METHODS: MethodsDocument = {
  toolName: "RoundLens (legacy Nanopore core)",
  pseudocount: 0.5,
  pvalueMethod:
    "Two-sided Wald z-test on the log2 WT-anchored fitness, using a four-term Poisson delta-method SE",
  fdrMethod: "Benjamini-Hochberg per (site, round) — each site is treated as an independent experiment",
  centeringMethod: "Library median of Fitness_vs_WT at each (site, round) (robust against hit outliers)",
  sections: [
    {
      title: "Variant identity",
      columns: [
        {
          name: "Site",
          summary: "Name of the SSM site this variant belongs to (one row per (site, AA-variant) pair).",
          notes: [
            "Each site has its own flanking anchors, expected ROI length, and WT codon. Rows for different sites are independent — sort and significance are scoped per-site.",
          ],
        },
        {
          name: "Variant_AA",
          summary: "Translated amino-acid for this ROI (1 codon = 1 AA for typical 3-bp SSM sites).",
          formula: "Variant_AA = translate(Dominant_DNA)",
        },
        {
          name: "Dominant_DNA",
          summary:
            "The DNA codon variant most frequently observed for this AA at this site, summed across rounds.",
        },
      ],
    },
    {
      title: "Counts and normalization",
      columns: [
        {
          name: "Count_<r>",
          summary:
            "Reads passing every Nanopore-side QC filter that extract this exact ROI sequence at this site in round <r>.",
          notes: [
            "Filter chain: valid FASTQ record → mean read Phred ≥ minMeanPhredRead → both anchors located by banded align (subs ≤ maxAnchorSubs, indels ≤ maxAnchorIndels) → ROI length == expected (no Nanopore indels in the variable region) → mean ROI Phred ≥ minMeanPhredRoi → frame check → stop check (if enabled). Malformed records are isolated in globalBreakdown.malformed_fastq.",
          ],
        },
        {
          name: "RPM_<r>",
          summary: "Reads per million, normalized by this site's passed-QC count for round <r>.",
          formula: "RPM_<r> = (Count_<r> / passed_qc_<site,r>) × 10⁶",
          notes: [
            "Per-site denominator: passed_qc is tracked per (site, round) because sites can fail independently (one anchor matches but the other doesn't).",
          ],
        },
      ],
    },
    {
      title: "Enrichment and fitness",
      columns: [
        {
          name: "Fitness_vs_WT_<r>",
          summary:
            "WT-anchored log₂ fitness. Compares the RPM-normalized variant abundance relative to the RPM-normalized reference state in each round.",
          formula:
            "Fitness_vs_WT = log₂[(RPM_v_<r>+p)/(RPM_wt_<r>+p)] − log₂[(RPM_v_<first>+p)/(RPM_wt_<first>+p)]",
          notes: [
            "wt_<r> = number of reads at this site whose ROI exactly matches the reference WT in round <r> (separate counter, see run_stats.json → rounds.<r>.sites.<siteName>.wt_count).",
            "Positive = variant outgrows WT; negative = variant is selected against relative to WT; ~0 = variant tracks WT.",
            "WT-anchoring cancels per-round library-size effects directly via the WT denominator. Works best when the WT codon is the dominant variant in the input (typically > 10% of reads); for fully degenerate libraries (e.g. NNN at every variable position) the WT denominator is small + noisy and `Fitness_vs_WT` becomes unreliable.",
          ],
        },
        {
          name: "Centered_Fitness_<r>",
          summary:
            "Library-median-centered fitness — the canonical fitness column and CSV's primary sort key. Corrects any residual library-wide shift not absorbed by WT normalization.",
          formula:
            "Centered_Fitness = Fitness_vs_WT − median(Fitness_vs_WT across all variants at this (site, round))",
          notes: [
            "Per-(site, round) median because sites are independent experiments.",
            "Same dropout caveat as cDNA: under stringent selection, median may be strongly negative — then Centered_Fitness over-corrects.",
            "Library median per (site, round) is exposed above and on the analyzer result as libraryMedianFitness.",
          ],
        },
      ],
    },
    {
      title: "Statistical inference (Z / p-value / FDR / Var)",
      columns: [
        {
          name: "Z_Fitness_<r>",
          summary: "Z-statistic for Fitness_vs_WT — distance from neutral in units of SE.",
          formula:
            "Z = Fitness_vs_WT / SE, where SE = (1/ln 2)·√[1/(Count_v_<r>+q_r)+1/(wt_<r>+q_r)+1/(Count_v_<first>+q_0)+1/(wt_<first>+q_0)], q_i=p×N_i/10⁶",
          notes: [
            "Four-term Poisson SE — all four counts (variant + WT, both rounds) contribute. Larger denominator than the cDNA two-term form by construction.",
            "Anti-conservative when any of the four counts is < ~5.",
            "WT-counter dependency: when the WT count is very low (synthesis dropout at the WT codon), the SE inflates for everyone at that site.",
          ],
        },
        {
          name: "Pval_Fitness_<r>",
          summary: "Two-sided z-test p-value for Fitness_vs_WT.",
          formula: "P = 2 · (1 − Φ(|Z|))",
        },
        {
          name: "FDR_q_<r>",
          summary:
            "Benjamini-Hochberg adjusted q-value, computed per (site, round). The standard hit-calling threshold is q < 0.05.",
          notes: [
            "Site-scoped: each site's variants form their own multiple-testing family. q for site_1 isn't affected by p-values at site_2.",
          ],
        },
        {
          name: "Var_Fitness_<r>",
          summary:
            "σ² of Fitness_vs_WT (four-term Poisson δ-method). Use 1/Var as the per-row inverse-variance weight for downstream ML training.",
          formula:
            "Var_Fitness = (1/ln 2)²·[1/(Count_v_<r>+q_r)+1/(wt_<r>+q_r)+1/(Count_v_<first>+q_0)+1/(wt_<first>+q_0)], q_i=p×N_i/10⁶",
          notes: [
            "Four-term form: unlike cDNA, the denominator (WT count) is itself a small Poisson quantity, so its variance contributes to σ² explicitly.",
            "Mathematically: Var_Fitness = SE²  ⇔  Z = Fitness_vs_WT / √Var_Fitness. Same σ² is used internally to derive Z.",
            "For ML: `weight = 1 / Var_Fitness`. Variants at sites with a weak WT counter automatically get smaller weights — the model is less confident in their fitness estimates.",
          ],
        },
      ],
    },
  ],
  mlRecipe: {
    description:
      "Per-site CSV is shaped to feed a transformer-based PLM (ESM-2, ProtBERT) for SSM fitness prediction. The (X, y, weight) triple below is the canonical regression setup.",
    inputColumn:
      "Variant_AA (joined with neighbouring site context if multi-site) — feed through ESM-2; per-residue embedding for SSM-specific heatmaps, or mean-pool for whole-protein fitness.",
    targetColumn:
      "Centered_Fitness_<lastRound> — corrected for systematic shift; per-site centering keeps each SSM site comparable.",
    weightExpr:
      "1 / Var_Fitness_<lastRound> — inverse-variance weighting; variants at sites with weak WT counters are automatically down-weighted.",
    snippet:
      'df = pd.read_csv("enrichment_per_site.csv")\n' +
      'df = df[df["Count_<firstRound>"] >= 5]            # confidence filter\n' +
      'y = df["Centered_Fitness_<lastRound>"]\n' +
      'w = 1.0 / df["Var_Fitness_<lastRound>"]\n' +
      "# Build (site, variant) → sequence string for ESM-2 input externally;\n" +
      "# then mean- or per-residue-pool the L × 1280 embedding before regression.",
  },
  caveats: [
    "The selected pseudocount p is in RPM units. Each round converts it to q_i=p×passed_qc_i/10⁶ reads for the four-term variance. Default p=0.5 RPM; p=1.0 RPM remains selectable.",
    "Wald-type Z is anti-conservative at any count < ~5. The pseudocount mitigates but does not eliminate this. For variants with Count_<first> < 5, treat the FDR as a lower bound on the true significance level.",
    "Banded anchor matching tolerates up to maxAnchorSubs substitutions + maxAnchorIndels indels per anchor (defaults: 2 + 1). Variants that fail this tolerance are dropped from the counter entirely, not counted as zero — so a variant absent from the CSV could be either truly absent or repeatedly anchor-failed.",
    "WT counter assumes the reference ROI string is what truly counts as WT in your library. For fully degenerate libraries (e.g. NNN positions), there is no biological WT and `Fitness_vs_WT` should NOT be used — fall back to the cDNA-style RPM normalization on the underlying counts.",
    "Enrich_Global_<r> and NegLog10Pval_Fitness_<r> columns were dropped in Phase 6.16 to make room for Var_Fitness without growing CSV width. Raw RPM+p enrichment is recoverable from counts, passed-QC totals and the recorded RPM pseudocount; NegLog10Pval is `−log₁₀(Pval_Fitness)`.",
  ],
};

/** Full-reference targeted Nanopore mode. Statistical columns are the
 * same tested WT-normalized implementation as NANOPORE_METHODS; only read
 * calling and QC semantics differ from the legacy dual-anchor SSM path. */
export const TARGETED_NANOPORE_METHODS: MethodsDocument = {
  ...NANOPORE_METHODS,
  toolName: "RoundLens (targeted Nanopore)",
  pvalueMethod: "Two-sided Wald z-test on each AA state's RPM+p enrichment, using an Enrich2-style four-term Poisson delta-method SE",
  fdrMethod: "Benjamini-Hochberg per (target, round), plus an independent AA-combination family per round",
  centeringMethod: "Eligible-variant median independently per target or AA-combination family",
  sections: [
    {
      title: "Variant identity",
      columns: [
        { name: "Target", summary: "Reference amino acid and CDS position, such as R233; each target is an independent counting and FDR family." },
        { name: "Variant_AA", summary: "Amino acid translated from a complete, high-quality three-base target call.", formula: "Variant_AA = translate(observed target codon)" },
        { name: "Dominant_DNA", summary: "Most abundant synonymous codon for this amino acid across rounds. Every exact codon count remains in run_stats.json." },
        { name: "Combination_AA", summary: "Complete linked target genotype in self-describing mutation notation, for example R233W|A304V|G331D." },
        { name: "Combination_DNA", summary: "Dominant exact target-codon combination for the amino-acid combination, in the same locked target order." },
      ],
    },
    {
      title: "Counts and normalization",
      columns: [
        {
          name: "Count_<r>",
          summary: "Callable observations for this amino acid at this target in round <r>.",
          notes: [
            "One semiglobal affine-gap alignment to the full amplicon projects substitutions, insertions and deletions into reference coordinates.",
            "Target codons are masked from protected-reference identity, so intended substitutions do not fail whole-read QC.",
            "A target-overlapping indel or low-Q/ambiguous target base makes only that target non-callable; other independently callable targets can still contribute.",
            "Partial reads may contribute one target when both fixed 30-nt flanks pass protected identity. Rescued calls never enter multi-target combinations.",
          ],
        },
        { name: "RPM_<r>", summary: "Reads per million using that target's callable total as denominator.", formula: "RPM_<r> = Count_<r> / callable_<target,r> × 10⁶" },
      ],
    },
    {
      title: "Round-to-baseline enrichment",
      columns: [
        { name: "Enrichment_<r>_vs_<first>", summary: "Raw RPM-normalized log2 fold-change for this amino-acid state or linked combination. Reference states are analyzed identically to every other state.", formula: "log₂[(RPM_<r>+p)/(RPM_<first>+p)]" },
        { name: "Centered_Enrichment_<r>_vs_<first>", summary: "Raw enrichment minus the median among score-eligible rows in the same target or linked-combination family.", formula: "Enrichment − median(eligible Enrichment)", notes: ["Centering changes the zero point but not ranking. Under severe selection, inspect the reported median because centering can over-correct."] },
      ],
    },
    {
      title: "Statistical inference",
      columns: [
        { name: "Z_Enrichment_<r>_vs_<first>", summary: "Wald z-statistic for the raw enrichment.", formula: "Z = Enrichment / SE; SE = (1/ln 2)·√[1/(Count_<r>+q_r)+1/(N_<r>+q_r)+1/(Count_<first>+q_0)+1/(N_<first>+q_0)], q_i=p×N_i/10⁶" },
        { name: "Pval_Enrichment_<r>_vs_<first>", summary: "Two-sided z-test p-value for raw enrichment.", formula: "P = 2·(1 − Φ(|Z|))" },
        { name: "FDR_q_<r>_vs_<first>", summary: "Benjamini-Hochberg q-value computed independently within each target, or across the linked-combination family.", notes: ["Reference and non-reference amino-acid states enter the same family with no special classification."] },
        { name: "Var_Enrichment_<r>_vs_<first>", summary: "Four-term Poisson delta-method variance used for inverse-variance weighting.", formula: "(1/ln 2)²·[1/(Count_<r>+q_r)+1/(N_<r>+q_r)+1/(Count_<first>+q_0)+1/(N_<first>+q_0)], q_i=p×N_i/10⁶" },
      ],
    },
  ],
  mlRecipe: {
    description: "The amino-acid matrices can feed downstream sequence or genotype models with count-aware weights.",
    inputColumn: "Target + Variant_AA for independent effects, or Combination_AA for linked multi-target genotypes.",
    targetColumn: "Centered_Enrichment_<lastRound>_vs_<firstRound>, centered within each target or the linked-combination family.",
    weightExpr: "1 / Var_Enrichment_<lastRound>_vs_<firstRound>; weak counts are automatically down-weighted.",
  },
  caveats: [
    "The selected pseudocount p is in RPM units and is used consistently in score and variance; q_i=p×callable_i/10⁶ is its count-scale equivalent for each library. Default p=0.5 RPM; p=1.0 RPM remains selectable.",
    "Without biological replicates, the four-term Poisson variance captures counting uncertainty only and usually underestimates total experimental uncertainty. Z, p and FDR must not be presented as replicate-aware evidence.",
    "Inference is blank when the Round 0 amino-acid count is below the locked threshold. Raw exact-codon and exact-combination counts are never removed by that threshold.",
    "Reference amino-acid states are ordinary rows and receive their own enrichment. No row is forced to zero by using it as a WT denominator.",
    "Protected-region substitutions and small indels are tolerated up to the locked QC limits. A systematic reference mismatch can therefore reduce yield and should be investigated from the QC funnel rather than reclassified as selection.",
    "Complete high-quality codons are counted without assuming how the researcher constructed the library. Stop codons remain explicitly flagged and are not silently discarded.",
  ],
};

// ============================================================================
// Text formatter (writes the methods section into QC_Summary_Report.txt)
// ============================================================================

/** Render a MethodsDocument as plain text, suitable for appending to the QC
 *  summary report. Layout matches the surrounding `=`-separator style.
 *
 *  @param doc           The static column documentation.
 *  @param runParams     Per-run parameters to include (settings the user
 *                       chose, library median values, etc.). All optional
 *                       — passing none still produces a useful column
 *                       reference, just without the run-specific lines.
 */
export interface MethodsRunParams {
  /** Settings the user picked for this run, formatted as key→value strings.
   *  E.g. `{ "Mean read Phred": "≥ 20.0", "Use WASM": "yes" }`. Rendered in
   *  insertion order. */
  settings?: ReadonlyArray<{ label: string; value: string }>;
  /** Library median values per round (or per site:round for Nanopore). */
  libraryMedian?: Record<string, number>;
  /** Hit counts per round at standard FDR thresholds. */
  hitCounts?: ReadonlyArray<{ label: string; q05: number; q01: number; total: number }>;
  /** Exact pseudocount used by this run. */
  pseudocount?: number;
}

export function formatMethodsAsText(
  doc: MethodsDocument,
  runParams: MethodsRunParams = {},
): string {
  const lines: string[] = [];
  const sep = "=".repeat(85);
  const sub = "-".repeat(85);

  lines.push(sep);
  lines.push(`                METHODS & COLUMN REFERENCE — ${doc.toolName}`);
  lines.push(sep);
  lines.push("");

  // --- Per-run parameters (if supplied) -----------------------------------
  if (runParams.settings && runParams.settings.length > 0) {
    lines.push("--- This run's settings ---");
    for (const s of runParams.settings) {
      lines.push(`  ${s.label.padEnd(32)}  ${s.value}`);
    }
    lines.push("");
  }

  // --- Headline method choices -------------------------------------------
  lines.push("--- Method choices ---");
  lines.push(`  Pseudocount (RPM)                 ${(runParams.pseudocount ?? doc.pseudocount).toFixed(2)}`);
  lines.push(`  p-value test                      ${doc.pvalueMethod}`);
  lines.push(`  Multiple-testing correction       ${doc.fdrMethod}`);
  lines.push(`  Centering scheme (tier-3 score)   ${doc.centeringMethod}`);
  lines.push("");

  if (runParams.libraryMedian && Object.keys(runParams.libraryMedian).length > 0) {
    lines.push("--- Library-wide median (diagnostic) ---");
    lines.push("  Values far from zero flag a systematic library-wide shift.");
    lines.push("  Strongly negative (< −1) flags the dropout regime where Centered_* over-corrects.");
    for (const [key, val] of Object.entries(runParams.libraryMedian)) {
      const warn = val < -1 || val > 1 ? "  ⚠ flagged" : "";
      lines.push(`  ${key.padEnd(60)}  ${val.toFixed(3)}${warn}`);
    }
    lines.push("");
  }

  if (runParams.hitCounts && runParams.hitCounts.length > 0) {
    lines.push("--- Hit counts at standard FDR thresholds ---");
    lines.push(`  ${"comparison".padEnd(40)}  ${"q<0.05".padStart(10)}  ${"q<0.01".padStart(10)}  ${"of total".padStart(10)}`);
    lines.push("  " + "-".repeat(75));
    for (const h of runParams.hitCounts) {
      lines.push(
        `  ${h.label.padEnd(40)}  ${h.q05.toString().padStart(10)}  ${h.q01.toString().padStart(10)}  ${h.total.toString().padStart(10)}`,
      );
    }
    lines.push("");
  }

  // --- Per-column documentation ------------------------------------------
  for (const section of doc.sections) {
    lines.push(`--- ${section.title} ---`);
    lines.push("");
    for (const col of section.columns) {
      lines.push(`  ${col.name}`);
      lines.push(`    ${col.summary}`);
      if (col.formula) {
        lines.push("");
        lines.push(`    Formula:  ${col.formula}`);
      }
      if (col.notes && col.notes.length > 0) {
        lines.push("");
        for (const note of col.notes) {
          lines.push(`    · ${note}`);
        }
      }
      lines.push("");
    }
  }

  // --- ML recipe ----------------------------------------------------------
  if (doc.mlRecipe) {
    lines.push("--- Using this CSV for machine learning ---");
    lines.push("");
    lines.push(`  ${doc.mlRecipe.description}`);
    lines.push("");
    lines.push(`  Input (X):   ${doc.mlRecipe.inputColumn}`);
    lines.push(`  Target (y):  ${doc.mlRecipe.targetColumn}`);
    lines.push(`  Weight (w):  ${doc.mlRecipe.weightExpr}`);
    if (doc.mlRecipe.snippet) {
      lines.push("");
      lines.push("  Example (pandas + ESM-2):");
      for (const line of doc.mlRecipe.snippet.split("\n")) {
        lines.push(`    ${line}`);
      }
    }
    lines.push("");
  }

  // --- Caveats ------------------------------------------------------------
  if (doc.caveats.length > 0) {
    lines.push("--- Caveats ---");
    lines.push("");
    for (const c of doc.caveats) {
      lines.push(`  · ${c}`);
    }
    lines.push("");
  }

  lines.push(sub);
  lines.push("End of methods reference.");
  lines.push("");

  return lines.join("\n");
}
