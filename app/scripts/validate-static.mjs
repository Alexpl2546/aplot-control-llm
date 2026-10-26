import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = p => fs.readFileSync(path.join(root, p), "utf8");
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]
);

const flatten = (value, prefix) => Object.fromEntries(Object.entries(value).flatMap(([key, child]) => typeof child === "object" && child !== null
  ? Object.entries(flatten(child, `${prefix}.${key}`)) : [[`${prefix}.${key}`, child]]));
const en = { ...JSON.parse(read("src/locales/en/common.json")), ...JSON.parse(read("src/locales/en/kontur.json")), ...JSON.parse(read("src/locales/en/modelDownloads.json")), ...flatten(JSON.parse(read("src/locales/en/smartTasks.json")), "smart") };
const ru = { ...JSON.parse(read("src/locales/ru/common.json")), ...JSON.parse(read("src/locales/ru/kontur.json")), ...JSON.parse(read("src/locales/ru/modelDownloads.json")), ...flatten(JSON.parse(read("src/locales/ru/smartTasks.json")), "smart") };
const enKeys = Object.keys(en).sort();
const ruKeys = Object.keys(ru).sort();
if (JSON.stringify(enKeys) !== JSON.stringify(ruKeys)) {
  throw new Error(`i18n mismatch: EN-only=${enKeys.filter(k => !(k in ru))}; RU-only=${ruKeys.filter(k => !(k in en))}`);
}
const languageType = read("src/types/app.ts").match(/export type AppLanguage\s*=\s*([^;]+);/)?.[1];
if (!languageType) throw new Error("AppLanguage type was not found.");
const languages = [...languageType.matchAll(/["']([a-z]+)["']/g)].map(match => match[1]);
const placeholders = value => [...value.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map(match => match[1]).sort();
for (const language of languages) {
  const catalog = { ...JSON.parse(read(`src/locales/${language}/common.json`)), ...JSON.parse(read(`src/locales/${language}/kontur.json`)), ...JSON.parse(read(`src/locales/${language}/modelDownloads.json`)), ...flatten(JSON.parse(read(`src/locales/${language}/smartTasks.json`)), "smart") };
  if (JSON.stringify(Object.keys(catalog).sort()) !== JSON.stringify(enKeys)) throw new Error(`i18n key mismatch: ${language}`);
  for (const key of enKeys) {
    if (typeof catalog[key] !== "string" || !catalog[key].trim()) throw new Error(`Empty translation: ${language}:${key}`);
    if (JSON.stringify(placeholders(catalog[key])) !== JSON.stringify(placeholders(en[key]))) throw new Error(`i18n interpolation mismatch: ${language}:${key}`);
    if (/APLOT\s*VAR|\[\[APLOT\d/.test(catalog[key])) throw new Error(`Unresolved translation marker: ${language}:${key}`);
  }
}
if (!/public Hugging Face.*GGUF/i.test(en["downloads.dialogHelp"])
  || !/private or gated repositories are not supported/i.test(en["downloads.dialogHelp"])) {
  throw new Error("English model-download help must limit the UI to public Hugging Face GGUF repositories.");
}
if (!/публичн.*Hugging Face.*GGUF/i.test(ru["downloads.dialogHelp"])
  || !/закрытые и gated-репозитории не поддерживаются/i.test(ru["downloads.dialogHelp"])) {
  throw new Error("Russian model-download help must limit the UI to public Hugging Face GGUF repositories.");
}

const sourceFiles = walk(path.join(root, "src")).filter(file => /\.(ts|tsx)$/.test(file));
const source = sourceFiles.map(file => fs.readFileSync(file, "utf8")).join("\n");
const usedTranslations = [...source.matchAll(/\bt\(["']([^"']+)["']/g)]
  .map(match => match[1])
  .filter(key => !key.includes("${"));
const missingTranslations = [...new Set(usedTranslations.filter(key => !(key in en)))];
if (missingTranslations.length) throw new Error(`Missing translations: ${missingTranslations.join(", ")}`);

// Validate every literal frontend Tauri invoke, regardless of which service file owns it.
const invokes = [...source.matchAll(/\binvoke(?:<[^>]+>)?\(["']([^"']+)["']/g)].map(match => match[1]);
const rust = read("src-tauri/src/lib.rs");
const handlerBlock = rust.match(/tauri::generate_handler!\[([\s\S]*?)\]\)/)?.[1] ?? "";
const handlers = handlerBlock
  .split(",")
  .map(item => item.trim())
  .filter(Boolean)
  .map(item => item.includes("::") ? item.split("::").pop() : item)
  .filter(Boolean);
const missingHandlers = [...new Set(invokes.filter(command => !handlers.includes(command)))];
if (missingHandlers.length) throw new Error(`Tauri invokes missing handlers: ${missingHandlers.join(", ")}`);

const supportedEngineIds = ["llama_cpp", "strata"];
const engineType = read("src/types/app.ts").match(/export type ServerEngine\s*=\s*([^;]+);/)?.[1];
if (!engineType) throw new Error("ServerEngine type was not found in src/types/app.ts");
const sourceEngineIds = [...engineType.matchAll(/["']([a-z_]+)["']/g)].map(match => match[1]).sort();
if (JSON.stringify(sourceEngineIds) !== JSON.stringify([...supportedEngineIds].sort())) {
  throw new Error(`ServerEngine must contain only ${supportedEngineIds.join(" and ")}: ${sourceEngineIds}`);
}

const componentCatalog = JSON.parse(read("src-tauri/installer/components.json"));
const installerEngineIds = componentCatalog.components.filter(row => row.kind === "engine").map(row => row.id).sort();
if (JSON.stringify(installerEngineIds) !== JSON.stringify([...supportedEngineIds].sort())) {
  throw new Error(`Installer engine catalog must contain only ${supportedEngineIds.join(" and ")}: ${installerEngineIds}`);
}
const requiredAgents = ["claude", "codex", "hermes"];
const installerAgentIds = componentCatalog.components.filter(row => row.kind === "agent").map(row => row.id).sort();
if (JSON.stringify(installerAgentIds) !== JSON.stringify(requiredAgents)) {
  throw new Error(`Installer agent choices changed unexpectedly: ${installerAgentIds}`);
}

const packageMetadata = JSON.parse(read("package.json"));
const packageLock = JSON.parse(read("package-lock.json"));
const lockRoot = packageLock.packages?.[""];
const cargoMetadata = read("src-tauri/Cargo.toml");
const cargoVersion = cargoMetadata.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const cargoDescription = cargoMetadata.match(/^description\s*=\s*"([^"]+)"/m)?.[1];
const tauriMetadata = JSON.parse(read("src-tauri/tauri.conf.json"));
if (!lockRoot
  || packageLock.name !== packageMetadata.name
  || lockRoot.name !== packageMetadata.name
  || packageLock.version !== packageMetadata.version
  || lockRoot.version !== packageMetadata.version
  || cargoVersion !== packageMetadata.version
  || tauriMetadata.version !== packageMetadata.version) {
  throw new Error("Package, lockfile, Cargo, and Tauri root name/version metadata must stay synchronized.");
}
const productDescriptions = [
  ["package.json", packageMetadata.description],
  ["src-tauri/Cargo.toml", cargoDescription],
];
for (const [sourceName, description] of productDescriptions) {
  if (!description
    || !description.includes("llama.cpp")
    || !description.includes("Strata")
    || /Ollama|QwFNfer/i.test(description)) {
    throw new Error(`${sourceName} description must identify only the supported llama.cpp and Strata engines.`);
  }
}

console.log(`OK: ${enKeys.length} translation keys across ${languages.length} languages; ${new Set(usedTranslations).size} referenced static t() keys; ${new Set(invokes).size} frontend invoke commands; ${new Set(handlers).size} Rust handlers; two local engines; three installer agents.`);
