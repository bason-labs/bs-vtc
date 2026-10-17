"use client";

import { ImageIcon } from "lucide-react";
import { isServableArtifactPath } from "@vtc/shared";
import { cn } from "@/lib/cn";
import { hrefs } from "@/lib/router";
import { useResource } from "@/lib/useResource";
import { imageDataUrl } from "@/lib/visual";
import { Link } from "@/components/app/Link";

/**
 * A screenshot or diff image from the artifacts route, shown inline as a `data:` URL (raster
 * images only, never SVG); while it loads, or when it is not an image, a link to the artifact.
 */
export function ArtifactImage({
  run,
  path,
  alt,
  className,
}: {
  run: string;
  path: string;
  alt: string;
  className?: string;
}) {
  const ok = isServableArtifactPath(path);
  const artifact = useResource(ok ? `artifact:${run}:${path}` : null, (c, s) =>
    c.artifact(run, path, s),
  );
  const url = artifact.data === undefined ? null : imageDataUrl(artifact.data);
  if (url !== null) {
    return (
      <Link href={hrefs.artifact(run, path)} className="block">
        <img
          src={url}
          alt={alt}
          className={cn("w-full rounded-xl border border-border bg-surface-2", className)}
        />
      </Link>
    );
  }
  return (
    <Link
      href={hrefs.artifact(run, path)}
      className="inline-flex items-center gap-1 text-xs break-all text-accent-fg underline"
    >
      <ImageIcon aria-hidden className="size-3.5 shrink-0" />
      {artifact.loading ? `Loading ${alt}…` : alt}
    </Link>
  );
}
