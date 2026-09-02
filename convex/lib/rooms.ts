import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

type RoomReader = Pick<QueryCtx, "db">;
type RoomActor = Pick<Doc<"users">, "_id">;

export function hasRoomAccess(
  room: Doc<"rooms">,
  actor: RoomActor,
): boolean {
  return (
    room.ownerTeacherId === actor._id ||
    room.memberIds.some((memberId) => memberId === actor._id)
  );
}

export async function requireRoomAccess(
  ctx: RoomReader,
  actor: RoomActor,
  roomId: Id<"rooms">,
): Promise<Doc<"rooms">> {
  const room = await ctx.db.get(roomId);
  if (!room || !hasRoomAccess(room, actor)) throw new Error("Forbidden");
  return room;
}

export async function requireRoomOwner(
  ctx: RoomReader,
  ownerId: Id<"users">,
  roomId: Id<"rooms">,
): Promise<Doc<"rooms">> {
  const room = await ctx.db.get(roomId);
  if (!room || room.ownerTeacherId !== ownerId) throw new Error("Forbidden");
  return room;
}
