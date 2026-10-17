import Constants from "expo-constants";
import * as Device from "expo-device";
import { useConvexAuth, useMutation } from "convex/react";
import { useEffect } from "react";
import { AppState } from "react-native";

import { api, type Id } from "@/lib/convex";
import { onAppHealthOutbox } from "@/lib/appHealthMonitor";
import {
  isDue,
  recordFailedAttempt,
  type PendingHealthReport,
} from "@/lib/appHealth";
import { readOutbox, updateInOutbox } from "@/lib/appHealthStore";

/** Kiosk iPads rarely leave the foreground, so retry on a slow clock too. */
const RETRY_INTERVAL_MS = 60_000;

type SubmitBugReport = ReturnType<
  typeof useMutation<typeof api.bugReports.submit>
>;

/**
 * Drains the outbox while signed in. A plain function (not hook body) so the
 * React Compiler, which cannot lower try/finally, still compiles the component.
 */
function startDraining(submitBugReport: SubmitBugReport): () => void {
  let mounted = true;
  let draining = false;
  let dirty = false;

  const send = (report: PendingHealthReport, withSession: boolean) =>
    submitBugReport({
      surface: "native",
      trigger: report.trigger,
      url: report.route,
      sessionId: withSession
        ? (report.sessionId as Id<"sessions"> | undefined)
        : undefined,
      clientReportId: report.id,
      description: report.description,
      deviceModel: Device.modelName ?? undefined,
      osVersion: Device.osVersion ?? undefined,
      appVersion: Constants.expoConfig?.version,
      appBuild: Constants.expoConfig?.ios?.buildNumber,
    });

  const deliver = async (report: PendingHealthReport) => {
    try {
      let result;
      try {
        result = await send(report, true);
      } catch (error) {
        // A malformed session id fails argument validation for good; the
        // report is still worth sending without it.
        if (!report.sessionId) throw error;
        result = await send(report, false);
      }
      if (!result.ok) console.warn("[app-health] report refused", result.error);
      // Delivered, or refused for good: either way it leaves the outbox.
      await updateInOutbox(report.id, null);
    } catch (error) {
      // Offline, or a backend without `trigger` yet: keep it, count it.
      console.warn("[app-health] report send failed", error);
      await updateInOutbox(report.id, recordFailedAttempt(report, Date.now()));
    }
  };

  const drain = async () => {
    if (draining) {
      dirty = true;
      return;
    }
    draining = true;
    try {
      do {
        dirty = false;
        for (const report of await readOutbox()) {
          if (!mounted) return;
          if (isDue(report, Date.now())) await deliver(report);
        }
      } while (dirty && mounted);
    } finally {
      draining = false;
    }
  };

  void drain();
  const unsubscribe = onAppHealthOutbox(() => void drain());
  const subscription = AppState.addEventListener("change", (state) => {
    if (state === "active") void drain();
  });
  const timer = setInterval(() => void drain(), RETRY_INTERVAL_MS);
  return () => {
    mounted = false;
    unsubscribe();
    subscription.remove();
    clearInterval(timer);
  };
}

/**
 * Sends automatic crash / freeze / quit reports (lib/appHealth.ts) to the
 * bug-report pipeline, which posts them to the triage Slack channel. Reports
 * wait on disk until someone is signed in; a failed send stays queued and is
 * retried with backoff (checked on a new report, a foreground, every minute)
 * for up to REPORT_MAX_AGE_MS.
 */
export function AppHealthReporter() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const submitBugReport = useMutation(api.bugReports.submit);

  useEffect(() => {
    if (isLoading || !isAuthenticated) return;
    return startDraining(submitBugReport);
  }, [isAuthenticated, isLoading, submitBugReport]);

  return null;
}
