import { describe, expect, it } from "vitest";
import {
  CONNECT_TV_GUIDANCE,
  CONNECT_TV_LABEL,
  DISCONNECT_TV_GUIDANCE,
  DISCONNECT_TV_LABEL,
  EXTERNAL_DISPLAY_SCENE,
  getAppPresentDisplayState,
  getPresentationDisplayState,
  getTvButton,
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

describe("app present mode on the classroom TV", () => {
  it("offers Connect TV until a TV is attached", () => {
    expect(getAppPresentDisplayState({})).toEqual({
      offerConnect: true,
      tvNotMirroring: false,
    });
  });

  it("is quiet while the TV mirrors this iPad", () => {
    expect(getAppPresentDisplayState(screens(true))).toEqual({
      offerConnect: false,
      tvNotMirroring: false,
    });
  });

  it("offers a way off the TV once one is attached", () => {
    expect(getTvButton(false)).toEqual({
      label: CONNECT_TV_LABEL,
      guidance: CONNECT_TV_GUIDANCE,
    });
    expect(getTvButton(true)).toEqual({
      label: DISCONNECT_TV_LABEL,
      guidance: DISCONNECT_TV_GUIDANCE,
    });
  });

  it("says so when the TV is attached but not mirroring this iPad", () => {
    expect(getAppPresentDisplayState(screens(false))).toEqual({
      offerConnect: false,
      tvNotMirroring: true,
    });
  });
});
