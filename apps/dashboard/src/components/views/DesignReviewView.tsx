"use client";

import { DESIGN_SCREENS_PATH, type DesignReviewCommentInput } from "@vtc/shared";
import { MapPin, MessageSquarePlus } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { ApiError, describeError } from "@/lib/api/errors";
import {
  buildReviewInput,
  designReviewsPath,
  designSelection,
  parsePins,
  parseScreens,
  pinsInView,
  prototypeFrameUrl,
  VIEWPORTS,
  type DesignPin,
  type DesignSelection,
  type DesignTheme,
} from "@/lib/design";
import { hrefs, navigate } from "@/lib/router";
import { useEvidenceMode } from "@/lib/useEvidenceMode";
import { useResource } from "@/lib/useResource";
import { useEngine } from "@/components/app/EngineProvider";
import { CommentForm, fieldClass, type CommentDraft } from "@/components/design/CommentForm";
import { Segmented } from "@/components/design/Controls";
import { PrototypeFrame, type DraftPin } from "@/components/design/PrototypeFrame";
import { Badge, Button, Card, CardDescription, CardTitle, EmptyState } from "@/components/ui";
import { Breadcrumbs, Loaded, MissingParam, PageHeader } from "./common";

const THEMES: readonly { value: DesignTheme; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** Reads an artifact as text; a file that does not exist yet reads as `null`. */
const readOptional = async (
  load: () => Promise<{ encoding: string; content: string }>,
): Promise<string | null> => {
  try {
    const a = await load();
    return a.encoding === "utf8" ? a.content : null;
  } catch (error) {
    if (error instanceof ApiError && error.code === "not_found") return null;
    throw error;
  }
};

const sameComment = (a: DesignReviewCommentInput, b: DesignReviewCommentInput): boolean =>
  a.screen === b.screen &&
  a.state === b.state &&
  a.viewport === b.viewport &&
  a.theme === b.theme &&
  a.x_pct === b.x_pct &&
  a.y_pct === b.y_pct &&
  a.comment === b.comment &&
  a.author === b.author;

function CommentList({ screen, pins }: { screen: string; pins: readonly DesignPin[] }) {
  const id = useId();
  return (
    <Card>
      <CardTitle id={id}>Comments on {screen}</CardTitle>
      <CardDescription className="mb-3">
        Every pin on this screen, with the state, width and theme it was made on.
      </CardDescription>
      {pins.length === 0 ? (
        <p className="text-sm text-muted-fg">No comments yet.</p>
      ) : (
        <ol aria-labelledby={id} className="space-y-2">
          {pins.map((p) => (
            <li key={p.n} className="flex gap-2 rounded-xl border border-border p-2 text-sm">
              <span
                aria-label={`Pin ${String(p.n)}`}
                className="grid size-6 shrink-0 place-items-center rounded-full bg-brand text-[11px] font-semibold text-white tabular"
              >
                {p.n}
              </span>
              <div className="min-w-0 space-y-1">
                <p className="break-words">{p.comment}</p>
                <p className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-fg">
                  <Badge>
                    {p.state} · {p.viewport} px · {p.theme}
                  </Badge>
                  <span className="tabular">
                    at {p.x_pct}%, {p.y_pct}%
                  </span>
                  {p.author === undefined ? null : <span>· {p.author}</span>}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

function Review({
  run,
  selection,
  prototypeUrl,
  screens,
  added,
  onAdded,
}: {
  run: string;
  selection: DesignSelection & { screen: NonNullable<DesignSelection["screen"]> };
  prototypeUrl: string | null;
  screens: readonly { id: string }[];
  /** Comments saved in this session (kept across screen switches). */
  added: readonly DesignReviewCommentInput[];
  onAdded: (input: DesignReviewCommentInput) => void;
}) {
  const { client } = useEngine();
  const { screen, state, viewport, theme } = selection;
  const reviewsPath = designReviewsPath(screen.id);
  const stored = useResource(`design-pins:${run}:${screen.id}`, (c, s) =>
    readOptional(() => c.artifact(run, reviewsPath, s)),
  );
  const [placing, setPlacing] = useState(false);
  // Evidence mode is read-only: no pin can be placed or posted (AD-27 rule 6).
  const readOnly = useEvidenceMode() !== "off";
  const [draft, setDraft] = useState<DraftPin | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  // Comments saved in this session stay visible even before the file is served back.
  const pins = useMemo(() => {
    const fromFile = stored.data == null ? [] : parsePins(stored.data);
    const extra = added.filter(
      (a) => a.screen === screen.id && !fromFile.some((p) => sameComment(p, a)),
    );
    return [...fromFile, ...extra.map((a, i) => ({ ...a, n: fromFile.length + i + 1 }))];
  }, [stored.data, added, screen.id]);

  const go = (next: {
    screen?: string;
    state?: string;
    viewport?: number;
    theme?: DesignTheme;
  }) => {
    // A new screen starts on its own first state.
    const target =
      next.screen === undefined
        ? { screen: screen.id, state, viewport, theme, ...next }
        : { screen: next.screen, viewport, theme };
    setDraft(null);
    setPlacing(false);
    setError(null);
    navigate(hrefs.design(run, target), { replace: true });
  };

  const submit = async (fields: CommentDraft) => {
    if (draft === null || readOnly) return;
    const built = buildReviewInput({
      screen: screen.id,
      state,
      viewport,
      theme,
      ...draft,
      ...fields,
    });
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await client.postDesignReview(built.input);
      onAdded(built.input);
      setSaved(`Saved to ${result.path}`);
      setDraft(null);
      setPlacing(false);
      stored.reload();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setSaving(false);
    }
  };

  const vp = VIEWPORTS.find((v) => v.width === viewport) ?? VIEWPORTS[2];
  const src =
    prototypeUrl === null ? null : prototypeFrameUrl(prototypeUrl, screen.route, state, theme);
  const screenSelect = useId();

  return (
    <div className="space-y-4">
      <Card className="space-y-3">
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
          <div className="min-w-[12rem]">
            <label
              htmlFor={screenSelect}
              className="mb-1 block text-[11px] font-medium text-muted-fg"
            >
              Screen
            </label>
            <select
              id={screenSelect}
              value={screen.id}
              onChange={(e) => {
                go({ screen: e.target.value });
              }}
              className={fieldClass}
            >
              {screens.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.id}
                </option>
              ))}
            </select>
          </div>
          <Segmented
            legend="State"
            options={screen.states.map((s) => ({ value: s, label: s }))}
            value={state}
            onChange={(s) => {
              go({ state: s });
            }}
          />
          <Segmented
            legend="Viewport"
            options={VIEWPORTS.map((v) => ({
              value: v.width,
              label: `${v.label} ${String(v.width)}`,
            }))}
            value={viewport}
            onChange={(w) => {
              go({ viewport: w });
            }}
          />
          <Segmented
            legend="Theme"
            options={THEMES}
            value={theme}
            onChange={(t) => {
              go({ theme: t });
            }}
          />
        </div>
        <p className="flex flex-wrap gap-x-2 text-xs text-muted-fg">
          <code className="font-mono">{screen.route}</code>
          {screen.reqs.length === 0 ? null : <span>Covers {screen.reqs.join(", ")}</span>}
        </p>
      </Card>

      {saved === null ? null : (
        <p role="status" className="text-sm text-ok">
          {saved}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-2">
          {src === null ? (
            <EmptyState
              title="No prototype is being served"
              description={
                prototypeUrl === null
                  ? "The engine serves .vtc/design/prototype/ from its own port while it runs. Comments can still be read below."
                  : "This screen's route does not resolve on the prototype origin."
              }
            />
          ) : (
            <>
              {readOnly ? null : (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant={placing ? "primary" : "secondary"}
                    aria-pressed={placing}
                    leftIcon={<MessageSquarePlus aria-hidden className="size-4" />}
                    onClick={() => {
                      setPlacing((p) => !p);
                      setSaved(null);
                    }}
                  >
                    Add comment
                  </Button>
                  <span className="text-xs text-muted-fg">
                    {placing
                      ? "Click the point the comment is about."
                      : "Turn this on, then click the frame to pin a comment."}
                  </span>
                </div>
              )}
              <PrototypeFrame
                src={src}
                title={`Prototype: ${screen.id}, state ${state}, ${String(viewport)} px, ${theme}`}
                width={vp.width}
                height={vp.height}
                pins={pinsInView(pins, selection)}
                draft={draft}
                placing={placing && draft === null && !readOnly}
                onPlace={(pin) => {
                  setDraft(pin);
                  setError(null);
                }}
              />
            </>
          )}
        </div>
        <div className="min-w-0 space-y-4">
          {draft === null || readOnly ? null : (
            <CommentForm
              pin={draft}
              saving={saving}
              error={error}
              onMove={setDraft}
              onSubmit={(fields) => {
                void submit(fields);
              }}
              onCancel={() => {
                setDraft(null);
                setError(null);
              }}
            />
          )}
          <Loaded resource={stored} skeleton="h-24">
            {() => <CommentList screen={screen.id} pins={pins} />}
          </Loaded>
        </div>
      </div>
    </div>
  );
}

/**
 * Design review (spec §17): the prototype with viewport, state and theme switchers, and
 * click-to-pin comments saved through `POST /api/design/reviews` (the dashboard's only write,
 * AD-5 rule 5). Approval still happens in the Lead chat.
 */
export function DesignReviewView({ run, params }: { run: string | null; params: URLSearchParams }) {
  const { health } = useEngine();
  const [added, setAdded] = useState<DesignReviewCommentInput[]>([]);
  const screensFile = useResource(run === null ? null : `design-screens:${run}`, (c, s) =>
    readOptional(() => c.artifact(run ?? "", DESIGN_SCREENS_PATH, s)),
  );
  if (run === null) return <MissingParam what="run" />;
  return (
    <>
      <Breadcrumbs
        items={[
          { label: "Runs", href: hrefs.runs() },
          { label: run, href: hrefs.run(run) },
          { label: "Design review" },
        ]}
      />
      <PageHeader title="Design review" eyebrow={`Run ${run}`}>
        <p className="flex max-w-sm items-center gap-1.5 text-xs text-muted-fg">
          <MapPin aria-hidden className="size-3.5 shrink-0" />
          Pins are saved to .vtc/design/reviews/. Approval still happens in the Lead chat.
        </p>
      </PageHeader>
      <Loaded resource={screensFile}>
        {(text) => {
          const parsed = text === null ? null : parseScreens(text);
          if (parsed === null || !parsed.ok || parsed.screens.length === 0) {
            return (
              <EmptyState
                title="No screens to review yet"
                description={
                  parsed === null
                    ? `The Designer lists screens in ${DESIGN_SCREENS_PATH} during DESIGN.`
                    : parsed.ok
                      ? `${DESIGN_SCREENS_PATH} lists no screen.`
                      : `${DESIGN_SCREENS_PATH} does not match the screens contract (${parsed.error}).`
                }
              />
            );
          }
          const selection = designSelection(params, parsed.screens);
          if (selection.screen === null) return null;
          return (
            <Review
              key={selection.screen.id}
              run={run}
              selection={{ ...selection, screen: selection.screen }}
              prototypeUrl={health?.prototype_url ?? null}
              screens={parsed.screens}
              added={added}
              onAdded={(input) => {
                setAdded((a) => [...a, input]);
              }}
            />
          );
        }}
      </Loaded>
    </>
  );
}
