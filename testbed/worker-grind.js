/**
 * Runs a real compute kernel for a real length of time.
 *
 * Every other fixture in this directory computes nothing on purpose. This one
 * has to actually spin, because what Phase 4 measures is how long a module runs
 * -- and a loop that exits on its first pass measures nothing. The kernel is
 * still pointless work: it rotates and xors an accumulator and returns it.
 *
 * The page starts several of these, which is the shape being looked for. One
 * worker at full tilt is a codec; every core at full tilt for half a minute is
 * a decision somebody made about your machine.
 */
self.onmessage = async (event) => {
  const seconds = Number(event.data?.seconds ?? 25);
  try {
    const response = await fetch("sustained-kernel.wasm");
    const { instance } = await WebAssembly.instantiateStreaming(response, {
      pool: { websocket_send: () => {} },
    });

    // Called in slices rather than one enormous call: a miner does the same, so
    // that it can poll for new work, and it keeps the worker responsive enough
    // to answer when the page asks it to stop.
    const until = Date.now() + seconds * 1000;
    let rounds = 0;
    while (Date.now() < until) {
      instance.exports.grind(400_000);
      rounds++;
    }
    self.postMessage(`ground for ${seconds}s in ${rounds} slices`);
  } catch (error) {
    self.postMessage(`grind failed: ${error.message}`);
  }
};
