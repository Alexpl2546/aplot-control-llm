import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.dirname(app);
const output = path.join(app, "artifacts", "legal");
// Only generated files inside this fixed directory may be replaced.
if (path.relative(app, output) !== path.join("artifacts", "legal")) throw new Error("Invalid output directory");
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
const records = [];
const noticeName = /^(licen[cs]e|copying|notice|copyright|unlicense)([._-]|$)/i;

function collect(root, dest, prefix = "") {
  if (!existsSync(root)) return 0;
  let count = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory() && !["node_modules", ".git", "target"].includes(entry.name)) {
      count += collect(path.join(root, entry.name), dest, relative);
    } else if (entry.isFile() && noticeName.test(entry.name)) {
      const target = path.join(dest, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      cpSync(path.join(root, entry.name), target);
      count++;
    }
  }
  return count;
}

function addNotices(kind, name, version, license, source, extraLicense) {
  const key = `${name.replaceAll("/", "__")}-${version}`;
  const dest = path.join(output, kind, key);
  let count = collect(source, dest);
  const override = path.join(app, "license-overrides", kind, key);
  if (existsSync(override)) {
    count += collect(override, dest);
    cpSync(path.join(override, "PROVENANCE.json"), path.join(dest, "PROVENANCE.json"));
  }
  if (extraLicense && existsSync(extraLicense)) {
    mkdirSync(dest, { recursive: true });
    cpSync(extraLicense, path.join(dest, "DECLARED-LICENSE"));
    count++;
  }
  if (!count || !license) throw new Error(`Missing license evidence: ${kind}/${name}@${version}`);
  records.push({ ecosystem: kind, name, version, license, notices: `${kind}/${key}` });
}

const npmLock = JSON.parse(readFileSync(path.join(app, "package-lock.json"), "utf8"));
for (const [relative, item] of Object.entries(npmLock.packages)) {
  if (!relative || item.dev) continue;
  const source = path.join(app, relative);
  const installed = JSON.parse(readFileSync(path.join(source, "package.json"), "utf8"));
  if (installed.version !== item.version) throw new Error(`Run npm ci: version mismatch for ${relative}`);
  addNotices("npm", installed.name, installed.version, item.license, source);
}

const result = spawnSync("cargo", ["metadata", "--locked", "--format-version", "1", "--filter-platform", "x86_64-pc-windows-msvc", "--manifest-path", path.join(app, "src-tauri", "Cargo.toml")], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
if (result.status !== 0) throw new Error(`Cargo metadata failed: ${result.stderr}`);
const metadata = JSON.parse(result.stdout);
const nodes = new Map(metadata.resolve.nodes.map(node => [node.id, node]));
const included = new Set();
const pending = [metadata.resolve.root];
while (pending.length) {
  const id = pending.pop();
  if (included.has(id)) continue;
  included.add(id);
  for (const dep of nodes.get(id)?.deps ?? []) pending.push(dep.pkg);
}
// Include build dependencies conservatively; do not claim each listed crate is linked into the EXE.
const checksums = new Map();
for (const block of readFileSync(path.join(app, "src-tauri", "Cargo.lock"), "utf8").split("[[package]]")) {
  const name = block.match(/^name = "([^"]+)"/m)?.[1];
  const version = block.match(/^version = "([^"]+)"/m)?.[1];
  const checksum = block.match(/^checksum = "([^"]+)"/m)?.[1];
  if (name && version && checksum) checksums.set(`${name}-${version}`, checksum);
}
for (const pkg of metadata.packages) {
  if (!included.has(pkg.id) || !pkg.source) continue;
  const source = path.dirname(pkg.manifest_path);
  addNotices("cargo", pkg.name, pkg.version, pkg.license, source, pkg.license_file ? path.resolve(source, pkg.license_file) : undefined);
  if (pkg.license?.includes("MPL-2.0")) {
    const key = `${pkg.name}-${pkg.version}`;
    const archive = path.resolve(source, "..", "..", "..", "cache", path.basename(path.dirname(source)), `${key}.crate`);
    const bytes = readFileSync(archive);
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (hash !== checksums.get(key)) throw new Error(`MPL source checksum mismatch: ${key}`);
    const dest = path.join(output, "mpl-source", `${key}.crate`);
    mkdirSync(path.dirname(dest), { recursive: true });
    cpSync(archive, dest);
  }
}

for (const name of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"]) cpSync(path.join(repo, name), path.join(output, name));
cpSync(path.join(app, "public", "creators", "LICENSE-lobe-icons"), path.join(output, "LICENSE-lobe-icons"));
cpSync(path.join(app, "public", "creators", "ATTRIBUTION.md"), path.join(output, "CREATOR-ATTRIBUTION.md"));
records.sort((a, b) => `${a.ecosystem}/${a.name}/${a.version}`.localeCompare(`${b.ecosystem}/${b.name}/${b.version}`));
writeFileSync(path.join(output, "DEPENDENCIES.json"), JSON.stringify(records, null, 2) + "\n");
writeFileSync(path.join(output, "README.txt"), "Aplot Control LLM 0.8.2 — license and source bundle\n\nLICENSE and NOTICE apply to Aplot. Third-party terms remain independent.\nDEPENDENCIES.json lists production npm packages and the Windows Cargo dependency closure, including build tools conservatively. It is not a list of exclusively linked crates.\n\nEach npm/ and cargo/ directory contains the original license and notice files.\nMissing package-root texts are preserved from pinned upstream revisions; PROVENANCE.json records their origin.\n\nThe unmodified sources of the included MPL dependencies are supplied in mpl-source/*.crate, verified against Cargo.lock checksums. These are gzip-compressed tar archives. Extract with tar -xf <file>.crate, 7-Zip, or Python tarfile. Those sources remain under their original MPL-2.0 terms.\n\nEngine binaries, CUDA libraries and model weights are not bundled.\nSource: https://github.com/Alexpl2546/aplot-control-llm\n");
console.log(`License bundle ready: ${records.filter(r => r.ecosystem === "npm").length} npm packages, ${records.filter(r => r.ecosystem === "cargo").length} Cargo packages`);
