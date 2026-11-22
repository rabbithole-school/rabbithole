/**
 * The done-screen pieces of the mission program (TRA-519), rendered under the
 * completion card in native/src/app/session/[id].tsx:
 *   • SavedForLaterBlock (B2) — the session's parked ideas come back, each with
 *     "Build it now" (sessions.startFreePlay with the idea → carry on in this
 *     session via `onBuildHere`, or open an older free-play copy; was: open the new
 *     session) and "Make it a Quest" (sessions.questFromParkedIdea plants or
 *     reuses a seed → the existing seed flow, useExploreSeed).
 * The caller decides when it shows; labels come from shared/missionCopy so
 * they match web byte for byte. Web twin: components/SavedForLaterBlock.tsx.
 */
import { useMemo, useState, type ReactNode } from "react";
import { useMutation } from "convex/react";
import { useRouter } from "expo-router";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";

import { ParkedIdeaList, type ParkedIdea } from "@/components/ParkedIdeaList";
import { useExploreSeed } from "@/hooks/useExploreSeed";
import type { Id } from "@/lib/convex";
import { questFromParkedIdeaRef, startFreePlayRef } from "@/lib/missionApi";
import { fonts, useColors } from "@/theme";
import { MISSION_COPY } from "../../vendor/shared/missionCopy";
import { serverErrorMessage } from "../../vendor/shared/serverErrorMessage";

type Busy = { text: string; action: "build" | "quest" } | null;

/**
 * Build it now + Make it a Quest for each parked idea, shared by the chat done
 * screen (SavedForLaterBlock below) and the builder's done state (the chat
 * drawer's Saved tab, components/vibecode/VibecodeScreen.tsx). `renderActions` goes to
 * ParkedIdeaList.
 */
export function useSavedForLaterActions({
  sessionId,
  canBuildNow,
  onBuildHere,
}: {
  sessionId: Id<"sessions">;
  /** `freePlayEligible` from getWithMessages — whether Build it now works. */
  canBuildNow: boolean;
  /** The builder's done state: carry on in this session with `idea`. Absent
   *  (the chat done screen), the session the server names is opened. */
  onBuildHere?: (idea: ParkedIdea) => void;
}): {
  renderActions: (idea: ParkedIdea) => ReactNode;
} {
  const router = useRouter();
  const startFreePlay = useMutation(startFreePlayRef);
  const questFromParkedIdea = useMutation(questFromParkedIdeaRef);
  const { exploreSeed, exploringSeedId } = useExploreSeed();
  const [busy, setBusy] = useState<Busy>(null);

  const buildNow = async (idea: ParkedIdea) => {
    Haptics.selectionAsync();
    setBusy({ text: idea.text, action: "build" });
    let next: Id<"sessions"> | null = null;
    try {
      next = (await startFreePlay({ sessionId, idea: idea.text })).sessionId;
    } catch (error) {
      Alert.alert(serverErrorMessage(error, "Couldn't start building that"));
    }
    // No `finally`, and no branching inside the try: the React Compiler bails
    // out on both, and the catch never rethrows, so this always runs.
    setBusy(null);
    if (next === null) return;
    if (next === sessionId) {
      // One app, one session: carry on here.
      if (onBuildHere) onBuildHere(idea);
      return;
    }
    // A scholar with an older free-play copy is taken there.
    router.push({ pathname: "/session/[id]", params: { id: next } });
  };

  const makeQuest = async (idea: ParkedIdea) => {
    setBusy({ text: idea.text, action: "quest" });
    try {
      // Always ask the server: it is idempotent per idea and replaces a seed
      // that is no longer live, which a cached questSeedId cannot know.
      const planted = await questFromParkedIdea({ sessionId, text: idea.text });
      await exploreSeed(planted.seedId, { title: idea.text });
    } catch (error) {
      Alert.alert(serverErrorMessage(error, "Couldn't make that a Quest"));
    }
    // No `finally`: the React Compiler bails out on it, and the catch never
    // rethrows, so this always runs.
    setBusy(null);
  };

  const locked = busy !== null || exploringSeedId !== null;
  const renderActions = (idea: ParkedIdea) => (
    <>
      {canBuildNow ? (
        <ActionButton
          label={MISSION_COPY.buildItNow}
          primary
          disabled={locked}
          loading={busy?.text === idea.text && busy.action === "build"}
          onPress={() => void buildNow(idea)}
        />
      ) : null}
      <ActionButton
        label={MISSION_COPY.makeItAQuest}
        disabled={locked}
        loading={busy?.text === idea.text && busy.action === "quest"}
        onPress={() => void makeQuest(idea)}
      />
    </>
  );
  return { renderActions };
}

export function SavedForLaterBlock({
  sessionId,
  ideas,
  canBuildNow,
}: {
  sessionId: Id<"sessions">;
  ideas: readonly ParkedIdea[];
  /** `freePlayEligible` from getWithMessages — whether Build it now works. */
  canBuildNow: boolean;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { renderActions } = useSavedForLaterActions({
    sessionId,
    canBuildNow,
  });
  if (ideas.length === 0) return null;
  return (
    <View style={styles.block} accessibilityLabel={MISSION_COPY.savedForLater}>
      <Text style={styles.heading}>{MISSION_COPY.savedForLater}</Text>
      <ParkedIdeaList ideas={ideas} renderActions={renderActions} />
    </View>
  );
}

function ActionButton({
  label,
  primary = false,
  disabled = false,
  loading = false,
  onPress,
}: {
  label: string;
  primary?: boolean;
  disabled?: boolean;
  loading?: boolean;
  onPress: () => void;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.button,
        primary ? styles.buttonPrimary : styles.buttonOutline,
        (pressed || disabled) && { opacity: 0.7 },
      ]}
    >
      {loading ? (
        <ActivityIndicator
          size="small"
          color={primary ? colors.white : colors.violet}
        />
      ) : (
        <Text
          style={[
            styles.buttonText,
            { color: primary ? colors.white : colors.violet },
          ]}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    block: {
      marginBottom: 14,
      borderRadius: 18,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      backgroundColor: c.gray50,
      padding: 14,
      gap: 8,
    },
    heading: { fontFamily: fonts.bold, fontSize: 15, color: c.navy },
    button: {
      borderRadius: 999,
      paddingHorizontal: 12,
      paddingVertical: 6,
      minHeight: 30,
      justifyContent: "center",
      alignItems: "center",
    },
    buttonPrimary: { backgroundColor: c.violet },
    buttonOutline: { borderWidth: 1, borderColor: c.violet },
    buttonText: { fontFamily: fonts.semibold, fontSize: 13.5 },
  });
}
