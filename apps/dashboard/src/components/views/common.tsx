"use client";

import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { describeError } from "@/lib/api/errors";
import type { Resource } from "@/lib/useResource";
import { Link } from "@/components/app/Link";
import { Button, EmptyState, Skeleton } from "@/components/ui";

export function PageHeader({
  title,
  eyebrow,
  children,
}: {
  title: ReactNode;
  eyebrow?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {eyebrow === undefined ? null : <div className="text-xs text-muted-fg">{eyebrow}</div>}
        <h1 className="font-display text-2xl font-semibold break-words">{title}</h1>
      </div>
      {children}
    </div>
  );
}

export function Breadcrumbs({ items }: { items: readonly { label: string; href?: string }[] }) {
  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex flex-wrap items-center gap-1 text-xs text-muted-fg">
        {items.map((item, i) => (
          <li key={`${item.label}-${String(i)}`} className="flex items-center gap-1">
            {i > 0 ? <ChevronRight aria-hidden className="size-3" /> : null}
            {item.href === undefined ? (
              <span aria-current="page">{item.label}</span>
            ) : (
              <Link className="underline hover:text-fg" href={item.href}>
                {item.label}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** Loading skeleton, error with retry, or the content once `resource` has data. */
export function Loaded<T>({
  resource,
  children,
  skeleton = "h-40",
}: {
  resource: Resource<T>;
  children: (data: T) => ReactNode;
  skeleton?: string;
}) {
  if (resource.data !== undefined) return <>{children(resource.data)}</>;
  if (resource.error !== null) {
    return (
      <EmptyState
        title="Could not load this"
        description={describeError(resource.error)}
        action={
          <Button size="sm" onClick={resource.reload}>
            Retry
          </Button>
        }
      />
    );
  }
  return (
    <div role="status" aria-label="Loading">
      <Skeleton className={`${skeleton} w-full rounded-3xl`} />
    </div>
  );
}

export function MissingParam({ what }: { what: string }) {
  return (
    <EmptyState
      title={`No ${what} selected`}
      description="Pick one from the runs list."
      action={
        <Link className="text-sm text-accent-fg underline" href="/">
          Go to runs
        </Link>
      }
    />
  );
}
