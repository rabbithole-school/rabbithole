import { ActionSheetIOS } from "react-native";

import { TALK_COPY } from "./talkCopy";

export type PresentChoice = "present" | "rehearse";

/**
 * The present button on slides and on a scholar's app offers two ways in:
 * present to the class, or rehearse with the BunnyPad recording. Both can be
 * filmed from the back of the room (audience mode). Shared by the slides
 * deliverable, the app screen and the `/dev-slides` harness so all of them
 * enter the same way.
 */
export function chooseHowToPresent(
  title: string,
  presentLabel: string,
): Promise<PresentChoice | null> {
  return new Promise((resolve) => {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title,
        message: TALK_COPY.chooseMessage,
        options: [presentLabel, TALK_COPY.rehearse, "Cancel"],
        cancelButtonIndex: 2,
      },
      (buttonIndex) => {
        resolve(buttonIndex === 0 ? "present" : buttonIndex === 1 ? "rehearse" : null);
      },
    );
  });
}
