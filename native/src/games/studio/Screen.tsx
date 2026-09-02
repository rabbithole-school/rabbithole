import { useCallback, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { StudioWorkspace } from "@/components/studio/StudioScreen";
import { fonts, useColors } from "@/theme";
import type { GameScreenProps } from "../../../vendor/games/contract";
import type { StudioRunResult } from "../../../vendor/shared/studioContract";
import {
  allocateStudioWorld,
  levelsForConfig,
  recordStudioRun,
  studioRunEvidence,
  type StudioGameConfig,
  type StudioGameState,
} from "./rules";

export default function StudioGameScreen({
  launch,
  checkpoint,
  host,
}: GameScreenProps<StudioGameConfig, StudioGameState>) {
  const colors = useColors();
  const [state, setState] = useState(launch.state);
  const stateRef = useRef(state);
  const levels = useMemo(() => levelsForConfig(launch.config), [launch.config]);

  const updateState = useCallback((next: StudioGameState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const nextWorldSeed = useCallback(
    (levelId: string) => {
      const allocated = allocateStudioWorld(stateRef.current, launch.seed, levelId);
      updateState(allocated.state);
      return allocated.seed;
    },
    [launch.seed, updateState],
  );

  const onRun = useCallback(
    (run: StudioRunResult) => {
      const next = recordStudioRun(stateRef.current, run);
      updateState(next);
      void checkpoint.transact({
        state: next,
        events: [studioRunEvidence(run)],
      });
    },
    [checkpoint, updateState],
  );

  const finish = useCallback(async () => {
    await host.complete({
      outcomeKey: "studio_finished",
      finalState: stateRef.current,
    });
  }, [host]);

  return (
    <View style={styles.root}>
      <View style={[styles.toolbar, { borderBottomColor: colors.border }]}>
        <Text style={[styles.progress, { color: colors.fgMuted }]}>
          {state.runCount} {state.runCount === 1 ? "run" : "runs"} this session
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => void finish()}
          disabled={checkpoint.pending}
          style={({ pressed }) => [
            styles.doneButton,
            { backgroundColor: colors.navy },
            (pressed || checkpoint.pending) && styles.pressed,
          ]}
        >
          <Text style={[styles.doneText, { color: colors.bg }]}>Done</Text>
        </Pressable>
      </View>
      <StudioWorkspace
        levels={levels}
        seedBase={launch.seed}
        nextWorldSeed={nextWorldSeed}
        onRun={onRun}
        initialLevelId={launch.state.activeLevelId}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  toolbar: {
    minHeight: 44,
    paddingHorizontal: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 12,
  },
  progress: {
    fontFamily: fonts.regular,
    fontSize: 13,
  },
  doneButton: {
    minHeight: 36,
    paddingHorizontal: 16,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  doneText: {
    fontFamily: fonts.semibold,
    fontSize: 15,
  },
  pressed: { opacity: 0.65 },
});
