import { hashSecret } from "@patchsmith/api-utils/hashing";
import { cliToken } from "@patchsmith/db/schema/cli-auth";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { authenticateCliEffect } from "#cli-token";
import { env } from "#env";
import { runPlatform } from "#services";
import type { PlatformServices } from "#services";
import { createPlatformFixture } from "#test/platform";
import { testServices } from "#test/services";

const secret = "test-cli-token-secret-test-cli-token-secret";
let fixture: Awaited<ReturnType<typeof createPlatformFixture>>;
const config = { ...env, AUTH_SECRET: secret };

const validToken = () => ({
  expiresAt: new Date(60_000),
  projectId: fixture.project.id,
  tokenHash: hashSecret("deploy-token", secret),
  ...fixture.scope,
});

const run = async <A, E>(effect: Effect.Effect<A, E, PlatformServices>) =>
  await runPlatform(
    effect.pipe(Effect.provide(TestClock.layer())),
    testServices({ config, database: fixture.db })
  );

beforeEach(async () => {
  fixture = await createPlatformFixture();
  config.AUTH_SECRET = secret;
});

afterEach(async () => {
  if (!fixture.client.closed) {
    await fixture.client.close();
  }
});

describe("platform CLI token authentication", () => {
  it("looks up only the current project's hashed credential and returns canonical scope", async () => {
    await fixture.db.insert(cliToken).values(validToken());
    await expect(
      run(authenticateCliEffect(fixture.project.id, "deploy-token"))
    ).resolves.toMatchObject({
      projectId: fixture.project.id,
      ...fixture.scope,
    });
    await expect(
      run(authenticateCliEffect(crypto.randomUUID(), "deploy-token"))
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      run(authenticateCliEffect(fixture.project.id, "wrong-token"))
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
  it.each([
    ["revoked", { revokedAt: new Date() }],
    ["expired", { expiresAt: new Date(-1) }],
    ["expires exactly now", { expiresAt: new Date(0) }],
    ["malformed scope", { scope: { name: "org", value: {} } }],
    ["mismatched scope key", { scopeKey: "0".repeat(32) }],
  ])("rejects a %s credential", async (_name, overrides) => {
    await fixture.db.insert(cliToken).values({ ...validToken(), ...overrides });
    await expect(
      run(authenticateCliEffect(fixture.project.id, "deploy-token"))
    ).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      message: "Invalid CLI deploy token.",
    });
  });
  it("rejects runtime credentials before accessing storage", async () => {
    await expect(
      run(authenticateCliEffect("invalid-uuid", "deploy-token", true))
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("reports unavailable configuration before accessing storage", async () => {
    await expect(
      runPlatform(
        authenticateCliEffect("invalid-uuid", "deploy-token"),
        testServices({
          config: { ...config, AUTH_SECRET: undefined },
          database: fixture.db,
        })
      )
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });
  it("retains infrastructure failures as typed errors instead of rejecting valid credentials", async () => {
    await fixture.client.close();
    await expect(
      run(authenticateCliEffect(fixture.project.id, "deploy-token"))
    ).rejects.toMatchObject({ _tag: "PlatformDependencyError" });
  });
});
