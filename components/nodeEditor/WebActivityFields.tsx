"use client";

/**
 * The kind="web" (Web Assignment) section of the activity editor.
 *
 * A Web Assignment can either reference a shared **External App** from the
 * catalog (the same registry that powers the scholar home launcher) or be
 * a one-off custom URL:
 *
 *  - Pick an External App → the app is the source of truth for the
 *    assignment's identity (name + icon) and its security allowlist
 *    (allowed hosts). The teacher only optionally sets a deep-link URL to
 *    a specific page; blank opens the app's own URL. DRY: define
 *    an app's identity (hosts, icon) once in the catalog, reuse it here AND
 *    on every scholar's launcher.
 *  - Custom website → freehand URL + allowed-hosts, as before.
 *
 * See review/external-apps-launcher.html.
 */

import { useQuery } from "convex/react";
import { Box, HStack, Input, Text } from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Field } from "./shared";
import { AppTileIcon } from "@/components/ui/AppTileIcon";

const selectStyle: React.CSSProperties = {
  width: "100%",
  fontSize: "13px",
  padding: "6px 8px",
  borderRadius: "6px",
  border: "1px solid #e2e8f0",
  fontFamily: "var(--chakra-fonts-heading)",
  background: "white",
};

export function WebActivityFields({
  activityId,
  webUrl,
  webHosts,
  externalAppId,
  missingWebUrl,
  setWebUrl,
  setWebHosts,
  update,
}: {
  activityId: Id<"activities">;
  webUrl: string;
  webHosts: string;
  externalAppId: Id<"externalApps"> | null;
  missingWebUrl: boolean;
  setWebUrl: (v: string) => void;
  setWebHosts: (v: string) => void;
  update: (args: {
    id: Id<"activities">;
    webUrl?: string | null;
    webAllowedHosts?: string[] | null;
    externalAppId?: Id<"externalApps"> | null;
  }) => void;
}) {
  const catalog = useQuery(api.externalApps.listCatalog, {});
  const selectedApp =
    externalAppId && catalog
      ? catalog.find((a) => a._id === externalAppId) ?? null
      : null;
  const usingApp = !!externalAppId;

  // When bound to an app the URL field is an optional deep-link override,
  // so a missing URL is no longer an error (the app's URL is the default).
  const urlIsError = missingWebUrl && !usingApp;

  return (
    <>
      <Field
        label="External app"
        hint="Link this assignment to a shared app from the catalog (its icon + allowed sites come from there), or pick Custom website for a one-off URL."
      >
        <select
          value={externalAppId ?? ""}
          onChange={(e) => {
            const val = e.target.value;
            update({
              id: activityId,
              externalAppId: val ? (val as Id<"externalApps">) : null,
              // Linking an app makes the catalog the source of truth for the
              // allowlist — clear any stale per-activity hosts so the hidden
              // value can't diverge from what's shown ("Locked to …").
              ...(val ? { webAllowedHosts: null } : {}),
            });
            if (val) setWebHosts("");
          }}
          style={selectStyle}
        >
          <option value="">Custom website (no app)</option>
          {(catalog ?? []).map((a) => (
            <option key={a._id} value={a._id}>
              {a.name}
            </option>
          ))}
        </select>
      </Field>

      {usingApp && selectedApp && (
        <Box
          bg="violet.50"
          borderWidth="1px"
          borderColor="violet.100"
          borderRadius="lg"
          p={3}
        >
          <HStack gap={2.5}>
            <AppTileIcon
              name={selectedApp.name}
              iconUrl={selectedApp.iconUrl}
              iconEmoji={selectedApp.iconEmoji}
              color={selectedApp.color}
              boxSize="30px"
              radius="8px"
              boxShadow="0 1px 3px rgba(20,24,50,0.15)"
              markFontSize="13px"
              imagePadding="4px"
              // The selected app's name is the next line in this card.
              decorative
            />
            <Box>
              <Text fontSize="sm" fontFamily="heading" fontWeight="600" color="charcoal.600">
                {selectedApp.name}
              </Text>
              <Text fontSize="2xs" color="charcoal.400" fontFamily="body">
                Locked to{" "}
                {(selectedApp.webAllowedHosts ?? [new URL(selectedApp.webUrl).hostname]).join(
                  ", ",
                )}
              </Text>
            </Box>
          </HStack>
        </Box>
      )}

      <Field
        label={usingApp ? "Deep-link URL (optional)" : "Website URL"}
        hint={
          usingApp
            ? `Open a specific page instead of the app's home. Leave blank to open ${selectedApp?.webUrl ?? "the app's URL"}.`
            : "The page the webview opens when a scholar starts this assignment — e.g. https://www.example.com/learn"
        }
      >
        <Input
          size="sm"
          type="url"
          value={webUrl}
          onChange={(e) => setWebUrl(e.target.value)}
          onBlur={() => update({ id: activityId, webUrl: webUrl || null })}
          placeholder={
            usingApp
              ? selectedApp?.webUrl ?? "https://…"
              : "https://www.example.com/learn"
          }
          fontFamily="heading"
          fontSize="sm"
          borderColor={urlIsError ? "red.400" : "gray.200"}
          _focus={{
            borderColor: urlIsError ? "red.400" : "violet.400",
            boxShadow: "none",
          }}
        />
      </Field>

      {/* The allowlist is the security boundary. When an app is linked it's
          owned by the catalog (edit once, applies everywhere) and hidden
          here; only custom URLs expose the freehand allowlist. */}
      {!usingApp && (
        <Field
          label="Allowed websites"
          hint="Comma-separated hosts the webview may visit. A bare domain (example.com) covers its subdomains too. Leave blank to lock to the URL's own site."
        >
          <Input
            size="sm"
            value={webHosts}
            onChange={(e) => setWebHosts(e.target.value)}
            onBlur={() =>
              update({
                id: activityId,
                webAllowedHosts: webHosts.trim()
                  ? webHosts.split(",").map((h) => h.trim()).filter(Boolean)
                  : null,
              })
            }
            placeholder="example.com"
            fontFamily="heading"
            fontSize="sm"
            borderColor="gray.200"
            _focus={{ borderColor: "violet.400", boxShadow: "none" }}
          />
        </Field>
      )}
    </>
  );
}
