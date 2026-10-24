import { call } from "@orpc/server";
import type { AppDeploymentMetadata } from "@patchsmith/api-utils/app-auth";
import { asyncFixture } from "@patchsmith/config/testing";
import { app as appTable, appDeployment } from "@patchsmith/db/schema/apps";
import { organization, user } from "@patchsmith/db/schema/auth";
import { project as projectTable } from "@patchsmith/db/schema/project";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { afterEach, beforeEach, vi } from "vite-plus/test";

import type { Context } from "#context";
import { env } from "#env";
import { appRouter } from "#routes/apps";
import { attempt } from "#services";
import { createTestDb } from "#test/pglite";
import { testServices } from "#test/services";

export const orgId = "11111111-1111-4111-8111-111111111111";
export const projectId = "22222222-2222-4222-8222-222222222222";
export const otherProjectId = "33333333-3333-4333-8333-333333333333";
export const userId = "44444444-4444-4444-8444-444444444444";

export const productionScope = {
  name: "environment",
  value: { environment: "production" },
};

export const stagingScope = {
  name: "environment",
  value: { environment: "staging" },
};

export const appTestFixture = () => {
  const settings: typeof env & { AUTH_SECRET: string } = {
    ...env,
    APP_RUNTIME_URL: undefined,
    AUTH_SECRET: "test-only-agent-creation-secret-32-chars",
  };

  const testState = {
    env: settings,
    issueToken:
      vi.fn<
        (identity: {
          subjectId: string;
          installationId: string;
          projectId: string;
          appId: string;
          deploymentId: string;
        }) => Promise<{ expiresAt: number; token: string }>
      >(),
    publishMetadata:
      vi.fn<(metadata: AppDeploymentMetadata) => Promise<void>>(),
  };

  const http = vi.fn<typeof fetch>();
  let services: ReturnType<typeof testServices>;

  const createContext = (overrides: Partial<Context> = {}): Context => ({
    ...services,
    organization: {
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      id: orgId,
      logo: null,
      metadata: null,
      name: "Analytical Engines",
      shortId: "team00000001",
      slug: "analytical-engines",
    },
    project: {
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
      id: projectId,
      name: "Compiler",
      organizationId: orgId,
      shortId: "proj00000001",
      slug: "compiler",
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    },
    storage: {
      createDownloadUrl: vi.fn(),
      createUploadUrl: vi.fn(),
      delete: vi.fn(),
      head: vi.fn(),
      type: "s3",
    },
    ...overrides,
  });

  let client: Awaited<ReturnType<typeof createTestDb>>["client"];
  let db: Awaited<ReturnType<typeof createTestDb>>["db"];

  beforeEach(async () => {
    http.mockReset();
    testState.issueToken.mockImplementation(
      asyncFixture(() => ({
        expiresAt: Date.now() + 300_000,
        token: "platform-token",
      }))
    );
    testState.env.APP_RUNTIME_URL = undefined;
    const testDb = await createTestDb();
    ({ client } = testDb);
    ({ db } = testDb);
    services = testServices({
      config: testState.env,
      database: db,
      fetch: http,
      runtime: {
        enqueueWarmup: (metadata) =>
          attempt(async () => {
            await testState.publishMetadata(metadata);
          }),
        issueToken: (identity) =>
          attempt(async () => await testState.issueToken(identity)),
        warmDeployment: () => Effect.void,
      },
    });

    await db.insert(user).values({
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      email: "ada@example.com",
      emailVerified: true,
      id: userId,
      name: "Ada Lovelace",
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    await db.insert(organization).values({
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      id: orgId,
      name: "Analytical Engines",
      shortId: "team00000001",
      slug: "analytical-engines",
    });

    await db.insert(projectTable).values([
      {
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
        id: projectId,
        name: "Compiler",
        organizationId: orgId,
        slug: "compiler",
        updatedAt: new Date("2026-01-02T00:00:00.000Z"),
      },
      {
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
        id: otherProjectId,
        name: "Runtime",
        organizationId: orgId,
        slug: "runtime",
        updatedAt: new Date("2026-01-02T00:00:00.000Z"),
      },
    ]);
  });

  afterEach(async () => {
    await client.close();
    vi.clearAllMocks();
  });

  const seedRuntimeApp = async (
    name: string,
    views: NonNullable<typeof appDeployment.$inferInsert.views>,
    scope = productionScope,
    context = createContext()
  ) => {
    const { body: app } = await call(
      appRouter.create,
      {
        body: { description: null, name, scope },
      },
      { context }
    );

    const [deployment] = await db
      .insert(appDeployment)
      .values({
        appId: app.id,
        shortId: name.padEnd(12, "0").slice(0, 12),
        status: "published",
        views,
      })
      .returning();

    if (!deployment) {
      throw new Error("Expected discovery deployment");
    }

    await db
      .update(appTable)
      .set({ currentDeploymentId: deployment.id })
      .where(eq(appTable.id, app.id));

    return { app, deployment };
  };

  return {
    get client() {
      return client;
    },
    createContext,
    get db() {
      return db;
    },
    http,
    seedRuntimeApp,
    testState,
  };
};
