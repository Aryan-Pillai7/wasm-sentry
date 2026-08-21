/**
 * WebAssembly Text rendering.
 *
 * This is a view over the decoder's output rather than a separate tool. Shelling
 * out to WABT would mean either a native binary the extension cannot load or a
 * ~1 MB wasm build of the disassembler shipped inside a security extension, and
 * either way a second implementation of the format to keep in step with the one
 * the analysis already needs. Rendering from our own decode keeps the engine
 * dependency-free and guarantees the listing a user reads is the same decode the
 * detector reasoned about.
 */
import type { Instruction } from "./decode.js";
import type { FuncType, WasmModule } from "./module.js";

function formatType(type: FuncType): string {
  const params = type.params.length > 0 ? ` (param ${type.params.join(" ")})` : "";
  const results = type.results.length > 0 ? ` (result ${type.results.join(" ")})` : "";
  return `${params}${results}`.trim();
}

function formatOperands(instruction: Instruction): string {
  const parts: string[] = [];
  if (instruction.big !== undefined) parts.push(instruction.big.toString());
  if (instruction.float !== undefined) parts.push(String(instruction.float));
  if (instruction.targets) parts.push(...instruction.targets.map(String));
  parts.push(...instruction.args.map(String));
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

/** Render one decoded body as indented WAT instructions. */
export function instructionsToWat(instructions: readonly Instruction[]): string {
  const lines: string[] = [];
  let depth = 0;

  for (const instruction of instructions) {
    const opensBlock =
      instruction.name === "block" || instruction.name === "loop" || instruction.name === "if";
    const closesBlock = instruction.name === "end" || instruction.name === "else";

    if (closesBlock && depth > 0) depth--;
    lines.push("  ".repeat(depth) + instruction.name + formatOperands(instruction));
    if (opensBlock || instruction.name === "else") depth++;
  }

  return lines.join("\n");
}

/**
 * Render the module's declared surface: what it imports, exports, and how much
 * memory it asks for. This is the part a reviewer reads first, and for most
 * modules it is already enough to say what the thing is for.
 */
export function moduleToWatHeader(module: WasmModule): string {
  const lines: string[] = ["(module"];

  module.types.forEach((type, index) => {
    lines.push(`  (type $t${index} (func ${formatType(type)}))`);
  });

  for (const entry of module.imports) {
    const detail =
      entry.kind === "func"
        ? `(func (type $t${entry.typeIndex}))`
        : entry.kind === "memory"
          ? `(memory ${entry.limits?.min ?? 0}${entry.limits?.max !== undefined ? ` ${entry.limits.max}` : ""}${entry.limits?.shared ? " shared" : ""})`
          : entry.kind === "global"
            ? `(global ${entry.mutable ? `(mut ${entry.valType})` : entry.valType})`
            : `(table ${entry.limits?.min ?? 0} ${entry.valType})`;
    lines.push(`  (import "${entry.module}" "${entry.name}" ${detail})`);
  }

  for (const memory of module.memories) {
    const max = memory.max !== undefined ? ` ${memory.max}` : "";
    lines.push(`  (memory ${memory.min}${max}${memory.shared ? " shared" : ""})`);
  }

  module.globals.forEach((global, index) => {
    const type = global.mutable ? `(mut ${global.valType})` : global.valType;
    lines.push(`  (global $g${index} ${type})`);
  });

  for (const entry of module.exports) {
    lines.push(`  (export "${entry.name}" (${entry.kind} ${entry.index}))`);
  }

  if (module.start !== undefined) lines.push(`  (start $f${module.start})`);
  lines.push(`  ;; ${module.code.length} function bodies, ${module.dataSegments} data segments`);
  lines.push(")");
  return lines.join("\n");
}
