/**
 * Hand-assembled WebAssembly fixtures.
 *
 * These are real modules, not recorded blobs: every test that uses one first
 * asserts `WebAssembly.validate` accepts it. That makes the fixture
 * self-checking -- if the encoder here is wrong, the test fails at the fixture
 * rather than quietly proving that our parser agrees with our own mistake.
 */

export function uleb(value: number): number[] {
  const out: number[] = [];
  let remaining = value >>> 0;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) byte |= 0x80;
    out.push(byte);
  } while (remaining !== 0);
  return out;
}

export function sleb(value: number): number[] {
  const out: number[] = [];
  let more = true;
  let remaining = value;
  while (more) {
    let byte = remaining & 0x7f;
    remaining >>= 7;
    const signBit = (byte & 0x40) !== 0;
    if ((remaining === 0 && !signBit) || (remaining === -1 && signBit)) more = false;
    else byte |= 0x80;
    out.push(byte);
  }
  return out;
}

/** A `vec(T)`: element count followed by the concatenated elements. */
export function vec(items: number[][]): number[] {
  return [...uleb(items.length), ...items.flat()];
}

export function section(id: number, payload: number[]): number[] {
  return [id, ...uleb(payload.length), ...payload];
}

export function name(text: string): number[] {
  const bytes = [...new TextEncoder().encode(text)];
  return [...uleb(bytes.length), ...bytes];
}

const HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

export function module(sections: number[][]): Uint8Array {
  return Uint8Array.from([...HEADER, ...sections.flat()]);
}

const I32 = 0x7f;
const F64 = 0x7c;

/**
 * A module shaped like a hashing kernel: one exported function whose body is a
 * tight loop of shifts and xors over an integer accumulator, with no floating
 * point anywhere.
 */
export function minerLikeModule(): Uint8Array {
  const body = [
    ...uleb(0), // no local declarations
    0x03, 0x40, //   loop (void)
    0x20, 0x00, //     local.get 0
    0x41, 0x07, //     i32.const 7
    0x74, //           i32.shl
    0x20, 0x00, //     local.get 0
    0x73, //           i32.xor
    0x21, 0x00, //     local.set 0
    0x20, 0x00, //     local.get 0
    0x41, 0x00, //     i32.const 0
    0x4a, //           i32.gt_s
    0x0d, 0x00, //     br_if 0   -- back edge into the loop
    0x0b, //         end
    0x20, 0x00, //   local.get 0
    0x0b, //         end
  ];

  return module([
    section(1, vec([[0x60, ...vec([[I32]]), ...vec([[I32]])]])),
    section(3, vec([[0]])),
    section(5, vec([[0x00, ...uleb(1)]])),
    section(7, vec([[...name("hash"), 0x00, ...uleb(0)]])),
    section(10, vec([[...uleb(body.length), ...body]])),
  ]);
}

/** A module shaped like ordinary compiled code: float arithmetic, no loops. */
export function benignModule(): Uint8Array {
  const f64Const = (value: number): number[] => {
    const buffer = new DataView(new ArrayBuffer(8));
    buffer.setFloat64(0, value, true);
    return [0x44, ...new Uint8Array(buffer.buffer)];
  };

  const body = [
    ...uleb(0),
    ...f64Const(1.5),
    ...f64Const(2.5),
    0xa2, // f64.mul
    0x0b, // end
  ];

  return module([
    section(1, vec([[0x60, ...vec([]), ...vec([[F64]])]])),
    section(2, vec([[...name("env"), ...name("log"), 0x00, ...uleb(0)]])),
    section(3, vec([[0]])),
    section(7, vec([[...name("compute"), 0x00, ...uleb(1)]])),
    section(10, vec([[...uleb(body.length), ...body]])),
  ]);
}
