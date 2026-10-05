import { useTranslation } from "react-i18next";

const copy = {
  ru: {
    workspace: "Рабочее пространство", overview: "Обзор системы", overviewHint: "Ваши модели, ресурсы и инференс — под контролем.",
    navigation: "Управление", tools: "Инструменты", local: "Локальный инференс", search: "Перейти к разделу…", searchHint: "Найти раздел или действие",
    noResults: "Ничего не найдено. Попробуйте другой запрос.", navigate: "выбор", open: "открыть", close: "закрыть", section: "Разделы", theme: "Сменить тему",
    light: "Светлая тема", dark: "Тёмная тема", monitoring: "Мониторинг", live: "В реальном времени", demo: "Демонстрационные данные",
    skip: "Перейти к содержимому", backTop: "Вернуться наверх", engine: "Движок", localHint: "Вычисления на вашем устройстве",
  },
  en: {
    workspace: "Workspace", overview: "System overview", overviewHint: "Your models, resources and inference. In control.",
    navigation: "Workspace", tools: "Tools", local: "Local inference", search: "Jump to a section…", searchHint: "Find a section or action",
    noResults: "No results. Try a different search.", navigate: "navigate", open: "open", close: "close", section: "Sections", theme: "Switch theme",
    light: "Light theme", dark: "Dark theme", monitoring: "Monitoring", live: "Live telemetry", demo: "Demonstration data",
    skip: "Skip to content", backTop: "Back to top", engine: "Engine", localHint: "Powered by your own hardware",
  },
};

export function useStudioCopy() {
  const { i18n } = useTranslation();
  return copy[i18n.language.startsWith("ru") ? "ru" : "en"];
}
