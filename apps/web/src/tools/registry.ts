// Central tool registry. Every analysis pipeline that ships in the app
// exports a Tool from its module and is listed here. The header switcher
// (App.tsx) renders one entry per tool in this array.

import { Dna, ScanLine } from "lucide-react";
import type { ToolRegistration } from "./types";

export const tools: ReadonlyArray<ToolRegistration> = [
  {
    id: "cdna-display",
    name: "RoundLens",
    shortName: "NGS",
    description:
      "Demultiplex + enrichment of cDNA/mRNA-display NGS selection rounds, streamed in-browser.",
    icon: Dna,
    load: () => import("./cdna-display").then((module) => module.cdnaDisplayTool),
  },
  {
    id: "nanopore-targeted",
    name: "RoundLens",
    shortName: "Nanopore",
    description:
      "Full-amplicon QC and Round 0-normalized enrichment for researcher-defined target codons.",
    icon: ScanLine,
    load: () => import("./nanopore-targeted").then((module) => module.nanoporeTool),
  },
];
export const DEFAULT_TOOL_ID = "cdna-display";

export function toolById(id: string): ToolRegistration {
  return tools.find((t) => t.id === id) ?? tools[0]!;
}
