import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { APP_LANGUAGES } from "./languages";
import { localeBackend } from "./localeBackend";
import commonEn from "../locales/en/common.json";
import konturEn from "../locales/en/kontur.json";
import downloadsEn from "../locales/en/modelDownloads.json";
import smartEn from "../locales/en/smartTasks.json";
import commonRu from "../locales/ru/common.json";
import konturRu from "../locales/ru/kontur.json";
import downloadsRu from "../locales/ru/modelDownloads.json";
import smartRu from "../locales/ru/smartTasks.json";

void i18n.use(localeBackend).use(initReactI18next).init({
  resources: {
    en: { translation: { ...commonEn, ...konturEn, ...downloadsEn, smart: smartEn } },
    ru: { translation: { ...commonRu, ...konturRu, ...downloadsRu, smart: smartRu } },
  },
  partialBundledLanguages: true,
  supportedLngs: APP_LANGUAGES.map(language => language.code),
  load: "languageOnly",
  lng: "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
  returnNull: false,
});
export default i18n;
