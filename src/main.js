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

  const term = new Terminal({
    fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
    fontSize: 14,
    theme: {
      background: "#1a1a2e",
      foreground: "#e0e0e0",
      cursor: "#f0f0f0",
    },
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(document.getElementById("terminal"));
  fitAddon.fit();
  window.addEventListener("resize", () => fitAddon.fit());

  term.write("Helix on WASIX\r\n");

  // 2. Initialize wasmer SDK
  setStatus("Loading WASIX runtime...");
  await initWasmer({ log: "warn,wasmer_wasix::syscalls::wasix::dl_env=info" });
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

  // 5. Run directly with runWasix — pass raw bytes, not pre-compiled Module.
  // The SDK needs the raw bytes for js-serializable-module to work
  // (transferring the module to Web Workers for thread spawning).
  setStatus("Starting helix...");
  term.write("Starting helix...\r\n");

  let instance;
  try {
    instance = await runWasix(wasmBytes, {
      program: "hx",
      args: ["/tmp/hello.rs"],
      env: {
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        HOME: "/home",
        HELIX_RUNTIME: "/runtime",
        RUST_BACKTRACE: "full",
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
        }),
        "/home": new Directory(),
        "/runtime": new Directory(runtimeFiles),
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
