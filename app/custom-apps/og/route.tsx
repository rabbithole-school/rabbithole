import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { APP_SNAPSHOT_MAX_BYTES } from "@/convex/lib/appSnapshot";
import { ImageResponse } from "next/og";
import { resolveCustomAppByToken } from "../customAppData";
import {
  GENERIC_SITE_DESCRIPTION,
  GENERIC_SITE_TITLE,
  customAppDescription,
} from "../customAppMetadata";

export const dynamic = "force-dynamic";

const CACHE_CONTROL = "public, max-age=3600";
type OgFont = {
  name: string;
  data: ArrayBuffer;
  style: "normal";
  weight: 400 | 700;
};

let hankenGroteskFonts: OgFont[] | undefined;
try {
  const [regularFontFile, boldFontFile] = await Promise.all([
    readFile(
      join(process.cwd(), "app/fonts/HankenGrotesk-Regular-Latin.ttf"),
    ),
    readFile(
      join(process.cwd(), "app/fonts/HankenGrotesk-Bold-Latin.ttf"),
    ),
  ]);
  hankenGroteskFonts = [
    {
      name: "Hanken Grotesk",
      data: Uint8Array.from(regularFontFile).buffer,
      style: "normal",
      weight: 400,
    },
    {
      name: "Hanken Grotesk",
      data: Uint8Array.from(boldFontFile).buffer,
      style: "normal",
      weight: 700,
    },
  ];
} catch (error) {
  console.warn(
    "[custom-apps/og] custom fonts could not be loaded; using the default font",
    error,
  );
}

const markFile = await readFile(
  join(process.cwd(), "app/custom-apps/og/rh-mark.png"),
);
const markSrc = `data:image/png;base64,${markFile.toString("base64")}`;

async function storedThumbnailResponse(
  url: string,
  appName: string,
): Promise<Response | null> {
  try {
    const response = await fetch(url);
    const contentType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      .toLowerCase();
    if (
      response.ok &&
      response.body &&
      (contentType === "image/png" || contentType === "image/jpeg")
    ) {
      const declaredSize = response.headers.get("content-length");
      if (declaredSize !== null) {
        const parsedSize = Number(declaredSize);
        if (
          !Number.isSafeInteger(parsedSize) ||
          parsedSize < 0 ||
          parsedSize > APP_SNAPSHOT_MAX_BYTES
        ) {
          console.warn(
            `[custom-apps/og] stored thumbnail for "${appName}" had an invalid or oversized content-length`,
          );
          return null;
        }
      }

      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > APP_SNAPSHOT_MAX_BYTES) {
        console.warn(
          `[custom-apps/og] stored thumbnail for "${appName}" exceeded the snapshot byte limit`,
        );
        return null;
      }

      return new Response(bytes, {
        headers: {
          "Cache-Control": CACHE_CONTROL,
          "Content-Type": contentType,
        },
      });
    }
    console.warn(
      `[custom-apps/og] stored thumbnail for "${appName}" was unavailable or not an image`,
    );
  } catch (error) {
    console.warn(
      `[custom-apps/og] stored thumbnail for "${appName}" could not be loaded`,
      error,
    );
  }
  return null;
}

function generatedCard(title: string, description: string): ImageResponse {
  return new ImageResponse(
    (
      <div
        style={{
          position: "relative",
          display: "flex",
          width: "100%",
          height: "100%",
          padding: "76px 84px",
          overflow: "hidden",
          color: "#fbfaf5",
          background:
            "linear-gradient(135deg, #17133f 0%, #28205f 48%, #4a368a 100%)",
          fontFamily: hankenGroteskFonts
            ? "Hanken Grotesk"
            : "sans-serif",
        }}
      >
        <div
          style={{
            position: "absolute",
            width: 420,
            height: 420,
            right: -120,
            top: -150,
            borderRadius: 999,
            background: "rgba(247, 201, 101, 0.15)",
          }}
        />
        <div
          style={{
            position: "absolute",
            width: 280,
            height: 280,
            right: 100,
            bottom: -170,
            borderRadius: 999,
            background: "rgba(198, 181, 255, 0.14)",
          }}
        />
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            width: "100%",
          }}
        >
          <div style={{ display: "flex", alignItems: "center" }}>
            {/* eslint-disable-next-line @next/next/no-img-element -- ImageResponse renders native image data, not a browser image element. */}
            <img
              src={markSrc}
              width={92}
              height={92}
              alt=""
              style={{
                borderRadius: 24,
                boxShadow: "0 12px 36px rgba(7, 5, 28, 0.32)",
              }}
            />
            <div
              style={{
                display: "flex",
                marginLeft: 24,
                fontSize: 34,
                fontWeight: 650,
                letterSpacing: "-0.02em",
              }}
            >
              Rabbithole
            </div>
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              maxWidth: 930,
            }}
          >
            <div
              style={{
                display: "flex",
                fontSize: 76,
                fontWeight: 700,
                lineHeight: 1.02,
                letterSpacing: "-0.045em",
              }}
            >
              {title}
            </div>
            <div
              style={{
                display: "flex",
                marginTop: 24,
                fontSize: 30,
                lineHeight: 1.25,
                color: "rgba(251, 250, 245, 0.78)",
              }}
            >
              {description}
            </div>
          </div>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
      headers: {
        "Cache-Control": CACHE_CONTROL,
      },
      ...(hankenGroteskFonts ? { fonts: hankenGroteskFonts } : {}),
    },
  );
}

export async function GET(request: Request): Promise<Response> {
  const token = new URL(request.url).searchParams.get("token")?.trim();
  const app = token ? await resolveCustomAppByToken(token) : null;

  if (app?.thumbnailUrl) {
    const thumbnail = await storedThumbnailResponse(
      app.thumbnailUrl,
      app.name,
    );
    if (thumbnail) return thumbnail;
  }

  const title = app
    ? app.name.trim() || "A Rabbithole app"
    : GENERIC_SITE_TITLE;
  const description = app
    ? customAppDescription(app)
    : GENERIC_SITE_DESCRIPTION;
  return generatedCard(title, description);
}
