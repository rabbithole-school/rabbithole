/**
 * VibecodeModeControl — the App designer's Edit | Play screen mode control on
 * iPad (TRA-301, review/teacher-build-flow.html §2/§4).
 *
 * The web twin uses the shared `ContextTabs` primitive; the iPad's idiomatic
 * equivalent is a real `UISegmentedControl`, which `@expo/ui`'s SwiftUI
 * `Picker` renders under `pickerStyle("segmented")` — so no hand-rolled pill
 * row and no new dependency. The `Host` + `Popover` idiom here is the one
 * already proven in `FlairChips.tsx`.
 *
 * The three states come straight from the SERVER's verdict, projected by the
 * shared `editControlFor` (never re-derived here):
 *  - allowed → both segments live;
 *  - locked  → the Edit segment keeps its word with a lock in front, so what
 *    is locked is named on the control (Andy, 2026-10-11); selecting it is
 *    REJECTED (the Picker is remounted so its native selection returns to
 *    Play) and the unlock sentence appears as a transient popover on that tap
 *    — the nearest native analog of the web's hover tooltip; the design says
 *    "long-press", a deviation the PR calls out for a ruling;
 *  - hidden  → this component renders nothing at all (the caller checks
 *    `showControl`), so a coached scholar never sees the word "Edit".
 */

import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import {
  Host,
  Label,
  Picker,
  Popover,
  Text as SwiftUIText,
  VStack,
} from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  fixedSize,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  padding,
  pickerStyle,
  tag,
} from "@expo/ui/swift-ui/modifiers";

import { fonts, useColors } from "@/theme";
import type { WorkshopMode } from "../../../vendor/shared/workshopMode";

/** How long the locked-segment explanation stays up before dismissing itself. */
const LOCK_TOOLTIP_MS = 2_500;
/** The one sentence a locked Edit segment is allowed to say (design §3). */
const LOCK_SENTENCE = "Edit unlocks when you finish the activity.";

export function VibecodeModeControl({
  mode,
  editUnlocked,
  teacherEdit = false,
  onChange,
}: {
  mode: WorkshopMode;
  /** `editControlFor(effectiveEditAccess).editUnlocked` — never re-derived. */
  editUnlocked: boolean;
  /** The server's `teacherEditOverride`: scholars on this activity cannot
   *  edit (yet), so the Edit segment is named as the teacher's (TRA-477). */
  teacherEdit?: boolean;
  onChange: (next: WorkshopMode) => void;
}) {
  const colors = useColors();
  const [lockNoticeOpen, setLockNoticeOpen] = useState(false);
  // The SwiftUI Picker binds a NATIVE @State that re-syncs from `selection`
  // only when the prop's value changes (PickerView.swift `onChange(of:
  // props.selection)`). A rejected tap leaves the prop on "play", so nothing
  // would re-sync and the segment would stick on Edit. Remounting the Picker
  // re-initialises that state from the prop, so the control snaps back.
  const [pickerEpoch, setPickerEpoch] = useState(0);

  // The notice is transient: a tooltip, not a banner. It never pushes layout —
  // the popover floats over the bar (design: "nothing that pushes the app or
  // chat down").
  useEffect(() => {
    if (!lockNoticeOpen) return;
    const timer = setTimeout(() => setLockNoticeOpen(false), LOCK_TOOLTIP_MS);
    return () => clearTimeout(timer);
  }, [lockNoticeOpen]);

  const handleSelection = (next: string | number | null) => {
    if (next !== "edit" && next !== "play") return;
    if (next === "edit" && !editUnlocked) {
      // Reject the selection: remount the Picker so its native state returns
      // to Play (see `pickerEpoch`), and let the sentence explain why.
      setPickerEpoch((epoch) => epoch + 1);
      setLockNoticeOpen(true);
      return;
    }
    onChange(next);
  };

  return (
    <View style={styles.wrap}>
      <Host matchContents>
        <Popover
          isPresented={lockNoticeOpen}
          attachmentAnchor="bottom"
          arrowEdge="top"
          onIsPresentedChange={(isPresented) => {
            if (!isPresented) setLockNoticeOpen(false);
          }}
        >
          <Popover.Trigger>
            <Picker<string>
              key={pickerEpoch}
              selection={mode}
              onSelectionChange={handleSelection}
              modifiers={[
                pickerStyle("segmented"),
                frame({ minWidth: 132 }),
                accessibilityLabel("App mode"),
              ]}
            >
              {editUnlocked ? (
                <SwiftUIText modifiers={[tag("edit")]}>
                  {teacherEdit ? "Teacher edit" : "Edit"}
                </SwiftUIText>
              ) : (
                // A locked Edit keeps its word with a small lock in front, so
                // what is locked is named on the control itself (web twin in
                // VibecodeWorkshop.tsx; Andy, 2026-10-11).
                <Label
                  title="Edit"
                  systemImage="lock.fill"
                  modifiers={[tag("edit"), accessibilityLabel("Edit locked")]}
                />
              )}
              <SwiftUIText modifiers={[tag("play")]}>Play</SwiftUIText>
            </Picker>
          </Popover.Trigger>
          <Popover.Content>
            <VStack
              alignment="leading"
              spacing={4}
              modifiers={[frame({ maxWidth: 260 }), padding()]}
            >
              <SwiftUIText
                modifiers={[
                  font({ family: fonts.regular, size: 13 }),
                  foregroundStyle(colors.charcoalMuted),
                  lineLimit(),
                  fixedSize({ horizontal: false, vertical: true }),
                ]}
              >
                {LOCK_SENTENCE}
              </SwiftUIText>
            </VStack>
          </Popover.Content>
        </Popover>
      </Host>
    </View>
  );
}

const styles = StyleSheet.create({
  // `matchContents` sizes the host to the SwiftUI control; the minimum keeps
  // the header from collapsing it to zero width on the first layout pass.
  wrap: { minWidth: 132, justifyContent: "center" },
});
