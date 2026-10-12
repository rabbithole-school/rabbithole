import type { Id } from "@/lib/convex";

export type CodeArtifactStateScope =
  | {
      kind: "session";
      artifactId: Id<"artifacts">;
    }
  | {
      kind: "customApp";
      token: string;
      stateUserId: string;
      stateKey: "default";
    };

export type CodeArtifactStateBinding =
  | {
      kind: "session";
      identity: string;
      artifactId: Id<"artifacts">;
      customAppArgs: null;
      supportsRooms: true;
      supportsActionResults: true;
    }
  | {
      kind: "customApp";
      identity: string;
      artifactId: null;
      customAppArgs: {
        token: string;
        userId: string;
        key: "default";
      };
      supportsRooms: false;
      supportsActionResults: false;
    };

export function selectCodeArtifactStateScope(
  scope: CodeArtifactStateScope,
): CodeArtifactStateBinding {
  if (scope.kind === "session") {
    return {
      kind: "session",
      identity: String(scope.artifactId),
      artifactId: scope.artifactId,
      customAppArgs: null,
      supportsRooms: true,
      supportsActionResults: true,
    };
  }
  return {
    kind: "customApp",
    identity: `customApp:${scope.token}`,
    artifactId: null,
    customAppArgs: {
      token: scope.token,
      userId: scope.stateUserId,
      key: scope.stateKey,
    },
    supportsRooms: false,
    supportsActionResults: false,
  };
}
