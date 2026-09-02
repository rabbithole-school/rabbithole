// Shared authoring tools for activity kinds that need payloads beyond the
// generic activity fields. Each surface supplies its own address schema and
// resolver: the unit bot matches titles inside one fixed unit, while the global
// aide follows direct lesson IDs returned by create_scholar_lesson.

import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import type { AideEmit } from "./aideStream";
import { refusedRecoveryMessage } from "./botTools";
import {
  assembleSimulatorSpec,
  simulatorAuthoringArgProperties,
} from "./simulatorTemplatesCatalog";

type ToolInput = Record<string, unknown>;

/**
 * Shared "which simulation kind?" guidance, injected verbatim into BOTH
 * curriculum bots' prompts (the global aide in http.ts and the unit designer
 * in unitDesignerStream.ts) — one copy, never pasted twice. A "simulation /
 * game / model" ask is genuinely ambiguous between vibecode and world, so the
 * bot must fork with ONE question instead of silently guessing.
 */
export const KIND_DISAMBIGUATION_GUIDANCE =
  `**"Simulation / game / model" requests are genuinely AMBIGUOUS.** They sit between **vibecode** (the SCHOLAR builds an app with the AI — the making is the learning) and a **Simulator** (a fixed-physics terrarium the scholar TUNES and observes — the experimenting is the learning). When the teacher's ask could reasonably be either and they haven't signaled which, DON'T assume — ask ONE short either/or question first, e.g. "Should scholars BUILD the simulation themselves (vibecode), or experiment inside a fixed Simulator I set up?" One question, then act on the answer — never a questionnaire. When the teacher clearly signals, act without asking: "have them code…" / "app-building" → vibecode; "a simulator activity" / "an ecosystem they tune" / "predator-prey terrarium" / "a tournament" → Simulator.`;

export type ActivityKindLesson = Pick<
  Doc<"lessons">,
  "_id" | "title" | "unitId"
>;

export type ActivityKindActivity = Pick<
  Doc<"activities">,
  "_id" | "title"
>;

type LessonResolution =
  | { ok: true; lesson: ActivityKindLesson }
  | { ok: false; error: string };

type ActivityResolution =
  | {
      ok: true;
      lesson: ActivityKindLesson;
      activity: ActivityKindActivity;
    }
  | { ok: false; error: string };

type AddressSchema = {
  properties: Record<
    string,
    {
      type: "string";
      description: string;
    }
  >;
  required: readonly string[];
  recoveryArg: string;
};

type ActivityKindToolOptions = {
  callerUserId: Id<"users">;
  lessonAddress: AddressSchema & {
    resolve: (input: ToolInput) => Promise<LessonResolution>;
  };
  activityAddress: AddressSchema & {
    resolve: (input: ToolInput) => Promise<ActivityResolution>;
  };
  activityUrl?: (
    lesson: ActivityKindLesson,
    activityId: Id<"activities">,
  ) => string | undefined;
};

const SIMULATOR_TOOL_GUIDANCE =
  " Author choices are config, speciesSlots, criterion, tickBudget (and optional microWorld). Do NOT pass version, templateVersion, or interpreter — those are set for you. Call list_simulator_templates first to get the exact field ranges and a copy-pasteable example for the Simulator template you pick. On an invalid spec this returns the precise error; fix that field and retry.";

const SIMULATOR_REQUIRED_ARGS = [
  "templateId",
  "config",
  "speciesSlots",
  "criterion",
  "tickBudget",
] as const;

function simulatorSpecFromInput(input: ToolInput) {
  return assembleSimulatorSpec({
    templateId: input.templateId as string,
    config: input.config as Record<string, unknown>,
    speciesSlots: input.speciesSlots as ReadonlyArray<Record<string, unknown>>,
    criterion: input.criterion as Record<string, unknown>,
    tickBudget: input.tickBudget as {
      iterationTicks?: number;
      seasonTicks?: number;
      absoluteMaxTicks?: number;
    },
    microWorld: input.microWorld as boolean | undefined,
  });
}

function linkedResult(
  opts: ActivityKindToolOptions,
  lesson: ActivityKindLesson,
  activityId: Id<"activities">,
  result: string,
  fields: Record<string, unknown>,
) {
  const url = opts.activityUrl?.(lesson, activityId);
  return url
    ? JSON.stringify({
        ...fields,
        activityId,
        lessonId: lesson._id,
        url,
        result,
      })
    : result;
}

/**
 * Build richer activity-kind tools against a surface-owned addressing seam.
 * The small descriptor registry is intentionally limited to the two currently
 * supported kinds; adding a kind means registering its real validated writer,
 * not widening the generic activity enum.
 */
export async function makeActivityKindTools(
  ctx: ActionCtx,
  emit: AideEmit,
  opts: ActivityKindToolOptions,
) {
  const { betaTool } = await import(
    "@anthropic-ai/sdk/helpers/beta/json-schema"
  );

  const listCatalogTool = betaTool({
    name: "list_activity_kind_catalog",
    description:
      "List the valid catalog choices before creating a GAME, WEB, or SHARE BACK activity. Call this first: use the returned gameId, externalAppId, or shareBackRecipe exactly as returned. Never invent or free-type an identifier.",
    inputSchema: { type: "object" as const, properties: {}, required: [] as const },
    run: async () => {
      const catalog = await ctx.runQuery(
        internal.activities.listActivityKindCatalogInternal,
        {},
      );
      emit({
        toolComplete: {
          name: "list_activity_kind_catalog",
          result: `${catalog.games.length} game(s), ${catalog.externalApps.length} External App(s), ${catalog.shareBackRecipes.length} Share Back recipe(s)`,
        },
      });
      return JSON.stringify(catalog);
    },
  });

  const createCatalogActivity = (
    name: "create_game_activity" | "create_web_activity" | "create_share_back_activity",
    kind: "game" | "web" | "shareBack",
    identifier: Record<string, unknown>,
    requiredIdentifier: string,
    description: string,
  ) =>
    betaTool({
      name,
      description,
      inputSchema: {
        type: "object" as const,
        properties: {
          ...opts.lessonAddress.properties,
          title: {
            type: "string" as const,
            description: "Short activity title — no leading sequence number or category prefix.",
          },
          description: {
            type: "string" as const,
            description:
              "Teacher-facing description: design intent / facilitation notes. Never shown to scholars.",
          },
          ...(kind !== "shareBack"
            ? {
                scholarDescription: {
                  type: "string" as const,
                  description:
                    "Scholar-facing card blurb shown on the scholar's home card + activity nav. Write TO the scholar, 2nd person, invitational and concrete; reveal no pedagogy/assessment framing (no 'stealth pre-assessment', 'baseline', rubrics). Optional — omitted means a title-only card, with no fallback to the teacher description.",
                },
              }
            : {}),
          durationMinutes: {
            type: "number" as const,
            description: "Optional expected duration in minutes.",
          },
          ...identifier,
        },
        required: [...opts.lessonAddress.required, "title", requiredIdentifier],
      },
      run: async (rawInput) => {
        const input = rawInput as ToolInput;
        const f = await opts.lessonAddress.resolve(input);
        if (!f.ok) return f.error;
        try {
          const result = await ctx.runMutation(
            internal.activities.createCatalogActivityInternal,
            {
              callerUserId: opts.callerUserId,
              lessonId: f.lesson._id,
              title: input.title as string,
              description: input.description as string | undefined,
              ...(kind !== "shareBack"
                ? {
                    scholarDescription: input.scholarDescription as
                      | string
                      | undefined,
                  }
                : {}),
              durationMinutes: input.durationMinutes as number | undefined,
              kind,
              ...(kind === "game" ? { gameId: input.gameId as string } : {}),
              ...(kind === "web"
                ? { externalAppId: input.externalAppId as Id<"externalApps"> }
                : {}),
              ...(kind === "shareBack"
                ? {
                    shareBackRecipe: input.shareBackRecipe as
                      | "reflection"
                      | "galleryWalk"
                      | "exitTicket"
                      | "debateDebrief"
                      | "custom",
                  }
                : {}),
            },
          );
          emit({
            toolComplete: {
              name,
              result: `Created ${kind} activity "${result.title}" on "${f.lesson.title}"`,
            },
          });
          return linkedResult(
            opts,
            f.lesson,
            result.activityId,
            `${kind} activity "${result.title}" created on lesson "${f.lesson.title}".`,
            { title: result.title, kind },
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          emit({
            toolComplete: { name, result: `Refused: ${message.slice(0, 200)}` },
          });
          return JSON.stringify({
            ...refusedRecoveryMessage(
              name,
              `${opts.lessonAddress.recoveryArg} + title + ${requiredIdentifier}`,
            ),
            error: message,
          });
        }
      },
    });

  const registry = [
    {
      kind: "game",
      describeForModel: {
        create:
          "Create a GAME activity from the built-in game catalog. Call list_activity_kind_catalog first, then pass an exact returned gameId — never invent an ID.",
      },
      createFn: (description: string) =>
        createCatalogActivity(
          "create_game_activity",
          "game",
          {
            gameId: {
              type: "string" as const,
              description: "Exact gameId returned by list_activity_kind_catalog.",
            },
          },
          "gameId",
          description,
        ),
    },
    {
      kind: "web",
      describeForModel: {
        create:
          "Create a WEB activity from the External Apps catalog. Call list_activity_kind_catalog first, then pass an exact returned externalAppId — never invent an ID or URL.",
      },
      createFn: (description: string) =>
        createCatalogActivity(
          "create_web_activity",
          "web",
          {
            externalAppId: {
              type: "string" as const,
              description:
                "Exact externalAppId returned by list_activity_kind_catalog.",
            },
          },
          "externalAppId",
          description,
        ),
    },
    {
      kind: "shareBack",
      describeForModel: {
        create:
          "Create a SHARE BACK activity using a catalog recipe. Call list_activity_kind_catalog first, then pass an exact returned shareBackRecipe.\n\n" +
          "A Share Back is a TEACHER-FACILITATED whole-class debrief. It collates work scholars ALREADY did in earlier online activities (sourceActivityIds) into one AI digest the teacher runs with the group. It has NO scholar-launched surface: scholars cannot start it, cannot finish it on their own, and no per-scholar completion is ever recorded for it.\n\n" +
          "So do NOT reach for this tool just because the teacher said \"reflection\" or \"exit ticket\" — those words name a recipe here, not the teacher's intent. If the teacher wants EACH scholar to answer reflection questions individually in their own tutor chat — the usual meaning of \"add a reflection for the class today\" — that is create_activity with kind='online' (optionally recipe='exitTicket'), and the questions belong in its systemPrompt, NOT in the description. Use this tool only to debrief work that already exists, together, as a class. When the ask is ambiguous, ask which before assuming.",
      },
      createFn: (description: string) =>
        createCatalogActivity(
          "create_share_back_activity",
          "shareBack",
          {
            shareBackRecipe: {
              type: "string" as const,
              enum: [
                "reflection",
                "galleryWalk",
                "exitTicket",
                "debateDebrief",
                "custom",
              ] as const,
              description:
                "Exact shareBackRecipe returned by list_activity_kind_catalog.",
            },
          },
          "shareBackRecipe",
          description,
        ),
    },
    {
      kind: "simulator",
      describeForModel: {
        create:
          "Create a Simulator activity on a lesson, fully configured with its physics. Use this — NOT create_activity — whenever a teacher wants a simulator activity: a fixed-physics terrarium (ecosystem grid or prisoner's dilemma), not a map or a build-your-own place/civilization (those are online/vibecode activities). The scholar tunes the Simulator by writing behavior prompts for its species; it runs and scores against the criterion. If the teacher may instead want scholars to BUILD the simulation themselves, that is vibecode — ask before assuming." +
          SIMULATOR_TOOL_GUIDANCE,
        update:
          "Reconfigure an EXISTING Simulator activity — set or replace its physics (`simulatorSpec`). Use this to change a Simulator's template, config, species, criterion, or run length, or to turn an existing activity into a Simulator. Targets the activity by lesson + activity title." +
          SIMULATOR_TOOL_GUIDANCE,
      },
      createFn: (description: string, toolName = "create_simulator_activity") =>
        betaTool({
          name: toolName,
          description,
          inputSchema: {
            type: "object" as const,
            properties: {
              ...opts.lessonAddress.properties,
              title: {
                type: "string" as const,
                description:
                  "Short activity title — no leading sequence number or category prefix.",
              },
              description: {
                type: "string" as const,
                description:
                  "Optional longer description of what the scholar does in this Simulator.",
              },
              durationMinutes: {
                type: "number" as const,
                description: "Optional expected duration in minutes.",
              },
              ...simulatorAuthoringArgProperties(),
            },
            required: [
              ...opts.lessonAddress.required,
              "title",
              ...SIMULATOR_REQUIRED_ARGS,
            ],
          },
          run: async (rawInput) => {
            const input = rawInput as ToolInput;
            const f = await opts.lessonAddress.resolve(input);
            if (!f.ok) return f.error;
            const spec = simulatorSpecFromInput(input);
            let result: {
              activityId: Id<"activities">;
              existed: boolean;
              title: string;
            };
            try {
              result = await ctx.runMutation(
                internal.simulator.createSimulatorActivityInternal,
                {
                  lessonId: f.lesson._id,
                  title: input.title as string,
                  description: input.description as string | undefined,
                  durationMinutes: input.durationMinutes as number | undefined,
                  spec,
                },
              );
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              emit({
                toolComplete: {
                  name: toolName,
                  result: `Refused: ${msg.slice(0, 200)}`,
                },
              });
              return JSON.stringify({
                error: msg,
                actionRequired:
                  `The Simulator spec was rejected. Re-call create_simulator_activity with the same ${opts.lessonAddress.recoveryArg} + title and a corrected spec — fix ONLY the field named in the error above. Simulator activities take NO deliverable; do not attach one.`,
                hint: "Call list_simulator_templates for the exact field ranges + a copy-pasteable Simulator example.",
              });
            }
            emit({
              toolComplete: {
                name: toolName,
                result: `${result.existed ? "Reconfigured" : "Built"} Simulator "${result.title}" on "${f.lesson.title}"`,
              },
            });
            const text = `Simulator activity "${result.title}" (${input.templateId}) ${result.existed ? "reconfigured" : "created"} on lesson "${f.lesson.title}". Its physics/spec are set and validated.`;
            return linkedResult(
              opts,
              f.lesson,
              result.activityId,
              text,
              {
                existed: result.existed,
                title: result.title,
                kind: "simulator",
              },
            );
          },
        }),
      updateFn: (description: string, toolName = "update_simulator_spec") =>
        betaTool({
          name: toolName,
          description,
          inputSchema: {
            type: "object" as const,
            properties: {
              ...opts.activityAddress.properties,
              ...simulatorAuthoringArgProperties(),
            },
            required: [
              ...opts.activityAddress.required,
              ...SIMULATOR_REQUIRED_ARGS,
            ],
          },
          run: async (rawInput) => {
            const input = rawInput as ToolInput;
            const f = await opts.activityAddress.resolve(input);
            if (!f.ok) return f.error;
            const spec = simulatorSpecFromInput(input);
            try {
              await ctx.runMutation(internal.simulator.setSimulatorSpecInternal, {
                activityId: f.activity._id,
                spec,
              });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              emit({
                toolComplete: {
                  name: toolName,
                  result: `Refused: ${msg.slice(0, 200)}`,
                },
              });
              return JSON.stringify({
                error: msg,
                actionRequired:
                  `The Simulator spec was rejected. Re-call update_simulator_spec with the same ${opts.activityAddress.recoveryArg} and a corrected spec — fix ONLY the field named in the error above. Simulator activities take NO deliverable; do not attach one.`,
                hint: "Call list_simulator_templates for the exact field ranges + a copy-pasteable Simulator example.",
              });
            }
            emit({
              toolComplete: {
                name: toolName,
                result: `Configured Simulator "${f.activity.title}"`,
              },
            });
            const text = `Simulator spec for "${f.activity.title}" on lesson "${f.lesson.title}" set and validated (${input.templateId}).`;
            return linkedResult(
              opts,
              f.lesson,
              f.activity._id,
              text,
              {
                title: f.activity.title,
                kind: "simulator",
              },
            );
          },
        }),
    },
    {
      kind: "problem_set",
      describeForModel: {
        create:
          "Add an adaptive MATH PROBLEM SET activity to a lesson — the homegrown fluency engine (our replacement for external practice sites). The scholar works problems drawn adaptively from our whole-number-arithmetic knowledge graph; mastery + spaced-repetition update automatically (no deliverable, no system prompt). Specify EITHER a `grade` (K–5; targets all that grade's skills) OR explicit `skillKeys`. Use this for 'give them multiplication practice', 'a fractions warm-up', 'fact fluency', etc.",
      },
      createFn: (description: string) =>
        betaTool({
          name: "create_problem_set",
          description,
          inputSchema: {
            type: "object" as const,
            properties: {
              ...opts.lessonAddress.properties,
              title: {
                type: "string" as const,
                description:
                  "Short title — just the title, with NO leading number or category prefix (e.g. 'Multiplication facts warm-up', not '1. Multiplication facts warm-up').",
              },
              grade: {
                type: "string" as const,
                enum: ["K", "1", "2", "3", "4", "5"] as const,
                description:
                  "Target all whole-number-arithmetic skills at this grade. Use this OR skillKeys.",
              },
              skillKeys: {
                type: "array" as const,
                items: { type: "string" as const },
                description:
                  "Explicit knowledge-graph skill keys (advanced). Use this OR grade.",
              },
              itemCount: {
                type: "number" as const,
                description: "Problems per session (default 10)",
              },
            },
            required: [...opts.lessonAddress.required, "title"],
          },
          run: async (rawInput) => {
            const input = rawInput as ToolInput;
            const f = await opts.lessonAddress.resolve(input);
            if (!f.ok) return f.error;
            try {
              const res = await ctx.runMutation(
                internal.practiceSkills.createProblemSetActivity,
                {
                  lessonId: f.lesson._id,
                  title: input.title as string,
                  grade: input.grade as string | undefined,
                  targetSkillKeys:
                    (input.skillKeys as string[] | undefined) ?? undefined,
                  itemCount: input.itemCount as number | undefined,
                },
              );
              emit({
                toolComplete: {
                  name: "create_problem_set",
                  result: `Added problem set "${input.title}" (${res.skillCount} skills)`,
                },
              });
              const text = `Problem set "${input.title}" created on lesson "${f.lesson.title}", practicing ${res.skillCount} skills.`;
              return linkedResult(
                opts,
                f.lesson,
                res.activityId,
                text,
                {
                  title: input.title,
                  kind: "problem_set",
                  skillCount: res.skillCount,
                },
              );
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              emit({
                toolComplete: {
                  name: "create_problem_set",
                  result: `Refused: ${msg.slice(0, 200)}`,
                },
              });
              return JSON.stringify({
                ...refusedRecoveryMessage(
                  "create_problem_set",
                  `${opts.lessonAddress.recoveryArg} + title + grade`,
                ),
                error: msg,
              });
            }
          },
        }),
    },
  ] as const;

  const simulatorDescriptor = registry.find((descriptor) => descriptor.kind === "simulator");
  if (!simulatorDescriptor || !("updateFn" in simulatorDescriptor)) {
    throw new Error("Simulator tool registration requires the Simulator descriptor");
  }
  return [
    listCatalogTool,
    ...registry.flatMap((descriptor) => [
      descriptor.createFn(descriptor.describeForModel.create),
      ...("updateFn" in descriptor
        ? [descriptor.updateFn(descriptor.describeForModel.update)]
        : []),
    ]),
    simulatorDescriptor.updateFn(
      "Update an existing Simulator activity's validated physics specification." +
        SIMULATOR_TOOL_GUIDANCE,
      "update_simulator",
    ),
  ];
}
