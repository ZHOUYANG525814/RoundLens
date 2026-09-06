// Tool registration for the cDNA-DISPLAY pipeline. Bundles the step
// components + metadata into a Tool the app shell can render. The store
// (state/useRunStore.ts) currently mirrors this tool's state shape; when
// a second tool ships, that store will either generalize or split per-tool.

import { Dna } from "lucide-react";
import type { Tool } from "@/tools/types";
import { useRunStore } from "@/state/useRunStore";
import { SourcesStep } from "./steps/SourcesStep";
import { ConfigureStep } from "./steps/ConfigureStep";
import { RunStep } from "./steps/RunStep";
import { ResultsStep } from "./steps/ResultsStep";
import { initializeCdnaWorker, terminateCdnaWorker } from "@/worker/cdnaWorkerClient";
import { registerWorkerInitializer } from "@/lib/telemetry";

registerWorkerInitializer("cdna-display", initializeCdnaWorker);

export const cdnaDisplayTool: Tool = {
  id: "cdna-display",
  name: "RoundLens",
  shortName: "NGS",
  description:
    "Demultiplex + enrichment of cDNA/mRNA-display NGS selection rounds, streamed in-browser.",
  icon: Dna,
  steps: [
    { id: "inputs", label: "Inputs", blurb: "Rounds + FASTQs", Component: SourcesStep },
    { id: "design", label: "Design", blurb: "Reference + primers + CDS", Component: ConfigureStep },
    { id: "analyze", label: "Analyze", blurb: "Review + run", Component: RunStep },
    { id: "results", label: "Results", blurb: "Enrichment + QC", Component: ResultsStep },
  ],
  useCurrentStep: () => useRunStore((s) => s.currentStep),
  useSetStep: () => useRunStore((s) => s.setStep),
  useRunStatus: () => useRunStore((s) => s.status),
  isRunning: () => useRunStore.getState().status === "running",
  dispose: () => {
    terminateCdnaWorker();
    if (useRunStore.getState().status === "running") {
      useRunStore.getState().cancelRun();
      useRunStore.getState().appendLog({ text: "Cancelled because the tool was closed.", tag: "warning" });
    }
  },
};
