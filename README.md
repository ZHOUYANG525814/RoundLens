# RoundLens

Local browser analysis of multi-round peptide enrichment and targeted Nanopore data.

RoundLens provides two guided workflows: **NGS** for peptide counts and enrichment across selection rounds, and **Nanopore** for calls at predefined targets and linked states within individual reads. Both use **Inputs → Design → Analyze → Results**, with QC summaries and downloadable results.

- Open local FASTQ or FASTQ.gz files and organize them by selection round.
- Inspect filtering, accepted counts and callable populations alongside enrichment.
- Export CSV results, QC reports, Methods text and reusable configurations.
- Process reads locally in a desktop browser using Web Workers and WebAssembly. Optional Google Drive input retrieves user-authorized files.

[Open the application](https://roundlens-web.vercel.app/) · [Source code](https://github.com/ZHOUYANG525814/RoundLens)

## Supported workflows

**NGS:** multiplexed or round-separated short reads are filtered, translated and counted as peptides. The output includes normalized abundance and descriptive enrichment across rounds. Where paired reads need merging, merge them before import.

**Targeted Nanopore:** round-separated long reads are aligned to a reference and evaluated at configured targets. Target and linked-combination outputs retain their respective callable populations. This is a targeted analysis workflow; biological-replicate inference is outside the current scope.

## Naming and compatibility

RoundLens was previously named cDNA-DISPLAY Analyzer. The application name now covers both supported workflows. Existing `@cdna/*` workspace imports, saved-project schema identifiers and internal tool IDs are retained so existing configurations and development commands remain compatible. Historical evidence keeps its original names and checksums. The existing application URL remains valid.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  apps/web (React + Vite)  — browser shell, swappable                │
│  ┌─ UI ────────────┐  ┌─ Adapters ─────────┐  ┌─ Worker host ──┐    │
│  │ 5-step wizard   │  │ DriveAuthProvider  │  │ Comlink RPC →  │    │
│  │ (Sources →      │  │ DriveFastqSource   │  │ packages/core  │    │
│  │  Configure →    │  │ LocalFastqSource   │  │ in a Worker    │    │
│  │  Preview →      │  │ BrowserExporter    │  └────────────────┘    │
│  │  Run →          │  └────────────────────┘                        │
│  │  Results)       │                                                │
│  └─────────────────┘                                                │
└─────────────────────────────┬───────────────────────────────────────┘
                              │ (isomorphic, no DOM, no fetch)
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  packages/core   — runs unchanged in Worker OR Node                 │
│   IFastqSource → LineSplitter → Q-filter → Demultiplexer            │
│   ↓                                       (TS path; WASM hot path)  │
│   Counter accumulator (Map<DNA, count>) → Analyzer → CSV / JSON     │
└─────────────────────────────────────────────────────────────────────┘
```

The split is deliberate:

- **`packages/core`** is pure isomorphic TypeScript. No DOM, no `window`, no
  `fetch`. Runs in a browser Web Worker, in Node (for tests), or in a future
  server backend with zero changes.
- **`packages/core-wasm`** is a Rust crate compiled to WebAssembly. It owns
  the per-read scoring loop (the only meaningfully hot path).
- **`apps/web`** is the React shell: UI, adapters that talk to browser-only
  APIs (Drive, File, Blob), and the Worker host. None of this is in `core`.
- **`packages/types`** holds the interfaces (`IFastqSource`, `IAuthProvider`,
  `IExporter`) that let the browser today and a Node backend tomorrow plug
  into the same algorithm.

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Hot path | **Rust → WebAssembly** | Cross-browser performance floor (V8 happens to JIT TS scoring well; SpiderMonkey/JavaScriptCore don't). Linear memory dodges GC pauses on big libraries. |
| Worker | Web Worker + **Comlink** | Pipeline never blocks the main thread; clean async over `postMessage`. |
| Streaming | Native **Web Streams** | `file.stream()` and `fetch().body` are `ReadableStream<Uint8Array>` — no buffering, backpressure-aware. |
| Drive | **Drive API v3** + **Picker API** + **GIS** | `drive.file` scope = per-file consent, no app verification needed. |
| UI | React + Tailwind + shadcn primitives | Light theme; bioinformatics-feel, not desktop port. |
| State | Zustand with granular selectors | Progress fires ~60–120×/sec during a run; selectors keep React out of the way. |
| Build | Vite + pnpm workspaces | Native ESM, zero-config Worker bundling. |

## Correctness — byte-for-byte parity with a Python reference

The project's hard requirement is that the browser output match the maintained
desktop Python reference **byte-for-byte** for both supported pseudocounts. The
[`test/parity.test.ts`](./packages/core/test/parity.test.ts) suite runs the
TypeScript pipeline (both pure-TS and WASM scoring paths) on a 1,000-read
synthetic fixture and asserts:

- `run_stats.json` is identical to the Python output (sort_keys=True, indent=2,
  same key order)
- `Master_Enrichment_Matrix.csv` matches bit-for-bit (pandas defaults: integer
  floats with `.0` suffix, `True`/`False` not `1`/`0`, `NaN` as empty, stable
  sort with `Peptide_Seq` tiebreaker)
- Numeric: the RPM+p ratio and unit-consistent four-term variance match for
  both `p=0.5 RPM` and `p=1.0 RPM`

```bash
$ pnpm --filter @cdna/core test parity
✓ p=0.5: TS and WASM paths match the Python CSV/JSON golden
✓ p=1.0: TS and WASM paths match the Python CSV/JSON golden
```

The fixture itself is synthetic — see
[`packages/core/test/fixtures/generate.py`](./packages/core/test/fixtures/generate.py)
for the seeded generator that produces both the FASTQ and the primer config.
Real lab data is not in this repo.

## Performance

The WASM hot path went through three iterations. Measured on a 50,000-read
sample under Node 24, 3 trials median:

| Iteration | TS end-to-end | WASM end-to-end | Speedup |
|---|---|---|---|
| Phase 2: WASM returns a `Vec<f64>` per call | 316 ms | 337 ms | **0.94× (slower!)** |
| Phase 2.5: WASM returns a `Float64Array` view aliasing linear memory | 320 ms | 293 ms | **1.08–1.18×** |

The first iteration was an honest negative result — V8 JIT-compiles the TS
byte-comparison loop about as well as `wasm-pack --release` does, and the
per-call boundary overhead (a `Vec<f64>` malloc + a slice copy) wiped out
any execution advantage. The fix was to put a `[f64; 4]` field inside the
Rust `Scorer` struct and hand JS a `Float64Array::view()` aliasing it — no
allocation, no copy. That moved the boundary cost below the per-record
scoring cost and crossed WASM over to faster than TS.

Other improvements that came out of the perf review:

- **Per-RC scratch buffer** in `pipeline.ts` — was allocating a new
  `Uint8Array(150)` for every read that needed an antisense retry (~30–50% of
  reads). Now reuses a grow-on-demand buffer.
- **Bounded CSV parse** in the results UI — was `csv.split("\n")` on the whole
  matrix to take the top-20 rows. Now walks via `indexOf("\n")` to the 21st
  newline. ~50–200ms saved on multi-MB CSVs.
- **Blob-instead-of-string transfer** from worker → main thread. CSV no longer
  deep-copies through `postMessage`; Blob crosses by reference.
- **Granular Zustand selectors** in the run screen, plus an isolated
  `<LogViewer />` that doesn't re-render on progress ticks.

## Repo layout

```
web/
├── apps/web/                 # React shell + browser adapters
│   ├── src/
│   │   ├── App.tsx
│   │   ├── adapters/         # Local / Drive sources, GIS auth, exporter
│   │   ├── worker/           # Comlink-exposed pipeline.worker.ts
│   │   ├── state/            # Zustand store
│   │   └── tools/            # Per-tool modules
│   │       ├── cdna-display/         # Primer-demultiplexed cDNA pipeline
│   │       ├── nanopore-ssm/         # Retained legacy implementation/tests
│   │       └── nanopore-targeted/    # Unified Nanopore UI + full-amplicon core
│   └── test/                 # Browser-side smoke tests
├── packages/
│   ├── core/                 # Pure isomorphic pipeline
│   │   ├── src/{dna,fastq,demultiplex,analyzer,pipeline,wasm}.ts
│   │   └── test/             # Unit + parity tests, fixtures, bench
│   ├── core-wasm/            # Rust crate → WASM
│   │   └── src/lib.rs        # Scorer + reverse_complement + mean_phred
│   └── types/                # IFastqSource, IAuthProvider, ...
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── README.md
```

## Develop

Requires Node 20+ and pnpm. The Rust toolchain (for `core-wasm`) is only
needed if you actually want to rebuild the WASM — the compiled artifact is
checked in via the build cache.

```bash
pnpm i
pnpm -r build       # build all packages (incl. WASM via wasm-pack)
pnpm -r test        # run the existing unit and parity suites
pnpm dev            # http://localhost:5173
```

To exercise the Drive flow locally:

1. Set up a Google Cloud project with the Drive API and Picker API enabled.
2. Copy `apps/web/.env.example` to `apps/web/.env.local` and fill in
   `VITE_GOOGLE_CLIENT_ID` + `VITE_GOOGLE_API_KEY`.
3. Add yourself as a test user on the OAuth consent screen.

The local-files flow needs no setup.

## Status

RoundLens exposes NGS and targeted Nanopore workflows. The Nanopore
workflow supports both small-site SSM and multi-codon targeted NNK libraries
through the full-amplicon core; see its
[processing contract](./docs/NANOPORE_TARGETED_WEB_MODE.md) and the original
[architecture audit](./docs/NANOPORE_MTG_INITIAL_AUDIT.md).
