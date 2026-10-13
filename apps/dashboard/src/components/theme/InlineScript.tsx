"use client";

/**
 * Inline script that runs during HTML parsing (hard loads) and is inert when React renders it on
 * the client, which avoids React's "script tag" warning. Copied from bs-job-agents.
 */
export function InlineScript({ html }: { html: string }) {
  return (
    <script
      type={typeof window === "undefined" ? "text/javascript" : "text/plain"}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
