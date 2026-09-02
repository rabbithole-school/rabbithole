// Decoded static-weight TTF bytes for the Special Delivery PDF renderer
// (convex/cloudPrintingActions.ts). Base64 is the safe way to ship binary
// font data through Convex's esbuild bundle for a "use node" action — see
// this directory's README.md for provenance + regeneration instructions.
//
// Convex statically analyzes every non-"use node" module (including ones
// only imported from a "use node" action) in a restricted, non-Node runtime
// with no `Buffer` global. So decoding must stay lazy — behind getters, never
// eager top-level `Buffer.from(...)` calls — or `npx convex dev`'s analysis
// pass fails with "Buffer is not defined" before any function ever runs.
import { hankenGroteskBase64 } from "./hankenGroteskRegular";
import { hankenGroteskSemiBoldBase64 } from "./hankenGroteskSemiBold";
import { hankenGroteskBoldBase64 } from "./hankenGroteskBold";
import { hankenGroteskItalicBase64 } from "./hankenGroteskItalic";
import { playfairDisplayBase64 } from "./playfairDisplayRegular";

function decode(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, "base64"));
}

export const specialDeliveryFontBytes = {
  get hankenGrotesk() {
    return decode(hankenGroteskBase64);
  },
  get hankenGroteskSemiBold() {
    return decode(hankenGroteskSemiBoldBase64);
  },
  get hankenGroteskBold() {
    return decode(hankenGroteskBoldBase64);
  },
  get hankenGroteskItalic() {
    return decode(hankenGroteskItalicBase64);
  },
  get playfairDisplay() {
    return decode(playfairDisplayBase64);
  },
};
