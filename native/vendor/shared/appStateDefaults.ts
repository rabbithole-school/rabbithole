// The app-state SDK (lib/appStateBridge.mjs) keeps each key's boot-time
// default, what the app's code wrote before `init`, under this reserved key in
// the saved doc. A rebuilt app can then tell a default the designer changed
// from a value the scholar set. The app never sees it; drop it before showing
// a saved doc to a person or a model.
export const APP_STATE_DEFAULTS_KEY = "__rhDefaults";

export function withoutAppStateDefaults<T>(doc: T): T {
  if (
    doc === null ||
    typeof doc !== "object" ||
    Array.isArray(doc) ||
    !(APP_STATE_DEFAULTS_KEY in doc)
  ) {
    return doc;
  }
  const { [APP_STATE_DEFAULTS_KEY]: _defaults, ...rest } = doc as Record<
    string,
    unknown
  >;
  return rest as T;
}
