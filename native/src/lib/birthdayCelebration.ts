// Fire-once-per-birthday flag for the scholar-home confetti burst. Keyed by
// the institution day-key so the burst plays on the FIRST arrival that day and
// not on every return to home. Mirrors onboardingStorage.ts: expo-secure-store,
// best-effort, never throws. (SecureStore keys allow [A-Za-z0-9._-], so a
// "YYYY-MM-DD" day-key is a safe suffix.)

import * as SecureStore from "expo-secure-store";

const keyFor = (dayKey: string) => `rabbithole_birthday_seen_${dayKey}`;

export async function hasSeenBirthday(dayKey: string): Promise<boolean> {
  try {
    const val = await SecureStore.getItemAsync(keyFor(dayKey));
    return val === "1";
  } catch {
    return false;
  }
}

export async function markBirthdaySeen(dayKey: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(keyFor(dayKey), "1");
  } catch {
    // Best-effort; a failed write just means the burst may replay on the next
    // home arrival, which is acceptable.
  }
}
