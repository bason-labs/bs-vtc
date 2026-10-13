"use client";

import { useId, useState, type SyntheticEvent } from "react";
import { DESIGN_REVIEW_MAX_BYTES } from "@vtc/shared";
import { Button } from "@/components/ui";
import type { DraftPin } from "./PrototypeFrame";

export const fieldClass =
  "w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent focus-visible:shadow-[var(--ring-focus)]";

export interface CommentDraft {
  readonly comment: string;
  readonly author: string;
}

/**
 * The draft pin's comment. The position fields let keyboard users place the pin without a
 * pointer (and fine-tune a click). `error` is the last refusal; the draft is kept on failure.
 */
export function CommentForm({
  pin,
  saving,
  error,
  onMove,
  onSubmit,
  onCancel,
}: {
  pin: DraftPin;
  saving: boolean;
  error: string | null;
  onMove: (pin: DraftPin) => void;
  onSubmit: (draft: CommentDraft) => void;
  onCancel: () => void;
}) {
  const [comment, setComment] = useState("");
  const [author, setAuthor] = useState("");
  const ids = { title: useId(), comment: useId(), author: useId(), x: useId(), y: useId() };
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    onSubmit({ comment, author });
  };
  const pct = (value: string): number => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0;
  };
  return (
    <form
      aria-labelledby={ids.title}
      onSubmit={submit}
      className="space-y-3 rounded-2xl border border-accent/50 bg-accent/5 p-3"
    >
      <h3 id={ids.title} className="text-sm font-semibold">
        New comment
      </h3>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label htmlFor={ids.x} className="text-[11px] text-muted-fg">
            Across (%)
          </label>
          <input
            id={ids.x}
            type="number"
            min={0}
            max={100}
            step={0.1}
            value={pin.x_pct}
            onChange={(e) => {
              onMove({ ...pin, x_pct: pct(e.target.value) });
            }}
            className={fieldClass}
          />
        </div>
        <div>
          <label htmlFor={ids.y} className="text-[11px] text-muted-fg">
            Down (%)
          </label>
          <input
            id={ids.y}
            type="number"
            min={0}
            max={100}
            step={0.1}
            value={pin.y_pct}
            onChange={(e) => {
              onMove({ ...pin, y_pct: pct(e.target.value) });
            }}
            className={fieldClass}
          />
        </div>
      </div>
      <div>
        <label htmlFor={ids.comment} className="text-[11px] text-muted-fg">
          Comment
        </label>
        <textarea
          id={ids.comment}
          rows={3}
          maxLength={2000}
          value={comment}
          onChange={(e) => {
            setComment(e.target.value);
          }}
          className={fieldClass}
        />
      </div>
      <div>
        <label htmlFor={ids.author} className="text-[11px] text-muted-fg">
          Your name (optional)
        </label>
        <input
          id={ids.author}
          maxLength={100}
          autoComplete="name"
          value={author}
          onChange={(e) => {
            setAuthor(e.target.value);
          }}
          className={fieldClass}
        />
      </div>
      {error === null ? null : (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" size="sm" loading={saving}>
          Save pin
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <span className="text-[11px] text-muted-fg">
          Appended to .vtc/design/reviews/ (at most {DESIGN_REVIEW_MAX_BYTES / 1024} KB).
        </span>
      </div>
    </form>
  );
}
