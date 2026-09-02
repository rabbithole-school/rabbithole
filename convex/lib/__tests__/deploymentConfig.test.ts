import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  appBaseUrl,
  appBaseUrlOrNull,
  authEmailFrom,
  driveWebhookUrl,
  parentMessageFromAddress,
} from "../deploymentConfig";

const ENV_KEYS = [
  "SITE_URL",
  "DRIVE_WEBHOOK_BASE_URL",
  "AUTH_EMAIL_FROM",
  "PARENT_MESSAGE_FROM",
  "AUTH_EMAIL_FROM_ADDRESS",
] as const;
const originalEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>;

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("deploymentConfig", () => {
  test("appBaseUrl returns SITE_URL exactly as configured", () => {
    process.env.SITE_URL = "https://school.example/";
    expect(appBaseUrl()).toBe("https://school.example/");
  });

  test("appBaseUrl names SITE_URL when config is missing", () => {
    expect(() => appBaseUrl()).toThrow(/SITE_URL/);
  });

  test("appBaseUrlOrNull omits links when SITE_URL is missing", () => {
    expect(appBaseUrlOrNull()).toBeNull();
    process.env.SITE_URL = "  https://rabbithole.school  ";
    expect(appBaseUrlOrNull()).toBe("https://rabbithole.school");
  });

  test("driveWebhookUrl is independent from the canonical app origin", () => {
    process.env.SITE_URL = "https://rabbithole.school";
    process.env.DRIVE_WEBHOOK_BASE_URL = "https://webhook.example.invalid/";
    expect(driveWebhookUrl()).toBe(
      "https://webhook.example.invalid/api/drive/webhook",
    );
  });

  test("driveWebhookUrl requires an absolute dedicated base URL", () => {
    expect(() => driveWebhookUrl()).toThrow(/DRIVE_WEBHOOK_BASE_URL/);
    process.env.DRIVE_WEBHOOK_BASE_URL = "webhook.example.invalid";
    expect(() => driveWebhookUrl()).toThrow(/absolute HTTP/);
  });

  test("authEmailFrom requires AUTH_EMAIL_FROM", () => {
    expect(() => authEmailFrom()).toThrow(/AUTH_EMAIL_FROM/);
    process.env.AUTH_EMAIL_FROM = "Rabbithole <hello@school.example>";
    expect(authEmailFrom()).toBe("Rabbithole <hello@school.example>");
  });

  test("parentMessageFromAddress derives a family-facing mailbox from no-reply auth email", () => {
    process.env.AUTH_EMAIL_FROM = "Rabbithole <hello@school.example>";
    expect(parentMessageFromAddress()).toBe("hello@school.example");

    process.env.AUTH_EMAIL_FROM =
      "Rabbithole <no-reply@messages.rabbithole.school>";
    expect(parentMessageFromAddress()).toBe(
      "families@messages.rabbithole.school",
    );
  });

  test.each([
    ["PARENT_MESSAGE_FROM", "families@school.example"],
    ["AUTH_EMAIL_FROM_ADDRESS", "legacy@school.example"],
  ] as const)(
    "parentMessageFromAddress accepts the %s override",
    (envName, address) => {
      process.env.AUTH_EMAIL_FROM = "Rabbithole <hello@school.example>";
      process.env[envName] = address;
      expect(parentMessageFromAddress()).toBe(address);
    },
  );

  test.each([
    ["PARENT_MESSAGE_FROM", "not-an-email"],
    ["AUTH_EMAIL_FROM_ADDRESS", "not-an-email"],
  ] as const)(
    "parentMessageFromAddress rejects an invalid %s override",
    (envName, address) => {
      process.env.AUTH_EMAIL_FROM = "Rabbithole <hello@school.example>";
      process.env[envName] = address;
      expect(() => parentMessageFromAddress()).toThrow(envName);
    },
  );

  test.each([
    ["PARENT_MESSAGE_FROM", "  families@school.example  "],
    ["AUTH_EMAIL_FROM_ADDRESS", "  legacy@school.example  "],
  ] as const)(
    "parentMessageFromAddress trims the %s override",
    (envName, address) => {
      process.env.AUTH_EMAIL_FROM = "Rabbithole <hello@school.example>";
      process.env[envName] = address;
      expect(parentMessageFromAddress()).toBe(address.trim());
    },
  );

  test("parentMessageFromAddress keeps PARENT_MESSAGE_FROM ahead of the legacy override", () => {
    process.env.AUTH_EMAIL_FROM = "Rabbithole <hello@school.example>";
    process.env.AUTH_EMAIL_FROM_ADDRESS = "legacy@school.example";
    process.env.PARENT_MESSAGE_FROM = "families@school.example";
    expect(parentMessageFromAddress()).toBe("families@school.example");
  });

  test("parentMessageFromAddress requires the canonical email identity", () => {
    expect(() => parentMessageFromAddress()).toThrow(/AUTH_EMAIL_FROM/);
  });
});
