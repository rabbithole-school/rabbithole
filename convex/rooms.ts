import { v } from "convex/values";
import { authedQuery, teacherQuery } from "./lib/customFunctions";

/**
 * Shared rooms for vibecoded apps were removed (TRA-732). These stubs are kept
 * only so clients built before the removal keep working, since a missing
 * Convex function throws in render: shipped iPad builds query
 * defaultForArtifact on every app open, and a teacher Apps page left open in a
 * browser tab queries listOwned. Delete both once the fleet runs a build
 * without shared rooms (TRA-735).
 */
export const defaultForArtifact = authedQuery({
  args: { artifactId: v.id("artifacts") },
  handler: async () => null,
});

export const listOwned = teacherQuery({
  args: {},
  handler: async () => [],
});
