import { NextResponse, type NextRequest } from "next/server";
import { renderSVG } from "uqr";

const DEVICE_ID_PATTERN = /^[a-zA-Z0-9_-]{10,64}$/;

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ pairedDeviceId: string }> },
) {
  const { pairedDeviceId } = await context.params;
  if (!DEVICE_ID_PATTERN.test(pairedDeviceId)) {
    return new NextResponse("Not found", { status: 404 });
  }

  // The device id comes only from the validated path segment. The encoder turns
  // the target into matrix geometry rather than reflecting it as SVG text.
  const target = new URL(
    `/school/devices/${encodeURIComponent(pairedDeviceId)}`,
    request.nextUrl.origin,
  ).toString();
  const markup = renderSVG(target, {
    ecc: "M",
    border: 2,
    pixelSize: 4,
    whiteColor: "#ffffff",
    blackColor: "#222656",
  });

  return new NextResponse(markup, {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "private, max-age=3600",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
