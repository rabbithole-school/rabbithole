export type ExternalScreen = {
  id: string;
  width: number;
  height: number;
  mirrored?: boolean;
  type?: string;
};

export const EXTERNAL_DISPLAY_SCENE = "@RNExternalDisplay_externalDisplay";

export function getPresentationDisplayState(
  screens: Readonly<Record<string, ExternalScreen>>,
) {
  const externalScreenId = Object.keys(screens).find(
    (screenId) => screens[screenId]?.type === EXTERNAL_DISPLAY_SCENE,
  );
  const hasExternalScreen = externalScreenId !== undefined;
  const connected =
    externalScreenId !== undefined &&
    screens[externalScreenId]?.mirrored === false;
  const mainScreenMode = connected
    ? "speaker"
    : hasExternalScreen
      ? "connecting"
      : "slide";

  return {
    externalScreenId,
    hasExternalScreen,
    connected,
    canPrintNotes: !hasExternalScreen || connected,
    mainScreenMode,
  };
}

// The words both presenting surfaces (slides, a live app) use to get the iPad
// onto the classroom TV.
export const CONNECT_TV_LABEL = "Connect TV";
export const CONNECT_TV_GUIDANCE =
  "Open Control Center from the top-right of this iPad, choose Screen Mirroring, then select the classroom TV.";
export const DISCONNECT_TV_LABEL = "Disconnect TV";
export const DISCONNECT_TV_GUIDANCE =
  "Open Control Center from the top-right of this BunnyPad, choose Screen Mirroring, then Stop Mirroring.";

/**
 * The one TV button a presenting surface shows. Screen Mirroring starts and
 * stops only in Control Center, which the Rabbithole Lock keeps out of reach,
 * so the button exists both ways: with no TV it connects one, and with a TV
 * attached it is the only way off it. Hiding it once a TV arrived left a
 * locked iPad mirroring to the TV with no way to stop.
 */
export function getTvButton(hasExternalScreen: boolean) {
  return hasExternalScreen
    ? { label: DISCONNECT_TV_LABEL, guidance: DISCONNECT_TV_GUIDANCE }
    : { label: CONNECT_TV_LABEL, guidance: CONNECT_TV_GUIDANCE };
}

/**
 * Present mode for a live app. Unlike slides, nothing is rendered on a second
 * screen: the TV shows the iPad itself through Screen Mirroring, so the ONE
 * live app a scholar plays by touch is the one the class sees. All this needs
 * to know is whether a TV is attached yet (offer "Connect TV" until one is) and
 * whether the TV is attached but NOT mirroring this iPad — the app owns the
 * external screen instead — which the scholar should be told plainly rather
 * than left facing a TV that doesn't show their app.
 */
export function getAppPresentDisplayState(
  screens: Readonly<Record<string, ExternalScreen>>,
) {
  const { hasExternalScreen, connected } = getPresentationDisplayState(screens);
  return {
    offerConnect: !hasExternalScreen,
    tvNotMirroring: connected,
  };
}
