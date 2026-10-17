"use client";

/**
 * AppCard — a session's live app as it sits in the chat's document panel
 * (TRA-519, one app surface). It replaces the panel's old Preview/Code tab:
 * the app runs live and interactive here (app state, Ask the tutor, the
 * snapshot capture and app actions work exactly as before), and **Open**
 * takes the SAME session full screen into the builder, where Code, History
 * and the rest live. The native twin is `native/src/components/AppCard.tsx`;
 * its copy comes from the same `APP_SURFACE_COPY`.
 *
 * The title is not repeated here: the panel's document switcher right above
 * the card already names the app.
 */

import { Button, Flex, Text } from "@chakra-ui/react";
import { ArrowsOut } from "@phosphor-icons/react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { CaptureAppSnapshot } from "@/hooks/useAppStateIframeBridge";
import type { AppTutorRequest } from "@/shared/appTutorRequest";
import { APP_SURFACE_COPY } from "@/shared/appSurface";
import { revisionsForApp } from "@/lib/vibecode/helpers";
import { CodeArtifactViewer } from "./CodeArtifactViewer";
import type { ArtifactSaveResult } from "./ArtifactPanel";

export function AppCard({
  artifact,
  builder,
  onSave,
  onSyncChange,
  onSnapshotCaptureReady,
  onAskTutor,
  onAppAiTurn,
  appAiEnabled,
}: {
  artifact: {
    _id: string;
    title: string;
    content: string;
    lastEditedBy: string;
    revision?: number;
    language?: string;
  };
  /** The builder this app opens in — on this app, newest or not. Absent for a
   *  code document the builder can't show. */
  builder?: { sessionId: Id<"sessions">; onOpen: () => void };
  onSave: (updates: {
    content?: string;
    title?: string;
    baseRevision?: number;
  }) => Promise<ArtifactSaveResult>;
  onSyncChange?: (synced: boolean) => void;
  onSnapshotCaptureReady?: (capture: CaptureAppSnapshot | null) => void;
  onAskTutor?: (request: AppTutorRequest) => void | Promise<void>;
  onAppAiTurn?: () => void;
  appAiEnabled: boolean;
}) {
  // The newest of THIS app's versions (the builder's History lists the same).
  const revisions = useQuery(
    api.codeArtifactRevisions.listForSession,
    builder ? { sessionId: builder.sessionId } : "skip",
  );
  const version = (revisionsForApp(revisions, artifact._id) ?? []).reduce(
    (max, rev) => Math.max(max, rev.version),
    0,
  );

  return (
    <Flex flexDir="column" flex={1} minH={0}>
      {builder && (
        <Flex
          align="center"
          gap={2}
          px={3}
          py={2}
          borderBottom="1px solid"
          borderColor="gray.100"
          flexShrink={0}
        >
          {version > 0 && (
            <Text fontFamily="heading" fontSize="sm" color="charcoal.400">
              {APP_SURFACE_COPY.version(version)}
            </Text>
          )}
          <Button
            ml="auto"
            size="sm"
            variant="outline"
            colorPalette="violet"
            fontFamily="heading"
            onClick={builder.onOpen}
          >
            <ArrowsOut />
            {APP_SURFACE_COPY.open}
          </Button>
        </Flex>
      )}
      {/* The viewer's root is flex={1}; it needs this flex column parent to
          fill the card instead of collapsing to its content height. */}
      <Flex flexDir="column" flex={1} minH={0}>
        <CodeArtifactViewer
          key={artifact._id}
          artifact={artifact}
          // The app only: Code, History and the rest are one Open away.
          appOnly
          onSave={onSave}
          onSyncChange={onSyncChange}
          onSnapshotCaptureReady={onSnapshotCaptureReady}
          onAskTutor={onAskTutor}
          onAppAiTurn={onAppAiTurn}
          appAiEnabled={appAiEnabled}
        />
      </Flex>
    </Flex>
  );
}
