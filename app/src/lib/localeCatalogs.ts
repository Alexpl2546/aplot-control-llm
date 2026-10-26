import type { AppLanguage } from "../types/app";
import common_en from "../locales/en/common.json";
import kontur_en from "../locales/en/kontur.json";
import downloads_en from "../locales/en/modelDownloads.json";
import smart_en from "../locales/en/smartTasks.json";
import common_ru from "../locales/ru/common.json";
import kontur_ru from "../locales/ru/kontur.json";
import downloads_ru from "../locales/ru/modelDownloads.json";
import smart_ru from "../locales/ru/smartTasks.json";
import common_de from "../locales/de/common.json";
import kontur_de from "../locales/de/kontur.json";
import downloads_de from "../locales/de/modelDownloads.json";
import smart_de from "../locales/de/smartTasks.json";
import common_fr from "../locales/fr/common.json";
import kontur_fr from "../locales/fr/kontur.json";
import downloads_fr from "../locales/fr/modelDownloads.json";
import smart_fr from "../locales/fr/smartTasks.json";
import common_es from "../locales/es/common.json";
import kontur_es from "../locales/es/kontur.json";
import downloads_es from "../locales/es/modelDownloads.json";
import smart_es from "../locales/es/smartTasks.json";
import common_pt from "../locales/pt/common.json";
import kontur_pt from "../locales/pt/kontur.json";
import downloads_pt from "../locales/pt/modelDownloads.json";
import smart_pt from "../locales/pt/smartTasks.json";
import common_it from "../locales/it/common.json";
import kontur_it from "../locales/it/kontur.json";
import downloads_it from "../locales/it/modelDownloads.json";
import smart_it from "../locales/it/smartTasks.json";
import common_zh from "../locales/zh/common.json";
import kontur_zh from "../locales/zh/kontur.json";
import downloads_zh from "../locales/zh/modelDownloads.json";
import smart_zh from "../locales/zh/smartTasks.json";
import common_ja from "../locales/ja/common.json";
import kontur_ja from "../locales/ja/kontur.json";
import downloads_ja from "../locales/ja/modelDownloads.json";
import smart_ja from "../locales/ja/smartTasks.json";
import common_ko from "../locales/ko/common.json";
import kontur_ko from "../locales/ko/kontur.json";
import downloads_ko from "../locales/ko/modelDownloads.json";
import smart_ko from "../locales/ko/smartTasks.json";

/** Complete resources for validation and tests; production loads extra locales through localeBackend. */
export const LOCALE_RESOURCES = {
  en: { translation: { ...common_en, ...kontur_en, ...downloads_en, smart: smart_en } },
  ru: { translation: { ...common_ru, ...kontur_ru, ...downloads_ru, smart: smart_ru } },
  de: { translation: { ...common_de, ...kontur_de, ...downloads_de, smart: smart_de } },
  fr: { translation: { ...common_fr, ...kontur_fr, ...downloads_fr, smart: smart_fr } },
  es: { translation: { ...common_es, ...kontur_es, ...downloads_es, smart: smart_es } },
  pt: { translation: { ...common_pt, ...kontur_pt, ...downloads_pt, smart: smart_pt } },
  it: { translation: { ...common_it, ...kontur_it, ...downloads_it, smart: smart_it } },
  zh: { translation: { ...common_zh, ...kontur_zh, ...downloads_zh, smart: smart_zh } },
  ja: { translation: { ...common_ja, ...kontur_ja, ...downloads_ja, smart: smart_ja } },
  ko: { translation: { ...common_ko, ...kontur_ko, ...downloads_ko, smart: smart_ko } },
} satisfies Record<AppLanguage, { translation: Record<string, unknown> }>;
