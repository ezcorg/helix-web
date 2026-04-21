import { init as initGhostty, Terminal, FitAddon } from "ghostty-web";
import { init as initWasmer, runWasix, Directory } from "@wasmer/sdk";

const status = document.getElementById("status");
const loading = document.getElementById("loading");

function setStatus(msg) {
  status.textContent = msg;
  console.log(`[helix-web] ${msg}`);
}

async function main() {
  // 1. Initialize ghostty-web terminal
  setStatus("Loading terminal...");
  await initGhostty();

  // Measure font metrics to calculate initial cols/rows from container size
  const fontFamily = '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace';
  const fontSize = 12;
  const measureCanvas = document.createElement("canvas").getContext("2d");
  measureCanvas.font = `${fontSize}px ${fontFamily}`;
  const charMetrics = measureCanvas.measureText("M");
  const cellWidth = Math.ceil(charMetrics.width);
  const cellAscent = charMetrics.actualBoundingBoxAscent || fontSize * 0.8;
  const cellDescent = charMetrics.actualBoundingBoxDescent || fontSize * 0.2;
  const cellHeight = Math.ceil(cellAscent + cellDescent) + 2;

  const terminalEl = document.getElementById("terminal");
  const containerWidth = terminalEl.clientWidth || window.innerWidth;
  const containerHeight = terminalEl.clientHeight || window.innerHeight;
  const initialCols = Math.max(2, Math.floor(containerWidth / cellWidth));
  const initialRows = Math.max(2, Math.floor(containerHeight / cellHeight));

  const term = new Terminal({
    fontFamily,
    fontSize,
    cols: initialCols,
    rows: initialRows,
    theme: {
      background: "#1a1a2e",
      foreground: "#e0e0e0",
      cursor: "#f0f0f0",
    },
  });

  // -- Intercept modifier key combos at the document level so the browser
  //    does not steal Ctrl+S (save dialog), Ctrl+W (close tab), Ctrl+N
  //    (new window), etc. before they reach the terminal's InputHandler.
  //    We only suppress defaults while the terminal element (or a descendant
  //    like the hidden textarea) has focus.
  document.addEventListener(
    "keydown",
    (e) => {
      // Only intercept when the terminal (or its children) is focused
      if (!terminalEl.contains(document.activeElement)) return;

      // Let the browser handle Cmd/Ctrl+V (paste), Cmd+C (copy), and
      // Cmd/Ctrl+Shift+I / F12 (devtools) so those remain functional.
      const isMeta = e.metaKey;
      const isCtrl = e.ctrlKey;
      if ((isMeta || isCtrl) && e.code === "KeyV") return;
      if (isMeta && e.code === "KeyC") return;
      if ((isMeta || isCtrl) && e.shiftKey && e.code === "KeyI") return;
      if (e.code === "F12") return;
      // Also let Cmd/Ctrl+Shift+J (console), Cmd+Option+I (macOS devtools) through
      if ((isMeta || isCtrl) && e.shiftKey && e.code === "KeyJ") return;
      if (isMeta && e.altKey && e.code === "KeyI") return;

      // For any other modified key combo (Ctrl+S, Ctrl+C, Alt+X, etc.),
      // prevent the browser's default action so the keydown event reaches
      // ghostty-web's InputHandler unimpeded.
      if (isCtrl || e.altKey || isMeta) {
        e.preventDefault();
      }
    },
    { capture: true },
  );

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(terminalEl);
  fitAddon.fit();

  // Use ResizeObserver via FitAddon for robust container-driven resizing,
  // plus a fallback window resize listener.
  fitAddon.observeResize();
  window.addEventListener("resize", () => fitAddon.fit());

  term.write("Helix on WASIX\r\n");

  // 2. Initialize wasmer SDK
  setStatus("Loading WASIX runtime...");
  await initWasmer({ log: "warn,wasmer_wasix::debug=info,wasmer_wasix::syscalls::wasix::dl_env=info,wasmer_js::tasks::scheduler=info" });
  term.write("WASIX runtime loaded\r\n");

  // 3. Load and compile the helix wasm binary
  setStatus("Loading helix.wasm...");
  const wasmResponse = await fetch("/helix.wasm");
  const wasmBytes = new Uint8Array(await wasmResponse.arrayBuffer());
  const wasmSize = (wasmBytes.length / 1024 / 1024).toFixed(1);
  term.write(`Loaded helix.wasm (${wasmSize} MB)\r\n`);

  // 4. Load runtime files (queries, themes) for syntax highlighting
  setStatus("Loading runtime files...");
  const runtimeResp = await fetch("/runtime-bundle.json");
  const runtimeFiles = await runtimeResp.json();

  // Load compiled grammar .wasm files
  const grammarNames = [
    "rust", "javascript", "python", "toml", "json", "bash",
    "c", "cpp", "go", "html", "css", "dockerfile",
  ];
  const grammarLoads = grammarNames.map(async (name) => {
    try {
      const resp = await fetch(`/grammars/${name}.wasm`);
      if (resp.ok) {
        runtimeFiles[`grammars/${name}.wasm`] = new Uint8Array(
          await resp.arrayBuffer(),
        );
      }
    } catch {}
  });
  await Promise.all(grammarLoads);

  const runtimeFileCount = Object.keys(runtimeFiles).length;
  term.write(`Loaded ${runtimeFileCount} runtime files\r\n`);

  // 5. Load rust-analyzer, rustc, and cargo for LSP support
  setStatus("Loading LSP tools...");
  let rustAnalyzerBytes = null;
  let rustcBytes = null;
  let cargoBytes = null;
  try {
    const [raResp, rcResp, cgResp] = await Promise.all([
      fetch("/rust-analyzer.wasm"),
      fetch("/rustc.wasm"),
      fetch("/cargo.wasm"),
    ]);
    if (raResp.ok) {
      rustAnalyzerBytes = new Uint8Array(await raResp.arrayBuffer());
      const raSize = (rustAnalyzerBytes.length / 1024 / 1024).toFixed(1);
      term.write(`Loaded rust-analyzer.wasm (${raSize} MB)\r\n`);
    }
    if (rcResp.ok) {
      rustcBytes = new Uint8Array(await rcResp.arrayBuffer());
      const rcSize = (rustcBytes.length / 1024 / 1024).toFixed(1);
      term.write(`Loaded rustc.wasm (${rcSize} MB)\r\n`);
    }
    if (cgResp.ok) {
      cargoBytes = new Uint8Array(await cgResp.arrayBuffer());
      const cgSize = (cargoBytes.length / 1024 / 1024).toFixed(1);
      term.write(`Loaded cargo.wasm (${cgSize} MB)\r\n`);
    }
  } catch (e) {
    console.warn("LSP tools not found:", e);
  }

  // 6. Run directly with runWasix — pass raw bytes, not pre-compiled Module.
  // The SDK needs the raw bytes for js-serializable-module to work
  // (transferring the module to Web Workers for thread spawning).
  setStatus("Starting helix...");
  term.write("Starting helix...\r\n");

  // Re-fit now so we have accurate cols/rows before launching the WASIX process
  fitAddon.fit();

  let instance;
  try {
    instance = await runWasix(wasmBytes, {
      program: "hx",
      args: ["/tmp/hello.rs"],
      cols: term.cols,
      rows: term.rows,
      env: {
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        HOME: "/home",
        HELIX_RUNTIME: "/runtime",
        PATH: "/usr/bin:/bin",
        XDG_CONFIG_HOME: "/helix-config",
        XDG_DATA_HOME: "/helix-data",
        XDG_CACHE_HOME: "/helix-cache",
        RUST_BACKTRACE: "full",
        TOKIO_WORKER_THREADS: "2",
        RAYON_NUM_THREADS: "1",
        COLUMNS: String(term.cols),
        LINES: String(term.rows),
      },
      mount: {
        "/tmp": new Directory({
          "test.json": `{
  "name": "helix-web",
  "version": "1.0",
  "description": "Helix in the browser with syntax highlighting!",
  "features": ["tree-sitter", "wasix", "wasm"]
}
`,
          "hello.rs": `// Helix running on WASIX in your browser!
fn main() {
    let message = "Hello from WebAssembly!";
    println!("{}", message);

    for i in 0..10 {
        if i % 2 == 0 {
            println!("even: {}", i);
        } else {
            println!("odd: {}", i);
        }
    }
}
`,
          "Cargo.toml": `[package]
name = "hello"
version = "0.1.0"
edition = "2021"
`,
          "rust-project.json": JSON.stringify({
            sysroot_src: null,
            crates: [
              {
                display_name: "hello",
                root_module: "/tmp/hello.rs",
                edition: "2021",
                deps: [],
                cfg: [
                  "target_arch=\"wasm32\"",
                  "target_os=\"wasi\"",
                ],
                is_workspace_member: true,
              },
            ],
          }),
          ".helix/languages.toml": `[language-server.rust-analyzer]
command = "rust-analyzer"
args = ["--log-file", "/tmp/ra-log.txt"]
timeout = 120

[language-server.rust-analyzer.config]
cargo.buildScripts.enable = false
cargo.sysroot = "none"
procMacro.enable = false
diagnostics.disabled = ["unresolved-proc-macro", "unresolved-extern-crate", "unresolved-import"]
linkedProjects = ["/tmp/rust-project.json"]
checkOnSave = false
numThreads = 1

[language-server.rust-analyzer.config.rustc]
source = "/nonexistent"

[language-server.rust-analyzer.config.files]
watcher = "client"
excludeDirs = ["/usr"]

[language-server.rust-analyzer.config.check]
command = "check"
invocationStrategy = "once"
overrideCommand = []
`,
        }),
        "/home": new Directory(),
        "/helix-config/helix": new Directory({
          "config.toml": "",
        }),
        "/helix-data/helix": new Directory({
          "trusted_workspaces": "/tmp\n",
        }),
        "/helix-cache/helix": new Directory(),
        "/runtime": new Directory(runtimeFiles),
        "/usr/bin": new Directory({
          ...(rustAnalyzerBytes ? { "rust-analyzer": rustAnalyzerBytes } : {}),
          ...(rustcBytes ? { "rustc": rustcBytes } : {}),
          ...(cargoBytes ? { "cargo": cargoBytes } : {}),
        }),
      },
    });
  } catch (e) {
    term.write(`\r\nFailed to start: ${e.message}\r\n`);
    console.error("runWasix error:", e);
    return;
  }

  // 6. Bridge stdin/stdout/stderr
  const encoder = new TextEncoder();
  const stdinWriter = instance.stdin?.getWriter();

  term.onData((data) => {
    if (stdinWriter) {
      stdinWriter.write(encoder.encode(data));
    }
  });

  instance.stdout.pipeTo(
    new WritableStream({
      write(chunk) {
        term.write(typeof chunk === "string" ? chunk : new Uint8Array(chunk));
      },
    })
  );

  instance.stderr.pipeTo(
    new WritableStream({
      write(chunk) {
        const text =
          typeof chunk === "string"
            ? chunk
            : new TextDecoder().decode(chunk);
        console.error("[helix stderr]", text);
        term.write(typeof chunk === "string" ? chunk : new Uint8Array(chunk));
      },
    })
  );

  // 7. Show terminal
  loading.classList.add("hidden");
  term.clear();
  term.focus();

  // Re-fit after the loading overlay is hidden so the terminal gets the
  // full viewport dimensions (the overlay may have affected layout).
  fitAddon.fit();

  // 8. Wait for exit
  const output = await instance.wait();
  term.write(`\r\n[helix exited with code ${output.code}]\r\n`);
  if (output.stderr) {
    term.write(`stderr: ${output.stderr}\r\n`);
  }
}

main().catch((err) => {
  console.error(err);
  setStatus(`Error: ${err.message}`);
  document.getElementById("terminal").innerHTML = `<pre style="color:#ff6060;padding:20px;font-family:monospace">${err.stack || err.message}</pre>`;
});
