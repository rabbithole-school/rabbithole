"use client";

import { createToaster } from "@chakra-ui/react";
import { haptic } from "@/lib/native";

export const toaster = createToaster({
  placement: "top",
  duration: 4000,
});

// In the iPad shell, haptics ride along with toast semantics: an error toast
// buzzes "warning", a success toast taps "success" (no-op on the web). The
// methods are patched in place — NOT spread into a copy — so the <Toaster>
// component keeps the exact store instance it subscribed to.
const origError = toaster.error.bind(toaster);
const origSuccess = toaster.success.bind(toaster);
toaster.error = (...args: Parameters<typeof origError>) => {
  haptic("warning");
  return origError(...args);
};
toaster.success = (...args: Parameters<typeof origSuccess>) => {
  haptic("success");
  return origSuccess(...args);
};
