import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { resolveReachableActivityResources } from "./activityResourceReachability";

export async function activityResourceDisplayRows(
  ctx: Pick<QueryCtx, "db" | "storage">,
  activityId: Id<"activities">,
) {
  const { all: rows } = await resolveReachableActivityResources(ctx, activityId);

  return await Promise.all(
    rows
      .map(async (row) => ({
        _id: row._id,
        title: row.title,
        kind: row.source.kind,
        fileName: row.source.kind === "file" ? row.source.fileName : null,
        mimeType: row.source.kind === "file" ? row.source.mimeType : null,
        sizeBytes: row.source.kind === "file" ? row.source.sizeBytes : null,
        url:
          row.source.kind === "file"
            ? await ctx.storage.getUrl(row.source.fileStorageId)
            : row.source.url,
      })),
  );
}
