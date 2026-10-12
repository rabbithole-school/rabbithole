import type {
  MoleculeAtom,
  MoleculeBond,
  MoleculeBondStereo,
  MoleculeHighlight,
} from "./types";

/**
 * V1 deliberately does not interpret aromatic bond type 4 or `M CHG` charge
 * records. PubChem's 2D endpoint supplies ordinary aromatic compounds in
 * Kekule single/double form; charged structures remain an explicit limitation.
 */

export const MAX_MOLECULE_HEAVY_ATOMS = 200;
export const MAX_RING_SIZE = 8;

export interface Molecule {
  atoms: MoleculeAtom[];
  bonds: MoleculeBond[];
}

export interface MoleculePoint {
  x: number;
  y: number;
}

interface MoleculeBondDrawBase {
  atoms: [number, number];
  bondIndex: number;
}

export type MoleculeDrawOp =
  | (MoleculeBondDrawBase & {
      op: "line";
      from: MoleculePoint;
      to: MoleculePoint;
    })
  | (MoleculeBondDrawBase & {
      op: "polygon";
      points: [MoleculePoint, MoleculePoint, MoleculePoint];
    })
  | {
      op: "atom";
      at: MoleculePoint;
      el: string;
      index: number;
      bondCount: number;
    };

export interface MoleculeDrawList {
  width: number;
  height: number;
  ops: MoleculeDrawOp[];
}

export interface MoleculeHighlightSelection {
  atomIndexes: number[];
  bondIndexes: number[];
}

export class MoleculeParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoleculeParseError";
  }
}

const STEREO_BY_CODE: Record<number, MoleculeBondStereo | undefined> = {
  0: "none",
  1: "up",
  4: "either",
  6: "down",
};

function fixedInt(line: string | undefined, start: number, end: number, label: string): number {
  const raw = line?.slice(start, end).trim() ?? "";
  if (!/^\d+$/.test(raw)) {
    throw new MoleculeParseError(`${label} is missing or invalid`);
  }
  return Number(raw);
}

function fixedNumber(line: string | undefined, start: number, end: number, label: string): number {
  const raw = line?.slice(start, end).trim() ?? "";
  const value = Number(raw);
  if (!raw || !Number.isFinite(value)) {
    throw new MoleculeParseError(`${label} is missing or invalid`);
  }
  return value;
}

/** Parse the MDL molfile V2000 atom and bond blocks using their fixed columns. */
export function parseMolfile(text: string): Molecule {
  const lines = text.split(/\r?\n/);
  const counts = lines[3];
  if (!counts || !counts.includes("V2000")) {
    throw new MoleculeParseError("PubChem did not return a V2000 molfile counts line");
  }

  const atomCount = fixedInt(counts, 0, 3, "atom count");
  const bondCount = fixedInt(counts, 3, 6, "bond count");
  const requiredLines = 4 + atomCount + bondCount;
  if (lines.length < requiredLines) {
    throw new MoleculeParseError(
      `molfile ended early: expected ${atomCount} atoms and ${bondCount} bonds`,
    );
  }

  const atoms: MoleculeAtom[] = [];
  for (let i = 0; i < atomCount; i++) {
    const line = lines[4 + i];
    const el = line?.slice(31, 34).trim() ?? "";
    if (!/^[A-Z][a-z]?$/.test(el)) {
      throw new MoleculeParseError(`atom ${i + 1} has an unsupported element symbol`);
    }
    atoms.push({
      el,
      x: fixedNumber(line, 0, 10, `atom ${i + 1} x coordinate`),
      y: fixedNumber(line, 10, 20, `atom ${i + 1} y coordinate`),
      z: fixedNumber(line, 20, 30, `atom ${i + 1} z coordinate`),
    });
  }

  const bonds: MoleculeBond[] = [];
  for (let i = 0; i < bondCount; i++) {
    const line = lines[4 + atomCount + i];
    const order = fixedInt(line, 6, 9, `bond ${i + 1} order`);
    if (order !== 1 && order !== 2 && order !== 3) {
      throw new MoleculeParseError(
        `bond ${i + 1} uses unsupported V2000 order ${order}`,
      );
    }
    const stereoCode = fixedInt(line, 9, 12, `bond ${i + 1} stereo flag`);
    const stereo = STEREO_BY_CODE[stereoCode];
    if (!stereo) {
      throw new MoleculeParseError(
        `bond ${i + 1} uses unsupported V2000 stereo flag ${stereoCode}`,
      );
    }
    if (stereo !== "none" && order !== 1) {
      throw new MoleculeParseError(
        `bond ${i + 1} combines stereo flag ${stereoCode} with bond order ${order}`,
      );
    }
    bonds.push({
      a: fixedInt(line, 0, 3, `bond ${i + 1} first atom`) - 1,
      b: fixedInt(line, 3, 6, `bond ${i + 1} second atom`) - 1,
      order,
      stereo,
    });
  }

  const molecule = { atoms, bonds };
  const invalid = validateMolecule(molecule);
  if (invalid) throw new MoleculeParseError(invalid);
  return molecule;
}

/** Structural validation shared by the fetch path and stored-spec validator. */
export function validateMolecule(
  molecule: Molecule,
  options: { maxHeavyAtoms?: number } = {},
): string | null {
  if (!Array.isArray(molecule.atoms) || molecule.atoms.length === 0) {
    return "molecule must contain at least one atom";
  }
  if (!Array.isArray(molecule.bonds)) return "molecule bonds must be an array";

  for (let i = 0; i < molecule.atoms.length; i++) {
    const atom = molecule.atoms[i];
    if (
      !atom ||
      !/^[A-Z][a-z]?$/.test(atom.el) ||
      !Number.isFinite(atom.x) ||
      !Number.isFinite(atom.y) ||
      !Number.isFinite(atom.z)
    ) {
      return `atom ${i + 1} has an invalid element or coordinate`;
    }
  }

  const maxHeavyAtoms = options.maxHeavyAtoms ?? Number.POSITIVE_INFINITY;
  const heavyAtoms = molecule.atoms.filter((atom) => atom.el !== "H").length;
  if (heavyAtoms > maxHeavyAtoms) {
    return `molecule has ${heavyAtoms} heavy atoms; the limit is ${maxHeavyAtoms}`;
  }

  for (let i = 0; i < molecule.bonds.length; i++) {
    const bond = molecule.bonds[i];
    if (
      !bond ||
      !Number.isInteger(bond.a) ||
      !Number.isInteger(bond.b) ||
      bond.a < 0 ||
      bond.b < 0 ||
      bond.a >= molecule.atoms.length ||
      bond.b >= molecule.atoms.length ||
      bond.a === bond.b
    ) {
      return `bond ${i + 1} refers to an atom outside the molecule`;
    }
    if (bond.order !== 1 && bond.order !== 2 && bond.order !== 3) {
      return `bond ${i + 1} has unsupported order ${String(bond.order)}`;
    }
    if (!["none", "up", "down", "either"].includes(bond.stereo)) {
      return `bond ${i + 1} has unsupported stereo ${String(bond.stereo)}`;
    }
    if (bond.stereo !== "none" && bond.order !== 1) {
      return `bond ${i + 1} combines stereo with a non-single bond`;
    }
  }

  return null;
}

/** Molecular formula in Hill order, derived from the fetched structure data. */
export function moleculeFormula({ atoms }: Molecule): string {
  const tally = new Map<string, number>();
  for (const atom of atoms) tally.set(atom.el, (tally.get(atom.el) ?? 0) + 1);
  const hasCarbon = tally.has("C");
  const rank = (el: string) =>
    hasCarbon
      ? el === "C"
        ? "0"
        : el === "H"
          ? "1"
          : `2${el}`
      : el;
  return [...tally.entries()]
    .sort(([a], [b]) => rank(a).localeCompare(rank(b)))
    .map(([el, count]) => (count === 1 ? el : `${el}${count}`))
    .join("");
}

function adjacency(molecule: Molecule): Array<Array<{ atom: number; bond: number }>> {
  const result = molecule.atoms.map(() => [] as Array<{ atom: number; bond: number }>);
  molecule.bonds.forEach((bond, index) => {
    result[bond.a].push({ atom: bond.b, bond: index });
    result[bond.b].push({ atom: bond.a, bond: index });
  });
  return result;
}

/**
 * Finds the smallest cycle closed by each bond. The breadth-first search is
 * bounded by `maxSize` and a global step budget, so fused or highly connected
 * structures cannot turn ring perception into an unbounded DFS. This is a
 * bounded display heuristic, not a full chemical ring-basis algorithm.
 */
export function rings(molecule: Molecule, maxSize = MAX_RING_SIZE): number[][] {
  const adj = adjacency(molecule);
  const found = new Map<string, number[]>();
  let remainingSteps = Math.max(10_000, molecule.bonds.length * maxSize * 20);

  for (let excludedBond = 0; excludedBond < molecule.bonds.length; excludedBond++) {
    const bond = molecule.bonds[excludedBond];
    const queue: number[][] = [[bond.a]];
    const bestDepth = new Map<number, number>([[bond.a, 1]]);
    let cycle: number[] | null = null;

    while (queue.length > 0 && remainingSteps-- > 0) {
      const path = queue.shift()!;
      const tail = path[path.length - 1];
      if (path.length >= maxSize) continue;
      for (const edge of adj[tail]) {
        if (edge.bond === excludedBond) continue;
        if (edge.atom === bond.b && path.length >= 2) {
          cycle = [...path, bond.b];
          queue.length = 0;
          break;
        }
        if (path.includes(edge.atom)) continue;
        const nextDepth = path.length + 1;
        const seenDepth = bestDepth.get(edge.atom);
        if (seenDepth != null && seenDepth < nextDepth) continue;
        bestDepth.set(edge.atom, nextDepth);
        queue.push([...path, edge.atom]);
      }
    }

    if (cycle && cycle.length >= 3 && cycle.length <= maxSize) {
      const key = [...cycle].sort((a, b) => a - b).join(",");
      if (!found.has(key)) found.set(key, cycle);
    }
    if (remainingSteps <= 0) break;
  }

  return [...found.values()];
}

export function ringComposition(molecule: Molecule, ring: number[]): string {
  const tally = new Map<string, number>();
  for (const index of ring) {
    const el = molecule.atoms[index].el;
    tally.set(el, (tally.get(el) ?? 0) + 1);
  }
  return [...tally.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([el, count]) => `${el}${count}`)
    .join("");
}

export function bridgingOxygens(
  molecule: Molecule,
): Array<{ oxygen: number; joins: [number, number]; bonds: [number, number] }> {
  // This pedagogical finder relies on the bounded ring heuristic above. It is
  // reliable for the small sugar structures it targets, but can mis-highlight
  // large fused or bridged systems whose chemically meaningful ring basis is
  // more complex than the shortest cycles found here.
  const adj = adjacency(molecule);
  const ringSets = rings(molecule).map((ring) => new Set(ring));
  const result: Array<{
    oxygen: number;
    joins: [number, number];
    bonds: [number, number];
  }> = [];

  for (let index = 0; index < molecule.atoms.length; index++) {
    if (molecule.atoms[index].el !== "O") continue;
    if (ringSets.some((ring) => ring.has(index))) continue;
    const heavy = adj[index].filter(({ atom }) => molecule.atoms[atom].el !== "H");
    if (heavy.length !== 2) continue;
    const ringOf = (atom: number) => ringSets.findIndex((ring) => ring.has(atom));
    const firstRing = ringOf(heavy[0].atom);
    const secondRing = ringOf(heavy[1].atom);
    if (firstRing === -1 || secondRing === -1 || firstRing === secondRing) continue;
    result.push({
      oxygen: index,
      joins: [heavy[0].atom, heavy[1].atom],
      bonds: [heavy[0].bond, heavy[1].bond],
    });
  }

  return result;
}

export function moleculeHighlightSelection(
  molecule: Molecule,
  highlight?: MoleculeHighlight,
): MoleculeHighlightSelection {
  if (!highlight) return { atomIndexes: [], bondIndexes: [] };
  if (highlight.kind === "element") {
    return {
      atomIndexes: molecule.atoms
        .map((atom, index) => (atom.el === highlight.el ? index : -1))
        .filter((index) => index >= 0),
      bondIndexes: [],
    };
  }
  const bridge = bridgingOxygens(molecule)[0];
  return bridge
    ? {
        atomIndexes: [bridge.oxygen, ...bridge.joins],
        bondIndexes: [...bridge.bonds],
      }
    : { atomIndexes: [], bondIndexes: [] };
}

function offsetLine(
  from: MoleculePoint,
  to: MoleculePoint,
  offset: number,
): { from: MoleculePoint; to: MoleculePoint } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const nx = (-dy / length) * offset;
  const ny = (dx / length) * offset;
  return {
    from: { x: from.x + nx, y: from.y + ny },
    to: { x: to.x + nx, y: to.y + ny },
  };
}

/**
 * Framework-free geometry. Stereo is expanded into portable primitives here:
 * filled triangle for wedge-up, widening perpendicular dashes for hash-down,
 * and a zigzag for "either". Web and native only map these ops to SVG.
 */
export function moleculeDrawList(
  molecule: Molecule,
  options: { showHydrogens?: boolean; scale?: number } = {},
): MoleculeDrawList {
  const showHydrogens = options.showHydrogens ?? false;
  const scale = options.scale ?? 42;
  const stereoHydrogens = new Set<number>();
  for (const bond of molecule.bonds) {
    if (bond.stereo === "none") continue;
    if (molecule.atoms[bond.a].el === "H") stereoHydrogens.add(bond.a);
    if (molecule.atoms[bond.b].el === "H") stereoHydrogens.add(bond.b);
  }
  // Skeletal drawings normally omit hydrogen, except when an explicit H is the
  // endpoint of a wedge/hash/either bond: hiding it would erase the only
  // stereochemical mark and silently flatten the stereocenter.
  const keep = (index: number) =>
    showHydrogens ||
    molecule.atoms[index].el !== "H" ||
    stereoHydrogens.has(index);
  const visible = molecule.atoms
    .map((atom, index) => ({ atom, index }))
    .filter(({ index }) => keep(index));
  if (visible.length === 0) return { width: 1, height: 1, ops: [] };

  const xs = visible.map(({ atom }) => atom.x);
  const ys = visible.map(({ atom }) => atom.y);
  const minX = Math.min(...xs);
  const maxY = Math.max(...ys);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const point = (atom: MoleculeAtom): MoleculePoint => ({
    x: (atom.x - minX) * scale,
    y: (maxY - atom.y) * scale,
  });
  const adj = adjacency(molecule);
  const ops: MoleculeDrawOp[] = [];

  molecule.bonds.forEach((bond, bondIndex) => {
    if (!keep(bond.a) || !keep(bond.b)) return;
    const from = point(molecule.atoms[bond.a]);
    const to = point(molecule.atoms[bond.b]);
    const base = {
      atoms: [bond.a, bond.b] as [number, number],
      bondIndex,
    };

    if (bond.stereo === "up") {
      const wide = offsetLine(to, from, 5);
      const wideOther = offsetLine(to, from, -5);
      ops.push({
        op: "polygon",
        points: [from, wide.from, wideOther.from],
        ...base,
      });
      return;
    }

    if (bond.stereo === "down") {
      for (let step = 1; step <= 6; step++) {
        const t = step / 7;
        const center = {
          x: from.x + (to.x - from.x) * t,
          y: from.y + (to.y - from.y) * t,
        };
        const halfWidth = 0.8 + t * 4.2;
        const dash = offsetLine(center, to, halfWidth);
        const other = offsetLine(center, to, -halfWidth);
        ops.push({ op: "line", from: dash.from, to: other.from, ...base });
      }
      return;
    }

    if (bond.stereo === "either") {
      const points: MoleculePoint[] = [from];
      for (let step = 1; step < 8; step++) {
        const t = step / 8;
        const center = {
          x: from.x + (to.x - from.x) * t,
          y: from.y + (to.y - from.y) * t,
        };
        const shifted = offsetLine(center, to, step % 2 === 0 ? -2.5 : 2.5);
        points.push(shifted.from);
      }
      points.push(to);
      for (let i = 0; i < points.length - 1; i++) {
        ops.push({ op: "line", from: points[i], to: points[i + 1], ...base });
      }
      return;
    }

    const offsets =
      bond.order === 1 ? [0] : bond.order === 2 ? [-3, 3] : [-4, 0, 4];
    for (const offset of offsets) {
      const line = offsetLine(from, to, offset);
      ops.push({ op: "line", ...line, ...base });
    }
  });

  visible.forEach(({ atom, index }) => {
    ops.push({
      op: "atom",
      at: point(atom),
      el: atom.el,
      index,
      bondCount: adj[index].length,
    });
  });

  return {
    width: Math.max(1, (maxX - minX) * scale),
    height: Math.max(1, (maxY - minY) * scale),
    ops,
  };
}

const ELEMENT_NAMES: Record<string, string> = {
  B: "boron",
  Br: "bromine",
  C: "carbon",
  Ca: "calcium",
  Cl: "chlorine",
  F: "fluorine",
  Fe: "iron",
  H: "hydrogen",
  I: "iodine",
  K: "potassium",
  Mg: "magnesium",
  N: "nitrogen",
  Na: "sodium",
  O: "oxygen",
  P: "phosphorus",
  S: "sulfur",
  Si: "silicon",
  Zn: "zinc",
};

export function elementName(symbol: string): string {
  return ELEMENT_NAMES[symbol] ?? symbol;
}

/** Skeletal labels always name heteroatoms; the toggle controls carbon only. */
export function moleculeAtomLabelVisible(
  element: string,
  carbonLabelsVisible: boolean,
): boolean {
  return carbonLabelsVisible || element !== "C";
}
