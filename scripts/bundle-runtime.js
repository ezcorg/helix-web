#!/usr/bin/env node
// Bundles helix runtime files (queries, themes, tutor) into a JSON file
// for loading into the WASIX virtual filesystem.

import { readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

const HELIX_ROOT = join(import.meta.dirname, "../../helix");
const RUNTIME_DIR = join(HELIX_ROOT, "runtime");
const OUT_FILE = join(import.meta.dirname, "../public/runtime-bundle.json");

// Directories to include (skip grammars — those are native binaries)
const INCLUDE = ["queries", "themes"];

function walkDir(dir, base) {
  const result = {};
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = relative(base, full);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      Object.assign(result, walkDir(full, base));
    } else if (stat.isFile()) {
      result[rel] = readFileSync(full, "utf-8");
    }
  }
  return result;
}

const bundle = {};

for (const subdir of INCLUDE) {
  const dir = join(RUNTIME_DIR, subdir);
  const files = walkDir(dir, RUNTIME_DIR);
  Object.assign(bundle, files);
}

// Include tutor file
try {
  bundle["tutor"] = readFileSync(join(RUNTIME_DIR, "tutor"), "utf-8");
} catch {
  // tutor is optional
}

const fileCount = Object.keys(bundle).length;
const json = JSON.stringify(bundle);
writeFileSync(OUT_FILE, json);

const sizeMB = (Buffer.byteLength(json) / 1024 / 1024).toFixed(1);
console.log(`Bundled ${fileCount} runtime files (${sizeMB} MB) → ${OUT_FILE}`);
