import type { AppSettings, AppView, ThemePreference } from "../types/app";
import { resolveAppLanguage } from "./languages";

const VIEWS: AppView[] = ["dashboard", "configuration", "models", "profiles", "performance", "logs", "apiDocs", "settings", "chat", "agentWorkspace"];

function params() { return new URLSearchParams(typeof window === "undefined" ? "" : window.location.search); }

/** Browser demo mode only: `?theme=&lang=` let screenshots and reviews pick presentation settings. */
export function demoUrlSettings(): Partial<AppSettings> {
  const q = params(), patch: Partial<AppSettings> = {};
  const theme = q.get("theme"), lang = q.get("lang");
  if (theme === "dark" || theme === "light" || theme === "system") patch.theme = theme as ThemePreference;
  const language = resolveAppLanguage(lang);
  if (language) patch.language = language;
  if (q.get("setup") === "done") patch.setupCompleted = true;
  return patch;
}

/** Browser demo mode only: `?view=` opens a screen directly. */
export function demoUrlView(): AppView | undefined {
  const view = params().get("view") as AppView | null;
  return view && VIEWS.includes(view) ? view : undefined;
}
