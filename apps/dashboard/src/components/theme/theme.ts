/** Theme preference storage (per viewer, per origin). The no-flash script reads the same key. */
export const THEME_STORAGE_KEY = "vtc_theme";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

/**
 * Runs before React hydrates so the theme is applied before first paint. Preference:
 * localStorage `vtc_theme` = "light" | "dark" | "system" (default).
 */
export const NO_FLASH_THEME_SCRIPT = `(function(){try{var p=localStorage.getItem('${THEME_STORAGE_KEY}')||'system';var d=p==='dark'||(p==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);var t=d?'dark':'light';document.documentElement.setAttribute('data-theme',t);document.documentElement.style.colorScheme=t;}catch(e){document.documentElement.setAttribute('data-theme','light');}})();`;
