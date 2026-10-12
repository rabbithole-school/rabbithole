import { useUniversalLinkNavigation } from "@/hooks/useUniversalLinkNavigation";

/**
 * Mount point for universal-link navigation. Renders nothing; it exists only to
 * run useUniversalLinkNavigation inside the router + auth providers (the same
 * placement pattern as DevNavigationBridge). Unlike the dev navigation bridge,
 * this is always active — universal links mainly serve RELEASE builds.
 */
export function UniversalLinkNavigator(): null {
  useUniversalLinkNavigation();
  return null;
}
