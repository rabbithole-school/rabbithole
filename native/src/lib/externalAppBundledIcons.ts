// The bundled catalog-icon registry — kept in its own module because a Metro
// `require` of an image resolves to an opaque asset id that only a bundler can
// produce. Isolating it here keeps `externalAppIcon.ts` (the resolver, and the
// only consumer of this map) plain logic that the unit tests can import.
//
// A catalog `iconUrl` is either an absolute http(s) URL or a web-relative path
// ("/external-apps/*.png"). A relative path has no origin inside the native
// app, so the ones we ship are listed here by their web path — the PATH alone,
// with no query or hash, since the bundle holds one asset per path. Callers go
// through `externalAppIcon`, which trims a cache-busting `?v=2` off before the
// lookup.

import type { ImageSourcePropType } from "react-native";

export const BUNDLED_ICONS: Record<string, ImageSourcePropType> = {
};
