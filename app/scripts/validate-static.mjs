import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = p => fs.readFileSync(path.join(root, p), "utf8");
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]
);

const en = JSON.parse(read("src/locales/en/common.json"));
const ru = JSON.parse(read("src/locales/ru/common.json"));
const enKeys = Object.keys(en).sort();
const ruKeys = Object.keys(ru).sort();
if (JSON.stringify(enKeys) !== JSON.stringify(ruKeys)) {
  throw new Error(`i18n mismatch: EN-only=${enKeys.filter(k => !(k in ru))}; RU-only=${ruKeys.filter(k => !(k in en))}`);
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

console.log(`OK: ${enKeys.length} translation keys; ${new Set(usedTranslations).size} referenced static t() keys; ${new Set(invokes).size} frontend invoke commands; ${new Set(handlers).size} Rust handlers.`);
