import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import { isGradableManipulative } from "../authoring";
import { isSolved } from "../logic";
import {
  bridgingOxygens,
  MAX_MOLECULE_HEAVY_ATOMS,
  moleculeAtomLabelVisible,
  moleculeDrawList,
  moleculeFormula,
  moleculeHighlightSelection,
  parseMolfile,
  ringComposition,
  rings,
  validateMolecule,
} from "../molecule";
import type { MoleculeSpec } from "../types";
import { validateManipulativeSpec } from "../validate";

const sucroseSdf = readFileSync(
  new URL("./fixtures/sucrose-2d.sdf", import.meta.url),
  "utf8",
);
const glucoseSdf = readFileSync(
  new URL("./fixtures/glucose-2d.sdf", import.meta.url),
  "utf8",
);
const galactoseSdf = readFileSync(
  new URL("./fixtures/galactose-2d.sdf", import.meta.url),
  "utf8",
);
const lAlanineSdf = readFileSync(
  new URL("./fixtures/l-alanine-2d.sdf", import.meta.url),
  "utf8",
);

function atomLine(x: number, y: number, el = "C"): string {
  return `${x.toFixed(4).padStart(10)}${y.toFixed(4).padStart(10)}${"0.0000".padStart(10)} ${el.padEnd(3)} 0  0  0  0  0  0  0  0  0  0  0  0`;
}

function bondLine(a: number, b: number, order = 1, stereo = 0): string {
  return `${String(a).padStart(3)}${String(b).padStart(3)}${String(order).padStart(3)}${String(stereo).padStart(3)}  0  0  0`;
}

function molfile(
  atoms: Array<{ x: number; y: number; el?: string }>,
  bonds: Array<{ a: number; b: number; order?: number; stereo?: number }>,
): string {
  return [
    "Rabbithole fixture",
    "  molecule.test",
    "",
    `${String(atoms.length).padStart(3)}${String(bonds.length).padStart(3)}  0  0  0  0            999 V2000`,
    ...atoms.map((atom) => atomLine(atom.x, atom.y, atom.el)),
    ...bonds.map((bond) =>
      bondLine(bond.a, bond.b, bond.order, bond.stereo),
    ),
    "M  END",
    "",
  ].join("\n");
}

function ringMolfile(size: number): string {
  const atoms = Array.from({ length: size }, (_, index) => {
    const angle = (index / size) * Math.PI * 2;
    return { x: Math.cos(angle), y: Math.sin(angle) };
  });
  const bonds = Array.from({ length: size }, (_, index) => ({
    a: index + 1,
    b: ((index + 1) % size) + 1,
  }));
  return molfile(atoms, bonds);
}

function fusedBicyclicMolfile(): string {
  const atoms = Array.from({ length: 10 }, (_, index) => ({
    x: index % 5,
    y: Math.floor(index / 5),
  }));
  const bonds = [
    [1, 2],
    [2, 3],
    [3, 4],
    [4, 5],
    [5, 6],
    [6, 1],
    [3, 7],
    [7, 8],
    [8, 9],
    [9, 10],
    [10, 4],
  ].map(([a, b]) => ({ a, b }));
  return molfile(atoms, bonds);
}

describe("PubChem V2000 molecule parsing", () => {
  test("parses and mechanically checks the checked-in sucrose structure", () => {
    const molecule = parseMolfile(sucroseSdf);
    const compositions = rings(molecule)
      .map((ring) => ringComposition(molecule, ring))
      .sort();

    expect(molecule.atoms).toHaveLength(45);
    expect(molecule.bonds).toHaveLength(46);
    expect(moleculeFormula(molecule)).toBe("C12H22O11");
    expect(compositions).toContain("C5O1");
    expect(compositions).toContain("C4O1");
    expect(bridgingOxygens(molecule)).toHaveLength(1);
    expect(
      moleculeDrawList(molecule).ops.filter((op) => op.op === "atom"),
    ).toHaveLength(23);
  });

  test("carries wedge/hash stereo into distinct glucose and galactose draw lists", () => {
    const glucose = parseMolfile(glucoseSdf);
    const galactose = parseMolfile(galactoseSdf);

    expect(glucose.bonds.some((bond) => bond.stereo === "up")).toBe(true);
    expect(glucose.bonds.some((bond) => bond.stereo === "down")).toBe(true);
    const glucoseDraw = moleculeDrawList(glucose);
    expect(glucoseDraw).not.toEqual(moleculeDrawList(galactose));
    expect(
      glucoseDraw.ops.some((op) => op.op === "polygon"),
    ).toBe(true);
    const hashedBond = glucose.bonds.findIndex(
      (bond) => bond.stereo === "down",
    );
    expect(
      glucoseDraw.ops.filter(
        (op) => op.op === "line" && op.bondIndex === hashedBond,
      ),
    ).toHaveLength(6);
  });

  test("renders the V2000 either stereo flag and refuses unknown flags", () => {
    const either = parseMolfile(
      molfile(
        [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
        ],
        [{ a: 1, b: 2, stereo: 4 }],
      ),
    );
    expect(either.bonds[0].stereo).toBe("either");
    expect(
      moleculeDrawList(either).ops.filter((op) => op.op === "line").length,
    ).toBeGreaterThan(1);

    expect(() =>
      parseMolfile(
        molfile(
          [
            { x: 0, y: 0 },
            { x: 1, y: 0 },
          ],
          [{ a: 1, b: 2, stereo: 3 }],
        ),
      ),
    ).toThrow(/unsupported V2000 stereo flag 3/);
  });

  test("keeps a stereo-bond hydrogen while culling ordinary hydrogens", () => {
    const molecule = parseMolfile(
      molfile(
        [
          { x: 0, y: 0, el: "C" },
          { x: 1, y: 0, el: "H" },
          { x: 0, y: 1, el: "H" },
        ],
        [
          { a: 1, b: 2, stereo: 1 },
          { a: 1, b: 3 },
        ],
      ),
    );
    const drawList = moleculeDrawList(molecule);
    expect(
      drawList.ops.some(
        (op) => op.op === "polygon" && op.atoms.includes(1),
      ),
    ).toBe(true);
    expect(
      drawList.ops.some(
        (op) => op.op === "atom" && op.index === 1 && op.el === "H",
      ),
    ).toBe(true);
    expect(
      drawList.ops.some((op) => op.op === "atom" && op.index === 2),
    ).toBe(false);
  });

  test("preserves L-alanine stereo from the checked-in PubChem fixture", () => {
    const molecule = parseMolfile(lAlanineSdf);
    const stereoBond = molecule.bonds.findIndex(
      (bond) => bond.stereo === "down",
    );
    const drawList = moleculeDrawList(molecule);
    expect(moleculeFormula(molecule)).toBe("C3H7NO2");
    expect(stereoBond).toBeGreaterThanOrEqual(0);
    expect(
      drawList.ops.filter(
        (op) => op.op === "line" && op.bondIndex === stereoBond,
      ),
    ).toHaveLength(6);
  });

  test("finds bounded simple and fused rings", () => {
    expect(rings(parseMolfile(ringMolfile(7)))).toEqual([
      expect.arrayContaining([0, 1, 2, 3, 4, 5, 6]),
    ]);
    expect(rings(parseMolfile(ringMolfile(8)))).toEqual([
      expect.arrayContaining([0, 1, 2, 3, 4, 5, 6, 7]),
    ]);
    const fused = rings(parseMolfile(fusedBicyclicMolfile())).map((ring) =>
      [...ring].sort((a, b) => a - b).join(","),
    );
    expect(fused).toContain("0,1,2,3,4,5");
    expect(fused).toContain("2,3,6,7,8,9");
  });

  test("carbon toggle preserves heteroatom and stereo-hydrogen labels", () => {
    expect(moleculeAtomLabelVisible("C", false)).toBe(false);
    for (const element of ["O", "N", "S", "Cl", "H"]) {
      expect(moleculeAtomLabelVisible(element, false)).toBe(true);
    }
    expect(moleculeAtomLabelVisible("C", true)).toBe(true);
  });

  test("rejects a PubChem 404 body and invalid bond indexes", () => {
    expect(() =>
      parseMolfile(
        "PUGREST.NotFound\nNo CID found\nThe requested compound was not found",
      ),
    ).toThrow(/counts line/);

    expect(
      validateMolecule({
        atoms: [{ el: "C", x: 0, y: 0, z: 0 }],
        bonds: [{ a: 0, b: 2, order: 1, stereo: "none" }],
      }),
    ).toMatch(/outside the molecule/);
  });

  test("caps large structures and keeps molecule non-gradable", () => {
    const atoms = Array.from(
      { length: MAX_MOLECULE_HEAVY_ATOMS + 1 },
      (_, index) => ({ el: "C", x: index, y: 0, z: 0 }),
    );
    expect(
      validateMolecule(
        { atoms, bonds: [] },
        { maxHeavyAtoms: MAX_MOLECULE_HEAVY_ATOMS },
      ),
    ).toMatch(/limit is 200/);

    const sucrose = parseMolfile(sucroseSdf);
    const spec: MoleculeSpec = {
      kind: "molecule",
      id: "molecule-sucrose",
      concept: "Glycosidic bonds",
      prompt: "Find the oxygen that joins the two rings.",
      query: "sucrose",
      resolvedName: "Sucrose",
      cid: 5988,
      formula: moleculeFormula(sucrose),
      atoms: sucrose.atoms,
      bonds: sucrose.bonds,
      highlight: { kind: "bridgingOxygen" },
    };
    expect(validateManipulativeSpec(spec)).toEqual({ ok: true, spec });
    const bridge = moleculeHighlightSelection(sucrose, spec.highlight);
    expect(bridge.atomIndexes).toHaveLength(3);
    expect(bridge.bondIndexes).toHaveLength(2);
    expect(
      moleculeHighlightSelection(sucrose, { kind: "element", el: "O" })
        .atomIndexes,
    ).toHaveLength(11);
    expect(isGradableManipulative(spec)).toBe(false);
    expect(isSolved(spec, {})).toBe(false);
    expect(
      validateManipulativeSpec({ ...spec, formula: "C12H22O10" }),
    ).toEqual({
      ok: false,
      reason:
        'molecule.formula must match the structure (C12H22O11), got "C12H22O10"',
    });
  });
});
