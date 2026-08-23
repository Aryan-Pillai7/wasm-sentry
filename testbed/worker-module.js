/**
 * The same compile, in an ES module worker.
 *
 * A module worker cannot use `importScripts`, so the shim the extension starts
 * it from has to `await` two dynamic imports before this file runs. That opens
 * a window in which the page's `postMessage` would arrive with no handler
 * registered, so the shim buffers and re-dispatches it -- which is what this
 * fixture exercises: if the buffer is wrong, this worker never replies.
 */
self.onmessage = async () => {
  try {
    const response = await fetch("kernel-only.wasm");
    await WebAssembly.instantiateStreaming(response, {});
    self.postMessage("compiled kernel-only.wasm inside a module Worker");
  } catch (error) {
    self.postMessage(`module worker compile failed: ${error.message}`);
  }
};
