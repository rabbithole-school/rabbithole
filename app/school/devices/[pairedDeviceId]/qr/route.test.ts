import { NextRequest } from "next/server";
import { describe, expect, test } from "vitest";

import { GET } from "./route";

describe("Device settings QR route", () => {
  test("renders a hardened same-origin SVG without reflecting the target text", async () => {
    const pairedDeviceId = "abc1234567890";
    const response = await GET(
      new NextRequest(
        `https://app.example.invalid/school/devices/${pairedDeviceId}/qr`,
      ),
      { params: Promise.resolve({ pairedDeviceId }) },
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/svg+xml");
    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(body).toContain("<svg");
    expect(body).not.toContain(pairedDeviceId);
    expect(body).not.toContain("app.example.invalid");
  });

  test("rejects malformed path ids", async () => {
    const pairedDeviceId = `bad"><script>alert(1)</script>`;
    const response = await GET(
      new NextRequest(
        "https://app.example.invalid/school/devices/bad/qr",
      ),
      { params: Promise.resolve({ pairedDeviceId }) },
    );
    expect(response.status).toBe(404);
  });
});
