"use client";

import type { AnchorHTMLAttributes, MouseEvent } from "react";
import { navigate } from "@/lib/router";

/**
 * An in-app link: a real `<a href>` (open in new tab, copy link and keyboard all work), switched
 * client-side on a plain left click (AD-20 fixed pages, ids in the query string).
 */
export function Link({
  href,
  onClick,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const handle = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      (rest.target !== undefined && rest.target !== "_self")
    ) {
      return;
    }
    event.preventDefault();
    navigate(href);
  };
  return <a href={href} onClick={handle} {...rest} />;
}
