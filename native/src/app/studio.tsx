/**
 * Route for the Studio coding elective screen — see
 * `components/studio/StudioScreen.tsx` for the actual implementation and its
 * header comment for why the editor/canvas/runtime live in one WebView
 * document instead of split across the bridge.
 */
import { StudioScreen } from "@/components/studio/StudioScreen";

export default function Studio() {
  return <StudioScreen />;
}
