import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import {
  authedQuery,
  teacherMutation,
  teacherQuery,
} from "./lib/customFunctions";
import {
  accessibleGroupScholars,
  requireActiveScholarAccess,
} from "./lib/access";
import { isTeacherRole, ROLES } from "./lib/roles";
import {
  hasRoomAccess,
  requireRoomOwner,
} from "./lib/rooms";
import { MAX_ROOM_MEMBERS } from "../shared/roomAppState";

const roomKind = v.union(
  v.literal("assignment"),
  v.literal("group"),
  v.literal("explicit"),
);

function normalizeRoomName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 80) {
    throw new Error("Room name must be between 1 and 80 characters");
  }
  return name;
}

async function sanitizeMemberIds(
  ctx: Parameters<typeof requireActiveScholarAccess>[0],
  teacher: Parameters<typeof requireActiveScholarAccess>[1],
  rawIds: Id<"users">[],
): Promise<Id<"users">[]> {
  const ids = Array.from(new Set(rawIds));
  if (ids.length === 0) throw new Error("Pick at least one scholar");
  if (ids.length > MAX_ROOM_MEMBERS) {
    throw new Error(`Rooms are limited to ${MAX_ROOM_MEMBERS} scholars`);
  }
  for (const id of ids) {
    const user = await ctx.db.get(id);
    if (!user || user.role !== ROLES.SCHOLAR) {
      throw new Error("Room members must be scholars");
    }
    await requireActiveScholarAccess(ctx, teacher, id);
  }
  return ids;
}

async function requireArtifactViewer(
  ctx: QueryCtx,
  user: Doc<"users">,
  artifactId: Id<"artifacts">,
) {
  const artifact = await ctx.db.get(artifactId);
  if (!artifact) throw new Error("Artifact not found");
  const session = await ctx.db.get(artifact.sessionId);
  if (!session) throw new Error("Session not found");
  if (session.userId !== user._id) {
    if (!isTeacherRole(user.role)) throw new Error("Forbidden");
    await requireActiveScholarAccess(ctx, user, session.userId);
  }
  return { artifact, session };
}

export const create = teacherMutation({
  args: {
    name: v.string(),
    kind: roomKind,
    assignmentId: v.optional(v.id("assignments")),
    groupId: v.optional(v.id("scholarGroups")),
    memberIds: v.optional(v.array(v.id("users"))),
  },
  handler: async (ctx, args) => {
    if (
      (args.kind === "assignment") !== (args.assignmentId !== undefined) ||
      (args.kind === "group") !== (args.groupId !== undefined) ||
      (args.kind === "explicit" &&
        (args.assignmentId !== undefined || args.groupId !== undefined))
    ) {
      throw new Error("Room scope does not match its assignment or group");
    }

    let sourceIds = args.memberIds ?? [];
    if (args.kind === "assignment") {
      const assignment = await ctx.db.get(args.assignmentId!);
      if (!assignment || assignment.teacherId !== ctx.user._id) {
        throw new Error("Forbidden");
      }
      const existing = await ctx.db
        .query("rooms")
        .withIndex("by_assignment", (q) =>
          q.eq("assignmentId", args.assignmentId),
        )
        .first();
      if (existing) throw new Error("This assignment already has a room");
      sourceIds = assignment.scholarIds;
    } else if (args.kind === "group") {
      const { group, scholarIds, forbidden } =
        await accessibleGroupScholars(ctx, ctx.user, args.groupId!);
      if (!group) throw new Error("Group not found");
      if (forbidden) throw new Error("Forbidden");
      sourceIds = scholarIds;
    }

    const memberIds = await sanitizeMemberIds(ctx, ctx.user, sourceIds);
    const now = Date.now();
    return await ctx.db.insert("rooms", {
      ownerTeacherId: ctx.user._id,
      name: normalizeRoomName(args.name),
      kind: args.kind,
      assignmentId: args.assignmentId,
      groupId: args.groupId,
      memberIds,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const setMembers = teacherMutation({
  args: {
    roomId: v.id("rooms"),
    memberIds: v.array(v.id("users")),
  },
  handler: async (ctx, args) => {
    await requireRoomOwner(ctx, ctx.user._id, args.roomId);
    const memberIds = await sanitizeMemberIds(ctx, ctx.user, args.memberIds);
    await ctx.db.patch(args.roomId, {
      memberIds,
      updatedAt: Date.now(),
    });
  },
});

export const listOwned = teacherQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("rooms")
      .withIndex("by_owner", (q) => q.eq("ownerTeacherId", ctx.user._id))
      .collect();
    return await Promise.all(
      rows
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(async (room) => {
          const [assignment, group, members] = await Promise.all([
            room.assignmentId ? ctx.db.get(room.assignmentId) : null,
            room.groupId ? ctx.db.get(room.groupId) : null,
            Promise.all(room.memberIds.map((id) => ctx.db.get(id))),
          ]);
          const unit = assignment?.unitId
            ? await ctx.db.get(assignment.unitId)
            : null;
          return {
            _id: room._id,
            name: room.name,
            kind: room.kind,
            assignmentId: room.assignmentId ?? null,
            assignmentTitle:
              assignment?.title ?? unit?.title ?? null,
            groupId: room.groupId ?? null,
            groupName: group?.name ?? null,
            memberIds: room.memberIds,
            members: members
              .filter((member) => member !== null)
              .map((member) => ({
                _id: member._id,
                name: member.name ?? member.username ?? "Scholar",
              })),
            updatedAt: room.updatedAt,
          };
        }),
    );
  },
});

/**
 * Assignment rooms are the only implicit binding. Explicit/group rooms must be
 * selected by id by app code, which avoids silently connecting an unrelated app
 * when a scholar belongs to multiple rooms.
 */
export const defaultForArtifact = authedQuery({
  args: { artifactId: v.id("artifacts") },
  handler: async (ctx, args) => {
    const { session } = await requireArtifactViewer(
      ctx,
      ctx.user,
      args.artifactId,
    );
    if (!session.assignmentId) return null;
    const room = await ctx.db
      .query("rooms")
      .withIndex("by_assignment", (q) =>
        q.eq("assignmentId", session.assignmentId),
      )
      .first();
    if (!room || !hasRoomAccess(room, ctx.user)) return null;
    return { _id: room._id, name: room.name };
  },
});

/**
 * Resolve an iframe-supplied room id only after verifying the artifact viewer
 * and room membership. Invalid or inaccessible values intentionally look absent.
 */
export const resolveAccessibleForArtifact = authedQuery({
  args: { artifactId: v.id("artifacts"), roomId: v.string() },
  handler: async (ctx, args) => {
    await requireArtifactViewer(ctx, ctx.user, args.artifactId);
    const roomId = ctx.db.normalizeId("rooms", args.roomId.trim());
    if (!roomId) return null;
    const room = await ctx.db.get(roomId);
    if (!room || !hasRoomAccess(room, ctx.user)) return null;
    return { _id: room._id, name: room.name };
  },
});
