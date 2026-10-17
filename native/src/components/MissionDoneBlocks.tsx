/**
 * The done-screen pieces of the mission program (TRA-519), rendered under the
 * completion card in native/src/app/session/[id].tsx:
 *   • SavedForLaterBlock (B2) — the session's parked ideas come back, each with
 *     "Build it now" (sessions.startFreePlay with the idea → open the new
 *     session) and "Make it a Quest" (sessions.questFromParkedIdea plants or
 *     reuses a seed → the existing seed flow, useExploreSeed).
 *   • QuestBuildUnlockOffer (B6) — a finished Quest with no build step offers
 *     "Unlock: build a simulation of this" (quests.appendBuildStep → open the
 *     new step the way the Quest page starts an activity).
 * The caller decides when each shows; labels come from shared/missionCopy so
 * they match web byte for byte. Web twins: components/SavedForLaterBlock.tsx,
 * components/QuestBuildUnlockOffer.tsx.
 */
import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "convex/react";
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
import { api, type Id } from "@/lib/convex";
import {
  appendBuildStepRef,
  canUnlockBuildOf,
  questFromParkedIdeaRef,
  startFreePlayRef,
} from "@/lib/missionApi";
import { fonts, useColors } from "@/theme";
import { MISSION_COPY } from "../../vendor/shared/missionCopy";
import { serverErrorMessage } from "../../vendor/shared/serverErrorMessage";

type Busy = { text: string; action: "build" | "quest" } | null;

/**
 * Build it now + Make it a Quest for each parked idea, shared by the chat done
 * screen (SavedForLaterBlock below) and the builder's done state (the Workshop
 * strip, components/vibecode/ParkingLot.tsx). `renderActions` goes to
 * ParkedIdeaList; the caller renders `dialog` (the seed flow's path picker).
 */
export function useSavedForLaterActions({
  sessionId,
  canBuildNow,
}: {
  sessionId: Id<"sessions">;
  /** `freePlayEligible` from getWithMessages — whether Build it now works. */
  canBuildNow: boolean;
}): {
  renderActions: (idea: ParkedIdea) => ReactNode;
  dialog: ReactNode;
} {
  const router = useRouter();
  const startFreePlay = useMutation(startFreePlayRef);
  const questFromParkedIdea = useMutation(questFromParkedIdeaRef);
  const { exploreSeed, exploringSeedId, exploreSeedDialog } = useExploreSeed();
  const [busy, setBusy] = useState<Busy>(null);

  const buildNow = async (idea: ParkedIdea) => {
    Haptics.selectionAsync();
    setBusy({ text: idea.text, action: "build" });
    try {
      const result = await startFreePlay({ sessionId, idea: idea.text });
      router.push({
        pathname: "/session/[id]",
        params: { id: result.sessionId },
      });
    } catch (error) {
      Alert.alert(serverErrorMessage(error, "Couldn't start building that"));
    }
    // No `finally`: the React Compiler bails out on it, and the catch never
    // rethrows, so this always runs.
    setBusy(null);
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
  return { renderActions, dialog: exploreSeedDialog };
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
  const { renderActions, dialog } = useSavedForLaterActions({
    sessionId,
    canBuildNow,
  });
  if (ideas.length === 0) return null;
  return (
    <View style={styles.block} accessibilityLabel={MISSION_COPY.savedForLater}>
      <Text style={styles.heading}>{MISSION_COPY.savedForLater}</Text>
      <ParkedIdeaList ideas={ideas} renderActions={renderActions} />
      {dialog}
    </View>
  );
}

/** Append the Quest's build step and open a session on it; the new session's
 * id, or null. Module-level for the same React Compiler reason as
 * questSeedFor. */
async function unlockBuildSession(
  unitId: Id<"units">,
  appendBuildStep: (args: { unitId: Id<"units"> }) => Promise<{ activityId: Id<"activities"> }>,
  createSession: (args: { activityId: Id<"activities"> }) => Promise<{ id?: string } | null | undefined>,
): Promise<string | null> {
  const { activityId } = await appendBuildStep({ unitId });
  const session = await createSession({ activityId });
  return session?.id ?? null;
}

export function QuestBuildUnlockOffer({ unitId }: { unitId: Id<"units"> }) {
  const router = useRouter();
  const unit = useQuery(api.units.get, { id: unitId });
  const appendBuildStep = useMutation(appendBuildStepRef);
  const createSession = useMutation(api.sessions.create);
  const [starting, setStarting] = useState(false);

  if (!canUnlockBuildOf(unit)) return null;

  const unlock = async () => {
    Haptics.selectionAsync();
    setStarting(true);
    try {
      const id = await unlockBuildSession(unitId, appendBuildStep, createSession);
      if (id) {
        router.push({
          pathname: "/session/[id]",
          params: { id, title: MISSION_COPY.unlockBuild },
        });
      }
    } catch (error) {
      Alert.alert(serverErrorMessage(error, "Couldn't unlock the build"));
    }
    // No `finally`: the React Compiler bails out on it, and the catch never
    // rethrows, so this always runs.
    setStarting(false);
  };

  return (
    <ActionButton
      label={MISSION_COPY.unlockBuild}
      primary
      loading={starting}
      disabled={starting}
      onPress={() => void unlock()}
      wide
    />
  );
}

function ActionButton({
  label,
  primary = false,
  disabled = false,
  loading = false,
  wide = false,
  onPress,
}: {
  label: string;
  primary?: boolean;
  disabled?: boolean;
  loading?: boolean;
  wide?: boolean;
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
        wide && styles.buttonWide,
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
    buttonWide: {
      alignSelf: "center",
      paddingHorizontal: 18,
      paddingVertical: 10,
      marginBottom: 14,
    },
    buttonText: { fontFamily: fonts.semibold, fontSize: 13.5 },
  });
}
