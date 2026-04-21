# Building Helix for the Browser

This documents the complete build process for running the Helix text editor
in a web browser with syntax highlighting, using WASIX + ghostty-web.

## Architecture

```
┌─────────────┐    ┌──────────────┐    ┌─────────────┐
│  ghostty-web │    │  @wasmer/sdk  │    │  helix.wasm  │
│  (terminal)  │◄──►│  (WASIX RT)   │◄──►│  (editor)    │
└─────────────┘    └──────────────┘    └─────────────┘
                          │
                   ┌──────┴───────┐
                   │ grammar.wasm  │  (tree-sitter, loaded via dlopen)
                   └──────────────┘
```

## Prerequisites

- **Rust nightly** (nightly-2025-11-01 for wasmer-js)
- **cargo-wasix** (`cargo install cargo-wasix`)
- **wasixcc** (`curl -fsSL https://wasix.cc | sh`)
- **wasm-bindgen CLI** 0.2.101 (`cargo install wasm-bindgen-cli`)
- **wasm-tools** (`cargo install wasm-tools`)
- **pnpm** (for helix-web)

## Repository Layout

All repos are in `~/dev/`:

| Repo | Branch | Purpose |
|------|--------|---------|
| `wasmer` | main | Wasmer runtime (patched for WASIX browser support) |
| `wasmer-js` | main | Browser SDK (path deps on wasmer) |
| `helix` | wasix | Helix editor (WASIX port) |
| `helix-web` | main | Browser frontend (vite + ghostty-web) |
| `wasix-rust` | fix-home-dir | Patched Rust stdlib (home_dir fix) |
| `wasix-tokio` | wasix-1.50.0 | Patched tokio for WASIX |
| `wasix-libc-rs` | — | Patched libc crate |
| `libloading` | wasix | Patched libloading for WASIX |
| + others | — | Various patched crates (see helix/Cargo.toml) |

## Step 1: Setup wasix-rust Source for stdlib

The cargo-wasix toolchain's pre-compiled std doesn't have the `home_dir()` fix.
We link our local wasix-rust source so `-Zbuild-std` compiles from the fixed source.

```bash
# After cargo-wasix auto-downloads its toolchain:
SYSROOT="$HOME/Library/Application Support/cargo-wasix/toolchains/aarch64-apple-darwin_v2026-03-27.1+rust-1.90/rust/lib/rustlib"
mkdir -p "$SYSROOT/src/rust"
ln -sf ~/dev/wasix-rust/library "$SYSROOT/src/rust/library"
ln -sf ~/dev/wasix-rust/Cargo.toml "$SYSROOT/src/rust/Cargo.toml"
ln -sf ~/dev/wasix-rust/Cargo.lock "$SYSROOT/src/rust/Cargo.lock"
```

## Step 2: Patch tree-house-bindings FFI

The tree-sitter C API changed `ts_query_cursor_set_byte_range` to return `bool`,
but tree-house-bindings still declares it as `void`. On WASM, wasm-ld generates
a trap stub for this mismatch.

```bash
# Find and patch the FFI declaration
BINDING_FILE=$(find ~/.cargo/registry/src -path "*/tree-house-bindings-*/src/query_cursor.rs")
sed -i '' 's/fn ts_query_cursor_set_byte_range(self_: \*mut QueryCursorData, start_byte: u32, end_byte: u32);/fn ts_query_cursor_set_byte_range(self_: *mut QueryCursorData, start_byte: u32, end_byte: u32) -> bool;/' "$BINDING_FILE"
```

## Step 3: Build Helix for WASIX

**CRITICAL**: Must use `-Zbuild-std=std,panic_abort` to compile std from the
wasix-rust source (which has the `home_dir()` fix). The pre-compiled std
from cargo-wasix does NOT have this fix.

```bash
cd ~/dev/helix

# Clean previous builds
rm -rf target/wasm32-wasmer-wasi

# Build with -Zbuild-std for the fixed stdlib
CARGO_BUILD_TARGET=wasm32-wasmer-wasi \
  cargo +wasix-dev build --release -p helix-term \
  -Zbuild-std=std,panic_abort
```

The `.cargo/config.toml` in helix provides:
- CC/CXX/AR pointing to wasixcc
- Linker flags: `--export=malloc,free,calloc,...,--growable-table`
- These exports are needed by dynamically loaded grammar modules

Output: `target/wasm32-wasmer-wasi/release/hx.wasm` (~22MB)

## Step 4: Build Wasmer JS SDK

```bash
cd ~/dev/wasmer-js

# Build the WASM runtime
RUSTUP_TOOLCHAIN=nightly-2025-11-01 cargo build --release

# Generate JS bindings
wasm-bindgen --target web --out-dir pkg --weak-refs \
  target/wasm32-unknown-unknown/release/wasmer_js.wasm

# Build the distributable
pnpm run build:rollup
```

Output: `dist/` directory (index.mjs, wasmer_js_bg.wasm, etc.)

## Step 5: Compile Tree-sitter Grammars

Grammars are compiled as PIC shared libraries with `wasm-ld --shared`.

```bash
GRAMMARS_SRC="$HOME/dev/helix/runtime/grammars/sources"
OUT="$HOME/dev/helix-web/public/grammars"
SYSROOT="$HOME/.wasixcc/sysroot/sysroot"
CLANG="$HOME/.wasixcc/llvm/bin/clang"
LD="$HOME/.wasixcc/llvm/bin/wasm-ld"

mkdir -p "$OUT"

for lang in rust javascript python toml json bash c cpp go html css dockerfile; do
    SRC="$GRAMMARS_SRC/$lang/src"
    [ -f "$SRC/parser.c" ] || continue

    TMPDIR=$(mktemp -d)

    # Compile with PIC + shared memory + visibility=default
    $CLANG --target=wasm32-wasi --sysroot="$SYSROOT" \
        -c -O2 -fPIC -fvisibility=default \
        -matomics -mbulk-memory -mmutable-globals -pthread \
        -I"$SRC" "$SRC/parser.c" -o "$TMPDIR/parser.o"

    OBJS=("$TMPDIR/parser.o")
    [ -f "$SRC/scanner.c" ] && {
        $CLANG --target=wasm32-wasi --sysroot="$SYSROOT" \
            -c -O2 -fPIC -fvisibility=default \
            -matomics -mbulk-memory -mmutable-globals -pthread \
            -I"$SRC" "$SRC/scanner.c" -o "$TMPDIR/scanner.o"
        OBJS+=("$TMPDIR/scanner.o")
    }

    # Link as PIC shared library with dylink.0
    $LD --shared --import-memory --shared-memory \
        --max-memory=4294967296 --allow-undefined --export-dynamic \
        "${OBJS[@]}" -o "$OUT/$lang.wasm"

    rm -rf "$TMPDIR"
done
```

Key flags:
- `--shared`: produces PIC shared library with `dylink.0` section
- `-fPIC -fvisibility=default`: position-independent code, exports all symbols
- `--import-memory --shared-memory`: shares memory with host module
- `--allow-undefined`: libc functions resolved from host at load time

## Step 6: Bundle Runtime Files

```bash
cd ~/dev/helix-web
node scripts/bundle-runtime.js
```

This generates `public/runtime-bundle.json` (~2.1MB) containing query files
(.scm) and themes for 331 languages.

## Step 7: Setup helix-web

```bash
cd ~/dev/helix-web

# Symlink the helix binary
ln -sf ~/dev/helix/target/wasm32-wasmer-wasi/release/hx.wasm public/helix.wasm

# Install dependencies
pnpm install

# Start dev server (with COOP/COEP headers for SharedArrayBuffer)
pnpm dev
```

Access at `http://localhost:5173`

## How Dynamic Grammar Loading Works

1. **dlopen**: Helix calls `dlopen("/runtime/grammars/rust.wasm")`
   - Reads .wasm from WASIX virtual filesystem
   - Allocates memory via `calloc` (coordinates with heap)
   - Compiles and instantiates as PIC module with `__memory_base`, `__table_base`
   - Places GOT.func functions in the table manually
   - Runs `__wasm_apply_data_relocs` and `__wasm_call_ctors`

2. **dlsym**: Helix calls `dlsym(handle, "tree_sitter_rust")`
   - Gets raw WASM function from grammar instance
   - Places in main module's `__indirect_function_table` via JS API
   - Returns table index as "function pointer"

3. **Parsing**: tree-sitter calls grammar functions via `call_indirect`
   - `lex_fn` (at `__table_base + 0`) for lexing
   - External scanner functions (at `__table_base + N`) via GOT.func

## Key Patches in Wasmer Runtime

| File | Change |
|------|--------|
| `lib/wasix/src/syscalls/wasix/dl_env.rs` | C-ABI dlopen/dlsym with PIC loader |
| `lib/wasix/src/lib.rs` | Register env:dlopen/dlclose/dlsym/dlerror |
| `lib/wasix/src/state/handles/thread_local.rs` | Fix RefCell double-borrow in signal handler |
| `lib/api/src/backend/js/entities/function/mod.rs` | `raw_js_function()` accessor |
| `lib/api/src/backend/js/entities/table.rs` | `raw_js_table()` accessor |

## Troubleshooting

- **`HomeDirError`**: Ensure `-Zbuild-std` is used and wasix-rust source is linked
- **`signature_mismatch:*`**: FFI declaration mismatch — patch tree-house-bindings
- **`null function`**: Grammar's GOT.func functions not placed in table
- **`table index out of bounds`**: Table not grown enough for GOT.func entries
- **`rust-analyzer LSP unresponsive (hover never returns)`**: `main_loop` deadlocks in
  `PrimeCachesProgress::End` calling `trigger_garbage_collection()`. That goes through
  salsa's `cancel_others`, which `cvar.wait`s until all snapshots drop to 1. Salsa's
  cancellation relies on panic-unwinding to drop snapshots held by in-flight tasks
  (e.g. `update_diagnostics`); with `panic = abort` the panic aborts the whole process
  instead, so the in-flight task never drops its snapshot and the wait never completes.
  **Fix**: rebuild r-a with panic=unwind and native WASM EH (new proposal). In
  `~/dev/rust-analyzer/.cargo/config.toml`:
  ```toml
  [target.wasm32-wasmer-wasi]
  rustflags = [
    "-C", "panic=unwind",
    "-C", "target-feature=+exception-handling",
    "-C", "llvm-args=-wasm-enable-eh",
    "-C", "llvm-args=-wasm-use-legacy-eh=false",
  ]
  ```
  Build with `-Zbuild-std=std,panic_unwind` (not `panic_abort`). The legacy EH proposal
  (`try/catch/rethrow`) won't work — wasmer requires the new `try_table`/`throw_ref` form.
  Note: native `wasmer run` on Apple Silicon still traps (cranelift aarch64 EH is
  incomplete); the browser path works because wasmer-js dispatches to the native
  WebAssembly engine, which implements the new EH proposal.
- **No syntax highlighting**: Check grammar exports `tree_sitter_*` with `-fvisibility=default`
