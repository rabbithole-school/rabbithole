import { useEffect, useState } from "react";
import { AppState } from "react-native";
import {
  institutionDayAt,
  millisecondsUntilNextDay,
  type InstitutionDay,
} from "../../vendor/shared/institutionDay";

/** Institution-local day state with midnight and app-resume correction. */
export function useInstitutionDay(
  serverDay: InstitutionDay | null | undefined,
): InstitutionDay | null {
  const [localDay, setLocalDay] = useState<InstitutionDay | null>(null);
  const timeZone = serverDay?.timeZone;

  useEffect(() => {
    if (!timeZone) return;

    let timer: ReturnType<typeof setTimeout>;
    const recompute = () => {
      setLocalDay(institutionDayAt(Date.now(), timeZone));
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

    arm();
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
