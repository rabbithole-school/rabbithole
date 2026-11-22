import { useEffect, useState } from "react";
import { AppState } from "react-native";
import {
  institutionDayAt,
  millisecondsUntilNextDay,
  type InstitutionDay,
} from "../../vendor/shared/institutionDay";

/**
 * Institution-local day state with midnight and app-resume correction.
 *
 * The day is read off the device clock as soon as the time zone is known, not
 * taken from `serverDay.dayKey`: that is a query result, only as fresh as its
 * last run, and a subscription another screen kept alive overnight still
 * carries yesterday. Day-scoped queries answer for the key this returns (T11).
 */
export function useInstitutionDay(
  serverDay: InstitutionDay | null | undefined,
): InstitutionDay | null {
  const [localDay, setLocalDay] = useState<InstitutionDay | null>(null);
  const timeZone = serverDay?.timeZone;

  useEffect(() => {
    if (!timeZone) return;

    let timer: ReturnType<typeof setTimeout>;
    const recompute = () => {
      const next = institutionDayAt(Date.now(), timeZone);
      setLocalDay((prev) =>
        prev?.timeZone === next.timeZone && prev.dayKey === next.dayKey
          ? prev
          : next,
      );
    };
    const arm = () => {
      timer = setTimeout(() => {
        recompute();
        arm();
      }, millisecondsUntilNextDay(Date.now(), timeZone));
    };
    const resume = () => {
      clearTimeout(timer);
      recompute();
      arm();
    };

    // Read the device clock as soon as the time zone is known (see above);
    // resume() then arms the midnight timer.
    timer = setTimeout(resume, 0);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") resume();
    });
    return () => {
      clearTimeout(timer);
      subscription.remove();
    };
  }, [timeZone]);

  if (!serverDay) return null;
  return localDay?.timeZone === serverDay.timeZone ? localDay : serverDay;
}
