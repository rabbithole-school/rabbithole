import { useEffect } from "react";
import { Keyboard, Platform } from "react-native";
import {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

// The keyboard inset for the session surfaces (chat pane + deliverable panel):
// a `paddingBottom` that shrinks the pane by exactly the keyboard's height, so
// the composer/editor rides above the keyboard and the scroll area gives up the
// space instead of hiding behind it.
//
// It is driven by React Native's own `Keyboard` notifications rather than
// Reanimated's `useAnimatedKeyboard`, which is wrong for us on iPad and is
// deprecated upstream in favour of react-native-keyboard-controller.
//
// What was MEASURED (iPad sim, landscape, window 1180×820 pt, soft keyboard up,
// keyboard top edge at screenY 398): RN reports the true 422pt; the same moment
// `useAnimatedKeyboard` reported 782. That over-inset flung the composer to the
// top of the screen and collapsed the transcript to nothing, and the stale value
// could outlive the keyboard, stranding the composer mid-screen above a dead
// band. Those numbers are the settled part — re-measure, don't re-reason.
//
// The likely CAUSE, offered as inference and not established: 1180 − 398 = 782
// exactly, and Reanimated's iOS observer derives the height from
// `CGRectGetMaxY(window.bounds)` of the app delegate's window, so it looks like
// that window is still reporting portrait bounds under a landscape app. Nobody
// has proven that; treat it as a lead if this ever needs revisiting.
//
// iOS's `will*` events carry its own animation duration, so tracking them with
// `withTiming` keeps the pane in step with the keyboard rather than snapping
// after it lands. An event with NO duration (Android's `did*`, and iOS when a
// hardware keyboard attaches) describes a keyboard that has ALREADY moved, so
// it is applied instantly — animating there would just lag reality by 300ms.
//
// Known limitation, deliberate: the transcript sets
// `keyboardDismissMode="interactive"`, and a partial drag moves the keyboard
// without emitting any JS event, so the pane holds still until the drag
// resolves instead of tracking it frame-by-frame. `useAnimatedKeyboard` did
// follow that drag — at the wrong offset, since it was mismeasuring the height
// throughout. A correct pane that settles a beat late beats a wrong one that
// tracks smoothly; frame-accurate tracking needs
// react-native-keyboard-controller, not a JS-event source.
/** The keyboard's height right now, or 0 when none is showing. */
function openKeyboardHeight(): number {
  return Keyboard.metrics()?.height ?? 0;
}

export function useKeyboardInset() {
  // Mounting while the keyboard is ALREADY up delivers no event to catch up on,
  // so the inset starts from the live metrics — otherwise the pane renders
  // full-height behind the keyboard until the next keyboard cycle. Reachable in
  // this app: DeliverablePanel mounts on rotation into the landscape two-pane
  // layout, which a scholar can do mid-sentence. `Keyboard.metrics()` is cleared
  // on `keyboardDidHide`, so it is never a stale non-zero read; it is read only
  // on the first render.
  const inset = useSharedValue(openKeyboardHeight());

  useEffect(() => {
    const ios = Platform.OS === "ios";
    // A `will*` event precedes the system animation, so the pane animates
    // alongside it — with iOS's own duration when it gives one (it does:
    // 383ms measured), and a sane default if it ever does not. A `did*` event
    // reports a keyboard that has ALREADY arrived, so there is nothing left to
    // travel with: snap, or the pane lags reality by the animation's length.
    const track = (to: number, duration?: number) =>
      inset.set(withTiming(to, duration && duration > 0 ? { duration } : undefined));
    const settle = (to: number) => inset.set(to);

    const subs = [
      ios
        ? Keyboard.addListener("keyboardWillShow", (e) =>
            track(e.endCoordinates.height, e.duration),
          )
        : Keyboard.addListener("keyboardDidShow", (e) =>
            settle(e.endCoordinates.height),
          ),
      ios
        ? Keyboard.addListener("keyboardWillHide", (e) => track(0, e?.duration))
        : Keyboard.addListener("keyboardDidHide", () => settle(0)),
      // Backstop. `keyboardDidHide` always lands, including on paths that never
      // deliver a matching `willHide`. Collapsing here unconditionally is what
      // guarantees the inset can never outlive the keyboard.
      Keyboard.addListener("keyboardDidHide", () => inset.set(0)),
    ];
    return () => subs.forEach((s) => s.remove());
  }, [inset]);

  const style = useAnimatedStyle(() => ({ paddingBottom: inset.get() }));

  return { style };
}
