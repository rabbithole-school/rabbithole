import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";

const DEFAULT_OUT = "evals/stance-fit/out";
const QUERY_DELAY_MS = 125;
const MAX_ATTEMPTS = 4;

function parseArgs(argv) {
  const args = { days: 30, minMessages: 8, limit: 40, out: DEFAULT_OUT };
  const flags = {
    "--days": "days",
    "--min-messages": "minMessages",
    "--limit": "limit",
    "--out": "out",
  };
  for (let i = 0; i < argv.length; i += 2) {
    const key = flags[argv[i]];
    const value = argv[i + 1];
    if (!key || value === undefined) {
      throw new Error(
        "Usage: node evals/stance-fit/fetch.mjs [--days N] [--min-messages N] [--limit N] [--out DIR]",
      );
    }
    args[key] = key === "out" ? value : Number(value);
  }
  for (const key of ["days", "minMessages", "limit"]) {
    if (!Number.isInteger(args[key]) || args[key] < 1) {
      throw new Error(`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} must be a positive integer`);
    }
  }
  return args;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(429|502|503|504)\b|rate.?limit|throttl|overloaded|fetch failed|network/i.test(
    message,
  );
}

async function queryWithRetry(client, name, args) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await delay(QUERY_DELAY_MS);
    try {
      return await client.query(name, args);
    } catch (error) {
      if (attempt === MAX_ATTEMPTS || !isRetryable(error)) throw error;
      await delay(QUERY_DELAY_MS * 2 ** attempt);
    }
  }
  throw new Error(`Query ${name} exhausted retries`);
}

function redactScholarName(text, scholarName) {
  if (!scholarName?.trim()) return text;
  const escaped = scholarName.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`\\b${escaped}\\b`, "gi"), "[scholar]");
}

function isTutorConversation(session, cutoff) {
  const createdAt = session._creationTime ?? session.createdAt ?? session.updatedAt;
  return (
    typeof createdAt === "number" &&
    createdAt >= cutoff &&
    session.isTestDrive !== true &&
    session.isOffline !== true &&
    session.seedExemplar !== true &&
    (session.sessionMode === undefined || session.sessionMode === "conversation")
  );
}

function roundRobin(queues) {
  const ordered = [];
  let remaining = true;
  for (let index = 0; remaining; index++) {
    remaining = false;
    for (const queue of queues) {
      if (index < queue.length) {
        ordered.push(queue[index]);
        remaining = true;
      }
    }
  }
  return ordered;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.RABBITHOLE_PROD_URL;
  const username = process.env.RABBITHOLE_PROD_USERNAME;
  const password = process.env.RABBITHOLE_PROD_PASSWORD;
  if (!url || !username || !password) {
    throw new Error(
      "RABBITHOLE_PROD_URL, RABBITHOLE_PROD_USERNAME, and RABBITHOLE_PROD_PASSWORD are required",
    );
  }

  const client = new ConvexHttpClient(url);
  const signIn = await client.action("auth:signIn", {
    provider: "password",
    params: {
      email: `${username}@local`,
      password,
      flow: "signIn",
    },
  });
  const token = signIn?.tokens?.token;
  if (!token) throw new Error("auth:signIn did not return an auth token");
  client.setAuth(token);

  const roster = await queryWithRetry(client, "mcp:listScholars", {
    includeExtendedEducation: false,
  });
  const scholars = Array.isArray(roster?.scholars) ? roster.scholars : [];
  const cutoff = Date.now() - args.days * 24 * 60 * 60 * 1000;
  const queues = [];

  for (const scholar of scholars) {
    const sessions = await queryWithRetry(client, "sessions:list", {
      userId: scholar.id,
      archivedFilter: "all",
    });
    queues.push(
      (Array.isArray(sessions) ? sessions : [])
        .filter((session) => isTutorConversation(session, cutoff))
        .map((session) => ({ scholar, session })),
    );
  }

  const dataDir = join(args.out, "data");
  await mkdir(dataDir, { recursive: true });
  let written = 0;

  for (const candidate of roundRobin(queues)) {
    if (written >= args.limit) break;
    const { scholar, session } = candidate;
    const sessionId = String(session.id ?? session._id);
    const transcript = await queryWithRetry(
      client,
      "sessions:getWithMessages",
      { id: sessionId },
    );
    const messages = (Array.isArray(transcript?.messages)
      ? transcript.messages
      : []
    )
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => ({
        role: message.role,
        content: redactScholarName(String(message.content ?? ""), scholar.name),
        createdAt: message.createdAt ?? message._creationTime ?? null,
      }));
    if (messages.length < args.minMessages) continue;

    let activityTitle = null;
    const activityId = transcript?.session?.activityId ?? session.activityId;
    if (activityId) {
      const activity = await queryWithRetry(client, "activities:getPublic", {
        id: activityId,
      });
      activityTitle = activity?.title ?? null;
    }

    const createdAt =
      transcript?.session?._creationTime ??
      session._creationTime ??
      session.createdAt ??
      session.updatedAt;
    const output = {
      sessionId,
      title: redactScholarName(
        String(transcript?.session?.title ?? session.title ?? "Untitled"),
        scholar.name,
      ),
      unitTitle: session.unitTitle ?? null,
      activityTitle,
      readingLevel:
        transcript?.session?.readingLevelOverride ?? scholar.readingLevel ?? null,
      createdAt,
      scholarId: String(scholar.id),
      messages,
    };
    await writeFile(
      join(dataDir, `${sessionId}.json`),
      `${JSON.stringify(output, null, 2)}\n`,
      "utf8",
    );
    written++;
    console.log(`${sessionId} scholar=${scholar.id} messages=${messages.length}`);
  }

  console.log(`Fetched ${written} sessions into ${dataDir}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
