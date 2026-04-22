#!/usr/bin/env node
// Bundles a seed list of crate sources from ~/.cargo/registry into a JSON
// file that helix-web can mount into the WASIX VFS at /crates. Each entry
// declares the crate name, edition, root module path, and (best-effort)
// dependencies parsed from Cargo.toml — main.js feeds these directly into
// the rust-project.json `crates[]` array so r-a can resolve `use serde::...`
// and friends.

import { readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { homedir } from "os";

const REGISTRY = join(
  homedir(),
  ".cargo/registry/src/index.crates.io-1949cf8c6b5b557f",
);
const OUT_FILE = join(import.meta.dirname, "../public/crates-bundle.json");

// Seed list: name → exact directory under REGISTRY. Pinned versions so the
// bundle is deterministic across machines (different ~/.cargo states).
const SEED = [
  { name: "anyhow", dir: "anyhow-1.0.102" },
];

const SKIP_DIRS = new Set([
  "tests",
  "benches",
  "examples",
  "target",
  ".git",
  "fuzz",
]);

function walkRs(dir, base, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      walkRs(full, base, out);
    } else if (stat.isFile() && entry.endsWith(".rs")) {
      out[relative(base, full)] = readFileSync(full, "utf-8");
    }
  }
}

// Best-effort Cargo.toml parser — enough to extract `edition`, `name`, and
// the [dependencies] / [dependencies.<name>] section keys. Doesn't handle
// every edge case (target-specific deps, dev-deps), which is fine: the
// crate graph in r-a only needs build-time deps for `use foo` resolution.
function parseManifest(toml) {
  const out = { edition: "2015", name: null, deps: new Set() };
  const lines = toml.split(/\r?\n/);
  let section = null;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const sec = line.match(/^\[([^\]]+)\]$/);
    if (sec) {
      section = sec[1].trim();
      // [dependencies.foo] form: foo is the dep name.
      const subdep = section.match(/^dependencies\.([^.]+)$/);
      if (subdep) out.deps.add(subdep[1].replace(/^"|"$/g, ""));
      continue;
    }
    if (section === "package") {
      const eq = line.match(/^(\w+)\s*=\s*(.+)$/);
      if (eq) {
        if (eq[1] === "edition") {
          out.edition = eq[2].replace(/^"|"$/g, "");
        } else if (eq[1] === "name") {
          out.name = eq[2].replace(/^"|"$/g, "");
        }
      }
    } else if (section === "dependencies") {
      // `name = "1.0"` or `name = { ... }`
      const eq = line.match(/^([A-Za-z0-9_-]+)\s*=/);
      if (eq) out.deps.add(eq[1]);
    }
  }
  return { ...out, deps: [...out.deps] };
}

const bundle = { files: {}, crates: [] };

for (const { name, dir } of SEED) {
  const cratePath = join(REGISTRY, dir);
  let cargoToml;
  try {
    cargoToml = readFileSync(join(cratePath, "Cargo.toml"), "utf-8");
  } catch {
    console.warn(`[skip] ${dir}: no Cargo.toml`);
    continue;
  }
  const manifest = parseManifest(cargoToml);
  const srcDir = join(cratePath, "src");
  let libRs;
  try {
    libRs = statSync(join(srcDir, "lib.rs"));
  } catch {
    console.warn(`[skip] ${dir}: no src/lib.rs`);
    continue;
  }
  if (!libRs.isFile()) continue;
  const before = Object.keys(bundle.files).length;
  walkRs(srcDir, cratePath, bundle.files);
  const added = Object.keys(bundle.files).length - before;

  // Move files under <dir>/src/... so different crate dirs don't collide.
  const filesForCrate = {};
  for (const [k, v] of Object.entries(bundle.files)) {
    if (k.startsWith("src/") && !filesForCrate.hasOwnProperty(`${dir}/${k}`)) {
      filesForCrate[`${dir}/${k}`] = v;
    }
  }
  // Replace the just-walked entries with prefixed entries, then drop the
  // un-prefixed ones we collected for THIS crate.
  for (const k of Object.keys(bundle.files)) {
    if (k.startsWith("src/")) delete bundle.files[k];
  }
  Object.assign(bundle.files, filesForCrate);

  bundle.crates.push({
    name: manifest.name || name,
    dir,
    edition: manifest.edition || "2015",
    deps: manifest.deps.filter((d) => SEED.some((s) => s.name === d)),
  });
  console.log(`  ${dir}: ${added} files, deps=[${manifest.deps.join(", ")}]`);
}

const json = JSON.stringify(bundle);
writeFileSync(OUT_FILE, json);

const sizeMB = (Buffer.byteLength(json) / 1024 / 1024).toFixed(2);
console.log(
  `Bundled ${bundle.crates.length} crates, ${Object.keys(bundle.files).length} files (${sizeMB} MB) -> ${OUT_FILE}`,
);
