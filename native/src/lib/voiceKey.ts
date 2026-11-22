// The voice key: the Magic Keyboard Folio's mic key talks to the AI from
// anywhere in the app.
//
// The key does what the screen's own mic button does, and nothing where a
// screen has no mic. Each screen that owns a recorder registers a "voice
// target" while it is focused; one listener (mounted once in the root layout)
// hands the key to the most recently registered target. No second recorder:
// targets call the screen's existing onMicStart / onMicStop / onMicCancel,
// which already go through useStreamingDictation and the mic-ownership bus.
//
// Held past a second, the mic key is push-to-talk: letting go sends
// (micKeyHold.ts). A quick press keeps the toggle.
//
// With the mic open, the keys mirror the RecordingBar: Escape is ✕, and the
// mic key, Space or Return is ✓, also while it still says "Getting ready…":
// the recorder sends whatever the mic has caught by then, or nothing if that
// is too short to be speech. Escape, Space and Return are watched only
// while a recorder is open, so ordinary typing never crosses the bridge.
//
// ⌘/ is the voice key's text twin: the same target opens its composer, ready to
// type, instead of the mic. Where a screen's chat is hidden (the builder's
// collapsed chat drawer), both keys open the floating chat panel
// (components/FloatingChatPanel.tsx) rather than the docked chat; Escape closes
// it. ⌘/ is a UIKeyCommand, so it is consumed and never types a "/".
//
// The mic key reaches the app as a UIKit press of type 504 with no key code
// (measured on a BunnyPad, 2026-11-11). It is undocumented, and it is the
// app's alone only where MDM blocks Siri, as the student profile does; with
// Siri allowed, iPadOS also opens a "Turn on Siri" prompt.
//
// To a focused text field the mic key is also the Dictation key: iOS
// dictation opened over the session chat's composer, which is focused most of
// the time (2026-11-14). So while the focused screen has a mic, the key is
// claimed and UIKit never sees it. Screens with no mic (NO_MIC, or nothing
// registered) leave it to iOS, so dictation still works in their fields.
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef } from "react";
import { TextInput } from "react-native";

import { appStatusBus } from "@/lib/appStatusBus";
import {
  claimHardwarePresses,
  endEditing,
  isEditingText,
  watchHardwareKeys,
  watchHardwarePresses,
  watchKeyCommands,
} from "@/lib/hardwareKeyboard";
import { micKeyReleased, micKeyStartedTake } from "@/lib/micKeyHold";

/** UIPress type of the Folio's top-row mic key. */
export const MIC_KEY_PRESS_TYPE = 504;

/** The text twin of the voice key. */
export const COMPOSE_CHORD = "cmd+/";

// HID usages (keyboard page) watched while a recorder or floating panel is open.
const HID_RETURN = 0x28;
const HID_ESCAPE = 0x29;
const HID_SPACE = 0x2c;
const HID_KEYPAD_ENTER = 0x58;
const CONFIRM_KEYS = new Set([HID_RETURN, HID_SPACE, HID_KEYPAD_ENTER]);
// Dev builds only: F5 stands in for the mic key, which a simulator cannot
// produce (it is a press with no key code). XCTest and a Mac keyboard can both
// send F5 to a simulator.
const HID_F5 = 0x3e;

export type VoiceRecorderState = "idle" | "connecting" | "recording" | "busy";

export type VoiceTarget = {
  /** idle: the mic is offered; busy: no mic now (tutor answering,
   *  transcribing, a photo waiting to be sent). Typed text never makes it
   *  busy: a voice turn replaces it. */
  state: VoiceRecorderState;
  start: () => void;
  confirm: () => void;
  cancel: () => void;
  /** ⌘/: open this screen's text composer, focused. Absent where the screen
   *  has nowhere to type to the AI. */
  compose?: () => void;
  /** Escape with no recorder open: close the floating chat panel. Present
   *  only while there is one to close. */
  dismiss?: () => void;
};

// Each entry reads its screen's latest target at press time, so a handler can
// never be a stale render's.
type Entry = { id: number; read: () => VoiceTarget };

const entries: Entry[] = [];
let nextId = 0;
const listeners = new Set<() => void>();

function top(): VoiceTarget | undefined {
  return entries[entries.length - 1]?.read();
}

function notify() {
  for (const listener of listeners) listener();
}

const noop = () => {};

/** Spread into the target of a screen whose AI chat has no mic, beside its
 *  `compose`: the voice key does nothing there. */
export const NO_MIC = {
  state: "busy",
  start: noop,
  confirm: noop,
  cancel: noop,
} as const satisfies Omit<VoiceTarget, "compose" | "dismiss">;

/** Whether this target has a mic of its own, rather than NO_MIC. */
function hasMic(target: VoiceTarget | undefined): boolean {
  return !!target && target.start !== NO_MIC.start;
}

/** Which keyless presses to keep from UIKit while this target is on top. */
export function claimedPressTypes(target: VoiceTarget | undefined): number[] {
  return hasMic(target) ? [MIC_KEY_PRESS_TYPE] : [];
}

// Nothing should be typed into while the mic is open: GameController only
// observes keys, so Space or Return would also land in a focused field (the
// writing editor beside the chat, say). UIKit's resign also reaches an input
// inside a web view (the builder's live app, which the floating panel leaves on
// screen), and ends any iOS dictation a focused field started.
function releaseTextFocus() {
  const focused = TextInput.State.currentlyFocusedInput();
  if (focused) TextInput.State.blurTextInput(focused);
  endEditing();
}

/** The voice key was pressed. False when no screen wants it. */
export function pressMicKey(): boolean {
  const entry = entries[entries.length - 1];
  const target = entry?.read();
  if (!target) return false;
  if (target.state === "idle") {
    // Now rather than once the recorder renders open, in case a focused field
    // heard the key anyway (a dev client built before press claims). Not
    // while another recorder holds the mic (the writing box dictating): the
    // screen's start does nothing then, and the field keeps its focus.
    if (!appStatusBus.isMicOwned()) releaseTextFocus();
    target.start();
    // Targets are read afresh on every call, so the release must read this
    // screen's target again rather than keep `target`; gone means no send.
    micKeyStartedTake(() => (entries.includes(entry) ? entry.read() : undefined));
  } else if (recorderOpen(target)) target.confirm();
  return true;
}

/** The voice key came back up: a long hold sends (micKeyHold.ts). */
export function releaseMicKey(): boolean {
  return micKeyReleased();
}

/** ⌘/ was pressed. False when no screen has a composer to open. */
export function pressComposeKey(): boolean {
  const target = top();
  if (!target?.compose) return false;
  // Mid-recording the mic owns the composer; finish or cancel it first.
  if (target.state === "connecting" || target.state === "recording") return true;
  target.compose();
  return true;
}

function recorderOpen(target: VoiceTarget | undefined): boolean {
  return target?.state === "connecting" || target?.state === "recording";
}

/** A confirm/cancel key was pressed while a recorder or floating panel may be open. */
export function pressRecorderKey(hid: number): boolean {
  const target = top();
  if (!target) return false;
  if (!recorderOpen(target)) {
    if (hid === HID_ESCAPE && target.dismiss) {
      target.dismiss();
      return true;
    }
    return false;
  }
  if (hid === HID_ESCAPE) {
    target.cancel();
    return true;
  }
  // A scholar who put the cursor in a text field mid-take (the writing editor
  // beside the chat) is typing: Space and Return belong to that field. The
  // mic key and the on-screen check still send.
  if (TextInput.State.currentlyFocusedInput()) return false;
  if (CONFIRM_KEYS.has(hid)) {
    target.confirm();
    return true;
  }
  return false;
}

/** Make this target the newest; returns its removal. Screens use the hook. */
export function registerVoiceTarget(read: () => VoiceTarget): () => void {
  const id = nextId++;
  entries.push({ id, read });
  notify();
  return () => {
    const index = entries.findIndex((e) => e.id === id);
    if (index >= 0) entries.splice(index, 1);
    notify();
  };
}

/**
 * Register what the voice key does on this screen while it is focused.
 * `enabled: false` (e.g. a shell screen that has handed off to a child that
 * owns its own composer) registers nothing.
 */
export function useVoiceKeyTarget(target: VoiceTarget, enabled = true) {
  const targetRef = useRef(target);
  // True while registered, so a state change only wakes the listener then.
  const registeredRef = useRef(false);
  useEffect(() => {
    // The listener only cares which keys to watch: recorder open, or a panel
    // to dismiss.
    const changed =
      targetRef.current.state !== target.state ||
      !targetRef.current.dismiss !== !target.dismiss ||
      hasMic(targetRef.current) !== hasMic(target);
    targetRef.current = target;
    if (changed && registeredRef.current) notify();
  }, [target]);

  useFocusEffect(
    useCallback(() => {
      if (!enabled) return;
      registeredRef.current = true;
      const unregister = registerVoiceTarget(() => targetRef.current);
      return () => {
        // Losing focus or being disabled mid-take (e.g. the session shell
        // handing off to the builder) must not leave an orphaned recorder
        // that no key can reach.
        if (recorderOpen(targetRef.current)) targetRef.current.cancel();
        unregister();
        registeredRef.current = false;
      };
    }, [enabled]),
  );
}

/** Which GameController keys the listener needs right now. */
export function watchedRecorderKeys(
  target: VoiceTarget | undefined,
  dev: boolean,
): number[] {
  const keys: number[] = dev ? [HID_F5] : [];
  if (recorderOpen(target)) {
    keys.push(HID_ESCAPE, HID_RETURN, HID_SPACE, HID_KEYPAD_ENTER);
  } else if (target?.dismiss) {
    keys.push(HID_ESCAPE);
  }
  return keys;
}

/** Mount once, at the root. */
export function useVoiceKeyListener() {
  useEffect(
    () =>
      watchHardwarePresses([MIC_KEY_PRESS_TYPE], (event) => {
        if (event.phase === "down") pressMicKey();
        else if (event.phase === "up" || event.phase === "cancelled") {
          releaseMicKey();
        }
      }),
    [],
  );

  useEffect(
    () =>
      watchKeyCommands([COMPOSE_CHORD], (event) => {
        if (event.chord === COMPOSE_CHORD) pressComposeKey();
      }),
    [],
  );

  // Claim the mic key from UIKit while the focused screen has a mic, so a
  // focused field never opens iOS dictation instead.
  useEffect(() => {
    let claimed = "";
    const sync = () => {
      const types = claimedPressTypes(top());
      const signature = types.join(",");
      if (signature === claimed) return;
      claimed = signature;
      claimHardwarePresses(types);
    };
    listeners.add(sync);
    sync();
    return () => {
      listeners.delete(sync);
      if (claimed) claimHardwarePresses([]);
    };
  }, []);

  // Escape / Space / Return only while the focused screen's recorder is open
  // (Escape also while a floating panel is), so ordinary typing never crosses
  // the bridge. GameController keeps one watched set, so one subscription
  // carries all of them.
  useEffect(() => {
    let unwatch: (() => void) | null = null;
    let watching = "";
    let wasOpen = false;
    const sync = () => {
      const target = top();
      const open = recorderOpen(target);
      // A recorder the on-screen mic button opened, too.
      if (open && !wasOpen) releaseTextFocus();
      wasOpen = open;
      const keys = watchedRecorderKeys(target, __DEV__);
      const signature = keys.join(",");
      if (signature === watching) return;
      unwatch?.();
      unwatch = null;
      watching = signature;
      if (keys.length === 0) return;
      unwatch = watchHardwareKeys(keys, (event) => {
        if (event.phase !== "down" || event.chorded) return;
        if (event.hid === HID_F5) pressMicKey();
        else if (event.hid === HID_ESCAPE) pressRecorderKey(event.hid);
        // Space/Return belong to a field the scholar put the cursor in
        // mid-take, a web view's included (React Native can't see those).
        else
          void isEditingText().then((editing) => {
            if (!editing) pressRecorderKey(event.hid);
          });
      });
    };
    listeners.add(sync);
    sync();
    return () => {
      listeners.delete(sync);
      unwatch?.();
    };
  }, []);
}
