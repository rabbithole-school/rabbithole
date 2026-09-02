"use client";

/**
 * The scholar home App Launcher — an iPad-home-screen-style grid of
 * squircles for the scholar's standing External Apps (an external practice app &
 * friends). Tapping a tile opens the domain-locked webview (iPad) or a
 * plain tab (desktop) via useExternalApp.
 *
 * Deliberately "dumb": icon + name only, no XP / streak / goal badge —
 * the teacher's assignments are the lever for "do this now", not a
 * third-party app's gamification. See review/external-apps-launcher.html.
 */

import { Box, SimpleGrid, Text, Spinner } from "@chakra-ui/react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useExternalApp } from "@/hooks/useExternalApp";
import { ScholarHomeSectionHeader } from "@/components/ui/ScholarHomeSectionHeader";
import { AppTileIcon } from "@/components/ui/AppTileIcon";

type LauncherTile = {
  // Null for a tile the scholar gets purely via an audience grant (no
  // per-scholar row); tiles are keyed by appId, which is always present.
  scholarAppId: Id<"scholarApps"> | null;
  appId: Id<"externalApps">;
  name: string;
  webUrl: string;
  webAllowedHosts: string[] | null;
  iconUrl: string | null;
  iconEmoji: string | null;
  color: string | null;
};

export function AppLauncher({ scholarId }: { scholarId?: Id<"users"> }) {
  const apps = useQuery(
    api.scholarApps.listForLauncher,
    scholarId ? { scholarId } : {},
  ) as LauncherTile[] | undefined;
  const { launch, launchingId } = useExternalApp();

  // Nothing to show (still loading or no apps) — render no section, so the
  // home stays clean for scholars who haven't been given any apps.
  if (!apps || apps.length === 0) return null;

  return (
    <Box display="flex" flexDirection="column" gap={3}>
      <ScholarHomeSectionHeader>
        Apps
      </ScholarHomeSectionHeader>
      <SimpleGrid columns={{ base: 4, sm: 5, md: 6 }} gap={{ base: 4, md: 5 }}>
        {apps.map((app) => (
          <AppTile
            key={app.appId}
            app={app}
            launching={launchingId === app.appId}
            onLaunch={() => void launch(app)}
          />
        ))}
      </SimpleGrid>
    </Box>
  );
}

function AppTile({
  app,
  launching,
  onLaunch,
}: {
  app: LauncherTile;
  launching: boolean;
  onLaunch: () => void;
}) {
  return (
    <Box
      as="button"
      onClick={() => {
        if (!launching) onLaunch();
      }}
      aria-label={app.name}
      display="flex"
      flexDirection="column"
      alignItems="center"
      gap={2}
      cursor={launching ? "default" : "pointer"}
      opacity={launching ? 0.6 : 1}
      // Big, deliberate tap target — primary device is the kids' iPad.
      role="group"
    >
      <AppTileIcon
        name={app.name}
        iconUrl={app.iconUrl}
        iconEmoji={app.iconEmoji}
        color={app.color}
        maxBoxSize="74px"
        radius="22%"
        boxShadow="0 4px 10px rgba(20,24,50,0.14), inset 0 1px 0 rgba(255,255,255,0.4)"
        markFontSize="26px"
        imagePadding="14%"
        interactive
        // The button around it is already labeled with the app name, and the
        // caption below repeats it.
        decorative
      >
        {launching && (
          <Box
            position="absolute"
            inset={0}
            bg="blackAlpha.300"
            display="flex"
            alignItems="center"
            justifyContent="center"
          >
            <Spinner size="sm" color="white" />
          </Box>
        )}
      </AppTileIcon>
      <Text
        fontFamily="body"
        fontSize="xs"
        fontWeight="600"
        color="charcoal.500"
        textAlign="center"
        lineHeight="1.2"
        lineClamp={2}
      >
        {app.name}
      </Text>
    </Box>
  );
}
