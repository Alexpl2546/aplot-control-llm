// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createInstance } from "i18next";
import { APP_LANGUAGES, detectAppLanguage, isAppLanguage, nextAppLanguage, resolveAppLanguage } from "../src/lib/languages";
import { LOCALE_RESOURCES } from "../src/lib/localeCatalogs";
import { localeBackend } from "../src/lib/localeBackend";
import { demoUrlSettings } from "../src/lib/demoUrl";

function flatten(value: Record<string, unknown>, prefix = ""): Record<string, string> {
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof child === "object" && child !== null
      ? Object.entries(flatten(child as Record<string, unknown>, path))
      : [[path, child as string]];
  }));
}

const placeholders = (value: string) => [...value.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map(match => match[1]).sort();
const source = flatten(LOCALE_RESOURCES.en.translation);

describe("localization catalogs", () => {
  it.each(APP_LANGUAGES)("ships all strings and interpolation values for $nativeName", ({ code }) => {
    const catalog = flatten(LOCALE_RESOURCES[code].translation);
    expect(Object.keys(catalog).sort()).toEqual(Object.keys(source).sort());
    for (const [key, value] of Object.entries(catalog)) {
      expect(typeof value, `${code}:${key}`).toBe("string");
      expect(value.trim(), `${code}:${key}`).not.toBe("");
      expect(placeholders(value), `${code}:${key}`).toEqual(placeholders(source[key]));
      expect(value, `${code}:${key}`).not.toMatch(/APLOT\s*VAR|\[\[APLOT\d/);
    }
    if (code !== "en") {
      const translated = Object.keys(source).filter(key => catalog[key] !== source[key]);
      expect(translated.length / Object.keys(source).length).toBeGreaterThan(.75);
    }
  });

  it.each(APP_LANGUAGES)("renders native $code chat, settings and parameter labels without fallback", async ({ code }) => {
    const instance = createInstance();
    await instance.init({ resources: LOCALE_RESOURCES, lng: code, fallbackLng: false, interpolation: { escapeValue: false } });
    for (const key of ["chat.history", "chat.historySearch", "settings.language", "nav.dashboard", "smart.configure", "downloads.dialogTitle"]) {
      expect(instance.t(key)).toBe(flatten(LOCALE_RESOURCES[code].translation)[key]);
      expect(instance.t(key)).not.toBe(key);
    }
    expect(instance.t("language.switchTo", { language: "Deutsch" })).toContain("Deutsch");
    expect(instance.t("language.switchTo", { language: "Deutsch" })).not.toContain("{{");
  });

  it("loads a saved additional language before publishing the language change", async () => {
    const instance = createInstance();
    await instance.use(localeBackend).init({
      resources: { en: LOCALE_RESOURCES.en, ru: LOCALE_RESOURCES.ru },
      partialBundledLanguages: true,
      supportedLngs: APP_LANGUAGES.map(language => language.code),
      lng: "en",
      fallbackLng: "en",
    });
    expect(instance.hasResourceBundle("ja", "translation")).toBe(false);
    const published: string[] = [];
    instance.on("languageChanged", () => published.push(instance.t("chat.history")));
    const switching = instance.changeLanguage("ja");
    expect(instance.t("chat.history")).toBe(source["chat.history"]);
    await switching;
    expect(instance.hasResourceBundle("ja", "translation")).toBe(true);
    expect(instance.t("chat.history")).toBe(LOCALE_RESOURCES.ja.translation["chat.history"]);
    expect(published).toEqual([LOCALE_RESOURCES.ja.translation["chat.history"]]);
  });
});

describe("language choices", () => {
  it("normalizes supported regional browser locales", () => {
    expect(resolveAppLanguage("pt-BR")).toBe("pt");
    expect(resolveAppLanguage("zh-Hans-CN")).toBe("zh");
    expect(resolveAppLanguage(" DE_de ")).toBe("de");
    expect(resolveAppLanguage("unsupported")).toBeUndefined();
    expect(isAppLanguage("en-US")).toBe(false);
    expect(detectAppLanguage(["unsupported", "ja-JP", "en"])).toBe("ja");
    expect(detectAppLanguage([])).toBe("en");
  });

  it("cycles through every advertised language once", () => {
    const visited = new Set<string>();
    let current = APP_LANGUAGES[0].code;
    for (let index = 0; index < APP_LANGUAGES.length; index++) {
      visited.add(current);
      current = nextAppLanguage(current);
    }
    expect([...visited].sort()).toEqual(APP_LANGUAGES.map(language => language.code).sort());
    expect(current).toBe("en");
  });
});

describe("demo language selection", () => {
  afterEach(() => window.history.replaceState({}, "", "/"));

  it.each(APP_LANGUAGES)("accepts $code in the demo URL", ({ code }) => {
    window.history.replaceState({}, "", `/?lang=${code}`);
    expect(demoUrlSettings().language).toBe(code);
  });

  it("normalizes locale tags and ignores unsupported values", () => {
    window.history.replaceState({}, "", "/?lang=pt-BR");
    expect(demoUrlSettings().language).toBe("pt");
    window.history.replaceState({}, "", "/?lang=invalid");
    expect(demoUrlSettings().language).toBeUndefined();
  });
});
