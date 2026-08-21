/**
 * Opcode names and immediate shapes for the WebAssembly binary format.
 *
 * The immediate shape matters more than the name: a decoder that guesses an
 * operand width wrong does not produce a slightly wrong listing, it desyncs and
 * turns the rest of the function into noise. Every opcode below therefore
 * declares exactly what follows it, and anything unrecognised stops the decode
 * of that function rather than silently drifting.
 */

/** What follows an opcode byte in the instruction stream. */
export const enum Imm {
  None,
  /** `blocktype`: 0x40, a value type, or a signed type index. */
  BlockType,
  /** One u32 index (local, global, function, label, table...). */
  U32,
  /** Two u32 indices (`call_indirect`). */
  U32U32,
  /** `memarg`: alignment and offset. */
  Memarg,
  /** `br_table`: a vector of labels plus a default. */
  BrTable,
  I32,
  I64,
  F32,
  F64,
  /** A single reserved byte (`memory.size`, `memory.grow`, `atomic.fence`). */
  Byte,
  /** `select` with an explicit vector of result types. */
  SelectT,
  /** A reference type byte (`ref.null`). */
  RefType,
  /** Multi-byte opcode: read a u32 sub-opcode, then its own immediates. */
  PrefixFC,
  PrefixFD,
  PrefixFE,
}

export interface OpcodeInfo {
  name: string;
  imm: Imm;
}

const TABLE = new Array<OpcodeInfo | undefined>(0x100);

function define(code: number, name: string, imm: Imm = Imm.None): void {
  TABLE[code] = { name, imm };
}

/* Control */
define(0x00, "unreachable");
define(0x01, "nop");
define(0x02, "block", Imm.BlockType);
define(0x03, "loop", Imm.BlockType);
define(0x04, "if", Imm.BlockType);
define(0x05, "else");
define(0x0b, "end");
define(0x0c, "br", Imm.U32);
define(0x0d, "br_if", Imm.U32);
define(0x0e, "br_table", Imm.BrTable);
define(0x0f, "return");
define(0x10, "call", Imm.U32);
define(0x11, "call_indirect", Imm.U32U32);

/* Parametric */
define(0x1a, "drop");
define(0x1b, "select");
define(0x1c, "select", Imm.SelectT);

/* Variables and tables */
define(0x20, "local.get", Imm.U32);
define(0x21, "local.set", Imm.U32);
define(0x22, "local.tee", Imm.U32);
define(0x23, "global.get", Imm.U32);
define(0x24, "global.set", Imm.U32);
define(0x25, "table.get", Imm.U32);
define(0x26, "table.set", Imm.U32);

/* Memory access -- every one of these takes a memarg */
const MEMORY_OPS = [
  "i32.load", "i64.load", "f32.load", "f64.load",
  "i32.load8_s", "i32.load8_u", "i32.load16_s", "i32.load16_u",
  "i64.load8_s", "i64.load8_u", "i64.load16_s", "i64.load16_u",
  "i64.load32_s", "i64.load32_u",
  "i32.store", "i64.store", "f32.store", "f64.store",
  "i32.store8", "i32.store16", "i64.store8", "i64.store16", "i64.store32",
];
MEMORY_OPS.forEach((name, index) => define(0x28 + index, name, Imm.Memarg));
define(0x3f, "memory.size", Imm.Byte);
define(0x40, "memory.grow", Imm.Byte);

/* Constants */
define(0x41, "i32.const", Imm.I32);
define(0x42, "i64.const", Imm.I64);
define(0x43, "f32.const", Imm.F32);
define(0x44, "f64.const", Imm.F64);

/* Numeric -- a dense run from 0x45 to 0xc4, none of which take immediates */
const NUMERIC_OPS = [
  "i32.eqz", "i32.eq", "i32.ne", "i32.lt_s", "i32.lt_u", "i32.gt_s", "i32.gt_u",
  "i32.le_s", "i32.le_u", "i32.ge_s", "i32.ge_u",
  "i64.eqz", "i64.eq", "i64.ne", "i64.lt_s", "i64.lt_u", "i64.gt_s", "i64.gt_u",
  "i64.le_s", "i64.le_u", "i64.ge_s", "i64.ge_u",
  "f32.eq", "f32.ne", "f32.lt", "f32.gt", "f32.le", "f32.ge",
  "f64.eq", "f64.ne", "f64.lt", "f64.gt", "f64.le", "f64.ge",
  "i32.clz", "i32.ctz", "i32.popcnt", "i32.add", "i32.sub", "i32.mul",
  "i32.div_s", "i32.div_u", "i32.rem_s", "i32.rem_u",
  "i32.and", "i32.or", "i32.xor", "i32.shl", "i32.shr_s", "i32.shr_u",
  "i32.rotl", "i32.rotr",
  "i64.clz", "i64.ctz", "i64.popcnt", "i64.add", "i64.sub", "i64.mul",
  "i64.div_s", "i64.div_u", "i64.rem_s", "i64.rem_u",
  "i64.and", "i64.or", "i64.xor", "i64.shl", "i64.shr_s", "i64.shr_u",
  "i64.rotl", "i64.rotr",
  "f32.abs", "f32.neg", "f32.ceil", "f32.floor", "f32.trunc", "f32.nearest",
  "f32.sqrt", "f32.add", "f32.sub", "f32.mul", "f32.div", "f32.min", "f32.max",
  "f32.copysign",
  "f64.abs", "f64.neg", "f64.ceil", "f64.floor", "f64.trunc", "f64.nearest",
  "f64.sqrt", "f64.add", "f64.sub", "f64.mul", "f64.div", "f64.min", "f64.max",
  "f64.copysign",
  "i32.wrap_i64", "i32.trunc_f32_s", "i32.trunc_f32_u", "i32.trunc_f64_s",
  "i32.trunc_f64_u", "i64.extend_i32_s", "i64.extend_i32_u", "i64.trunc_f32_s",
  "i64.trunc_f32_u", "i64.trunc_f64_s", "i64.trunc_f64_u",
  "f32.convert_i32_s", "f32.convert_i32_u", "f32.convert_i64_s",
  "f32.convert_i64_u", "f32.demote_f64",
  "f64.convert_i32_s", "f64.convert_i32_u", "f64.convert_i64_s",
  "f64.convert_i64_u", "f64.promote_f32",
  "i32.reinterpret_f32", "i64.reinterpret_f64", "f32.reinterpret_i32",
  "f64.reinterpret_i64",
  "i32.extend8_s", "i32.extend16_s", "i64.extend8_s", "i64.extend16_s",
  "i64.extend32_s",
];
NUMERIC_OPS.forEach((name, index) => define(0x45 + index, name));

/* Reference types */
define(0xd0, "ref.null", Imm.RefType);
define(0xd1, "ref.is_null");
define(0xd2, "ref.func", Imm.U32);

/* Multi-byte prefixes */
define(0xfc, "", Imm.PrefixFC);
define(0xfd, "", Imm.PrefixFD);
define(0xfe, "", Imm.PrefixFE);

export function lookup(opcode: number): OpcodeInfo | undefined {
  return TABLE[opcode];
}

/** Names for the 0xFC (bulk memory and saturating conversion) sub-opcodes. */
export const FC_NAMES: Readonly<Record<number, string>> = {
  0: "i32.trunc_sat_f32_s", 1: "i32.trunc_sat_f32_u",
  2: "i32.trunc_sat_f64_s", 3: "i32.trunc_sat_f64_u",
  4: "i64.trunc_sat_f32_s", 5: "i64.trunc_sat_f32_u",
  6: "i64.trunc_sat_f64_s", 7: "i64.trunc_sat_f64_u",
  8: "memory.init", 9: "data.drop", 10: "memory.copy", 11: "memory.fill",
  12: "table.init", 13: "elem.drop", 14: "table.copy", 15: "table.grow",
  16: "table.size", 17: "table.fill",
};

/**
 * 0xFD (SIMD) sub-opcodes that carry a memarg, and those that additionally
 * carry a lane index. Everything else in the SIMD space takes either nothing,
 * 16 immediate bytes (`v128.const`, `i8x16.shuffle`) or a single lane byte.
 */
export const FD_MEMARG = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 92, 93]);
export const FD_MEMARG_LANE = new Set([84, 85, 86, 87, 88, 89, 90, 91]);
export const FD_SIXTEEN_BYTES = new Set([12, 13]);
/** `*.extract_lane` / `*.replace_lane`: one lane index byte. */
export const FD_LANE = new Set([21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34]);

export const FD_NAMES: Readonly<Record<number, string>> = {
  0: "v128.load", 11: "v128.store", 12: "v128.const", 13: "i8x16.shuffle",
  14: "i8x16.swizzle", 15: "i8x16.splat", 16: "i16x8.splat", 17: "i32x4.splat",
  18: "i64x2.splat", 19: "f32x4.splat", 20: "f64x2.splat",
  77: "v128.not", 78: "v128.and", 80: "v128.or", 81: "v128.xor",
  92: "v128.load32_zero", 93: "v128.load64_zero",
};

/** 0xFE (threads) sub-opcodes. Only `atomic.fence` breaks the memarg pattern. */
export const FE_NAMES: Readonly<Record<number, string>> = {
  0: "memory.atomic.notify", 1: "memory.atomic.wait32", 2: "memory.atomic.wait64",
  3: "atomic.fence",
  16: "i32.atomic.load", 17: "i64.atomic.load",
  30: "i32.atomic.store", 31: "i64.atomic.store",
  36: "i32.atomic.rmw.add", 37: "i64.atomic.rmw.add",
  72: "i32.atomic.rmw.cmpxchg", 73: "i64.atomic.rmw.cmpxchg",
};
