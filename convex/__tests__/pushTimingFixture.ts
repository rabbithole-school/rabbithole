import type { Doc } from "../_generated/dataModel";
import type { RequestedWindow } from "../../shared/classMeetings";

// Test fixtures for a push's WHEN, stored the way writers store it since
// TRA-580 step 5: `timing` holds only the kind, and the end lives in the
// top-level `endsAt` + `afterEnd`. Readers no longer fall back to a nested
// `timing.endsAt`/`timing.dueAt`, so a fixture row must carry these fields.
//
// An untimed focus gets no `endsAt` here. Real writers store the close of its
// school day, but no reader consumes an `untilCleared` push's end, so a
// fixture that does not care about it leaves it out.

export type StoredTiming = Pick<Doc<"pushes">, "timing" | "endsAt" | "afterEnd">;

/** The stored fields for a requested window (focus end, homework due). */
export function storedTiming(window: RequestedWindow): StoredTiming {
  switch (window.kind) {
    case "focus":
      return { timing: { kind: "focus" }, endsAt: window.endsAt, afterEnd: "fade" };
    case "untilCleared":
      return { timing: { kind: "untilCleared" }, afterEnd: "fade" };
    case "homework":
      return { timing: { kind: "homework" }, endsAt: window.dueAt, afterEnd: "late" };
  }
}
