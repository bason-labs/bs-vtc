"use client";

import { isServableArtifactPath, LOOKBACK_REPO } from "@vtc/shared";
import { readEvidence } from "@/lib/evidence";
import { isReplayPath, readReplayResult } from "@/lib/replays";
import { readScorecard } from "@/lib/scorecards";
import { imageDataUrl, readVisualReport } from "@/lib/visual";
import { hrefs } from "@/lib/router";
import { useResource } from "@/lib/useResource";
import { EvidenceDocView } from "@/components/evidence/EvidenceView";
import { ReplayDetail } from "@/components/lookback/ReplayDetail";
import { ScorecardDetail } from "@/components/lookback/ScorecardDetail";
import { VisualReportView } from "@/components/visual/VisualReportView";
import { Card, EmptyState } from "@/components/ui";
import { Breadcrumbs, Loaded, MissingParam, PageHeader } from "./common";
import { REDACT } from "@/lib/redact";

function ArtifactText({ content }: { content: string }) {
  return (
    <pre
      className="max-h-[70vh] overflow-auto rounded-xl bg-surface-2 p-3 font-mono text-xs whitespace-pre-wrap"
      data-testid="artifact-text"
      {...REDACT}
    >
      {content}
    </pre>
  );
}

/**
 * One run artifact (spec, plan file, evidence bundle…), shown as text: the engine serves artifacts
 * as JSON so agent-written HTML never runs on this origin (AD-5 rule 10). Evidence bundles and
 * traceability reports (AD-18) are rendered as the REQ → test → result matrix, visual QA reports
 * (AD-24, at the path `VisualSummary.report` names) as the render matrix with axe results and
 * diffs, Lookback scorecards and replay results (with their grader) as such, raw JSON on demand. Screenshots and
 * diff images (raster only) are shown as images.
 */
export function ArtifactView({ run, path }: { run: string | null; path: string | null }) {
  const valid = run !== null && path !== null && isServableArtifactPath(path);
  const artifact = useResource(valid ? `artifact:${run}:${path}` : null, (c, s) =>
    c.artifact(run ?? "", path ?? "", s),
  );
  if (run === null || path === null) return <MissingParam what="artifact" />;
  return (
    <>
      <Breadcrumbs
        items={[
          { label: "Runs", href: hrefs.runs() },
          { label: run, href: hrefs.run(run) },
          { label: path },
        ]}
      />
      <PageHeader
        title={path.split("/").at(-1) ?? path}
        eyebrow={<code className="font-mono">{path}</code>}
      />
      {!valid ? (
        <EmptyState
          title="Not a run artifact"
          description="Only files under .vtc/ (never .vtc/state/) can be shown."
        />
      ) : (
        <Loaded resource={artifact}>
          {(a) => {
            const meta = (
              <p className="mb-2 text-xs text-muted-fg tabular">
                {a.media_type} · {a.size.toLocaleString("en-US")} bytes · sha256{" "}
                <span className="font-mono">{a.sha256.slice(0, 12)}</span>
              </p>
            );
            if (a.encoding !== "utf8") {
              const image = imageDataUrl(a);
              return (
                <Card>
                  {meta}
                  {image === null ? (
                    <p className="text-sm text-muted-fg">Binary file; not shown.</p>
                  ) : (
                    <img
                      src={image}
                      alt={path}
                      className="max-w-full rounded-xl border border-border bg-surface-2"
                    />
                  )}
                </Card>
              );
            }
            const text = <ArtifactText content={a.content} />;
            const evidence = readEvidence(a);
            const visual = evidence === null ? readVisualReport(a) : null;
            const scorecard = a.path.startsWith(`${LOOKBACK_REPO.scorecardsDir}/`)
              ? readScorecard(a)
              : null;
            const replay = isReplayPath(a.path) ? readReplayResult(a) : null;
            if (scorecard?.ok === true || replay?.ok === true) {
              return (
                <div className="space-y-4">
                  <Card>
                    {scorecard?.ok === true ? (
                      <ScorecardDetail scorecard={scorecard.value} />
                    ) : null}
                    {replay?.ok === true ? <ReplayDetail replay={replay.value} /> : null}
                  </Card>
                  <Card>
                    <details>
                      <summary className="cursor-pointer text-sm font-medium">Raw JSON</summary>
                      <div className="mt-2">
                        {meta}
                        {text}
                      </div>
                    </details>
                  </Card>
                </div>
              );
            }
            if (evidence === null && visual === null) {
              return (
                <Card>
                  {meta}
                  {text}
                </Card>
              );
            }
            return (
              <div className="space-y-4">
                {evidence === null ? null : <EvidenceDocView run={run} doc={evidence} />}
                {visual === null ? null : <VisualReportView run={run} report={visual} />}
                <Card>
                  <details>
                    <summary className="cursor-pointer text-sm font-medium">Raw JSON</summary>
                    <div className="mt-2">
                      {meta}
                      {text}
                    </div>
                  </details>
                </Card>
              </div>
            );
          }}
        </Loaded>
      )}
    </>
  );
}
