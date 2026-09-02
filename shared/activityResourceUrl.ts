export type ActivityResourceUrlValidation =
  | { ok: true; url: string }
  | { ok: false; error: string };

export function validateActivityResourceUrl(
  raw: string,
): ActivityResourceUrlValidation {
  const value = raw.trim();
  if (!value) {
    return { ok: false, error: "Enter a website URL." };
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return {
      ok: false,
      error: "Enter a full website URL, including https://.",
    };
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return {
      ok: false,
      error: "Website URLs must start with http:// or https://.",
    };
  }

  return { ok: true, url: parsed.toString() };
}
