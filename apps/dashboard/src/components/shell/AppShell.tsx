"use client";

import { AlertTriangle, Workflow } from "lucide-react";
import type { ReactNode } from "react";
import { runTopic } from "@/lib/api/topics";
import { cn } from "@/lib/cn";
import { hrefs, type View } from "@/lib/router";
import { useEvidenceMode } from "@/lib/useEvidenceMode";
import { useResource } from "@/lib/useResource";
import type { Route } from "@/lib/useRoute";
import {
  contractsMismatch,
  useEngine,
  type ConnectionState,
} from "@/components/app/EngineProvider";
import { Link } from "@/components/app/Link";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { Badge } from "@/components/ui";
import type { Tone } from "@/lib/states";

const CONNECTION: Readonly<
  Record<ConnectionState["kind"], { label: string; tone: Tone; title: string }>
> = {
  starting: { label: "Starting", tone: "neutral", title: "Setting up the session" },
  connecting: {
    label: "Connecting",
    tone: "neutral",
    title: "Connecting to the engine's event stream",
  },
  live: { label: "Live", tone: "ok", title: "Following the engine's event stream" },
  reconnecting: {
    label: "Reconnecting",
    tone: "warn",
    title: "The event stream dropped; retrying",
  },
  closed: { label: "Offline", tone: "danger", title: "Not connected to the engine" },
  snapshot: {
    label: "Snapshot",
    tone: "brand",
    title: "Read-only view of the committed .vtc/ snapshot",
  },
  unauthorized: {
    label: "Session expired",
    tone: "danger",
    title: "Open the dashboard again with vtc dashboard",
  },
};

function NavLink({
  href,
  current,
  children,
}: {
  href: string;
  current: boolean;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={current ? "page" : undefined}
      className={cn(
        "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl px-3 text-sm transition",
        current
          ? "bg-surface-2 font-medium text-fg"
          : "text-muted-fg hover:bg-surface-2 hover:text-fg",
      )}
    >
      {children}
    </Link>
  );
}

const RUN_VIEWS: readonly View[] = [
  "run",
  "task",
  "feature",
  "escalations",
  "artifact",
  "design",
  "gates",
  "research",
  "lookback",
];

/** Upstream evidence mode: only the flow and Lookback, and no run id (D-by). */
function UpstreamRunNav({ run, view }: { run: string; view: View }) {
  return (
    <nav aria-label="Run" className="flex items-center gap-1 overflow-x-auto">
      <NavLink href={hrefs.run(run)} current={view === "run"}>
        Flow
      </NavLink>
      <NavLink href={hrefs.lookback(run)} current={view === "lookback"}>
        Lookback
      </NavLink>
    </nav>
  );
}

function RunNav({ run, view }: { run: string; view: View }) {
  const escalations = useResource(`shell-esc:${run}`, (c, s) => c.escalations(run, s), [
    runTopic(run, "escalations"),
  ]);
  const open = escalations.data?.escalations.filter((e) => e.answer === undefined).length ?? 0;
  return (
    <nav aria-label={`Run ${run}`} className="flex items-center gap-1 overflow-x-auto">
      <span className="hidden shrink-0 px-2 text-xs text-muted-fg sm:inline">Run {run}</span>
      <NavLink href={hrefs.run(run)} current={view === "run" || view === "task"}>
        Flow
      </NavLink>
      <NavLink href={hrefs.feature(run)} current={view === "feature"}>
        Feature
      </NavLink>
      <NavLink href={hrefs.gates(run)} current={view === "gates"}>
        Gates
      </NavLink>
      <NavLink href={hrefs.escalations(run)} current={view === "escalations"}>
        Escalations
        {open > 0 ? (
          <span
            className="rounded-full bg-danger px-1.5 text-[11px] leading-4 text-white tabular"
            aria-label={`${String(open)} open`}
          >
            {open}
          </span>
        ) : null}
      </NavLink>
      <NavLink href={hrefs.design(run)} current={view === "design"}>
        Design
      </NavLink>
      <NavLink href={hrefs.research(run)} current={view === "research"}>
        Research
      </NavLink>
      <NavLink href={hrefs.lookback(run)} current={view === "lookback"}>
        Lookback
      </NavLink>
    </nav>
  );
}

/** Header with navigation, the live/snapshot badge and the theme switch; banners; the page. */
export function AppShell({ route, children }: { route: Route; children: ReactNode }) {
  const { connection, health } = useEngine();
  const upstream = useEvidenceMode() === "upstream";
  const run = route.params.get("run");
  const conn = CONNECTION[connection.kind];
  const brand = (
    <>
      <span
        aria-hidden
        className="grid size-8 place-items-center rounded-xl bg-gradient-brand text-white shadow-glow"
      >
        <Workflow className="size-4" />
      </span>
      <span className="font-display text-base font-semibold">Flow Studio</span>
    </>
  );
  return (
    <div className="flex min-h-dvh flex-col">
      <a href="#main" className="skip-link rounded-xl bg-brand px-3 py-2 text-sm text-white">
        Skip to content
      </a>
      <header className="sticky top-0 z-30 border-b border-border/60 bg-bg/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
          {upstream ? (
            <span className="flex shrink-0 items-center gap-2 py-1 pr-2">{brand}</span>
          ) : (
            <Link
              href={hrefs.runs()}
              className="flex shrink-0 items-center gap-2 rounded-xl py-1 pr-2"
            >
              {brand}
            </Link>
          )}
          {upstream ? null : (
            <nav aria-label="Main" className="flex items-center gap-1">
              <NavLink href={hrefs.runs()} current={route.view === "runs"}>
                Runs
              </NavLink>
              <NavLink href={hrefs.usage()} current={route.view === "usage"}>
                Usage
              </NavLink>
              <NavLink href={hrefs.automation()} current={route.view === "automation"}>
                Automation
              </NavLink>
            </nav>
          )}
          <div className="ml-auto flex items-center gap-2">
            <Badge tone={conn.tone} title={conn.title} data-testid="connection">
              <span
                aria-hidden
                className={cn(
                  "size-1.5 rounded-full bg-current",
                  connection.kind === "live" && "animate-pulse",
                )}
              />
              {conn.label}
            </Badge>
            <ThemeToggle />
          </div>
          {run !== null && RUN_VIEWS.includes(route.view) ? (
            <div className="w-full border-t border-border/60 pt-1">
              {upstream ? (
                <UpstreamRunNav run={run} view={route.view} />
              ) : (
                <RunNav run={run} view={route.view} />
              )}
            </div>
          ) : null}
        </div>
      </header>
      {connection.kind === "unauthorized" ? (
        <p
          role="alert"
          className="mx-auto mt-3 flex w-full max-w-7xl items-center gap-2 px-4 text-sm text-danger"
        >
          <AlertTriangle aria-hidden className="size-4 shrink-0" />
          This dashboard session is not valid (it expires after 12 hours or when the engine
          restarts). Run <code className="font-mono">vtc dashboard</code> again.
        </p>
      ) : null}
      {contractsMismatch(health) ? (
        <p
          role="alert"
          className="mx-auto mt-3 flex w-full max-w-7xl items-center gap-2 px-4 text-sm text-warn-fg"
        >
          <AlertTriangle aria-hidden className="size-4 shrink-0" />
          The engine speaks contracts {health?.contracts_version}; this dashboard was built for a
          different major version. Some views may not load.
        </p>
      ) : null}
      <main
        id="main"
        tabIndex={-1}
        className="mx-auto w-full max-w-7xl flex-1 px-4 py-5 outline-none"
      >
        {children}
      </main>
    </div>
  );
}
