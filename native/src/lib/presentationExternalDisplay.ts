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
