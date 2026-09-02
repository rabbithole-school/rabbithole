type ActivityResourceEmbedInput = {
  kind: "file" | "link" | "video";
  url: string | null;
};

export function youtubeVideoId(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (host === "youtu.be") {
      return validVideoId(parsed.pathname.split("/").filter(Boolean)[0]);
    }
    if (
      host === "youtube.com" ||
      host === "m.youtube.com" ||
      host === "youtube-nocookie.com"
    ) {
      if (parsed.pathname === "/watch") {
        return validVideoId(parsed.searchParams.get("v"));
      }
      const [, route, id] = parsed.pathname.split("/");
      if (route === "embed" || route === "shorts" || route === "live") {
        return validVideoId(id);
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function activityResourceEmbedUrl(
  resource: ActivityResourceEmbedInput,
): string | null {
  if (!resource.url) return null;
  const videoId =
    resource.kind === "video" ? youtubeVideoId(resource.url) : null;
  if (!videoId) return resource.url;
  return (
    `https://www.youtube-nocookie.com/embed/${videoId}` +
    "?playsinline=1&rel=0&iv_load_policy=3&disablekb=1&color=white" +
    "&cc_load_policy=1&cc_lang_pref=en"
  );
}

function validVideoId(value: string | null | undefined): string | null {
  return value && /^[A-Za-z0-9_-]{11}$/.test(value) ? value : null;
}
