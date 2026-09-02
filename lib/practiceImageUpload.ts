import type { Id } from "@/convex/_generated/dataModel";

export type PracticeImageSource = "hint" | "miss" | "handoff" | "dialogue";

export function practiceImageUploadUrl(
  siteUrl: string,
  args: {
    scholarId: Id<"users">;
    itemId: string;
    source: PracticeImageSource;
  },
): string {
  const query = new URLSearchParams({
    scholarId: args.scholarId,
    itemId: args.itemId,
    source: args.source,
  });
  return `${siteUrl}/practice-image-upload?${query.toString()}`;
}

export async function uploadPracticeImage(args: {
  siteUrl: string;
  authToken: string;
  scholarId: Id<"users">;
  itemId: string;
  source: PracticeImageSource;
  body: Blob;
}): Promise<Id<"_storage">> {
  const response = await fetch(
    practiceImageUploadUrl(args.siteUrl, args),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.authToken}`,
        "Content-Type": args.body.type,
      },
      body: args.body,
    },
  );
  if (!response.ok) {
    throw new Error(`practice image upload failed (${response.status})`);
  }
  const data = (await response.json()) as { storageId?: Id<"_storage"> };
  if (!data.storageId) throw new Error("practice image upload returned no storage id");
  return data.storageId;
}
