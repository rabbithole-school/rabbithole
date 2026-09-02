// Decoded static PNG bytes for the configured primary-institution seal used on
// the printed Calculator License (convex/cloudPrintingActions.ts). Base64 is the safe
// way to ship binary image data through Convex's esbuild bundle for a
// "use node" action — see this directory's README.md for provenance +
// regeneration instructions.
//
// Convex statically analyzes every non-"use node" module (including ones
// only imported from a "use node" action) in a restricted, non-Node runtime
// with no `Buffer` global. So decoding must stay lazy — behind a getter,
// never an eager top-level `Buffer.from(...)` call — or `npx convex dev`'s
// analysis pass fails with "Buffer is not defined" before any function ever
// runs. Mirrors convex/assets/fonts/index.ts.
import { primaryInstitutionSealPngBase64 } from "./primaryInstitutionSeal";

function decode(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, "base64"));
}

export const sealImageBytes = {
  get primaryInstitutionSealPng() {
    return decode(primaryInstitutionSealPngBase64);
  },
};
