/**
 * Control flow graph construction.
 *
 * WebAssembly's control flow is structured -- there is no computed goto, and
 * every branch targets an enclosing `block`, `loop` or `if` by relative depth.
 * That makes an exact CFG cheap to build in a single pass, with none of the
 * indirect-jump guesswork that makes native-binary CFG recovery expensive. It
 * is also what makes the result trustworthy enough to reason about: a loop this
 * pass reports is a loop the engine will actually execute.
 *
 * The structural facts that fall out -- loop count, nesting depth, which
 * instructions sit inside the hottest loop -- are what separate a hash inner
 * loop from a codec that happens to use the same arithmetic.
 */
import type { Instruction } from "./decode.js";

export interface BasicBlock {
  id: number;
  /** Instruction index range, half-open. */
  start: number;
  end: number;
  successors: number[];
}

export interface LoopInfo {
  /** Instruction index of the `loop` opcode. */
  header: number;
  /** Instruction index of the matching `end`. */
  end: number;
  /** Nesting depth, 0 for an outermost loop. */
  depth: number;
  /** Instructions contained in the loop body. */
  size: number;
}

export interface Cfg {
  blocks: BasicBlock[];
  /** Edges that jump backwards to a loop header. */
  backEdges: Array<{ from: number; to: number }>;
  loops: LoopInfo[];
  /** Deepest block/loop/if nesting reached anywhere in the function. */
  maxNesting: number;
  /** True when a branch could not be resolved and the graph is approximate. */
  approximate: boolean;
}

interface Frame {
  kind: "block" | "loop" | "if" | "func";
  startIndex: number;
  endIndex: number;
  depth: number;
}

const BRANCHES = new Set(["br", "br_if", "br_table"]);
const TERMINATORS = new Set(["br", "br_table", "return", "unreachable"]);

/**
 * `branchTarget` only ever reads `open[open.length - 1 - label]` for a small
 * `label` (real compiled code essentially never branches more than a few
 * levels out). Snapshotting only the innermost frames bounds the cost of
 * `openAt[index] = [...stack]` to a constant per instruction instead of
 * O(depth) -- for well-nested input `depth` is already small so this changes
 * nothing, but for a corrupt module where garbage bytes rarely decode as a
 * matching `end`, `stack` grows toward the instruction count itself, turning
 * an O(n) pass into O(n * depth). Observed directly: one real (WasmBench)
 * file that fails `WebAssembly.validate` drove this past 8GB from ~1.1M
 * instructions before this cap existed. A label deeper than the cap now
 * falls through to the existing "can't resolve" path (`frameId === undefined`
 * -> -1, treated as approximate) rather than being read exactly -- the same
 * fallback already used for any other unresolved branch.
 */
const MAX_OPEN_DEPTH = 256;

/**
 * Match every structured opcode with its `end`, and record which frames are
 * open at each instruction. One pass, so branch resolution afterwards is a
 * lookup rather than a search.
 */
function buildFrames(instructions: readonly Instruction[]): {
  frames: Frame[];
  openAt: number[][];
  maxNesting: number;
} {
  const frames: Frame[] = [
    { kind: "func", startIndex: -1, endIndex: instructions.length - 1, depth: 0 },
  ];
  const openAt: number[][] = new Array<number[]>(instructions.length);
  const stack: number[] = [0];
  let maxNesting = 0;

  for (let index = 0; index < instructions.length; index++) {
    const name = instructions[index]!.name;

    if (name === "end") {
      // The frame closes *at* this instruction, so record the stack before
      // popping -- an `end` belongs to the frame it terminates.
      openAt[index] = stack.length > MAX_OPEN_DEPTH ? stack.slice(-MAX_OPEN_DEPTH) : [...stack];
      const frameId = stack.pop();
      if (frameId !== undefined && frameId !== 0) frames[frameId]!.endIndex = index;
      else if (frameId === 0) frames[0]!.endIndex = index;
      continue;
    }

    openAt[index] = stack.length > MAX_OPEN_DEPTH ? stack.slice(-MAX_OPEN_DEPTH) : [...stack];

    if (name === "block" || name === "loop" || name === "if") {
      const frame: Frame = {
        kind: name,
        startIndex: index,
        endIndex: instructions.length - 1,
        depth: stack.length - 1,
      };
      frames.push(frame);
      stack.push(frames.length - 1);
      maxNesting = Math.max(maxNesting, stack.length - 1);
    }
  }

  return { frames, openAt, maxNesting };
}

/** Instruction index a branch to relative `label` lands on, or -1 for a return. */
function branchTarget(
  frames: readonly Frame[],
  open: readonly number[],
  label: number,
  instructionCount: number,
): number {
  const frameId = open[open.length - 1 - label];
  if (frameId === undefined) return -1; // branch past the outermost frame: a return
  const frame = frames[frameId]!;
  if (frame.kind === "func") return -1;
  // Branching to a loop re-enters it; branching to a block or if leaves it.
  if (frame.kind === "loop") return frame.startIndex;
  const after = frame.endIndex + 1;
  return after >= instructionCount ? -1 : after;
}

/** Build the control flow graph for one decoded function body. */
export function buildCfg(instructions: readonly Instruction[]): Cfg {
  if (instructions.length === 0) {
    return { blocks: [], backEdges: [], loops: [], maxNesting: 0, approximate: false };
  }

  const { frames, openAt, maxNesting } = buildFrames(instructions);
  let approximate = false;

  /* ---- leaders: the first instruction of every basic block ---- */
  const leaders = new Set<number>([0]);
  for (let index = 0; index < instructions.length; index++) {
    const instruction = instructions[index]!;
    const name = instruction.name;
    const open = openAt[index] ?? [];

    if (name === "loop" || name === "block" || name === "if" || name === "else" || name === "end") {
      leaders.add(index);
      if (index + 1 < instructions.length) leaders.add(index + 1);
    }

    if (BRANCHES.has(name)) {
      const labels = name === "br_table" ? [...(instruction.targets ?? []), ...instruction.args] : instruction.args;
      for (const label of labels) {
        const target = branchTarget(frames, open, label, instructions.length);
        if (target >= 0) leaders.add(target);
        else if (label > open.length - 1) approximate = true;
      }
    }

    if (TERMINATORS.has(name) && index + 1 < instructions.length) leaders.add(index + 1);
    if (name === "br_if" && index + 1 < instructions.length) leaders.add(index + 1);
  }

  /* ---- blocks ---- */
  const starts = [...leaders].sort((a, b) => a - b);
  const blocks: BasicBlock[] = starts.map((start, position) => ({
    id: position,
    start,
    end: starts[position + 1] ?? instructions.length,
    successors: [],
  }));
  const blockAt = new Map<number, number>(starts.map((start, position) => [start, position]));

  /* ---- edges ---- */
  const backEdges: Array<{ from: number; to: number }> = [];

  for (const block of blocks) {
    const lastIndex = block.end - 1;
    const last = instructions[lastIndex];
    if (!last) continue;
    const open = openAt[lastIndex] ?? [];

    const addEdge = (targetInstruction: number): void => {
      if (targetInstruction < 0) return; // falls out of the function
      const target = blockAt.get(targetInstruction);
      if (target === undefined) {
        approximate = true;
        return;
      }
      if (!block.successors.includes(target)) block.successors.push(target);
      if (targetInstruction <= block.start) backEdges.push({ from: block.id, to: target });
    };

    const fallthrough = (): void => addEdge(block.end < instructions.length ? block.end : -1);

    switch (last.name) {
      case "br":
        addEdge(branchTarget(frames, open, last.args[0] ?? 0, instructions.length));
        break;
      case "br_if":
        addEdge(branchTarget(frames, open, last.args[0] ?? 0, instructions.length));
        fallthrough();
        break;
      case "br_table": {
        for (const label of [...(last.targets ?? []), ...last.args]) {
          addEdge(branchTarget(frames, open, label, instructions.length));
        }
        break;
      }
      case "return":
      case "unreachable":
        break; // no successors: control leaves the function
      case "if": {
        // Taken branch falls through into the consequent; the untaken branch
        // skips to the matching `else` or past the `end`.
        fallthrough();
        const frameId = openAt[lastIndex + 1]?.at(-1);
        const frame = frameId !== undefined ? frames[frameId] : undefined;
        if (frame && frame.kind === "if") {
          let elseIndex = -1;
          for (let i = frame.startIndex + 1; i <= frame.endIndex; i++) {
            if (instructions[i]!.name === "else" && (openAt[i]?.at(-1)) === frameId) {
              elseIndex = i;
              break;
            }
          }
          addEdge(elseIndex >= 0 ? elseIndex + 1 : frame.endIndex + 1);
        }
        break;
      }
      default:
        fallthrough();
    }
  }

  /* ---- loops ---- */
  const loops: LoopInfo[] = frames
    .filter((frame): frame is Frame => frame.kind === "loop")
    .map((frame) => ({
      header: frame.startIndex,
      end: frame.endIndex,
      depth: frame.depth,
      size: frame.endIndex - frame.startIndex,
    }));

  return { blocks, backEdges, loops, maxNesting, approximate };
}
