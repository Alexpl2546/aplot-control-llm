import type { BackendModule } from "i18next";

/** Each catalog is a local application chunk, loaded once when selected. */
const loaders = {
  de: () => import("../locales/de"),
  fr: () => import("../locales/fr"),
  es: () => import("../locales/es"),
  pt: () => import("../locales/pt"),
  it: () => import("../locales/it"),
  zh: () => import("../locales/zh"),
  ja: () => import("../locales/ja"),
  ko: () => import("../locales/ko"),
};

export const localeBackend: BackendModule = {
  type: "backend",
  init() {},
  read(language, _namespace, callback) {
    const load = loaders[language as keyof typeof loaders];
    if (!load) { callback(null, {}); return; }
    void load().then(module => callback(null, module.default)).catch(error => callback(error, false));
  },
};
