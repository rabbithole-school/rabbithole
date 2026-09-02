/**
 * Judged eval for misconception fidelity in scholar slide-image generation.
 *
 * ANTHROPIC_API_KEY=... GEMINI_API_KEY=... \
 *   npx tsx evals/slide-image-fidelity/run.ts
 *
 * Generates each incorrect-model fixture with the shipped Gemini prompt, then
 * uses the pinned judge to verify the learner's wrong relationship is visible
 * and was not silently corrected to the textbook version.
 *
 * (This is the surviving half of the old evals/slide-image-guardrail/ suite.
 * Its route stage tested a Haiku authorship classifier that was deleted after
 * running 13/13 false positives in production — see
 * review/image-offloading-tutor-judgment-plan.html.)
 */

import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFaithfulSlideImagePrompt } from "../../convex/lib/slideImageFidelity";
import { geminiGenerateImage } from "../../convex/lib/gemini";
import { JUDGE_MODEL } from "../../convex/lib/models";
import { writeRunArtifacts } from "../lib/harness";
import {
  SLIDE_IMAGE_FIDELITY_FIXTURES,
  type SlideImageFidelityFixture,
} from "./fixtures";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const anthropic = new Anthropic();
const imageTrials = Number(process.env.IMAGE_TRIALS ?? 1);

const IMAGE_JUDGE_TOOL = {
  name: "record_image_fidelity" as const,
  input_schema: {
    type: "object" as const,
    properties: {
      specifiedRelationshipVisible: {
        type: "boolean" as const,
        description:
          "True only when the learner-specified relationship is visibly represented.",
      },
      silentlyCorrected: {
        type: "boolean" as const,
        description:
          "True when the image substitutes the canonical/correct relationship for the learner's incorrect one.",
      },
      faithful: {
        type: "boolean" as const,
        description:
          "True only when the specified misconception is visible and has not been corrected.",
      },
      notes: { type: "string" as const },
    },
    required: [
      "specifiedRelationshipVisible",
      "silentlyCorrected",
      "faithful",
      "notes",
    ],
  },
};

type ImageVerdict = {
  specifiedRelationshipVisible: boolean;
  silentlyCorrected: boolean;
  faithful: boolean;
  notes: string;
};

type ImageRun = {
  fixtureId: string;
  trial: number;
  imageFile: string;
  verdict: ImageVerdict;
  pass: boolean;
};

async function judgeImage(
  fixture: SlideImageFidelityFixture,
  bytes: Uint8Array,
  mimeType: string,
): Promise<ImageVerdict> {
  if (
    mimeType !== "image/png" &&
    mimeType !== "image/jpeg" &&
    mimeType !== "image/gif" &&
    mimeType !== "image/webp"
  ) {
    throw new Error(`Unsupported judge image type: ${mimeType}`);
  }
  const response = await anthropic.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 500,
    tools: [IMAGE_JUDGE_TOOL],
    tool_choice: { type: "tool", name: IMAGE_JUDGE_TOOL.name },
    system:
      "Judge whether an image generator faithfully rendered a learner's explicitly incorrect model. Do not reward scientific correctness. An omission is unfaithful; silently replacing the misconception with the textbook relationship is both unfaithful and a correction.",
    messages: [{
      role: "user",
      content: [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: mimeType,
            data: Buffer.from(bytes).toString("base64"),
          },
        },
        {
          type: "text",
          text:
            `Learner brief: ${fixture.learnerBrief}\n\n` +
            `The image MUST visibly show: ${fixture.imageCheck.mustShow}\n\n` +
            `The canonical correction it must NOT substitute: ${fixture.imageCheck.correctedVersion}`,
        },
      ],
    }],
  });
  const block = response.content.find((part) => part.type === "tool_use");
  if (block?.type !== "tool_use") {
    throw new Error(`No image verdict for ${fixture.id}`);
  }
  return block.input as ImageVerdict;
}

function extensionFor(mimeType: string) {
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/gif") return ".gif";
  if (mimeType === "image/webp") return ".webp";
  return ".png";
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is required");
  }
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is required");
  }
  mkdirSync(OUT, { recursive: true });

  const imageRuns: ImageRun[] = [];
  for (const fixture of SLIDE_IMAGE_FIDELITY_FIXTURES) {
    for (let trial = 1; trial <= imageTrials; trial++) {
      const image = await geminiGenerateImage([
        { text: buildFaithfulSlideImagePrompt(fixture.learnerBrief) },
      ]);
      if (!image) throw new Error(`Gemini returned no image for ${fixture.id}`);
      const imageFile = `${fixture.id}-${trial}${extensionFor(image.mimeType)}`;
      writeFileSync(join(OUT, imageFile), image.bytes);
      const verdict = await judgeImage(fixture, image.bytes, image.mimeType);
      imageRuns.push({
        fixtureId: fixture.id,
        trial,
        imageFile,
        verdict,
        pass:
          verdict.specifiedRelationshipVisible &&
          !verdict.silentlyCorrected &&
          verdict.faithful,
      });
      console.error(
        `[image] ${fixture.id} ${trial}/${imageTrials}: ${
          verdict.faithful ? "faithful" : "FAIL"
        }`,
      );
    }
  }

  const imagePasses = imageRuns.filter((run) => run.pass).length;
  const passed = imageRuns.every((run) => run.pass);
  const report = [
    "# Slide image fidelity eval",
    "",
    `- misconception fidelity: **${imagePasses}/${imageRuns.length}**`,
    `- gate: **${passed ? "PASS" : "FAIL"}** (every image must render the learner's stated misconception uncorrected)`,
    "",
    "## Image runs",
    "",
    "| fixture | trial | faithful | corrected | relationship visible | notes |",
    "|---|---:|---|---|---|---|",
    ...imageRuns.map((run) =>
      `| ${run.fixtureId} | ${run.trial} | ${run.verdict.faithful ? "yes" : "no"} | ${run.verdict.silentlyCorrected ? "yes" : "no"} | ${run.verdict.specifiedRelationshipVisible ? "yes" : "no"} | ${run.verdict.notes.replace(/\|/g, "/")} |`
    ),
    "",
  ].join("\n");
  writeRunArtifacts({
    outDir: OUT,
    runs: { imageRuns },
    report,
  });
  console.error(`Wrote ${join(OUT, "report.md")}`);
  if (!passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
