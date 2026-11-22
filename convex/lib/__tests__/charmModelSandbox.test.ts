import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import { checkCharmModel } from "../charmModelSandbox";
import { charmModelScript } from "../charmModelCode";

// The exact three.js bytes apps run, as the action loads them.
const THREE_SOURCE = readFileSync(
  new URL("../../../public/app-kit/v2/three.iife.min.js", import.meta.url),
  "utf8",
);

/** A contract-following crate: one unit, standing on y = 0, named parts. */
const CRATE = `function build(THREE) {
  const palette = { wood: 0xb5803f, band: 0x6b4a2b };
  const root = new THREE.Group();
  root.name = "crate";
  const box = new THREE.Mesh(
    new THREE.BoxGeometry(1, 0.8, 0.8),
    new THREE.MeshStandardMaterial({ color: palette.wood, flatShading: true, roughness: 0.8 }),
  );
  box.name = "body";
  box.position.y = 0.4;
  root.add(box);
  const lid = new THREE.Mesh(
    new THREE.BoxGeometry(1.02, 0.08, 0.82),
    new THREE.MeshStandardMaterial({ color: palette.band, flatShading: true, roughness: 0.8 }),
  );
  lid.name = "lid";
  lid.position.y = 0.76;
  root.add(lid);
  return root;
}`;

const sized = (w: number, y: number) => `function build(THREE) {
  const root = new THREE.Group();
  const m = new THREE.Mesh(new THREE.BoxGeometry(${w}, ${w}, ${w}), new THREE.MeshStandardMaterial());
  m.position.y = ${y};
  root.add(m);
  return root;
}`;

describe("checkCharmModel", () => {
  test("passes a model that follows the contract and lists its parts", async () => {
    const result = await checkCharmModel(CRATE, THREE_SOURCE);
    expect(result).toMatchObject({ ok: true, meshes: 2, parts: ["body", "lid"] });
  });

  test.each([
    ["throws", "function build(THREE) { throw new Error('nope'); }", /threw: nope/],
    ["throws at load", "throw new Error('early'); function build() {}", /while loading: early/],
    ["has a syntax error", "function build(THREE) { return ( }", /failed to run/],
    ["loops forever", "function build(THREE) { while (true) {} }", /longer than/],
    ["reads process", "function build(THREE) { return process.env; }", /process is not defined/],
    [
      "climbs to the Function constructor",
      "function build(THREE) { return THREE.Group.constructor.constructor('return process')(); }",
      /disallowed/,
    ],
    ["returns a non-object", "function build(THREE) { return 42; }", /did not return a THREE object/],
    ["defines no build", "const x = 1;", /does not define a build/],
    ["is far too big", sized(5, 2.5), /largest dimension is 5/],
    ["floats above the ground", sized(1, 2), /stand on y = 0/],
    [
      "hangs the host through a Proxy thrown past its own wrapper",
      "function build(){} })(); } catch (e) {} throw new Proxy({}, { getOwnPropertyDescriptor() { for (;;) {} }, get() { for (;;) {} }, getPrototypeOf() { for (;;) {} } }); try { (function () {",
      /failed to run|longer than/,
    ],
    [
      "allocates until memory runs out",
      "function build(THREE) { var a = []; for (;;) a.push(new Array(1e6).fill(1.5)); }",
      /too much memory|longer than/,
    ],
  ])("refuses code that %s", async (_label, code, problem) => {
    const result = await checkCharmModel(code, THREE_SOURCE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toMatch(problem);
    // The Proxy case is refused only when the 5 s worker deadline kills it.
  }, 20_000);

  test("refuses too many meshes", async () => {
    const code = `function build(THREE) {
      const root = new THREE.Group();
      for (let i = 0; i < 61; i++) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(0.01, 1, 0.01), new THREE.MeshStandardMaterial());
        m.position.y = 0.5;
        root.add(m);
      }
      return root;
    }`;
    const result = await checkCharmModel(code, THREE_SOURCE);
    expect(result).toMatchObject({ ok: false, problem: expect.stringMatching(/61 meshes/) });
  });

  test("the app's script wrapper registers the same build function", () => {
    // What the app actually runs: the stored script, in a page with THREE.
    const script = charmModelScript("crate", CRATE);
    const window: { charmModels?: Record<string, unknown> } = {};
    new Function("window", script)(window);
    expect(typeof window.charmModels?.crate).toBe("function");
  });
});
