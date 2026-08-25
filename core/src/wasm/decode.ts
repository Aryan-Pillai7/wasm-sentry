/**
 * Instruction decoding.
 *
 * The decoder is deliberately total: it either returns a faithful instruction
 * list or stops at the first byte it cannot account for and says so. It never
 * guesses an operand width, because a wrong guess desynchronises the stream and
 * every instruction after it becomes fiction -- which for a detector means
 * inventing evidence.
 */
import { Reader } from "./reader.js";
import {
  FC_NAMES,
  FD_LANE,
  FD_MEMARG,
  FD_MEMARG_LANE,
  FD_NAMES,
  FD_SIXTEEN_BYTES,
  FE_NAMES,
  Imm,
  lookup,
} from "./opcodes.js";

export interface Instruction {
  /** Offset of the opcode byte within the module. */
  offset: number;
  /** Primary opcode byte; 0xFC/0xFD/0xFE for the multi-byte families. */
  opcode: number;
  /** Sub-opcode, for the multi-byte families. */
  sub?: number;
  name: string;
  /** Integer immediates in order: indices, memarg align/offset, lane index. */
  args: number[];
  /** `i64.const` operand, kept exact. */
  big?: bigint;
  /** `f32.const` / `f64.const` operand. */
  float?: number;
  /** `br_table` branch targets, excluding the default (which is last in args). */
  targets?: number[];
}

export interface DecodeResult {
  instructions: Instruction[];
  /** Set when decoding stopped early; the instruction list is still valid. */
  truncated?: string;
}

/** Read a `memarg`: alignment exponent followed by offset. */
function memarg(reader: Reader, into: number[]): void {
  const align = reader.u32();
  into.push(align, reader.u32());
  // Bit 6 of the alignment field flags an explicit memory index (multi-memory).
  if ((align & 0x40) !== 0) into.push(reader.u32());
}

function decodePrefixFC(reader: Reader, instruction: Instruction): void {
  const sub = reader.u32();
  instruction.sub = sub;
  instruction.name = FC_NAMES[sub] ?? `fc.unknown_${sub}`;
  switch (sub) {
    case 8: // memory.init dataidx memidx
    case 12: // table.init elemidx tableidx
    case 14: // table.copy dst src
      instruction.args.push(reader.u32(), reader.u32());
      break;
    case 9: // data.drop
    case 13: // elem.drop
    case 15: // table.grow
    case 16: // table.size
    case 17: // table.fill
      instruction.args.push(reader.u32());
      break;
    case 10: // memory.copy: two memory indices
      instruction.args.push(reader.u32(), reader.u32());
      break;
    case 11: // memory.fill: one memory index
      instruction.args.push(reader.u32());
      break;
    default:
      if (sub > 7) reader.fail(`unknown 0xfc sub-opcode ${sub}`);
      break; // 0..7 are the saturating conversions: no immediates
  }
}

function decodePrefixFD(reader: Reader, instruction: Instruction): void {
  const sub = reader.u32();
  instruction.sub = sub;
  instruction.name = FD_NAMES[sub] ?? `v128.op_${sub}`;
  if (FD_MEMARG.has(sub)) {
    memarg(reader, instruction.args);
  } else if (FD_MEMARG_LANE.has(sub)) {
    memarg(reader, instruction.args);
    instruction.args.push(reader.u8());
  } else if (FD_SIXTEEN_BYTES.has(sub)) {
    reader.skip(16);
  } else if (FD_LANE.has(sub)) {
    instruction.args.push(reader.u8());
  }
  // Every other SIMD opcode is operand-free.
}

function decodePrefixFE(reader: Reader, instruction: Instruction): void {
  const sub = reader.u32();
  instruction.sub = sub;
  instruction.name = FE_NAMES[sub] ?? `atomic.op_${sub}`;
  if (sub === 3) reader.u8(); // atomic.fence: one reserved byte
  else memarg(reader, instruction.args);
}

/** Decode exactly one instruction, advancing the reader past its immediates. */
export function decodeInstruction(reader: Reader): Instruction {
  const offset = reader.offset;
  const opcode = reader.u8();
  const info = lookup(opcode);
  if (!info) {
    reader.offset = offset;
    reader.fail(`unknown opcode 0x${opcode.toString(16).padStart(2, "0")}`);
  }

  const instruction: Instruction = { offset, opcode, name: info.name, args: [] };

  switch (info.imm) {
    case Imm.None:
      break;
    case Imm.BlockType: {
      // 0x40 is "no result"; a negative value is an inline value type; a
      // non-negative one indexes the type section.
      const byte = reader.peek();
      if (byte === 0x40 || (byte >= 0x6f && byte <= 0x7f)) instruction.args.push(reader.u8());
      else instruction.args.push(reader.i32());
      break;
    }
    case Imm.U32:
      instruction.args.push(reader.u32());
      break;
    case Imm.U32U32:
      instruction.args.push(reader.u32(), reader.u32());
      break;
    case Imm.Memarg:
      memarg(reader, instruction.args);
      break;
    case Imm.BrTable: {
      instruction.targets = reader.vec((r) => r.u32());
      instruction.args.push(reader.u32()); // default label
      break;
    }
    case Imm.I32:
      instruction.args.push(reader.i32());
      break;
    case Imm.I64:
      instruction.big = reader.i64();
      break;
    case Imm.F32:
      instruction.float = reader.f32();
      break;
    case Imm.F64:
      instruction.float = reader.f64();
      break;
    case Imm.Byte:
      instruction.args.push(reader.u8());
      break;
    case Imm.SelectT:
      // Not `.push(...vec)`: spreading a large array into a single call is a
      // known V8 pathology (an "arguments list", not a normal append) and
      // was observed to blow past several GB on a corrupt module where a
      // garbage byte stream got misread as a huge vec count here.
      for (const type of reader.vec((r) => r.u8())) instruction.args.push(type);
      break;
    case Imm.RefType:
      instruction.args.push(reader.u8());
      break;
    case Imm.PrefixFC:
      decodePrefixFC(reader, instruction);
      break;
    case Imm.PrefixFD:
      decodePrefixFD(reader, instruction);
      break;
    case Imm.PrefixFE:
      decodePrefixFE(reader, instruction);
      break;
  }

  return instruction;
}

/**
 * Decode instructions until `end`, or until the structured `end` opcode that
 * closes the outermost block -- whichever comes first.
 *
 * `maxInstructions` bounds a single call, not just the caller's running
 * total: `end` is only checked against the declared body size, which for a
 * corrupt or hostile module can span nearly the entire file while still
 * passing that check. Without an in-loop cap, one such function decodes
 * millions of instructions before the caller's own budget check ever runs
 * again -- observed directly: a 9.4MB malformed module (rejected by
 * `WebAssembly.validate`) drove this loop past 8GB of live objects in one
 * call. `Infinity` preserves the old unbounded behaviour for callers that
 * don't pass a limit.
 */
export function decodeExpression(reader: Reader, end: number, maxInstructions = Infinity): DecodeResult {
  const instructions: Instruction[] = [];
  let depth = 0;

  while (reader.offset < end) {
    if (instructions.length >= maxInstructions) {
      return { instructions, truncated: `exceeded ${maxInstructions} instructions in a single function` };
    }

    let instruction: Instruction;
    try {
      instruction = decodeInstruction(reader);
    } catch (error) {
      return {
        instructions,
        truncated: error instanceof Error ? error.message : String(error),
      };
    }
    instructions.push(instruction);

    if (instruction.name === "block" || instruction.name === "loop" || instruction.name === "if") {
      depth++;
    } else if (instruction.name === "end") {
      if (depth === 0) break; // closed the function body
      depth--;
    }
  }

  return { instructions };
}

/**
 * Skip a constant expression (global initialisers, segment offsets) without
 * building an instruction list for it.
 */
export function skipExpression(reader: Reader, end: number): void {
  let depth = 0;
  while (reader.offset < end) {
    const instruction = decodeInstruction(reader);
    if (instruction.name === "block" || instruction.name === "loop" || instruction.name === "if") {
      depth++;
    } else if (instruction.name === "end") {
      if (depth === 0) return;
      depth--;
    }
  }
  reader.fail("constant expression is not terminated");
}
