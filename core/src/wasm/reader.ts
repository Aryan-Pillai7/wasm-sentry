/**
 * Byte reader for the WebAssembly binary format.
 *
 * Every read is bounds-checked and throws `WasmParseError` with the offset
 * where things went wrong. Truncated and hostile modules are the normal case
 * for a security tool, not an exceptional one -- a miner that trips the parser
 * would otherwise be a miner that escapes analysis.
 */

export class WasmParseError extends Error {
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(`${message} (at offset ${offset})`);
    this.name = "WasmParseError";
    this.offset = offset;
  }
}

/** LEB128 quantities wider than this are malformed rather than merely large. */
const MAX_LEB_BYTES_32 = 5;
const MAX_LEB_BYTES_64 = 10;

export class Reader {
  readonly bytes: Uint8Array;
  offset: number;

  constructor(bytes: Uint8Array, offset = 0) {
    this.bytes = bytes;
    this.offset = offset;
  }

  get eof(): boolean {
    return this.offset >= this.bytes.length;
  }

  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  fail(message: string): never {
    throw new WasmParseError(message, this.offset);
  }

  u8(): number {
    if (this.offset >= this.bytes.length) this.fail("unexpected end of input");
    return this.bytes[this.offset++]!;
  }

  peek(): number {
    if (this.offset >= this.bytes.length) this.fail("unexpected end of input");
    return this.bytes[this.offset]!;
  }

  skip(count: number): void {
    if (count < 0 || this.offset + count > this.bytes.length) this.fail("skip past end of input");
    this.offset += count;
  }

  /** Read `count` bytes as a view onto the same buffer -- no copy. */
  take(count: number): Uint8Array {
    if (count < 0 || this.offset + count > this.bytes.length) this.fail("read past end of input");
    const view = this.bytes.subarray(this.offset, this.offset + count);
    this.offset += count;
    return view;
  }

  /** Unsigned LEB128, 32-bit. */
  u32(): number {
    let result = 0;
    let shift = 0;
    for (let i = 0; i < MAX_LEB_BYTES_32; i++) {
      const byte = this.u8();
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result >>> 0;
      shift += 7;
    }
    this.fail("LEB128 unsigned integer too long");
  }

  /** Signed LEB128, 32-bit. */
  i32(): number {
    let result = 0;
    let shift = 0;
    for (let i = 0; i < MAX_LEB_BYTES_32; i++) {
      const byte = this.u8();
      result |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) {
        // Sign-extend from the last significant bit we consumed.
        if (shift < 32 && (byte & 0x40) !== 0) result |= ~0 << shift;
        return result | 0;
      }
    }
    this.fail("LEB128 signed integer too long");
  }

  /** Signed LEB128, 64-bit, as a bigint so large constants survive intact. */
  i64(): bigint {
    let result = 0n;
    let shift = 0n;
    for (let i = 0; i < MAX_LEB_BYTES_64; i++) {
      const byte = this.u8();
      result |= BigInt(byte & 0x7f) << shift;
      shift += 7n;
      if ((byte & 0x80) === 0) {
        if (shift < 64n && (byte & 0x40) !== 0) result -= 1n << shift;
        return BigInt.asIntN(64, result);
      }
    }
    this.fail("LEB128 signed integer too long");
  }

  f32(): number {
    const view = this.take(4);
    return new DataView(view.buffer, view.byteOffset, 4).getFloat32(0, true);
  }

  f64(): number {
    const view = this.take(8);
    return new DataView(view.buffer, view.byteOffset, 8).getFloat64(0, true);
  }

  /** A length-prefixed UTF-8 name. */
  name(): string {
    const length = this.u32();
    return new TextDecoder("utf-8", { fatal: false }).decode(this.take(length));
  }

  /** Read a `vec(T)`: a u32 count followed by that many elements. */
  vec<T>(read: (reader: Reader) => T): T[] {
    const count = this.u32();
    // A count larger than the bytes remaining cannot be honest, and allocating
    // for it is how a 20-byte file turns into an out-of-memory crash.
    if (count > this.remaining) this.fail(`vector length ${count} exceeds remaining input`);
    const items: T[] = new Array<T>(count);
    for (let i = 0; i < count; i++) items[i] = read(this);
    return items;
  }
}
