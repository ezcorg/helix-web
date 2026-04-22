#!/usr/bin/env node
// Bundles wasix-rust stdlib sources (core/alloc/std/...) into a JSON file
// that can be mounted into the WASIX VFS at /sysroot/library. r-a then
// picks it up via `sysroot_src` in rust-project.json and falls into its
// stitched-sysroot path (which reads <crate>/src/lib.rs directly).

import { readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

const STDLIB_ROOT = join(import.meta.dirname, "../../wasix-rust/library");
const OUT_FILE = join(import.meta.dirname, "../public/stdlib-bundle.json");

// Crates r-a's stitched-sysroot loader looks up by name, in
// project-model/src/sysroot.rs (SYSROOT_CRATES). Each path here is relative
// to STDLIB_ROOT and r-a expects <path>/src/lib.rs.
const CRATES = [
  "alloc",
  "core",
  "panic_abort",
  "panic_unwind",
  "proc_macro",
  "std",
  "stdarch/crates/std_detect",
  "test",
  "unwind",
];

// Directories to skip while walking each crate — they bloat the bundle
// and r-a has no use for them during name resolution.
const SKIP_DIRS = new Set([
  "tests",
  "benches",
  "examples",
  "target",
  "ci",
  "doc",
  "docs",
  ".git",
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
      const rel = relative(base, full);
      out[rel] = readFileSync(full, "utf-8");
    }
  }
}

const bundle = {};
const crateStats = [];

for (const crate of CRATES) {
  const crateDir = join(STDLIB_ROOT, crate);
  let libRs;
  try {
    libRs = statSync(join(crateDir, "src/lib.rs"));
  } catch {
    console.warn(`[skip] ${crate}: no src/lib.rs`);
    continue;
  }
  if (!libRs.isFile()) continue;
  const before = Object.keys(bundle).length;
  walkRs(join(crateDir, "src"), STDLIB_ROOT, bundle);
  const added = Object.keys(bundle).length - before;
  crateStats.push(`${crate}: ${added} files`);
}

const fileCount = Object.keys(bundle).length;
const json = JSON.stringify(bundle);
writeFileSync(OUT_FILE, json);

const sizeMB = (Buffer.byteLength(json) / 1024 / 1024).toFixed(1);
console.log(`Bundled ${fileCount} stdlib files (${sizeMB} MB) -> ${OUT_FILE}`);
for (const s of crateStats) console.log(`  ${s}`);
