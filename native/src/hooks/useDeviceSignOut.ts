import { useCallback, useEffect, useRef, useState } from "react";
import { useAuthActions } from "@convex-dev/auth/react";
import { useMutation, useQuery } from "convex/react";
import { Alert } from "react-native";

import { api } from "@/lib/convex";
import { getStableDeviceId } from "@/lib/deviceIdentity";
import {
  clearManagedClaimSuppression,
  readManagedClaim,
  suppressManagedClaim,
} from "@/lib/managedClaim";

function useDeviceId(): string | null {
  const [deviceId, setDeviceId] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void getStableDeviceId()
      .then((id) => {
        if (active) setDeviceId(id);
      })
      .catch((error) => {
        console.warn("[deviceSignOut] couldn't read device identity", error);
      });
    return () => {
      active = false;
    };
  }, []);
  return deviceId;
}

export function useDeviceSignOutPrompt(): () => void {
  const deviceId = useDeviceId();
  const status = useQuery(
    api.deviceSignOut.statusForDevice,
    deviceId ? { deviceId } : "skip",
  );
  const requestApproval = useMutation(api.deviceSignOut.requestApproval);
  const { signOut } = useAuthActions();

  return useCallback(() => {
    if (!deviceId || status === undefined) {
      Alert.alert(
        "Checking this iPad",
        "Please wait a moment, then try signing out again.",
      );
      return;
    }
    if (status?.paired) {
      if (status.request?.status === "pending") {
        Alert.alert(
          status.request.notified ? "Approval requested" : "Requesting approval",
          status.request.notified
            ? "A teacher has been alerted. This iPad will sign out after they approve the request."
            : "The request is being sent. This iPad will sign out after a teacher approves it.",
          [{ text: "OK" }],
        );
        return;
      }
      if (status.request?.status === "approved") {
        Alert.alert(
          "Approval received",
          "This iPad is finishing sign-out now.",
          [{ text: "OK" }],
        );
        return;
      }
      if (
        status.request?.status === "expired" &&
        status.request.slackPostError
      ) {
        Alert.alert(
          "Couldn't alert a teacher",
          `${status.request.slackPostError} Ask a teacher for help or try again.`,
          [{ text: "OK" }],
        );
        return;
      }
      Alert.alert(
        `This iPad is paired to ${status.scholarName}`,
        "Signing out requires teacher approval. Request teacher approval?",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Request approval",
            onPress: () => {
              void requestApproval({ deviceId })
                .then(() => {
                  Alert.alert(
                    "Requesting approval",
                    "The request is being sent. This iPad will sign out after a teacher approves it.",
                    [{ text: "OK" }],
                  );
                })
                .catch((error) => {
                  Alert.alert(
                    "Couldn't request approval",
                    error instanceof Error ? error.message : "Please try again.",
                  );
                });
            },
          },
        ],
      );
      return;
    }

    Alert.alert(
      "Sign out?",
      "You'll need your username and password to sign back in.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Sign out",
          style: "destructive",
          onPress: () => void signOut(),
        },
      ],
    );
  }, [deviceId, requestApproval, signOut, status]);
}

export function useApprovedDeviceSignOut(enabled: boolean): void {
  const deviceId = useDeviceId();
  const status = useQuery(
    api.deviceSignOut.statusForDevice,
    enabled && deviceId ? { deviceId } : "skip",
  );
  const complete = useMutation(api.deviceSignOut.completeApprovedSignOut);
  const { signOut } = useAuthActions();
  const completingRef = useRef<string | null>(null);
  const [retryVersion, setRetryVersion] = useState(0);

  useEffect(() => {
    const request = status?.request;
    if (
      !enabled ||
      !deviceId ||
      request?.status !== "approved" ||
      completingRef.current === request._id
    ) {
      return;
    }
    completingRef.current = request._id;
    void (async () => {
      let suppressedClaimToken: string | null = null;
      let completionCommitted = false;
      try {
        const claim = readManagedClaim();
        if (claim) {
          await suppressManagedClaim(claim.claimToken);
          suppressedClaimToken = claim.claimToken;
        }
        await complete({ requestId: request._id, deviceId });
        completionCommitted = true;
        await signOut();
      } catch (error) {
        if (suppressedClaimToken && !completionCommitted) {
          await clearManagedClaimSuppression(suppressedClaimToken).catch(
            (suppressionError) => {
              console.warn(
                "[deviceSignOut] couldn't clear managed claim suppression",
                suppressionError,
              );
            },
          );
        }
        completingRef.current = null;
        console.warn("[deviceSignOut] approved sign-out failed", error);
        Alert.alert(
          "Couldn't sign out",
          "Your teacher approved the request, but this iPad couldn't finish signing out. Check the connection and try again.",
          [
            { text: "Cancel", style: "cancel" },
            {
              text: "Try again",
              onPress: () => setRetryVersion((version) => version + 1),
            },
          ],
        );
      }
    })();
  }, [complete, deviceId, enabled, retryVersion, signOut, status]);
}
