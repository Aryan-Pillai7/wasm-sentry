/**
 * Module structure parsing.
 *
 * Walks the section list and reconstructs the module's declared shape: types,
 * imports, exports, memory, globals, and the location of every function body.
 * Function bodies themselves are decoded lazily by `disassemble()`, because a
 * 5 MB module has a few thousand functions and the heuristics only ever need
 * some of them.
 *
 * A section that fails to parse is recorded as a warning and skipped -- its
 * length is known, so one malformed section costs one section, not the module.
 * Malformed input is the normal case here, not the exception.
 */
import { Reader, WasmParseError } from "./reader.js";
import { skipExpression } from "./decode.js";

export type ValType = "i32" | "i64" | "f32" | "f64" | "v128" | "funcref" | "externref" | "?";

export interface FuncType {
  params: ValType[];
  results: ValType[];
}

export interface Limits {
  min: number;
  max?: number;
  shared: boolean;
}

export type ExternKind = "func" | "table" | "memory" | "global";

export interface ImportEntry {
  module: string;
  name: string;
  kind: ExternKind;
  /** Type index, for `func` imports. */
  typeIndex?: number;
  /** Declared limits, for `table` and `memory` imports. */
  limits?: Limits;
  /** Value type and mutability, for `global` imports. */
  valType?: ValType;
  mutable?: boolean;
}

export interface ExportEntry {
  name: string;
  kind: ExternKind;
  index: number;
}

export interface GlobalEntry {
  valType: ValType;
  mutable: boolean;
}

export interface TableEntry {
  refType: ValType;
  limits: Limits;
}

/** Where a function body lives, so it can be decoded on demand. */
export interface CodeEntry {
  /** Index into the module's defined functions (imports excluded). */
  index: number;
  typeIndex: number;
  locals: Array<{ count: number; type: ValType }>;
  /** Total declared locals, imports of the count fields above. */
  localCount: number;
  bodyStart: number;
  bodyEnd: number;
}

export interface CustomSection {
  name: string;
  byteLength: number;
}

export interface WasmModule {
  version: number;
  types: FuncType[];
  imports: ImportEntry[];
  /** Type index for each locally defined function. */
  functions: number[];
  tables: TableEntry[];
  memories: Limits[];
  globals: GlobalEntry[];
  exports: ExportEntry[];
  start?: number;
  elementSegments: number;
  dataSegments: number;
  /** Total bytes in the data section -- large values mean an embedded payload. */
  dataSectionBytes: number;
  code: CodeEntry[];
  customSections: CustomSection[];
  /** Sections that could not be parsed, with the reason. */
  warnings: string[];
  /** The module's own bytes, needed to decode bodies later. */
  bytes: Uint8Array;
}

const VALTYPES: Readonly<Record<number, ValType>> = {
  0x7f: "i32",
  0x7e: "i64",
  0x7d: "f32",
  0x7c: "f64",
  0x7b: "v128",
  0x70: "funcref",
  0x6f: "externref",
};

function valType(reader: Reader): ValType {
  const byte = reader.u8();
  return VALTYPES[byte] ?? "?";
}

function limits(reader: Reader): Limits {
  const flags = reader.u8();
  const min = reader.u32();
  const shared = (flags & 0x02) !== 0;
  // Bit 0 signals a maximum; bit 1 signals a shared memory, which only appears
  // with the threads proposal and is a prerequisite for worker-based mining.
  if ((flags & 0x01) !== 0) return { min, max: reader.u32(), shared };
  return { min, shared };
}

function funcType(reader: Reader): FuncType {
  const form = reader.u8();
  if (form !== 0x60) reader.fail(`expected function type 0x60, found 0x${form.toString(16)}`);
  return {
    params: reader.vec(valType),
    results: reader.vec(valType),
  };
}

const EXTERN_KINDS: Readonly<Record<number, ExternKind>> = {
  0x00: "func",
  0x01: "table",
  0x02: "memory",
  0x03: "global",
};

/** Parse a module's sections. Throws only if the header itself is not a module. */
export function parseModule(bytes: Uint8Array): WasmModule {
  const reader = new Reader(bytes);

  const magic = reader.take(4);
  if (magic[0] !== 0x00 || magic[1] !== 0x61 || magic[2] !== 0x73 || magic[3] !== 0x6d) {
    throw new WasmParseError("not a WebAssembly module", 0);
  }
  const version = new DataView(bytes.buffer, bytes.byteOffset + 4, 4).getUint32(0, true);

  const module: WasmModule = {
    version,
    types: [],
    imports: [],
    functions: [],
    tables: [],
    memories: [],
    globals: [],
    exports: [],
    elementSegments: 0,
    dataSegments: 0,
    dataSectionBytes: 0,
    code: [],
    customSections: [],
    warnings: [],
    bytes,
  };
  reader.offset = 8;

  while (!reader.eof) {
    // The section header itself can be malformed. Losing it means we no longer
    // know where the next section begins, so there is nothing to resynchronise
    // on and the walk has to stop -- but with a warning, and with every section
    // parsed so far intact.
    let sectionId: number;
    let sectionSize: number;
    try {
      sectionId = reader.u8();
      sectionSize = reader.u32();
    } catch (error) {
      module.warnings.push(
        `malformed section header: ${error instanceof Error ? error.message : String(error)}`,
      );
      break;
    }
    const sectionStart = reader.offset;
    const sectionEnd = sectionStart + sectionSize;
    if (sectionEnd > bytes.length) {
      module.warnings.push(`section ${sectionId} claims ${sectionSize} bytes past end of module`);
      break;
    }

    try {
      parseSection(module, reader, sectionId, sectionEnd);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      module.warnings.push(`section ${sectionId}: ${reason}`);
    }

    // Always resynchronise on the declared boundary, whether the section parsed
    // cleanly, stopped short, or overran into the next one.
    reader.offset = sectionEnd;
  }

  return module;
}

function parseSection(
  module: WasmModule,
  reader: Reader,
  sectionId: number,
  sectionEnd: number,
): void {
  switch (sectionId) {
    case 0: {
      const name = reader.name();
      module.customSections.push({ name, byteLength: sectionEnd - reader.offset });
      break;
    }

    case 1:
      module.types = reader.vec(funcType);
      break;

    case 2:
      module.imports = reader.vec((r): ImportEntry => {
        const moduleName = r.name();
        const name = r.name();
        const kindByte = r.u8();
        const kind = EXTERN_KINDS[kindByte];
        if (kind === undefined) {
          throw new WasmParseError(`unknown import kind 0x${kindByte.toString(16)}`, r.offset);
        }
        switch (kind) {
          case "func":
            return { module: moduleName, name, kind, typeIndex: r.u32() };
          case "table": {
            const refType = valType(r);
            return { module: moduleName, name, kind, valType: refType, limits: limits(r) };
          }
          case "memory":
            return { module: moduleName, name, kind, limits: limits(r) };
          case "global": {
            const type = valType(r);
            return { module: moduleName, name, kind, valType: type, mutable: r.u8() === 1 };
          }
        }
      });
      break;

    case 3:
      module.functions = reader.vec((r) => r.u32());
      break;

    case 4:
      module.tables = reader.vec((r) => ({ refType: valType(r), limits: limits(r) }));
      break;

    case 5:
      module.memories = reader.vec(limits);
      break;

    case 6:
      module.globals = reader.vec((r): GlobalEntry => {
        const type = valType(r);
        const mutable = r.u8() === 1;
        skipExpression(r, sectionEnd);
        return { valType: type, mutable };
      });
      break;

    case 7:
      module.exports = reader.vec((r): ExportEntry => {
        const name = r.name();
        const kindByte = r.u8();
        const kind = EXTERN_KINDS[kindByte];
        if (kind === undefined) {
          throw new WasmParseError(`unknown export kind 0x${kindByte.toString(16)}`, r.offset);
        }
        return { name, kind, index: r.u32() };
      });
      break;

    case 8:
      module.start = reader.u32();
      break;

    case 9:
      // Element segment contents are only needed for indirect-call resolution,
      // which is Phase 3 work; the count alone is a useful structural feature.
      module.elementSegments = reader.u32();
      break;

    case 10:
      parseCodeSection(module, reader);
      break;

    case 11:
      module.dataSegments = reader.u32();
      module.dataSectionBytes = sectionEnd - reader.offset;
      break;

    case 12:
      // Data count section: a redundant declaration used for validation.
      reader.u32();
      break;

    default:
      module.warnings.push(`unknown section id ${sectionId}`);
  }
}

function parseCodeSection(module: WasmModule, reader: Reader): void {
  const count = reader.u32();
  if (count > reader.remaining) reader.fail(`code section declares ${count} bodies`);

  for (let index = 0; index < count; index++) {
    const size = reader.u32();
    const bodyStart = reader.offset;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > module.bytes.length) {
      module.warnings.push(`function body ${index} runs past end of module`);
      return;
    }

    const locals = reader.vec((r) => ({ count: r.u32(), type: valType(r) }));
    const localCount = locals.reduce((sum, group) => sum + group.count, 0);

    module.code.push({
      index,
      typeIndex: module.functions[index] ?? -1,
      locals,
      localCount,
      bodyStart: reader.offset,
      bodyEnd,
    });

    reader.offset = bodyEnd;
  }
}

/** Number of imported functions, which offsets every function index. */
export function importedFunctionCount(module: WasmModule): number {
  return module.imports.filter((entry) => entry.kind === "func").length;
}
