// Map-asset discovery for the STAFF bots (Curriculum Bot / teacher aide /
// Slack bot). A read-only inventory of the curated GeoMap assets a real
// interactive map can draw on, so an author can write activity prompts that
// name exact registry / era keys.
//
// The scholar-facing tutor already discovers these dynamically (its show_map
// tool description lists the registry + era keys at tool-build time), so this
// tool is deliberately NOT on any scholar surface — it exists so the people
// AUTHORING activities can see what the tutor will be able to show.
//
// Pure read of checked-in, framework-free modules — no ctx, no query, no
// scholar data. The governance surface is the registry itself
// (lib/geomap/registry): every dataset carries source + license + accuracy
// notes, and this tool SURFACES that provenance so teachers can judge a map
// before pointing an activity at it.
//
// Runtime note: like the sibling aide tool factories, it dynamically imports
// betaTool and does NO static @anthropic-ai/sdk import (keeps node:* out of
// the edge bundle).

import type { AideEmit } from "./aideStream";
import { listRegistryEntries } from "../../lib/geomap/registry";
import { OAHU_WIND_OVERLAY_ID } from "../../lib/geomap/registry/keys";
import { HISTORICAL_BASEMAPS } from "../../lib/geomap/historicalBasemaps";

/**
 * How an authored activity actually reaches the interactive map. Returned in
 * the tool RESULT (not just the description) so the model has the wiring in
 * front of it while it drafts a prompt.
 */
const USAGE_GUIDANCE =
  "Activities never render a map directly — they DIRECT the tutor to call its show_map tool. " +
  "Add a curated overlay/region dataset by its registry `id` in the spec's `layers`. " +
  "The base map is TODAY'S world by DEFAULT — leave it that way for almost every map " +
  "(geography, nature, current places, spatial reasoning). ONLY set a historical era " +
  "(`historicalBasemap` = an era `key`) when the activity is specifically about that past " +
  "period and a present-day map would be wrong or misleading; otherwise omit it entirely. " +
  "Write the activity's systemPrompt to name the exact keys you want (e.g. \"show a map with the " +
  `\`${OAHU_WIND_OVERLAY_ID}\` overlay", and — only when the era is the point — "open the \`europe-1914\` ` +
  "era\"). Only these checked-in keys work — the tutor cannot load an arbitrary dataset or style URL.";

/**
 * Build the `list_geomap_assets` read tool. Assembled onto the curriculum /
 * aide surfaces (never a scholar surface); the surface's own role gate is the
 * ACL — this tool reads only curated, non-sensitive catalog data.
 */
export async function makeListGeomapAssetsTool(emit: AideEmit) {
  const { betaTool } = await import(
    "@anthropic-ai/sdk/helpers/beta/json-schema"
  );

  return betaTool({
    name: "list_geomap_assets",
    description:
      "List the curated map assets an online activity can use. Rabbithole online activities can drive a real interactive map (the tutor's show_map tool — satellite / terrain / political bases, curated data overlays, and historical era basemaps). This returns: (1) DATASETS from the checked-in registry — each with id, label, kind (overlay = a renderable layer; region = polygons usable as a map-task target), plus source / license / accuracy notes for provenance; and (2) historical ERA basemaps — each with a key + label (an era transforms the whole map to that time period). Note: the DEFAULT and right choice for almost every map is the present-day (today's) base — historical eras are the exception, only for activities specifically about that past period. Call this before writing a map-using activity so you name real keys. Optional `kind` filters the datasets.",
    inputSchema: {
      type: "object" as const,
      properties: {
        kind: {
          type: "string" as const,
          enum: ["overlay", "region"] as const,
          description:
            "Optional. Filter the datasets to just overlays or just regions. Era basemaps are a separate axis and are always returned.",
        },
      },
      required: [] as const,
    },
    run: async (input: { kind?: "overlay" | "region" }) => {
      const datasets = listRegistryEntries()
        .filter((e) => !input.kind || e.kind === input.kind)
        .map((e) => ({
          id: e.id,
          label: e.label,
          kind: e.kind,
          source: e.source,
          license: e.license,
          notes: e.notes,
        }));

      const eras = Object.entries(HISTORICAL_BASEMAPS).map(([key, b]) => ({
        key,
        label: b.label,
      }));

      emit({
        toolComplete: {
          name: "list_geomap_assets",
          result: `${datasets.length} dataset${datasets.length === 1 ? "" : "s"}, ${eras.length} era${eras.length === 1 ? "" : "s"}`,
        },
      });

      return JSON.stringify(
        { datasets, eras, usage: USAGE_GUIDANCE },
        null,
        2,
      );
    },
  });
}
