import { describe, expect, it } from "vitest";
import {
  EXTERNAL_DISPLAY_SCENE,
  getPresentationDisplayState,
} from "../presentationExternalDisplay";

function screens(mirrored?: boolean) {
  return {
    tv: {
      id: "tv",
      width: 1920,
      height: 1080,
      mirrored,
      type: EXTERNAL_DISPLAY_SCENE,
    },
  };
}

describe("presentation external-display privacy", () => {
  it("permits printing when no external scene is registered", () => {
    expect(getPresentationDisplayState({})).toMatchObject({
      externalScreenId: undefined,
      hasExternalScreen: false,
      connected: false,
      canPrintNotes: true,
      mainScreenMode: "slide",
    });
  });

  it("permits speaker notes and printing only on a confirmed extended display", () => {
    expect(getPresentationDisplayState(screens(false))).toMatchObject({
      hasExternalScreen: true,
      connected: true,
      canPrintNotes: true,
      mainScreenMode: "speaker",
    });
  });

  for (const mirrored of [true, undefined]) {
    it(`blocks speaker notes and printing when mirroring is ${String(mirrored)}`, () => {
      expect(getPresentationDisplayState(screens(mirrored))).toMatchObject({
        hasExternalScreen: true,
        connected: false,
        canPrintNotes: false,
        mainScreenMode: "connecting",
      });
    });
  }
});
