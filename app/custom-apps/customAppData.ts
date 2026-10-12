import { cache } from "react";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";

type CustomAppBase = {
  name: string;
  status: "building" | "live";
  origin: "starter" | null;
  thumbnailUrl: string | null;
  appAssets: Array<{ id: string; url: string }>;
};

export type ResolvedCustomApp =
  | (CustomAppBase & {
      kind: "static";
      html: string | null;
    })
  | (CustomAppBase & {
      kind: "coded";
      routePath: string | null;
    });

async function queryCustomAppByToken(
  token: string,
): Promise<ResolvedCustomApp | null> {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) return null;

  try {
    return await new ConvexHttpClient(convexUrl).action(
      api.appAssetHostActions.resolveCustomAppForHost,
      { token },
    );
  } catch (error) {
    console.error("[custom-apps] token resolution failed", error);
    return null;
  }
}

// The page and generateMetadata resolve the same token during one render.
export const resolveCustomAppByToken = cache(queryCustomAppByToken);
