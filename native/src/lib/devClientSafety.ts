export function devServerUrlFromHostUri(hostUri: string | null | undefined): string | null {
  const value = hostUri?.trim();
  if (!value) return null;

  try {
    const parsed = new URL(value.includes("://") ? value : `http://${value}`);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}
