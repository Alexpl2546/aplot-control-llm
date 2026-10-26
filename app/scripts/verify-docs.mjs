import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const docsRoot = path.join(appRoot, "docs");
const requiredPages = [
  "README.md",
  "overview.md",
  "architecture.md",
  "code-map.md",
  "learning-path.md",
  "troubleshooting.md",
  "ipc.md",
  "benchmarks.md",
  "configuration.md",
  "modules/connections.md",
  "modules/harnesses.md",
  "modules/model-downloads.md",
];
function allMarkdownPages(directory, prefix = "") {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? allMarkdownPages(path.join(directory, entry.name), relative)
      : entry.name.endsWith(".md") ? [relative] : [];
  });
}
const pageIds = [...new Set([...requiredPages, ...allMarkdownPages(path.join(docsRoot, "ru")), ...allMarkdownPages(path.join(docsRoot, "en"))])].sort();

function readDoc(language, page) {
  const fullPath = path.join(docsRoot, language, page);
  if (!fs.existsSync(fullPath)) throw new Error(`Missing ${language} documentation page: ${page}`);
  return { fullPath, source: fs.readFileSync(fullPath, "utf8") };
}

function headings(source) {
  return [...source.matchAll(/^\s*(#{1,6})\s+.+$/gm)].map(match => match[1].length);
}

function anchors(source) {
  return [...source.matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1]);
}

function markdownLinks(source) {
  return [...source.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)].map(match => match[1].trim());
}

function slugifyHeading(value) {
  return value.toLowerCase().replace(/<[^>]+>/g, "").replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s+/g, "-");
}

function pageAnchors(source) {
  const result = new Set(anchors(source));
  for (const match of source.matchAll(/^\s*#{1,6}\s+(.+?)\s*#*\s*$/gm)) result.add(slugifyHeading(match[1]));
  return result;
}

let localLinkCount = 0;
for (const language of ["ru", "en"]) {
  for (const page of pageIds) {
    const { fullPath, source } = readDoc(language, page);
    for (const rawLink of markdownLinks(source)) {
      const link = rawLink.startsWith("<") ? rawLink.slice(1, rawLink.indexOf(">")) : rawLink.split(/\s+/)[0];
      if (!link || /^[a-z][a-z0-9+.-]*:/i.test(link) || link.startsWith("//")) continue;
      const [relativePath, fragment] = link.split("#", 2);
      const targetPath = relativePath ? path.resolve(path.dirname(fullPath), decodeURIComponent(relativePath)) : fullPath;
      if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isFile()) {
        throw new Error(`Broken local link in ${language}/${page}: ${rawLink}`);
      }
      if (fragment) {
        const targetSource = fs.readFileSync(targetPath, "utf8");
        if (!pageAnchors(targetSource).has(decodeURIComponent(fragment))) {
          throw new Error(`Broken local anchor in ${language}/${page}: ${rawLink}`);
        }
      }
      localLinkCount++;
    }
  }
}

for (const page of pageIds) {
  const ru = readDoc("ru", page).source;
  const en = readDoc("en", page).source;
  if (JSON.stringify(headings(ru)) !== JSON.stringify(headings(en))) {
    throw new Error(`RU/EN heading-level parity mismatch: ${page}`);
  }
  if (JSON.stringify(anchors(ru)) !== JSON.stringify(anchors(en))) {
    throw new Error(`RU/EN stable section ID mismatch: ${page}`);
  }
}

const serviceSource = fs.readFileSync(path.join(appRoot, "src/services/connections.ts"), "utf8");
const targetInterface = serviceSource.match(/export interface ConnectionTarget\s*\{([^}]*)\}/)?.[1];
if (!targetInterface) throw new Error("ConnectionTarget interface was not found in services/connections.ts");
const targetFields = [...targetInterface.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)].map(match => match[1]);
for (const language of ["ru", "en"]) {
  const source = readDoc(language, "modules/connections.md").source;
  const missing = targetFields.filter(field => !source.includes(`\`${field}\``));
  if (missing.length) throw new Error(`${language} connection contract omits fields: ${missing.join(", ")}`);
}

function documentedConfigFields(source) {
  const fields = [];
  for (const line of source.split(/\r?\n/).filter(line => /^\|/.test(line))) {
    fields.push(...[...line.matchAll(/`([^`]+)`/g)].map(match => match[1]));
  }
  return fields.sort();
}
const ruConfig = documentedConfigFields(readDoc("ru", "configuration.md").source);
const enConfig = documentedConfigFields(readDoc("en", "configuration.md").source);
if (JSON.stringify(ruConfig) !== JSON.stringify(enConfig)) {
  throw new Error(`RU/EN configuration parameter coverage mismatch: RU=${ruConfig}; EN=${enConfig}`);
}
if (!ruConfig.length) throw new Error("No configuration parameter rows were found.");

const downloadCommands = [
  "resolve_model_download", "prepare_model_download", "start_model_download",
  "list_model_downloads", "get_model_download", "pause_model_download",
  "resume_model_download", "cancel_model_download", "remove_model_download_partial",
  "model_download_destination",
];
for (const language of ["ru", "en"]) {
  const overview = readDoc(language, "overview.md").source;
  const adapters = readDoc(language, "modules/engine-adapters.md").source;
  const downloads = readDoc(language, "modules/model-downloads.md").source;
  const ipc = readDoc(language, "ipc.md").source;
  for (const engine of ["llama_cpp", "strata"]) {
    if (!overview.includes(`\`${engine}\``) || !adapters.includes(`\`${engine}\``)) {
      throw new Error(`${language} docs do not describe supported engine ${engine}`);
    }
  }
  const missing = downloadCommands.filter(command => !downloads.includes(`\`${command}\``) || !ipc.includes(`\`${command}\``));
  if (missing.length) throw new Error(`${language} download IPC docs omit commands: ${missing.join(", ")}`);
  if (!downloads.includes("download://updated") || !downloads.includes(".aplot-staging")) {
    throw new Error(`${language} download docs omit event or staging guarantees`);
  }
}

console.log(`OK: ${pageIds.length} RU/EN page pairs; ${localLinkCount} local links; matching section IDs; ${targetFields.length} ConnectionTarget fields; ${ruConfig.length} documented config rows; two engines and ${downloadCommands.length} download commands documented.`);
