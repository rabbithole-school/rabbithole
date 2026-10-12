import type { Doc } from "../_generated/dataModel";

export type UsableVibecodeStarterApp = Doc<"customApps"> & {
  kind: "static";
  html: string;
};

export function isUsableVibecodeStarterApp(
  app: Doc<"customApps"> | null,
): app is UsableVibecodeStarterApp {
  return app?.kind === "static" && !!app.html?.trim();
}
