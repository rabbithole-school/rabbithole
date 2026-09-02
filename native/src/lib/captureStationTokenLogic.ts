function validToken(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("rhcapture_") && value.length > 20;
}

export function resolveCaptureStationEnrollmentToken(
  managed: unknown,
  devToken: unknown,
  isDev: boolean,
): string | null {
  if (validToken(managed)) return managed;
  return isDev && validToken(devToken) ? devToken : null;
}
