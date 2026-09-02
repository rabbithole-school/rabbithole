"use client";

import { useEffect, useState } from "react";
import {
  institutionDayAt,
  millisecondsUntilNextDay,
  type InstitutionDay,
} from "@/shared/institutionDay";

/**
 * Keeps mounted day-scoped subscriptions aligned with institution midnight and
 * corrects immediately after a sleeping/backgrounded tab resumes.
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
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", resume);
    };
  }, [timeZone]);

  if (!serverDay) return null;
  return localDay?.timeZone === serverDay.timeZone ? localDay : serverDay;
}
