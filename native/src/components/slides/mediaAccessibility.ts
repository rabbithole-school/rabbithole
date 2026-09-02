type MediaKind = "image" | "video";
type MediaState = "resolved" | "fallback";

export function mediaAccessibility(
  alt: string,
  accessible: boolean,
  kind: MediaKind,
  state: MediaState,
  playing = false,
) {
  const normalizedAlt = alt.trim();
  const fallbackLabel = normalizedAlt || (kind === "image" ? "Image" : "Video");
  const accessibilityLabel =
    !accessible
      ? undefined
      : state === "fallback"
        ? fallbackLabel
        : kind === "video"
          ? `${fallbackLabel}. ${playing ? "Pause" : "Play"}`
          : undefined;

  return {
    alt: normalizedAlt,
    imageAlt: kind === "image" && accessible ? normalizedAlt : "",
    ariaHidden: kind === "image" ? !accessible || !normalizedAlt : undefined,
    accessibilityLabel,
    fallbackLabel,
  };
}
