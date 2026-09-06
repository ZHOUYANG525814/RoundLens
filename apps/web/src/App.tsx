// App shell. Renders the active tool's stepper + active step, with a
// top-of-page tool switcher that routes between cDNA-DISPLAY and Nanopore
// (and any future sibling tools listed in tools/registry.ts).

import { useEffect, useRef, useState } from "react";
import { Stepper } from "@/components/Stepper";
import { useAppStore } from "@/state/useAppStore";
import { tools, toolById } from "@/tools/registry";
import type { Tool } from "@/tools/types";
import { recordTelemetry } from "@/lib/telemetry";
import { isMobileOrTablet, readDeviceSignals } from "@/lib/deviceSupport";

export function App() {
  const activeToolId = useAppStore((s) => s.activeToolId);
  const setActiveTool = useAppStore((s) => s.setActiveTool);
  const registration = toolById(activeToolId);
  const unsupportedDevice = isMobileOrTablet(readDeviceSignals());
  const [tool, setTool] = useState<Tool | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [homeRequest, setHomeRequest] = useState(0);
  // Mirror the active tool id onto <html data-tool="..."> so the per-tool CSS
  // variable overrides in index.css take effect. Any element under <html>
  // automatically picks up the swap — no per-component theming code needed.
  useEffect(() => {
    document.documentElement.dataset.tool = activeToolId;
  }, [activeToolId]);

  useEffect(() => {
    if (unsupportedDevice) return;
    let cancelled = false;
    setTool(null);
    setLoadError(null);
    const startedAt = performance.now();
    performance.mark(`tool:${registration.id}:import:start`);
    void registration.load().then(
      (loaded) => {
        if (cancelled) return;
        performance.mark(`tool:${registration.id}:import:end`);
        performance.measure(
          `tool:${registration.id}:import`,
          `tool:${registration.id}:import:start`,
          `tool:${registration.id}:import:end`,
        );
        window.dispatchEvent(new CustomEvent("cdna:tool-loaded", {
          detail: { toolId: registration.id, durationMs: performance.now() - startedAt },
        }));
        recordTelemetry({
          toolId: registration.id,
          phase: "tool-import",
          status: "ok",
          startedAt,
          durationMs: performance.now() - startedAt,
        });
        setTool(loaded);
      },
      (error: unknown) => {
        if (!cancelled) {
          recordTelemetry({
            toolId: registration.id,
            phase: "tool-import",
            status: "error",
            startedAt,
            durationMs: performance.now() - startedAt,
          });
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      },
    );
    return () => { cancelled = true; };
  }, [registration, unsupportedDevice]);

  // Logo click → jump back to the active tool's Inputs step. Keeps
  // the user's data intact — this is navigation, not a reset. Lets a user
  // who clicked too far quickly get back without hunting through the stepper.
  const confirmNavigation = () =>
    !tool?.isRunning?.() || window.confirm("An analysis is running. Cancel it and leave this tool?");
  const goHome = () => {
    if (!confirmNavigation()) return;
    if (tool?.isRunning?.()) tool.dispose?.();
    setHomeRequest((request) => request + 1);
  };
  const changeTool = (id: string) => {
    if (id !== activeToolId && confirmNavigation()) setActiveTool(id);
  };
  const Icon = registration.icon;

  if (unsupportedDevice) return <DesktopRequired />;

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4">
          <button
            type="button"
            onClick={goHome}
            className="group flex items-center gap-2 rounded-md px-1.5 py-0.5 transition hover:bg-muted/60"
            title="Back to first step"
          >
            {Icon ? <Icon className="h-5 w-5 text-primary transition group-hover:scale-110" /> : null}
            <h1 className="text-base font-semibold tracking-tight">{registration.name}</h1>
          </button>
          <div className="flex items-center gap-3">
            <ToolSwitcher activeId={activeToolId} onChange={changeTool} />
            <span className="hidden text-xs text-muted-foreground sm:inline">
              Browser-only · no upload
            </span>
          </div>
        </div>
      </header>

      {loadError ? (
        <main className="mx-auto max-w-7xl px-4 py-8 text-sm text-destructive">
          Could not load {registration.name}: {loadError}
        </main>
      ) : tool ? (
        <ToolRuntime key={tool.id} tool={tool} homeRequest={homeRequest} />
      ) : (
        <main className="mx-auto max-w-7xl px-4 py-8 text-sm text-muted-foreground">
          Loading {registration.name}…
        </main>
      )}

      <SiteFooter />
    </div>
  );
}

function ToolRuntime({ tool, homeRequest }: { tool: Tool; homeRequest: number }) {
  const currentStep = tool.useCurrentStep?.();
  const setStep = tool.useSetStep?.();
  const runStatus = tool.useRunStatus?.();
  const previousHomeRequest = useRef(homeRequest);
  useEffect(() => () => tool.dispose?.(), [tool]);
  useEffect(() => {
    if (previousHomeRequest.current !== homeRequest) {
      previousHomeRequest.current = homeRequest;
      if (setStep && tool.steps.length > 0) setStep(tool.steps[0]!.id);
    }
  }, [homeRequest, setStep, tool.steps]);
  useEffect(() => {
    if (runStatus !== "running") return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [runStatus]);
  const ActiveStep =
    tool.steps.find((step) => step.id === currentStep)?.Component ?? tool.steps[0]!.Component;
  return (
    <>
      <Stepper
        steps={tool.steps}
        {...(tool.useCurrentStep ? { useCurrentStep: tool.useCurrentStep } : {})}
        {...(tool.useSetStep ? { useSetStep: tool.useSetStep } : {})}
        {...(tool.useRunStatus ? { useRunStatus: tool.useRunStatus } : {})}
      />
      <main className="mx-auto max-w-7xl px-4 py-8">
        <ActiveStep />
      </main>
    </>
  );
}

function DesktopRequired() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6">
      <main className="w-full max-w-lg rounded-xl border bg-card p-8 text-center shadow-sm">
        <h1 className="text-xl font-semibold">Desktop browser required</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          This enrichment analysis tool runs only in a browser on a desktop or laptop computer.
          Phones and tablets are not supported because large local FASTQ analysis requires desktop-class memory and file handling.
        </p>
        <p className="mt-3 text-xs text-muted-foreground">
          Supported: current desktop Chrome/Chromium, Firefox, and Safari/WebKit.
        </p>
      </main>
    </div>
  );
}

function ToolSwitcher({
  activeId,
  onChange,
}: {
  activeId: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="inline-flex rounded-md border bg-muted/50 p-0.5 text-xs">
      {tools.map((t) => {
        const Icon = t.icon;
        const isActive = t.id === activeId;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onChange(t.id)}
            title={t.description}
            className={
              "inline-flex items-center gap-1.5 rounded px-2.5 py-1 transition-colors " +
              (isActive
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground")
            }
          >
            {Icon ? <Icon className="h-3.5 w-3.5" /> : null}
            <span className="font-medium">{t.shortName ?? t.name}</span>
          </button>
        );
      })}
    </div>
  );
}

function SiteFooter() {
  return (
    <footer className="border-t bg-muted/30">
      <div className="mx-auto max-w-6xl px-4 py-6 text-center text-xs text-muted-foreground">
        <div className="text-sm font-medium text-foreground">Zhouyang Zhou</div>
        <div className="mt-0.5">Nagoya University</div>
        <div className="mt-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
          <a
            href="https://molbiotech.wixsite.com/molbiotech"
            target="_blank"
            rel="noopener noreferrer"
            className="underline-offset-2 transition-colors hover:text-foreground hover:underline"
          >
            Lab website
          </a>
          <span aria-hidden="true">·</span>
          <a
            href="https://github.com/ZHOUYANG525814/RoundLens"
            target="_blank"
            rel="noopener noreferrer"
            className="underline-offset-2 transition-colors hover:text-foreground hover:underline"
          >
            Source on GitHub
          </a>
        </div>
      </div>
    </footer>
  );
}
