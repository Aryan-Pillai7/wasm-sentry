/**
 * Drives every capture path the extension hooks.
 *
 * The "miner" fixtures only perform arithmetic on a local that stays zero --
 * they compute nothing, connect to nothing, and exit their loop immediately.
 * They exist so the detector has a realistic shape to fire on without a real
 * malware sample being involved.
 */
const log = document.getElementById("log");

function say(text, cls = "") {
  log.innerHTML += `\n<span class="${cls}">${text}</span>`;
}

/** Imports satisfying every fixture, so instantiation actually succeeds. */
const IMPORTS = {
  env: { log: () => {} },
  pool: { websocket_send: () => {} },
};

async function bytesOf(name) {
  const response = await fetch(name, { cache: "no-store" });
  return response.arrayBuffer();
}

const RUNS = {
  // Streaming: the extension must clone the Response without consuming the
  // copy the engine reads.
  async streaming() {
    await WebAssembly.instantiateStreaming(fetch("benign.wasm"), IMPORTS);
    say("1. instantiateStreaming(benign.wasm) ok", "ok");
  },

  // Bytes already in memory: webRequest sees the fetch, but only the API hook
  // sees what was actually compiled.
  async buffer() {
    const bytes = await bytesOf("kernel-only.wasm");
    await WebAssembly.instantiate(bytes, IMPORTS);
    say("2. instantiate(ArrayBuffer) of kernel-only.wasm ok", "ok");
  },

  // compile() captures; the follow-up instantiate(Module) carries no bytes and
  // must not be double-counted.
  async compile() {
    const bytes = await bytesOf("miner-no-threads.wasm");
    const module = await WebAssembly.compile(bytes);
    await WebAssembly.instantiate(module, IMPORTS);
    say("3. compile + instantiate(Module) of miner-no-threads.wasm ok", "ok");
  },

  // The constructor path, wrapped with a Proxy so `new` and `instanceof` still
  // behave.
  async ctor() {
    const bytes = await bytesOf("benign.wasm");
    const module = new WebAssembly.Module(bytes);
    say(`4. new WebAssembly.Module ok (instanceof: ${module instanceof WebAssembly.Module})`, "ok");
  },

  // Never touches the network as a .wasm request: webRequest cannot see this at
  // all, which is the whole reason for hooking the API.
  async blob() {
    const bytes = await bytesOf("miner.wasm");
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/wasm" }));
    try {
      await WebAssembly.compileStreaming(fetch(url));
      say("5. compileStreaming(blob:) of miner.wasm ok", "ok");
    } catch (error) {
      // Shared memory needs cross-origin isolation. The capture happens before
      // the engine is called, so the module is still analysed.
      say(`5. blob: compile threw (${error.message}) -- capture still happened`, "warn");
    } finally {
      URL.revokeObjectURL(url);
    }
  },

  // Identical bytes twice: the popup must show one module, not two.
  async dedupe() {
    const bytes = await bytesOf("benign.wasm");
    await WebAssembly.instantiate(bytes.slice(0), IMPORTS);
    await WebAssembly.instantiate(bytes.slice(0), IMPORTS);
    say("6. same bytes compiled twice -- expect ONE module in the popup", "ok");
  },

  // Content scripts do not run in workers, so the hooks are carried in by a
  // shim the extension starts the worker from. Expect a captured module tagged
  // "in a Worker" -- not a "not analysed" note, which is what this produced
  // before worker instrumentation landed.
  async worker() {
    const worker = new Worker("worker.js");
    worker.postMessage("go");
    await new Promise((resolve) => {
      worker.onmessage = (event) => {
        say(`7. worker reported: ${event.data} -- expect a module tagged "in a Worker"`, "ok");
        worker.terminate();
        resolve();
      };
      setTimeout(resolve, 2000);
    });
  },

  // The same, as an ES module worker: its two loads are awaited, so the shim
  // has to buffer this message until the real script has a handler for it.
  async moduleWorker() {
    const worker = new Worker("worker-module.js", { type: "module" });
    worker.postMessage("go");
    await new Promise((resolve) => {
      worker.onmessage = (event) => {
        say(`8. module worker reported: ${event.data}`, "ok");
        worker.terminate();
        resolve();
      };
      setTimeout(resolve, 2000);
    });
  },

  // A worker that spawns a worker: captures have to bubble up one level at a
  // time, and the page must not see any of them.
  async nestedWorker() {
    const worker = new Worker("worker-parent.js");
    worker.postMessage("go");
    await new Promise((resolve) => {
      worker.onmessage = (event) => {
        say(`9. nested worker reported: ${event.data}`, "ok");
        worker.terminate();
        resolve();
      };
      setTimeout(resolve, 3000);
    });
  },

  // What Phase 4 is for. Several workers running a real kernel for long enough
  // that "sustained" means something: the static verdict on this module is
  // ambiguous by design, and watching it run is what settles it.
  async grind() {
    const workers = Math.max(2, Math.ceil((navigator.hardwareConcurrency || 4) / 2));
    say(`10. starting ${workers} workers grinding for 25s — watch the popup`, "warn");

    const running = Array.from({ length: workers }, () => {
      const worker = new Worker("worker-grind.js");
      return new Promise((resolve) => {
        worker.onmessage = (event) => {
          worker.terminate();
          resolve(event.data);
        };
        worker.postMessage({ seconds: 25 });
        setTimeout(() => {
          worker.terminate();
          resolve("timed out");
        }, 40000);
      });
    });

    const replies = await Promise.all(running);
    say(`10. ${replies.length} workers finished: ${replies[0]}`, "ok");
    say("    the module should now be scored on what it did, not only its shape", "ok");
  },

  // Needs "Analyse JavaScript" enabled. The script below computes nothing: it
  // is shaped like an obfuscated loader -- escaped strings, a base64 blob and
  // something that would evaluate it -- so the scanner has an honest example to
  // measure without a real payload being committed here.
  async jsInline() {
    const BACKSLASH = String.fromCharCode(92);
    const hex = (text) =>
      [...text]
        .map((c) => BACKSLASH + "x" + c.charCodeAt(0).toString(16).padStart(2, "0"))
        .join("");

    const script = document.createElement("script");
    script.textContent =
      `var _0x1f=["${hex("WebAssembly")}","${hex("hardwareConcurrency")}"];` +
      `var _0x2a="${"ZnVuY3Rpb24gbm9vcCgpe3JldHVybiAwfQ".repeat(4)}";` +
      `if(false){eval(atob(_0x2a));}` +
      `void _0x1f;`;
    document.body.appendChild(script);
    say("11. injected an obfuscated-looking inline script (it runs nothing)", "warn");
    say("    expect a JavaScript finding in the popup, and no source stored anywhere", "warn");
  },

  // A third-party script with no Subresource Integrity: the classic supply
  // chain exposure, visible from the markup without reading anything.
  async jsThirdParty() {
    const script = document.createElement("script");
    script.src = "https://cdn.example.invalid/analytics.js";
    script.async = true;
    // It will fail to load, which does not matter: the finding is about the
    // reference, and the extension never fetches it either.
    script.onerror = () => say("12. the third-party script failed to load, as expected", "ok");
    document.body.appendChild(script);
    say("12. referenced an unpinned third-party script -- expect a supply-chain note", "warn");
  },
};

document.addEventListener("click", async (event) => {
  const which = event.target.dataset?.run;
  if (!which) return;
  const names = which === "all" ? Object.keys(RUNS) : [which];
  for (const name of names) {
    try {
      await RUNS[name]();
    } catch (error) {
      say(`${name} failed: ${error.message}`, "err");
    }
  }
});
