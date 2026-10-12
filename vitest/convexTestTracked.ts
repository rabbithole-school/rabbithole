/**
 * `convex-test` with instance tracking, aliased in for the shared-worker
 * Convex vitest project (see vitest.config.ts).
 *
 * Every `convexTest()` instance has its own scheduler, and its jobs sit on
 * real `setTimeout`s that outlive the test that created the instance. A test
 * that triggers a mutation which `ctx.scheduler.runAfter(0, …)`s something and
 * returns without draining leaves that job to fire during a later test. In an
 * isolated process it dies with the process; in a shared worker it can still
 * be loading modules when the file's environment is torn down, and the
 * worker then fails every later import of those modules (TRA-443). Recording
 * EVERY instance a file creates lets vitest.convexShared.setup.ts drain all
 * of their schedulers in `afterAll`. Tracking only the latest one left the
 * jobs of every earlier test in the file undrained.
 */
import { convexTest as untrackedConvexTest } from "convex-test/dist/index.js";

export * from "convex-test/dist/index.js";

type ConvexTestFn = typeof untrackedConvexTest;
type TrackedInstance = ReturnType<ConvexTestFn>;
type ConvexGlobal = {
  syscall: (op: string, jsonArgs: string) => string;
  asyncSyscall: (op: string, jsonArgs: string) => Promise<string>;
  jsSyscall: (op: string, args: Record<string, unknown>) => unknown;
};

declare global {
  // Every instance created since the shared setup last drained, i.e. by the
  // running test file.
  var __rhConvexTests: Set<TrackedInstance> | undefined;
  var Convex: ConvexGlobal | undefined;
}

const storageMetadata = new Map<
  string,
  {
    storageId: string;
    sha256: string;
    size: number;
    contentType: string | null;
  }
>();
let storageMetadataShimInstalled = false;

function installStorageMetadataShim() {
  if (storageMetadataShimInstalled || !globalThis.Convex) return;
  storageMetadataShimInstalled = true;
  const convexTestProxy = globalThis.Convex;
  globalThis.Convex = {
    get syscall() {
      return convexTestProxy.syscall;
    },
    get asyncSyscall() {
      const asyncSyscall = convexTestProxy.asyncSyscall;
      return async (op: string, jsonArgs: string) => {
        const args = JSON.parse(jsonArgs) as { storageId?: string };
        if (op === "1.0/storageGetMetadata") {
          return JSON.stringify(
            args.storageId
              ? storageMetadata.get(String(args.storageId)) ?? null
              : null,
          );
        }
        const result = await asyncSyscall(op, jsonArgs);
        if (op === "1.0/storageDelete" && args.storageId) {
          storageMetadata.delete(String(args.storageId));
        }
        return result;
      };
    },
    get jsSyscall() {
      const jsSyscall = convexTestProxy.jsSyscall;
      return async (op: string, args: Record<string, unknown>) => {
        const result = await jsSyscall(op, args);
        if (op === "storage/storeBlob" && args.blob instanceof Blob) {
          const storageId = String(result);
          storageMetadata.set(storageId, {
            storageId,
            sha256: "",
            size: args.blob.size,
            contentType: args.blob.type || null,
          });
        }
        return result;
      };
    },
  };
}

export const convexTest: ConvexTestFn = ((...args: Parameters<ConvexTestFn>) => {
  const t = untrackedConvexTest(...args);
  installStorageMetadataShim();
  storageMetadata.clear();
  (globalThis.__rhConvexTests ??= new Set()).add(t);
  return t;
}) as ConvexTestFn;
