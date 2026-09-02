// Pure ASAM (Autonomous Single App Mode) decision logic — NO React or
// React-Native imports, so it unit-tests as a plain function. Given the current
// {isOnline, paired, armed, inSam} snapshot it returns the single transition the
// controller should apply next.
//
// The "best of both" behavior this encodes:
//   - When Rabbithole Lock is ARMED and ONLINE, keep the app locked into
//     Single App Mode so schoolwork stays distraction-free.
//   - When we go OFFLINE while locked, STEP OUT of Single App Mode so a trusted
//     adult can reach Settings → Wi-Fi and fix connectivity (the whole point of
//     the hybrid over hard App Lock).
//   - When staff remotely DISARMS while locked, STEP OUT and stay out until the
//     server-owned desired state re-arms.
//   - Never enter ASAM unless this install has a current paired-device record.

/** The connectivity + intent snapshot the decision is a pure function of. */
export type AsamInputs = {
  /** True when the device currently has confirmed internet. */
  isOnline: boolean;
  /** Server pairing result, or "unknown" while the current read is loading. */
  paired: boolean | "unknown";
  /** True when Rabbithole Lock is armed in the server-owned setting. */
  armed: boolean;
  /** True when the app is currently locked in Single App Mode (OS truth). */
  inSam: boolean;
};

/** The transition to apply. "none" = already in the desired state. */
export type AsamAction = "enter" | "exit" | "none";

export type AsamLockStatus = {
  label: string;
  tone: "success" | "warning" | "neutral";
  detail: string;
};

type AsamLockStateForStatus = {
  desiredState: "armed" | "disarmed";
  disarmMode:
    | "one_time"
    | "until_midnight"
    | "until_further_notice"
    | "timed"
    | null;
  /** Only meaningful for "until_midnight" / "timed"; unused otherwise. */
  disarmExpiresAt?: number | null;
};

/** "4:35 PM" in the device's own locale/timezone — the person reading this is standing next to the iPad. */
function formatDisarmExpiryTime(expiresAt: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(expiresAt);
  } catch {
    return new Date(expiresAt).toLocaleTimeString();
  }
}

export type OneTimeDisarmAction = "clear" | "wait" | "observe" | "consume";

type AsamTransitionDriver = {
  enter: () => Promise<boolean>;
  exit: () => Promise<boolean>;
};

/**
 * ASAM is an MDM capability, never a build-channel capability. Keeping the
 * gate in managed configuration lets the App Store-safe Stable binary run on
 * an ordinary install without attempting ASAM while enabling it on a school
 * iPad that has both the MDM permission payload and this explicit opt-in.
 */
export function isManagedAsamEnabled(
  config: Record<string, unknown> | null,
): boolean {
  return config?.asamEnabled === "1";
}

export type AppLifecycleState =
  | "active"
  | "background"
  | "inactive"
  | "unknown"
  | "extension";

export type OneTimeDisarmInputs = {
  desiredUpdatedAt: number | null;
  observedUpdatedAt: number | null;
  observedEntryVersion: number | null;
  appEntryVersion: number;
  isAppActive: boolean;
  inSam: boolean;
};

/**
 * Decide the next Single App Mode transition from the current snapshot. Pure:
 * same inputs → same output, no side effects.
 *
 * Truth table (all eight combinations):
 *   online armed inSam → action
 *     T     T     F   → "enter"  (armed + online, not yet locked → lock in)
 *     T     T     T   → "none"   (already where we want to be)
 *     F     *     T   → "exit"   (offline while locked → free Settings/Wi-Fi)
 *     *     F     T   → "exit"   (staff disarmed → step out, stay out)
 *     otherwise       → "none"
 */
export function decideAsamAction({
  isOnline,
  paired,
  armed,
  inSam,
}: AsamInputs): AsamAction {
  // Offline while locked → step out so Settings → Wi-Fi is reachable to fix it.
  if (!isOnline && inSam) return "exit";
  // Hold the current OS state until the server confirms whether this install is
  // paired. A cold-start loading gap must never briefly release a locked iPad.
  if (paired === "unknown") return "none";
  // Unpaired or disarmed while still locked → step out and stay out.
  if ((!paired || !armed) && inSam) return "exit";
  // Online, armed, not yet locked → lock ourselves in.
  if (isOnline && paired && armed && !inSam) return "enter";
  // Online + armed + already locked, or nothing to do → leave it alone.
  return "none";
}

/**
 * The Wi-Fi recovery label is reserved for a confirmed armed pairing which has
 * stepped out of ASAM. Cached or disarmed state must keep its ordinary status.
 */
export function shouldUseOfflineRecoveryBypass({
  isOnline,
  paired,
  armed,
  inSam,
}: AsamInputs): boolean {
  return !isOnline && paired === true && armed && !inSam;
}

/** Select the parent-gate status without importing React Native. */
export function selectAsamLockStatus(
  state: AsamLockStateForStatus | null,
  isAsamActive: boolean,
  isOfflineRecoveryBypass: boolean,
): AsamLockStatus {
  if (isOfflineRecoveryBypass) {
    return {
      label: "Lock paused for Wi-Fi recovery",
      tone: "warning",
      detail: "Rabbithole Lock resumes after this iPad reconnects.",
    };
  }
  if (!state) {
    return {
      label: "This iPad is not paired",
      tone: "warning",
      detail: "Pair this iPad before managing Rabbithole Lock.",
    };
  }
  if (state.desiredState === "armed") {
    return isAsamActive
      ? {
          label: "Rabbithole Lock is armed",
          tone: "success",
          detail: "This iPad is staying in Rabbithole.",
        }
      : {
          label: "Rabbithole Lock is arming",
          tone: "neutral",
          detail: "The iPad is applying the latest setting.",
        };
  }
  return !isAsamActive
    ? {
        label: "Rabbithole Lock is disarmed",
        tone: "warning",
        detail:
          state.disarmMode === "one_time"
            ? "It re-arms the next time Rabbithole is entered."
            : state.disarmMode === "until_further_notice"
              ? "It stays disarmed until a staff member re-arms it."
              : state.disarmMode === "timed"
                ? state.disarmExpiresAt
                  ? `It re-arms automatically at ${formatDisarmExpiryTime(state.disarmExpiresAt)}.`
                  : "It re-arms automatically soon."
                : "It re-arms automatically at midnight.",
      }
    : {
        label: "Rabbithole Lock is disarming",
        tone: "neutral",
        detail: "The iPad is applying the latest setting.",
      };
}

/**
 * Apply an OS transition and turn Apple's `false` result into a visible error.
 * iOS reports `false` rather than throwing when MDM has not permitted this
 * bundle for ASAM, so silently ignoring the result leaves the UI "arming"
 * forever with no diagnosis.
 */
export async function applyAsamAction(
  action: AsamAction,
  driver: AsamTransitionDriver,
): Promise<void> {
  if (action === "none") return;
  const applied =
    action === "enter" ? await driver.enter() : await driver.exit();
  if (applied) return;
  throw new Error(
    action === "enter"
      ? "Rabbithole Lock could not arm. This app is not permitted by the iPad management profile."
      : "Rabbithole Lock could not disarm. Reopen Rabbithole and try again.",
  );
}

/**
 * A one-time disarm becomes consumable only after this app has observed the
 * release while active and outside Single App Mode, followed by a later app
 * entry. Local entry versions avoid comparing the iPad and server clocks.
 */
export function decideOneTimeDisarmAction({
  desiredUpdatedAt,
  observedUpdatedAt,
  observedEntryVersion,
  appEntryVersion,
  isAppActive,
  inSam,
}: OneTimeDisarmInputs): OneTimeDisarmAction {
  if (desiredUpdatedAt === null) return "clear";
  if (observedUpdatedAt !== desiredUpdatedAt) {
    return isAppActive && !inSam ? "observe" : "wait";
  }
  return observedEntryVersion !== null &&
    appEntryVersion > observedEntryVersion
    ? "consume"
    : "wait";
}

/** Screen interruptions use "inactive"; only a real background return is re-entry. */
export function isAppReentry(
  previous: AppLifecycleState,
  next: AppLifecycleState,
): boolean {
  return previous === "background" && next === "active";
}
