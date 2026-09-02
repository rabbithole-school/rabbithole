// Thin re-export seam: the launch machinery now lives in the app-lifetime
// NativeAppLaunchProvider (native/src/contexts/NativeAppLaunchContext.tsx) so it
// is single-flight and cannot unmount mid-launch. Components keep importing a
// `useNativeAppLauncher` hook; it just reads the provider's launch function.
export {
  useNativeAppLauncher,
  type LaunchNativeApp,
} from "@/contexts/NativeAppLaunchContext";
