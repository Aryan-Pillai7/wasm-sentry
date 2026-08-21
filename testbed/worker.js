/**
 * Compiles a module inside a Worker.
 *
 * Content scripts do not run in worker contexts, so the main-world hook cannot
 * see this. It should surface in the popup as a "not analysed" note from the
 * network observer rather than as a captured module -- which is the point: the
 * report states its own blind spot instead of implying a clean page.
 */
self.onmessage = async () => {
  try {
    const response = await fetch("kernel-only.wasm");
    await WebAssembly.instantiateStreaming(response, {});
    self.postMessage("compiled kernel-only.wasm inside a Worker");
  } catch (error) {
    self.postMessage(`worker compile failed: ${error.message}`);
  }
};
