"use client";

import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { THEME_STORAGE_KEY, type ResolvedTheme, type ThemePreference } from "./theme";

interface ThemeContextValue {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (next: ThemePreference) => void;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function subscribePreference(callback: () => void) {
  const handler = (e: StorageEvent) => {
    if (e.key === THEME_STORAGE_KEY) callback();
  };
  window.addEventListener("storage", handler);
  return () => {
    window.removeEventListener("storage", handler);
  };
}

function readPreference(): ThemePreference {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

function subscribeOS(callback: () => void) {
  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  mql.addEventListener("change", callback);
  return () => {
    mql.removeEventListener("change", callback);
  };
}

function readOS(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Light by default, `data-theme="dark"` on <html> (copied from bs-job-agents ThemeProvider). */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const preference = useSyncExternalStore(
    subscribePreference,
    readPreference,
    () => "system" as const,
  );
  const os = useSyncExternalStore(subscribeOS, readOS, () => "light" as const);
  const resolved: ResolvedTheme = preference === "system" ? os : preference;

  useLayoutEffect(() => {
    document.documentElement.setAttribute("data-theme", resolved);
    document.documentElement.style.colorScheme = resolved;
  }, [resolved]);

  const setPreference = useCallback((next: ThemePreference) => {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage blocked (private mode): the theme still applies for this page.
    }
    // `storage` only fires across tabs; notify this tab's subscribers too.
    window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY, newValue: next }));
  }, []);

  const toggle = useCallback(() => {
    setPreference(resolved === "dark" ? "light" : "dark");
  }, [resolved, setPreference]);

  const value = useMemo(
    () => ({ preference, resolved, setPreference, toggle }),
    [preference, resolved, setPreference, toggle],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}
