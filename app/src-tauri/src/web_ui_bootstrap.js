function initializeWebUi(origin, apiKey) {
  // Run before the bundled llama.cpp UI reads settings. Never seed other origins.
  if (location.origin !== origin || window.top !== window) return;
  const keys = ["LlamaUi.config", "LlamaCppWebui.config"];
  let fallback = {};
  for (const key of keys) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || "null");
      if (value && typeof value === "object" && !Array.isArray(value)) {
        fallback = value;
        break;
      }
    } catch { /* A damaged settings record must not prevent authentication. */ }
  }
  for (const key of keys) {
    let config = { ...fallback };
    try {
      const value = JSON.parse(localStorage.getItem(key) || "null");
      if (value && typeof value === "object" && !Array.isArray(value)) config = value;
    } catch { /* Preserve valid legacy settings when migrating a damaged record. */ }
    // Empty keys deliberately clear a credential left by a previous run on this port.
    config.apiKey = apiKey;
    localStorage.setItem(key, JSON.stringify(config));
  }
}
