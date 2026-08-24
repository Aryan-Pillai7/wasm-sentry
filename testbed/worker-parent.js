/**
 * A worker that spawns a worker.
 *
 * The child's captures have to travel up through this worker to the page and
 * on to the service worker, one hop at a time, and none of them may be visible
 * to the message handlers on either level. This also checks the relative URL
 * below still resolves against *this* file rather than against the blob the
 * worker was actually started from.
 */
self.onmessage = async () => {
  try {
    const child = new Worker("worker.js");
    const reply = await new Promise((resolve) => {
      child.onmessage = (event) => resolve(event.data);
      child.postMessage("go");
      setTimeout(() => resolve("child never answered"), 2000);
    });

    // Not terminated the instant the child replies, deliberately.
    //
    // A streaming capture is posted once the cloned response has been read,
    // which can land after the module has finished instantiating -- so the
    // child's reply and its capture are racing, and `terminate()` kills
    // whichever messages are still in flight. Waiting a beat makes this fixture
    // demonstrate capture rather than demonstrate that race. The race itself is
    // real and documented: a worker killed mid-capture degrades to the
    // network observer's "not analysed" note.
    await new Promise((resolve) => setTimeout(resolve, 150));
    child.terminate();

    const response = await fetch("benign.wasm");
    await WebAssembly.instantiateStreaming(response, { env: { log: () => {} } });
    self.postMessage(`child said "${reply}", and this worker compiled benign.wasm too`);
  } catch (error) {
    self.postMessage(`parent worker failed: ${error.message}`);
  }
};
