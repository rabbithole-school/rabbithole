import type { Metadata } from "next";

export const GENERIC_SITE_TITLE = "Rabbithole";
export const GENERIC_SITE_DESCRIPTION = "AI that makes you think harder.";

type CustomAppMetadataSource = {
  name: string;
  kind: "static" | "coded";
  status: "building" | "live" | "archived";
  origin?: "starter" | null;
};

export function customAppDescription(app: CustomAppMetadataSource): string {
  if (app.origin === "starter") {
    return "An interactive learning app made in Rabbithole.";
  }
  if (app.kind === "coded") {
    return "An interactive app built in Rabbithole.";
  }
  return "An interactive app made in Rabbithole.";
}

function genericSiteMetadata(): Metadata {
  const image = {
    url: "/opengraph-image.png",
    alt: "The Rabbithole astronaut rabbit",
  };
  return {
    title: GENERIC_SITE_TITLE,
    description: GENERIC_SITE_DESCRIPTION,
    openGraph: {
      title: GENERIC_SITE_TITLE,
      description: GENERIC_SITE_DESCRIPTION,
      siteName: GENERIC_SITE_TITLE,
      type: "website",
      images: [image],
    },
    twitter: {
      card: "summary_large_image",
      title: GENERIC_SITE_TITLE,
      description: GENERIC_SITE_DESCRIPTION,
      images: [image],
    },
  };
}

export function buildCustomAppMetadata(
  app: CustomAppMetadataSource | null,
  token: string,
): Metadata {
  if (!app || app.status === "archived") {
    return genericSiteMetadata();
  }

  const title = app.name.trim() || "A Rabbithole app";
  const description = customAppDescription(app);
  const image = {
    url: `/custom-apps/og?token=${encodeURIComponent(token)}`,
    alt: `${title} — a Rabbithole app`,
  };

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      siteName: GENERIC_SITE_TITLE,
      type: "website",
      images: [image],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [image],
    },
  };
}
