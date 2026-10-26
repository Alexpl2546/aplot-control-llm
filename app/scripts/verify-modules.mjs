import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAst } from "rolldown/parseAst";

const rootArgument = process.argv.indexOf("--root");
const appRoot = rootArgument >= 0 ? path.resolve(process.argv[rootArgument + 1]) : fileURLToPath(new URL("..", import.meta.url));
const relative = file => path.relative(appRoot, file).replaceAll(path.sep, "/");
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
const sourceFiles = walk(path.join(appRoot, "src")).filter(file => /\.(ts|tsx)$/.test(file));
const imports = new Map();

for (const file of sourceFiles) {
  const ast = parseAst(fs.readFileSync(file, "utf8"), { lang: file.endsWith(".tsx") ? "tsx" : "ts" }, file);
  const edges = [];
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (node.type === "ImportDeclaration" && node.importKind !== "type" && (!node.specifiers.length || node.specifiers.some(item => item.importKind !== "type"))) edges.push(node.source.value);
    if (["ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type) && node.source && node.exportKind !== "type" && (!node.specifiers?.length || node.specifiers.some(item => item.exportKind !== "type"))) edges.push(node.source.value);
    if (node.type === "ImportExpression" && typeof node.source.value === "string") edges.push(node.source.value);
    if (node.type === "CallExpression" && node.callee?.name === "require" && typeof node.arguments[0]?.value === "string") edges.push(node.arguments[0].value);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object" && typeof value.type === "string") visit(value);
    }
  }
  visit(ast);
  imports.set(file, edges);
}

// Pure rules and contracts may not acquire UI, store, transport or native dependencies,
// including through helpers. React hooks/bridges remain the explicit integration boundary.
const pureRoots = [
  "src/features/launches/launchActions.ts", "src/features/launches/presentation.ts",
  "src/features/resources/memoryUsage.ts", "src/features/resources/planner.ts",
  "src/features/models/artifactCatalog.ts", "src/features/profiles/profileAdapters.ts",
  "src/features/connections/harnesses.ts",
];
const forbidden = /^(?:react(?:-dom)?(?:\/|$)|zustand(?:\/|$)|@tauri-apps\/|node:|bun:)|^src\/(?:store|services|components|views|mocks)\/|\.(?:tsx|css)(?:[?#]|$)/;
let checkedEdges = 0;
for (const root of pureRoots) {
  const visited = new Set();
  function check(file, trail) {
    if (visited.has(file)) return;
    visited.add(file);
    for (const specifier of imports.get(file) ?? []) {
      checkedEdges++;
      const target = specifier.startsWith(".")
        ? ["", ".ts", ".tsx", "/index.ts", "/index.tsx"].map(suffix => path.resolve(path.dirname(file), specifier + suffix)).find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile())
        : undefined;
      const name = target ? relative(target) : specifier;
      if (forbidden.test(name)) throw new Error(`Module boundary violated: ${[...trail, relative(file), name].join(" → ")}`);
      if (target) check(target, [...trail, relative(file)]);
    }
  }
  const rootPath = path.join(appRoot, root);
  if (!imports.has(rootPath)) throw new Error(`Missing module: ${root}`);
  check(rootPath, []);
}

for (const [file, edges] of imports) {
  if (edges.some(edge => /(?:^|\/)_(?:redesign|design_exploration)(?:\/|$)|(?:^|\/)redesign\//.test(edge))) throw new Error(`Production source depends on a design copy: ${relative(file)}`);
  if (relative(file).startsWith("src/components/shell/") && edges.some(edge => /@tauri-apps\//.test(edge) && edge !== "@tauri-apps/api/core")) throw new Error(`Shell bypasses the application boundary: ${relative(file)}`);
}
console.log(`OK: ${pureRoots.length} pure module entry points; ${checkedEdges} transitive runtime imports; shell and design-copy boundaries.`);
