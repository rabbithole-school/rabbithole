"use node";

// The server-side check every charm model passes before it is cached or handed
// to an app (lib/charmModelCode.ts has the contract it enforces).
//
// The code is model-written, and the model's input includes a child's words,
// so treat the code as hostile. Two walls:
//
//  1. A `vm` context that holds NOTHING from the outer realm: three.js itself
//     is evaluated inside it from the same app-kit bytes the app runs, so no
//     object's `constructor.constructor` leads back to `process`. String code
//     generation (eval, new Function) is off and microtasks drain inside the
//     vm timeout.
//  2. That context lives in a throwaway worker thread with a capped heap,
//     which the action kills on a wall-clock deadline. Review of the first
//     version (vm in the action itself) showed why both are needed: code can
//     close its own wrapper and throw a Proxy whose traps run when the host
//     inspects the error, outside any vm timeout, and a vm has no heap cap, so
//     an allocation loop crashed the whole action. Now the action never sees a
//     thrown value, only a JSON string posted by the worker, and a hang or an
//     out-of-memory kills only the worker.
//
// What this is NOT: a quality gate against code written to lie to it. Code
// that patches THREE.Box3 inside the context can fake its own measurements.
// That code still only reaches the app's sandboxed iframe, the same trust as
// the app HTML the builder writes; the check exists to catch honest mistakes
// (a throw, a loop, a 40-unit-tall model) before a scholar sees them.

import { Worker } from "node:worker_threads";
import {
  CHARM_MODEL_LIMITS,
  MAX_CHARM_MODEL_CODE_CHARS,
} from "./charmModelCode";

/** A build that takes longer than this is broken, not detailed (spike: <30 ms). */
const CHECK_TIMEOUT_MS = 1_000;
/** The whole worker: boot (~50 ms), three.js (~15 ms), the build, the measure. */
const WORKER_DEADLINE_MS = 5_000;
/** three.js plus a 60-mesh model measured well under 64 MB of heap. */
const WORKER_HEAP_MB = 128;

export type CharmModelCheck =
  | {
      ok: true;
      meshes: number;
      triangles: number;
      size: [number, number, number];
      /** Named parts an app can animate via root.getObjectByName(name). */
      parts: string[];
    }
  | { ok: false; problem: string };

// Runs inside the context after the model's code has defined `build`. Uses only
// context-realm objects and returns a JSON string either way.
const MEASURE = `
(function () {
  try {
    if (__charmDefineError !== undefined) {
      return JSON.stringify({ problem: "the code threw while loading: " + __charmDefineError });
    }
    if (typeof __charmBuild !== "function") {
      return JSON.stringify({ problem: "the code does not define a build(THREE) function" });
    }
    var root = __charmBuild(THREE);
    if (!root || root.isObject3D !== true) {
      return JSON.stringify({ problem: "build(THREE) did not return a THREE object" });
    }
    root.updateMatrixWorld(true);
    var meshes = 0, triangles = 0, parts = [];
    root.traverse(function (o) {
      if (o !== root && typeof o.name === "string" && o.name && parts.length < 40 && parts.indexOf(o.name) === -1) {
        parts.push(o.name.slice(0, 40));
      }
      if (!o.isMesh) return;
      meshes += 1;
      var g = o.geometry;
      if (g && g.index) triangles += g.index.count / 3;
      else if (g && g.attributes && g.attributes.position) triangles += g.attributes.position.count / 3;
    });
    var box = new THREE.Box3().setFromObject(root);
    var size = box.getSize(new THREE.Vector3());
    var center = box.getCenter(new THREE.Vector3());
    return JSON.stringify({
      meshes: meshes,
      triangles: Math.round(triangles),
      size: [size.x, size.y, size.z],
      minY: box.min.y,
      center: [center.x, center.z],
      parts: parts,
    });
  } catch (error) {
    return JSON.stringify({ problem: "build(THREE) threw: " + String(error && error.message || error).slice(0, 200) });
  }
})()`;

type Measured = {
  problem?: string;
  meshes?: number;
  triangles?: number;
  size?: number[];
  minY?: number;
  center?: number[];
  parts?: unknown[];
};

const round = (n: number) => Math.round(n * 100) / 100;

/** Judge a measurement against the contract; the problem reads as a fix-it. */
function judge(m: Measured): CharmModelCheck {
  if (m.problem) return { ok: false, problem: m.problem };
  const { meshes, triangles, size, minY, center } = m;
  if (
    typeof meshes !== "number" ||
    typeof triangles !== "number" ||
    !Array.isArray(size) ||
    size.length !== 3 ||
    !size.every(Number.isFinite) ||
    typeof minY !== "number" ||
    !Number.isFinite(minY) ||
    !Array.isArray(center) ||
    !center.every(Number.isFinite)
  ) {
    return { ok: false, problem: "the model has no measurable meshes" };
  }
  const L = CHARM_MODEL_LIMITS;
  if (meshes === 0) return { ok: false, problem: "the model has no meshes" };
  if (meshes > L.maxMeshes) {
    return { ok: false, problem: `it uses ${meshes} meshes; the limit is ${L.maxMeshes}` };
  }
  if (triangles > L.maxTriangles) {
    return { ok: false, problem: `it has ${triangles} triangles; the limit is ${L.maxTriangles}` };
  }
  const largest = Math.max(...size);
  if (largest < L.minLargestDimension || largest > L.maxLargestDimension) {
    return {
      ok: false,
      problem: `its largest dimension is ${round(largest)}; it must be about 1.0`,
    };
  }
  if (Math.abs(minY) > L.maxGroundOffset) {
    return { ok: false, problem: `its lowest point is at y = ${round(minY)}; it must stand on y = 0` };
  }
  if (Math.abs(center[0]) > L.maxCenterOffset || Math.abs(center[1]) > L.maxCenterOffset) {
    return { ok: false, problem: "it is not centered on x and z" };
  }
  return {
    ok: true,
    meshes,
    triangles,
    size: [round(size[0]), round(size[1]), round(size[2])],
    parts: (m.parts ?? []).filter((p): p is string => typeof p === "string"),
  };
}

// The worker's whole program. Plain CommonJS so the bundler leaves it alone;
// it gets the code, three.js, and MEASURE through workerData and posts back one
// JSON string. Anything it reads off a thrown value runs inside the worker,
// which the action kills at the deadline.
const WORKER_SOURCE = `
const vm = require("node:vm");
const { parentPort, workerData } = require("node:worker_threads");
const { code, three, measure, timeout } = workerData;
const fail = (problem) => JSON.stringify({ problem });
let out;
try {
  const context = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: "afterEvaluate",
  });
  const options = { timeout };
  // three.iife reads window/self when it registers THREE.
  vm.runInContext("var window = globalThis, self = globalThis;", context, options);
  vm.runInContext(three, context, options);
  try {
    // Same strict-mode wrapper the app's script uses (charmModelScript).
    vm.runInContext(
      [
        "var __charmBuild, __charmDefineError;",
        "try {",
        '  __charmBuild = (function () { "use strict";',
        code,
        '  ;\\n  return typeof build === "function" ? build : null; })();',
        "} catch (e) { __charmDefineError = String(e && e.message || e).slice(0, 200); }",
      ].join("\\n"),
      context,
      options,
    );
    const raw = vm.runInContext(measure, context, options);
    out = typeof raw === "string" ? raw : fail("the check could not read the model");
  } catch (error) {
    out = error && error.code === "ERR_SCRIPT_EXECUTION_TIMEOUT"
      ? fail("building it took longer than " + timeout + " ms")
      : fail("the code failed to run (" + String(error && error.message || error).slice(0, 200) + ")");
  }
} catch (error) {
  out = JSON.stringify({ serverFault: "three.js failed to load: " + String(error).slice(0, 200) });
}
parentPort.postMessage(String(out));
`;

/** Run the worker and resolve with its one JSON string, or a problem. */
function runInWorker(code: string, threeSource: string): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { code, three: threeSource, measure: MEASURE, timeout: CHECK_TIMEOUT_MS },
      resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB, maxYoungGenerationSizeMb: 32 },
      stdout: true,
      stderr: true,
    });
    const finish = (json: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      void worker.terminate();
      resolve(json);
    };
    const deadline = setTimeout(
      () => finish(JSON.stringify({ problem: `building it took longer than ${CHECK_TIMEOUT_MS} ms` })),
      WORKER_DEADLINE_MS,
    );
    worker.once("message", (message: unknown) =>
      finish(typeof message === "string" ? message : JSON.stringify({ problem: "the check could not read the model" })),
    );
    // The only errors that reach here are the worker's own (out of memory, a
    // crash); never a value the model's code threw.
    worker.once("error", (error: Error & { code?: string }) =>
      finish(
        JSON.stringify({
          problem:
            error.code === "ERR_WORKER_OUT_OF_MEMORY"
              ? "it used too much memory while building"
              : "the check stopped while building it",
        }),
      ),
    );
    worker.once("exit", () =>
      finish(JSON.stringify({ problem: "the check stopped while building it" })),
    );
  });
}

/**
 * Run `code` (a `function build(THREE) { ... }`) against `threeSource` (the
 * app-kit three.iife.min.js bytes) in a fresh worker and check what it builds.
 */
export async function checkCharmModel(
  code: string,
  threeSource: string,
): Promise<CharmModelCheck> {
  if (!code.trim()) return { ok: false, problem: "the reply contained no code" };
  if (code.length > MAX_CHARM_MODEL_CODE_CHARS) {
    return { ok: false, problem: `the code is ${code.length} characters; the limit is ${MAX_CHARM_MODEL_CODE_CHARS}` };
  }
  let measured: Measured & { serverFault?: string };
  try {
    measured = JSON.parse(await runInWorker(code, threeSource)) as Measured & {
      serverFault?: string;
    };
  } catch {
    return { ok: false, problem: "the check could not read the model" };
  }
  // Our own bundle failing to load is a server fault, not the model's.
  if (measured.serverFault) throw new Error(measured.serverFault);
  return judge(measured);
}
