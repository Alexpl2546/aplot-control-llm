import type { AppLanguage } from "../types/app";

/** Keep language choices consistent in settings, onboarding and the shell. */
export const APP_LANGUAGES: readonly { code: AppLanguage; nativeName: string }[] = [
  { code: "en", nativeName: "English" },
  { code: "ru", nativeName: "Русский" },
  { code: "de", nativeName: "Deutsch" },
  { code: "fr", nativeName: "Français" },
  { code: "es", nativeName: "Español" },
  { code: "pt", nativeName: "Português" },
  { code: "it", nativeName: "Italiano" },
  { code: "zh", nativeName: "简体中文" },
  { code: "ja", nativeName: "日本語" },
  { code: "ko", nativeName: "한국어" },
];

export function isAppLanguage(value: unknown): value is AppLanguage {
  return typeof value === "string" && APP_LANGUAGES.some(language => language.code === value);
}

export function resolveAppLanguage(value: string | null | undefined): AppLanguage | undefined {
  const base = value?.trim().toLowerCase().split(/[-_]/)[0];
  return isAppLanguage(base) ? base : undefined;
}

export function detectAppLanguage(preferences: readonly string[]): AppLanguage {
  for (const language of preferences) {
    const supported = resolveAppLanguage(language);
    if (supported) return supported;
  }
  return "en";
}

export function nextAppLanguage(current: AppLanguage): AppLanguage {
  const index = APP_LANGUAGES.findIndex(language => language.code === current);
  return APP_LANGUAGES[(index + 1) % APP_LANGUAGES.length].code;
}

export function languageName(language: AppLanguage): string {
  return APP_LANGUAGES.find(candidate => candidate.code === language)?.nativeName ?? language;
}
