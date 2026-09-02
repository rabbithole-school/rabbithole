import { useCallback, useMemo } from "react";
import { ScrollView, View } from "react-native";
import { Stack, router } from "expo-router";

import { IdeasBoard, MissionSubhead, makeStyles } from "@/app/meta";
import { useColors } from "@/theme";

/**
 * The Workshop view — the ideas board alone (the shipped IdeasBoard, reused
 * as-is). A standing place: reached from the Scholar's-Prep chooser AND anytime
 * from the account menu. Its idea chips open the standing Ask Rabbithole chat
 * seeded with the phrase.
 * review/prep-time-chooser.html.
 */
export default function WorkshopScreen() {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const seedAsk = useCallback((phrase: string) => {
    router.push({
      pathname: "/workshop-ask",
      params: { seed: phrase, n: String(Date.now()) },
    });
  }, []);

  return (
    <>
      <Stack.Screen options={{ title: "The Workshop" }} />
      <View style={styles.flex}>
        <MissionSubhead styles={styles} />
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          style={styles.flex}
          contentContainerStyle={styles.boardScrollContent}
          keyboardShouldPersistTaps="handled"
        >
          <IdeasBoard onSpark={seedAsk} colors={colors} styles={styles} />
          <View style={{ height: 40 }} />
        </ScrollView>
      </View>
    </>
  );
}
