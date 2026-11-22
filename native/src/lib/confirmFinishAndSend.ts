import { Alert } from "react-native";

import { FINISH_AND_SEND_CONFIRM } from "../../vendor/shared/finishAndSend";

/** Ask before finishing an activity with no rubric (shared/finishAndSend.ts).
 *  Resolves true only when the scholar chose Finish. */
export function confirmFinishAndSend(): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      FINISH_AND_SEND_CONFIRM.title,
      FINISH_AND_SEND_CONFIRM.body,
      [
        {
          text: FINISH_AND_SEND_CONFIRM.cancel,
          style: "cancel",
          onPress: () => resolve(false),
        },
        { text: FINISH_AND_SEND_CONFIRM.confirm, onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}
