import { OpenAPIHandler } from "@orpc/openapi/fetch";
import type { ORPCError } from "@orpc/server";
import { call } from "@orpc/server";
import {
  issueAgentToken,
  verifyAgentToken,
} from "@patchsmith/api-utils/agent-token";
import { hashSecret } from "@patchsmith/api-utils/hashing";
import { RateLimitHandlerPlugin } from "@patchsmith/api-utils/rate-limiting";
import { asyncFixture } from "@patchsmith/config/testing";
import {
  app as appTable,
  appDeployment,
  appDeploymentFile,
} from "@patchsmith/db/schema/apps";
import { organization, user } from "@patchsmith/db/schema/auth";
import { cliToken } from "@patchsmith/db/schema/cli-auth";
import { project as projectTable } from "@patchsmith/db/schema/project";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { z } from "zod";

import type { Context } from "#context";
import { env } from "#env";
import { forEachSequential } from "#for-each-sequential";
import { attempt } from "#services";
import { createTestDb } from "#test/pglite";
import { testServices } from "#test/services";

import { appAgentRouter } from "./app-agent";

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
  publishMetadata: vi.fn(),
};

const { appRouter } = await import("./apps");
const { canonicalizeScope } = await import("#scope");

const orgId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const otherProjectId = "33333333-3333-4333-8333-333333333333";
const userId = "44444444-4444-4444-8444-444444444444";

const productionScope = {
  name: "environment",
  value: { environment: "production" },
};

const stagingScope = { name: "environment", value: { environment: "staging" } };

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

const createdAtImplementationImplementation = (day: number) =>
  new Date(`2026-01-${String(day).padStart(2, "0")}T00:00:00.000Z`);

describe("platform appRouter", () => {
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

  it("resolves only authorized installations on the platform without returning runtime credentials", async () => {
    const views = [{ instances: true as const, path: "/", slot: "page" }];
    const first = await seedRuntimeApp("firstresolve", views);
    const second = await seedRuntimeApp("secondresolve", views);
    await seedRuntimeApp("stageresolve", views, stagingScope);
    await seedRuntimeApp(
      "foreignresolve",
      views,
      productionScope,
      createContext({
        project: { ...createContext().project, id: otherProjectId },
      })
    );
    await seedRuntimeApp("disabledresolve", [
      { disabled: true, instances: true, path: "/", slot: "page" },
    ]);
    const requests: Request[] = [];

    const runtimeFetch = http.mockImplementation(async (value, init) => {
      const request =
        value instanceof Request ? value : new Request(value, init);

      requests.push(request);
      await request.clone().json();

      return Response.json(
        { json: [{ data: {}, key: "page", metadata: { label: "Page" } }] },
        {
          headers: {
            "server-timing":
              "runtime_execute;dur=3.0, private;desc=platform-token",
          },
        }
      );
    });

    const findMany = vi.spyOn(db.query.app, "findMany");
    const findFirst = vi.spyOn(db.query.app, "findFirst");

    const body = {
      contexts: [
        {
          context: { workspace: "verified" },
          path: "/",
          status: "ready" as const,
        },
      ],
      scopes: [productionScope],
      slot: "page",
      subjectId: "principal",
      toolUrl: "https://host.test/api/patchsmith/tools/execute",
    };

    try {
      const handler = new OpenAPIHandler({ apps: appRouter });

      const response = await handler.handle(
        new Request("https://platform.test/api/platform/apps/runtime/resolve", {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
        { context: createContext(), prefix: "/api/platform" }
      );

      expect(response.response?.status).toBe(200);
      expect(response.response?.headers.get("cache-control")).toBe("no-store");
      expect(response.response?.headers.get("server-timing")).toMatch(
        /^views_discovery;dur=\d+\.\d, views_instances;dur=\d+\.\d(?:, [a-z_]+;dur=\d+\.\d)*$/u
      );
      expect(response.response?.headers.get("server-timing")).toContain(
        "runtime_execute_max;dur=3.0"
      );
      expect(response.response?.headers.get("server-timing")).not.toContain(
        "platform-token"
      );
      const text = await response.response?.text();
      expect(text).not.toContain("platform-token");

      const result = z
        .object({
          data: z.array(
            z.object({ app: z.object({ id: z.string() }), key: z.string() })
          ),
          status: z.literal("ready"),
        })
        .parse(JSON.parse(text ?? "null"));

      expect(result.data.map(({ app }) => app.id).toSorted()).toEqual(
        [first.app.id, second.app.id].toSorted()
      );
      expect(findMany).toHaveBeenCalledOnce();
      expect(findFirst).not.toHaveBeenCalled();
      expect(requests).toHaveLength(2);

      for (const request of requests) {
        expect(request.headers.get("authorization")).toBe(
          "Bearer platform-token"
        );
        // oxlint-disable-next-line no-await-in-loop -- Read each captured request once while checking its independent wire contract.
        expect(await request.json()).toEqual({
          json: {
            args: {
              context: { workspace: "verified" },
              path: "/",
              slot: "page",
            },
            name: "_patchsmith.instances.resolve",
          },
        });
      }

      const filtered = await call(
        appRouter.runtimeResolve,
        { body: { ...body, appIds: [first.app.id, "not-an-installation"] } },
        { context: createContext() }
      );

      expect(filtered.body).toMatchObject({
        data: [{ app: { id: first.app.id } }],
        status: "ready",
      });
      expect(requests).toHaveLength(3);
      await expect(
        call(
          appRouter.runtimeResolve,
          { body },
          { context: createContext({ runtimeService: true }) }
        )
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(requests).toHaveLength(3);
      await expect(
        call(
          appRouter.runtimeResolve,
          { body },
          {
            context: createContext({
              agentToken: {
                appId: first.app.id,
                cliTokenId: "cli-token",
                exp: Math.floor(Date.now() / 1000) + 60,
                iat: Math.floor(Date.now() / 1000),
                jti: "test-agent",
                platformUrl: "https://platform.test/api/platform",
                projectId,
                scope: productionScope,
                sub: userId,
                token: "agent-token",
              },
            }),
          }
        )
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(requests).toHaveLength(3);
    } finally {
      runtimeFetch.mockRestore();
      findMany.mockRestore();
      findFirst.mockRestore();
    }
  });

  it("discovers authorized static entries and follows deployment changes without runtime configuration", async () => {
    const entry = {
      data: { section: "reports" },
      key: "reports",
      metadata: { label: "Reports" },
    };

    const views = [
      {
        instances: true as const,
        path: "/",
        slot: "page",
        staticInstances: [entry],
      },
    ];

    const installation = await seedRuntimeApp("staticresolve", views);
    await seedRuntimeApp("staticstage", views, stagingScope);
    await seedRuntimeApp(
      "staticforeign",
      views,
      productionScope,
      createContext({
        project: { ...createContext().project, id: otherProjectId },
      })
    );

    const input = {
      body: {
        contexts: [{ context: {}, path: "/", status: "ready" as const }],
        scopes: [productionScope],
        slot: "page",
        subjectId: "principal",
        toolUrl: "https://host.test/api/patchsmith/tools/execute",
      },
    };

    const result = await call(appRouter.runtimeResolve, input, {
      context: createContext(),
    });

    expect(result.body).toMatchObject({
      data: [{ ...entry, app: { id: installation.app.id } }],
      status: "ready",
      warnings: [],
    });
    expect(JSON.stringify(result.body)).not.toContain("staticInstances");
    expect(testState.issueToken).not.toHaveBeenCalled();

    const [next] = await db
      .insert(appDeployment)
      .values({
        appId: installation.app.id,
        shortId: "staticnext00",
        status: "published",
        views: [
          {
            ...views[0],
            instances: true,
            path: "/",
            slot: "page",
            staticInstances: [],
          },
        ],
      })
      .returning();

    if (!next) {
      throw new Error("Expected next deployment");
    }

    await db
      .update(appTable)
      .set({ currentDeploymentId: next.id })
      .where(eq(appTable.id, installation.app.id));

    const empty = await call(appRouter.runtimeResolve, input, {
      context: createContext(),
    });

    expect(empty.body).toEqual({ data: [], status: "ready", warnings: [] });
    expect(testState.issueToken).not.toHaveBeenCalled();
  });

  it("returns a sanitized 504 and cancels the resolver when its one-second budget expires", async () => {
    await seedRuntimeApp("timeoutmatch", [
      { instances: true, path: "/", slot: "page" },
    ]);

    const requests: Request[] = [];

    const runtimeFetch = http.mockImplementation(async (value, init) => {
      requests.push(
        value instanceof Request ? value : new Request(value, init)
      );

      return await Promise.withResolvers<Response>().promise;
    });

    try {
      const handler = new OpenAPIHandler({ apps: appRouter });

      const result = await handler.handle(
        new Request("https://platform.test/api/platform/apps/runtime/resolve", {
          body: JSON.stringify({
            contexts: [{ context: {}, path: "/", status: "ready" }],
            scopes: [productionScope],
            slot: "page",
            subjectId: "principal",
            toolUrl: "https://host.test/tools",
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
        { context: createContext(), prefix: "/api/platform" }
      );

      expect(result.response?.status).toBe(504);
      expect(await result.response?.json()).toMatchObject({
        code: "GATEWAY_TIMEOUT",
        message: "View resolution timed out",
      });
      expect(runtimeFetch).toHaveBeenCalledOnce();
      expect(requests[0]?.signal.aborted).toBe(true);
    } finally {
      runtimeFetch.mockRestore();
    }
  });

  it("returns per-app timeout warnings with completed data over HTTP", async () => {
    const views = [{ instances: true as const, path: "/", slot: "page" }];
    const completed = await seedRuntimeApp("completewarn", views);
    const stalled = await seedRuntimeApp("stalledwarn", views);
    const requests: Request[] = [];

    const runtimeFetch = http.mockImplementation(async (value, init) => {
      const request =
        value instanceof Request ? value : new Request(value, init);

      requests.push(request);

      if (request.url.includes(`/a/${completed.app.shortId}/`)) {
        return Response.json({
          json: [{ data: {}, key: "ready", metadata: {} }],
        });
      }

      return await Promise.withResolvers<Response>().promise;
    });

    try {
      const handler = new OpenAPIHandler({ apps: appRouter });

      const result = await handler.handle(
        new Request("https://platform.test/api/platform/apps/runtime/resolve", {
          body: JSON.stringify({
            contexts: [{ context: {}, path: "/", status: "ready" }],
            scopes: [productionScope],
            slot: "page",
            subjectId: "principal",
            toolUrl: "https://host.test/tools",
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
        { context: createContext(), prefix: "/api/platform" }
      );

      expect(result.response?.status).toBe(200);
      expect(await result.response?.json()).toMatchObject({
        data: [{ app: { id: completed.app.id }, key: "ready" }],
        status: "ready",
        warnings: [
          {
            appId: stalled.app.id,
            code: "INSTANCE_RESOLUTION_TIMEOUT",
            message: "View resolution timed out",
            path: "/",
          },
        ],
      });
      expect(requests).toHaveLength(2);
      expect(
        requests.find((request) =>
          request.url.includes(`/a/${stalled.app.shortId}/`)
        )?.signal.aborted
      ).toBe(true);
    } finally {
      runtimeFetch.mockRestore();
    }
  });

  it("continues platform resolution past an entire page with no matching views", async () => {
    const matching = await seedRuntimeApp("oldermatch", [
      { instances: true, path: "/", slot: "page" },
    ]);

    const scope = canonicalizeScope(productionScope);
    await db.insert(appTable).values(
      Array.from({ length: 100 }, (_, index) => ({
        createdAt: new Date("2030-01-01T00:00:00.000Z"),
        name: `Unpublished ${index}`,
        projectId,
        scope: scope.scope,
        scopeKey: scope.scopeKey,
        shortId: `page${String(index).padStart(8, "0")}`,
      }))
    );

    const runtimeFetch = http.mockResolvedValue(Response.json({ json: [] }));

    const findMany = vi.spyOn(db.query.app, "findMany");

    try {
      const result = await call(
        appRouter.runtimeResolve,
        {
          body: {
            contexts: [{ context: {}, path: "/", status: "ready" }],
            scopes: [productionScope],
            slot: "page",
            subjectId: "principal",
            toolUrl: "https://host.test/tools",
          },
        },
        { context: createContext() }
      );

      expect(result.body).toEqual({ data: [], status: "ready", warnings: [] });
      expect(findMany).toHaveBeenCalledTimes(2);

      const firstPage = z
        .array(z.object({ id: z.string() }))
        .parse(await findMany.mock.results[0]?.value);

      const tiedIds = firstPage.slice(0, 100).map(({ id }) => id);
      expect(tiedIds).toHaveLength(100);
      expect(tiedIds).toEqual(tiedIds.toSorted().toReversed());
      expect(runtimeFetch).toHaveBeenCalledOnce();
      expect(testState.issueToken).toHaveBeenCalledWith(
        expect.objectContaining({ installationId: matching.app.id })
      );
    } finally {
      runtimeFetch.mockRestore();
      findMany.mockRestore();
    }
  });

  it("resolves each installation once when discovery pages overlap", async () => {
    const matching = await seedRuntimeApp("overlapmatch", [
      { instances: true, path: "/", slot: "page" },
    ]);

    const scope = canonicalizeScope(productionScope);
    await db.insert(appTable).values(
      Array.from({ length: 101 }, (_, index) => ({
        createdAt: new Date("2030-01-01T00:00:00.000Z"),
        currentDeploymentId: matching.deployment.id,
        name: `Installation ${index}`,
        projectId,
        scope: scope.scope,
        scopeKey: scope.scopeKey,
        shortId: `over${String(index).padStart(8, "0")}`,
      }))
    );

    const installations = await db.query.app.findMany({
      orderBy: { createdAt: "desc", id: "desc" },
      with: {
        currentDeployment: {
          with: { app: { columns: { shortId: true } } },
        },
      },
    });

    // Model an offset shifted by a concurrent insert, repeating the last app from page one.
    const findMany = vi
      .spyOn(db.query.app, "findMany")
      .mockResolvedValueOnce(installations.slice(0, 101))
      .mockResolvedValueOnce(installations.slice(99));

    const runtimeFetch = http.mockImplementation(
      asyncFixture(() =>
        Response.json({
          json: [{ data: {}, key: "page", metadata: {} }],
        })
      )
    );

    testState.issueToken.mockClear();

    try {
      const result = await call(
        appRouter.runtimeResolve,
        {
          body: {
            contexts: [{ context: {}, path: "/", status: "ready" }],
            scopes: [productionScope],
            slot: "page",
            subjectId: "principal",
            toolUrl: "https://host.test/tools",
          },
        },
        { context: createContext() }
      );

      expect(result.body.status).toBe("ready");

      if (result.body.status !== "ready") {
        throw new Error("Expected resolved installations");
      }

      expect(result.body.data.map(({ app }) => app.id).toSorted()).toEqual(
        installations.map(({ id }) => id).toSorted()
      );
      expect(testState.issueToken).toHaveBeenCalledTimes(102);
      expect(runtimeFetch).toHaveBeenCalledTimes(102);
    } finally {
      runtimeFetch.mockRestore();
      findMany.mockRestore();
    }
  });

  it("serves OpenAPI create and explicit lookup selectors with detailed inputs", async () => {
    const handler = new OpenAPIHandler(
      { apps: appRouter },
      { plugins: [new RateLimitHandlerPlugin()] }
    );

    const handle = async (path: string, body: z.core.util.JSONType) =>
      await handler.handle(
        new Request(`https://example.com/api/platform${path}`, {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
        { context: createContext(), prefix: "/api/platform" }
      );

    const created = await handle("/apps", {
      description: null,
      name: "Compiler",
      scope: productionScope,
    });

    expect(created.response?.status).toBe(200);
    expect(created.response?.headers.get("ratelimit-limit")).toBe("100");

    const app = z
      .object({ id: z.string() })
      .parse(await created.response?.json());

    const found = await handle("/apps/lookup", {
      app: { id: app.id },
      scopes: [productionScope],
    });

    expect(found.response?.status).toBe(200);
    await expect(found.response?.json()).resolves.toMatchObject({
      id: app.id,
      name: "Compiler",
    });

    const missing = await handle("/apps/lookup", {
      app: { slug: "missing" },
      scopes: [productionScope],
    });

    expect(missing.response?.status).toBe(404);
    const error: unknown = await missing.response?.json();
    expect(error).toMatchObject({ code: "NOT_FOUND" });
    expect(error).not.toHaveProperty("status");
  });

  it("installs a published app with separate scope and runtime identity while retaining its artifacts", async () => {
    const context = createContext();

    const { body: source } = await call(
      appRouter.create,
      {
        body: {
          description: "An inbox",
          name: "Shared inbox",
          scope: productionScope,
        },
      },
      { context }
    );

    const [deployment] = await db
      .insert(appDeployment)
      .values({
        appId: source.id,
        hooks: ["sync"],
        logoLightPath: `logos/${"a".repeat(64)}.svg`,
        shortId: "published001",
        status: "published",
        views: [{ path: "/", slot: "page" }],
      })
      .returning();

    if (!deployment) {
      throw new Error("Expected published deployment");
    }

    const keyBase = `projects/${context.project.shortId}/apps/${source.shortId}`;

    const [clientFile] = await db
      .insert(appDeploymentFile)
      .values({
        appDeploymentId: deployment.id,
        contentLength: 10,
        contentType: "application/javascript",
        objectKey: `${keyBase}/deployments/${deployment.shortId}/client/client.js`,
        status: "verified",
      })
      .returning();

    if (!clientFile) {
      throw new Error("Expected client file");
    }

    await db
      .update(appDeployment)
      .set({ clientEntryFileId: clientFile.id })
      .where(eq(appDeployment.id, deployment.id));
    await db.insert(appDeploymentFile).values({
      appDeploymentId: deployment.id,
      checksum: "b".repeat(64),
      contentLength: 20,
      contentType: "application/javascript",
      encoding: "gzip",
      objectKey: `${keyBase}/deployments/${deployment.shortId}/server/server.js`,
      status: "verified",
    });
    await db
      .update(appTable)
      .set({ currentDeploymentId: deployment.id })
      .where(eq(appTable.id, source.id));

    const handler = new OpenAPIHandler({ apps: appRouter });

    const response = await handler.handle(
      new Request("https://platform.test/api/platform/apps/install", {
        body: JSON.stringify({
          app: { slug: source.slug },
          scope: stagingScope,
          slug: "installed-inbox",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      { context, prefix: "/api/platform" }
    );

    expect(response.response?.status).toBe(200);

    const installed = z
      .object({ id: z.string(), shortId: z.string(), slug: z.string() })
      .parse(await response.response?.json());

    expect(installed.id).not.toBe(source.id);
    expect(installed.shortId).not.toBe(source.shortId);
    expect(installed.slug).toBe("installed-inbox");
    await expect(
      call(
        appRouter.install,
        {
          body: {
            app: { slug: source.slug },
            scope: productionScope,
            slug: installed.slug,
          },
        },
        { context }
      )
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const { body: listed } = await call(
      appRouter.list,
      { body: { scopes: [stagingScope] } },
      { context }
    );

    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({
      ...installed,
      createdByAgent: false,
      currentDeployment: { hooks: ["sync"], id: deployment.id },
      description: source.description,
      name: source.name,
      scope: stagingScope,
      views: [{ path: "/", slot: "page" }],
    });
    expect(listed.items[0]?.clientPath).toContain(
      `/a/${source.shortId}/d/${deployment.shortId}/client/client.js`
    );
    expect(listed.items[0]?.logoPaths?.light).toContain(
      `/a/${source.shortId}/d/${deployment.shortId}/logos/`
    );

    const lookup = await call(
      appRouter.get,
      { body: { app: { id: installed.id }, scopes: [stagingScope] } },
      { context }
    );

    expect(lookup.body.clientPath).toBe(listed.items[0]?.clientPath);
    await expect(
      call(
        appRouter.get,
        {
          body: { app: { id: installed.id }, scopes: [productionScope] },
        },
        { context }
      )
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const session = await call(
      appRouter.runtimeSession,
      {
        body: {
          app: { id: installed.id },
          scopes: [stagingScope],
          subjectId: "principal",
          toolUrl: "https://host.test/api/patchsmith/tools/execute",
        },
      },
      { context }
    );

    expect(session.body.identity).toMatchObject({
      appId: installed.id,
      deploymentId: deployment.id,
      installationId: installed.id,
      scope: stagingScope,
    });
    const { getRuntimeBundle } = await import("./runtime");

    const bundle = await call(
      getRuntimeBundle,
      { body: {}, params: { appId: installed.id } },
      { context: { ...context, runtimeService: true } }
    );

    expect(bundle.body).toMatchObject({
      appId: installed.id,
      contentEncoding: "gzip",
      deploymentId: deployment.id,
      objectKey: `${keyBase}/deployments/${deployment.shortId}/server/server.js`,
    });

    await expect(
      call(
        appRouter.delete,
        {
          body: { app: { id: source.id }, scope: productionScope },
        },
        { context }
      )
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // Changing the source deployment never changes an existing installation.
    await db
      .update(appTable)
      .set({ currentDeploymentId: null })
      .where(eq(appTable.id, source.id));

    const pinned = await call(
      appRouter.get,
      { body: { app: { id: installed.id }, scopes: [stagingScope] } },
      { context }
    );

    expect(pinned.body.currentDeployment?.id).toBe(deployment.id);
    expect(pinned.body.currentDeployment?.hooks).toEqual(["sync"]);
    await call(
      appRouter.delete,
      { body: { app: { id: installed.id }, scope: stagingScope } },
      { context }
    );
    expect(
      await db.query.app.findFirst({ where: { id: source.id } })
    ).toBeDefined();
  });

  it("returns a conflict when an installation appears after the deletion dependency check", async () => {
    const context = createContext();

    const { body: source } = await call(
      appRouter.create,
      {
        body: { description: null, name: "Shared app", scope: productionScope },
      },
      { context }
    );

    await db.insert(appDeployment).values({
      appId: source.id,
      shortId: "published001",
      status: "published",
    });

    // Insert the dependency during deletion so the initial check cannot see it.
    await client.exec(`
      CREATE FUNCTION install_before_delete() RETURNS trigger AS $$
      BEGIN
        INSERT INTO app (
          name, project_id, short_id, scope_json, scope_key, current_deployment_id
        )
        SELECT 'Concurrent installation', OLD.project_id, 'installed001',
          OLD.scope_json, OLD.scope_key, id
        FROM app_deployment WHERE app_id = OLD.id;
        RETURN OLD;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER install_before_delete
        BEFORE DELETE ON app
        FOR EACH ROW EXECUTE FUNCTION install_before_delete();
    `);

    await expect(
      call(
        appRouter.delete,
        { body: { app: { id: source.id }, scope: productionScope } },
        { context }
      )
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Remove installations using this app before deleting it.",
    });
    expect(
      await db.query.app.findFirst({ where: { id: source.id } })
    ).toBeDefined();
  });

  it.each(["23503", "23001", "P0001"])(
    "handles deletion error %s without masking unrelated failures",
    async (code) => {
      const context = createContext();

      const { body: source } = await call(
        appRouter.create,
        { body: { description: null, name: "App", scope: productionScope } },
        { context }
      );

      await client.exec(`
      CREATE FUNCTION fail_delete() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'Deletion failed' USING ERRCODE = '${code}';
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_delete
        BEFORE DELETE ON app
        FOR EACH ROW EXECUTE FUNCTION fail_delete();
    `);

      const deletion = call(
        appRouter.delete,
        { body: { app: { id: source.id }, scope: productionScope } },
        { context }
      );

      await expect(deletion).rejects.toMatchObject({
        _tag: "PlatformDependencyError",
        cause: {
          cause: { code, message: "Deletion failed" },
          name: "DrizzleQueryError",
        },
      });
    }
  );

  it("limits installation to published apps in the host project and rejects agent credentials", async () => {
    const context = createContext();

    const { body: source } = await call(
      appRouter.create,
      {
        body: { description: null, name: "Draft", scope: productionScope },
      },
      { context }
    );

    const input = {
      body: { app: { id: source.id }, scope: stagingScope },
    };

    await expect(
      call(appRouter.install, input, { context })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const [deployment] = await db
      .insert(appDeployment)
      .values({
        appId: source.id,
        shortId: "uploading001",
        status: "uploading",
      })
      .returning();

    if (!deployment) {
      throw new Error("Expected deployment");
    }

    await db
      .update(appTable)
      .set({ currentDeploymentId: deployment.id })
      .where(eq(appTable.id, source.id));
    await expect(
      call(appRouter.install, input, { context })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await db
      .update(appDeployment)
      .set({ status: "published" })
      .where(eq(appDeployment.id, deployment.id));
    await expect(
      call(appRouter.install, input, {
        context: createContext({
          project: { ...context.project, id: otherProjectId },
        }),
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const token = await issueAgentToken(
      {
        appId: source.id,
        cliTokenId: "credential",
        projectId,
        scope: productionScope,
      },
      testState.env.AUTH_SECRET,
      "https://platform.test/api/platform"
    );

    const claims = await verifyAgentToken(
      token,
      testState.env.AUTH_SECRET,
      "https://platform.test/api/platform"
    );

    await expect(
      call(appRouter.install, input, {
        context: createContext({ agentToken: { ...claims, token } }),
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await db.select().from(appTable)).toHaveLength(1);
    const installed = await call(appRouter.install, input, { context });
    expect(installed.body.id).not.toBe(source.id);
  });

  it("rejects caller-supplied provenance on general app creation", async () => {
    const handler = new OpenAPIHandler({ apps: appRouter });

    const result = await handler.handle(
      new Request("https://platform.test/api/platform/apps", {
        body: JSON.stringify({
          createdByAgent: true,
          description: null,
          name: "Forged AI app",
          scope: productionScope,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      { context: createContext(), prefix: "/api/platform" }
    );

    expect(result.response?.status).toBe(400);
    expect(await db.select().from(appTable)).toEqual([]);
  });

  it.each([{ createdByAgent: true }, { scope: stagingScope }])(
    "rejects caller-supplied agent creation fields %j",
    async (untrustedFields) => {
      const handler = new OpenAPIHandler({ appAgent: appAgentRouter });

      const result = await handler.handle(
        new Request("https://platform.test/api/platform/app-agent/apps", {
          body: JSON.stringify({
            ...untrustedFields,
            deployToken: "cli-token",
            description: null,
            name: "Forged AI app",
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
        { context: createContext(), prefix: "/api/platform" }
      );

      expect(result.response?.status).toBe(400);
      expect(await db.select().from(appTable)).toEqual([]);
    }
  );

  it.each(["cli", "agent"] as const)(
    "derives AI provenance and scope from an authenticated %s creation flow",
    async (credential) => {
      const secret = testState.env.AUTH_SECRET;

      const [source] = await db
        .insert(cliToken)
        .values({
          expiresAt: new Date(Date.now() + 3_600_000),
          projectId,
          ...canonicalizeScope(productionScope),
          tokenHash: hashSecret("cli-token", secret),
        })
        .returning();

      if (!source) {
        throw new Error("Expected CLI credential.");
      }

      const context = createContext();
      let deployToken = "cli-token";

      if (credential === "agent") {
        deployToken = await issueAgentToken(
          {
            appId: "initiating-app",
            cliTokenId: source.id,
            projectId,
            scope: productionScope,
          },
          secret,
          "https://platform.test/api/platform"
        );
        context.agentToken = {
          ...(await verifyAgentToken(
            deployToken,
            secret,
            "https://platform.test/api/platform"
          )),
          token: deployToken,
        };

        const manual = await call(
          appRouter.create,
          {
            body: {
              description: null,
              name: "Manual app",
              scope: productionScope,
            },
          },
          { context }
        );

        expect(manual.body.createdByAgent).toBe(false);
      }

      const created = await call(
        appAgentRouter.create,
        {
          body: { deployToken, description: null, name: "AI app" },
        },
        { context }
      );

      expect(created.body.createdByAgent).toBe(true);
      expect(created.body.scope).toEqual(productionScope);

      const found = await call(
        appRouter.get,
        {
          body: { app: { id: created.body.id }, scopes: [productionScope] },
        },
        { context }
      );

      expect(found.body.createdByAgent).toBe(true);

      const listed = await call(
        appRouter.list,
        {
          body: { scopes: [productionScope] },
        },
        { context }
      );

      expect(listed.body.items).toContainEqual(
        expect.objectContaining({ createdByAgent: true, id: created.body.id })
      );
    }
  );

  it.each(["missing", "expired", "revoked", "foreign-project"])(
    "rejects %s CLI credentials before creating an agent app",
    async (credential) => {
      await db.insert(cliToken).values({
        expiresAt: new Date(
          Date.now() + (credential === "expired" ? -1000 : 3_600_000)
        ),
        projectId:
          credential === "foreign-project" ? otherProjectId : projectId,
        revokedAt: credential === "revoked" ? new Date() : null,
        ...canonicalizeScope(productionScope),
        tokenHash: hashSecret("cli-token", testState.env.AUTH_SECRET),
      });
      await expect(
        call(
          appAgentRouter.create,
          {
            body: {
              deployToken:
                credential === "missing" ? "missing-token" : "cli-token",
              description: null,
              name: "AI app",
            },
          },
          { context: createContext() }
        )
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      expect(await db.select().from(appTable)).toEqual([]);
    }
  );

  it("creates and lists apps within the authenticated project and scope", async () => {
    const context = createContext();

    const created = await call(
      appRouter.create,
      {
        body: {
          description: " Embedded inbox ",
          name: " Inbox ",
          scope: productionScope,
        },
      },
      { context }
    );

    const expectedShortIdMatcher1: unknown =
      expect.stringMatching(/^[0-9a-z]{12}$/u);

    expect(created.body).toEqual(
      expect.objectContaining({
        createdByAgent: false,
        description: "Embedded inbox",
        name: "Inbox",
        projectId,
        scope: productionScope,
        shortId: expectedShortIdMatcher1,
      })
    );

    await db.insert(appTable).values({
      name: "Staging app",
      projectId,
      shortId: "staging00001",
      ...canonicalizeScope(stagingScope),
    });

    const result = await call(
      appRouter.list,
      { body: { page: 1, pageSize: 10, scopes: [productionScope] } },
      { context }
    );

    expect(result.body.items).toHaveLength(1);
    expect(result.body.items[0]).toEqual(
      expect.objectContaining({ id: created.body.id })
    );
  });

  it("returns the current published deployment", async () => {
    const context = createContext();

    const [createdApp] = await db
      .insert(appTable)
      .values({
        name: "Notes",
        projectId,
        shortId: "notes0000001",
        ...canonicalizeScope(productionScope),
      })
      .returning();

    if (!createdApp) {
      throw new Error("Expected test app to be created.");
    }

    const [deployment] = await db
      .insert(appDeployment)
      .values({
        appId: createdApp.id,
        shortId: "deploy000001",
        status: "published",
      })
      .returning();

    if (!deployment) {
      throw new Error("Expected test deployment to be created.");
    }

    const [clientEntryFile] = await db
      .insert(appDeploymentFile)
      .values({
        appDeploymentId: deployment.id,
        checksum: "0".repeat(64),
        contentLength: 1,
        contentType: "application/javascript",
        encoding: "utf-8",
        objectKey: "client.js",
        status: "verified",
      })
      .returning();

    if (!clientEntryFile) {
      throw new Error("Expected client entry file to be created.");
    }

    await db
      .update(appDeployment)
      .set({ clientEntryFileId: clientEntryFile.id })
      .where(eq(appDeployment.id, deployment.id));

    await db
      .update(appTable)
      .set({ currentDeploymentId: deployment.id })
      .where(eq(appTable.id, createdApp.id));

    const result = await call(
      appRouter.list,
      { body: { page: 1, pageSize: 10, scopes: [productionScope] } },
      { context }
    );

    expect(result.body.items[0]?.currentDeployment?.id).toBe(deployment.id);
    expect(result.body.items[0]?.clientPath).toBe(
      `https://proj00000001.tailorkit.app/a/notes0000001/d/deploy000001/client/client.js`
    );
  });

  const createdAtImplementation = createdAtImplementationImplementation;

  it("lists apps across selected named scopes with global ordering and pagination", async () => {
    const context = createContext();
    const teamScope = { name: "team", value: { teamId: "team_1" } };
    const userScope = { name: "user", value: { userId: "user_1" } };
    const excludedScope = { name: "team", value: { teamId: "team_2" } };
    const createdAt = createdAtImplementation;

    await db.insert(appTable).values([
      {
        createdAt: createdAt(3),
        name: "Team app",
        projectId,
        shortId: "teamapp00001",
        ...canonicalizeScope(teamScope),
      },
      {
        createdAt: createdAt(4),
        name: "User app",
        projectId,
        shortId: "userapp00001",
        ...canonicalizeScope(userScope),
      },
      {
        createdAt: createdAt(5),
        name: "Other team app",
        projectId,
        shortId: "otherapp0001",
        ...canonicalizeScope(excludedScope),
      },
    ]);

    const firstPage = await call(
      appRouter.list,
      { body: { page: 1, pageSize: 1, scopes: [teamScope, userScope] } },
      { context }
    );

    const secondPage = await call(
      appRouter.list,
      { body: { page: 2, pageSize: 1, scopes: [teamScope, userScope] } },
      { context }
    );

    expect(firstPage.body.items.map(({ name }) => name)).toEqual(["User app"]);
    expect(secondPage.body.items.map(({ name }) => name)).toEqual(["Team app"]);
    expect(firstPage.body.pagination.hasMore).toBe(true);
    expect(secondPage.body.pagination.hasMore).toBe(false);
  });

  it("does not resolve apps outside the current project or scope", async () => {
    const [created] = await db
      .insert(appTable)
      .values({
        name: "Other project app",
        projectId: otherProjectId,
        shortId: "other0000001",
        ...canonicalizeScope(productionScope),
      })
      .returning();

    if (!created) {
      throw new Error("Expected test app to be created.");
    }

    await expect(
      call(
        appRouter.get,
        { body: { app: { id: created.id }, scopes: [productionScope] } },
        { context: createContext() }
      )
    ).rejects.toEqual(
      expect.objectContaining({ code: "NOT_FOUND" } satisfies Partial<
        ORPCError<"NOT_FOUND", unknown>
      >)
    );

    const [otherScopeApp] = await db
      .insert(appTable)
      .values({
        name: "Staging app",
        projectId,
        shortId: "staging00002",
        ...canonicalizeScope(stagingScope),
      })
      .returning();

    if (!otherScopeApp) {
      throw new Error("Expected staging app to be created.");
    }

    await expect(
      call(
        appRouter.get,
        {
          body: { app: { id: otherScopeApp.id }, scopes: [productionScope] },
        },
        { context: createContext() }
      )
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it.each(["uploading", "deploying", "verifying", "published"] as const)(
    "publishes verified runtime metadata only for a published deployment (%s)",
    async (status) => {
      const context = createContext();

      const [created] = await db
        .insert(appTable)
        .values({
          name: "Runtime",
          projectId,
          shortId: "runtime00001",
          ...canonicalizeScope(productionScope),
        })
        .returning();

      if (!created) {
        throw new Error("Expected test app");
      }

      const [deployment] = await db
        .insert(appDeployment)
        .values({ appId: created.id, shortId: "runtime00002", status })
        .returning();

      if (!deployment) {
        throw new Error("Expected test deployment");
      }

      const objectKey = `projects/${context.project.shortId}/apps/${created.shortId}/deployments/${deployment.shortId}/server/server.js`;
      await db.insert(appDeploymentFile).values({
        appDeploymentId: deployment.id,
        checksum: "0".repeat(64),
        contentLength: 1,
        contentType: "application/javascript",
        encoding: "utf-8",
        objectKey,
        status: "verified",
      });
      await call(
        appRouter.deploy,
        {
          body: {
            app: { shortId: created.shortId },
            deploymentId: deployment.shortId,
            scope: productionScope,
          },
        },
        { context }
      );

      if (status === "published") {
        expect(testState.publishMetadata).toHaveBeenCalledWith(
          expect.objectContaining({ deploymentId: deployment.id, objectKey })
        );
      } else {
        expect(testState.publishMetadata).not.toHaveBeenCalled();
      }
    }
  );

  it.each(["missing", "unverified", "empty-checksum", "verified"] as const)(
    "advances installations when selecting a deployment with a %s server bundle",
    async (server) => {
      const context = createContext();
      const source = await seedRuntimeApp("rollout", []);

      const [installation] = await db
        .insert(appTable)
        .values({
          currentDeploymentId: source.deployment.id,
          name: "Installed rollout",
          projectId,
          ...canonicalizeScope(stagingScope),
        })
        .returning();

      const [deployment] = await db
        .insert(appDeployment)
        .values({
          appId: source.app.id,
          shortId: "next00000001",
          status: "published",
        })
        .returning();

      if (!installation || !deployment) {
        throw new Error("Expected rollout fixtures");
      }

      if (server !== "missing") {
        await db.insert(appDeploymentFile).values({
          appDeploymentId: deployment.id,
          checksum: server === "empty-checksum" ? "" : "0".repeat(64),
          contentLength: 1,
          contentType: "application/javascript",
          objectKey: `projects/${context.project.shortId}/apps/${source.app.shortId}/deployments/${deployment.shortId}/server/server.js`,
          status: server === "unverified" ? "uploading" : "verified",
        });
      }

      await call(
        appRouter.deploy,
        {
          body: {
            app: { id: source.app.id },
            deploymentId: deployment.id,
            scope: productionScope,
          },
        },
        { context }
      );

      expect(
        await db.query.app.findFirst({ where: { id: installation.id } })
      ).toMatchObject({ currentDeploymentId: deployment.id });

      if (server === "verified") {
        expect(testState.publishMetadata).toHaveBeenCalledOnce();
      } else {
        expect(testState.publishMetadata).not.toHaveBeenCalled();
      }
    }
  );

  it("uses the JSON body scope for app mutations", async () => {
    const context = createContext();

    const [created] = await db
      .insert(appTable)
      .values({
        id: "55555555-5555-7555-8555-555555555555",
        name: "Inbox",
        projectId,
        shortId: "inbox0000001",
        ...canonicalizeScope(productionScope),
      })
      .returning();

    if (!created) {
      throw new Error("Expected test app to be created.");
    }

    await expect(
      call(
        appRouter.update,
        {
          body: {
            app: { shortId: created.shortId },
            description: null,
            name: "Wrong scope",
            scope: stagingScope,
          },
        },
        { context }
      )
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const updated = await call(
      appRouter.update,
      {
        body: {
          app: { shortId: created.shortId },
          description: null,
          name: "Updated inbox",
          scope: productionScope,
        },
      },
      { context }
    );

    expect(updated.body.name).toBe("Updated inbox");

    const [deployment] = await db
      .insert(appDeployment)
      .values({
        appId: created.id,
        shortId: "deploy000002",
        status: "published",
        views: [
          { instances: true, path: "/", slot: "page" },
          { disabled: true, path: "/disabled", slot: "page" },
        ],
      })
      .returning();

    if (!deployment) {
      throw new Error("Expected test deployment to be created.");
    }

    const deployed = await call(
      appRouter.deploy,
      {
        body: {
          app: { shortId: created.shortId },
          deploymentId: deployment.shortId,
          scope: productionScope,
        },
      },
      { context }
    );

    expect(deployed.body.currentDeployment?.id).toBe(deployment.id);
    expect(deployed.body.currentDeployment?.hooks).toEqual([]);
    expect(deployed.body.views).toEqual([
      { instances: true, path: "/", slot: "page" },
      { disabled: true, path: "/disabled", slot: "page" },
    ]);

    const listed = await call(
      appRouter.list,
      { body: { scopes: [productionScope] } },
      { context }
    );

    expect(listed.body.items[0]?.views).toEqual([
      { instances: true, path: "/", slot: "page" },
      { disabled: true, path: "/disabled", slot: "page" },
    ]);

    const deleted = await call(
      appRouter.delete,
      { body: { app: { shortId: created.shortId }, scope: productionScope } },
      { context }
    );

    expect(deleted.body.id).toBe(created.id);
  });
  it("authorizes backend sessions with existing scopes and resolves canonical installation identities", async () => {
    const context = createContext();

    const [created] = await db
      .insert(appTable)
      .values({
        id: "55555555-5555-7555-8555-555555555555",
        name: "Inbox",
        projectId,
        shortId: "inbox0000001",
        ...canonicalizeScope(productionScope),
      })
      .returning();

    if (!created) {
      throw new Error("Expected test app");
    }

    const [deployment] = await db
      .insert(appDeployment)
      .values({
        appId: created.id,
        shortId: "deploy000002",
        status: "published",
      })
      .returning();

    if (!deployment) {
      throw new Error("Expected test deployment");
    }

    await db
      .update(appTable)
      .set({ currentDeploymentId: deployment.id })
      .where(eq(appTable.id, created.id));

    const input = {
      body: {
        app: { shortId: created.shortId },
        scopes: [productionScope],
        subjectId: "principal",
        toolUrl: "https://host.test/api/patchsmith/tools/execute",
      },
    };

    const session = await call(appRouter.runtimeSession, input, { context });
    expect(session.body.token).toBe("platform-token");
    expect(session.body.identity).toMatchObject({
      deploymentId: deployment.id,
      expiresAt: session.body.expiresAt,
      installationId: created.id,
      projectId,
      scope: created.scope,
      subjectId: "principal",
      toolUrl: input.body.toolUrl,
    });
    expect(testState.issueToken).toHaveBeenCalledWith({
      appId: created.id,
      appShortId: created.shortId,
      deploymentId: deployment.id,
      installationId: created.id,
      projectId,
      projectShortId: context.project.shortId,
      scope: created.scope,
      subjectId: "principal",
      toolUrl: input.body.toolUrl,
    });

    await expect(
      call(
        appRouter.runtimeSession,
        { ...input, body: { ...input.body, scopes: [stagingScope] } },
        { context }
      )
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      call(appRouter.runtimeSession, input, {
        context: {
          ...context,
          project: { ...context.project, id: otherProjectId },
        },
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(testState.issueToken).toHaveBeenCalledTimes(1);
    const handler = new OpenAPIHandler({ apps: appRouter });

    const httpResult = await handler.handle(
      new Request("https://platform.test/api/platform/apps/runtime/session", {
        body: JSON.stringify({
          app: { shortId: created.shortId },
          scopes: [productionScope],
          subjectId: "principal",
          toolUrl: input.body.toolUrl,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      { context, prefix: "/api/platform" }
    );

    expect(httpResult.response?.status).toBe(200);
    await expect(httpResult.response?.json()).resolves.toMatchObject({
      identity: {
        appShortId: created.shortId,
        projectShortId: context.project.shortId,
      },
      token: "platform-token",
      url: `https://proj00000001.tailorkit.app/a/${created.shortId}/rpc`,
    });

    const issued = testState.issueToken.mock.calls.length;
    await Promise.all(
      [undefined, null, "", 123, "x".repeat(257)].map(async (subjectId) => {
        const invalid = await handler.handle(
          new Request(
            "https://platform.test/api/platform/apps/runtime/session",
            {
              body: JSON.stringify({ ...input.body, subjectId }),
              headers: { "content-type": "application/json" },
              method: "POST",
            }
          ),
          { context, prefix: "/api/platform" }
        );

        expect(invalid.response?.status).toBe(400);
      })
    );
    expect(testState.issueToken.mock.calls).toHaveLength(issued);

    expect(session.body.url).toBe(
      `https://proj00000001.tailorkit.app/a/${created.shortId}/rpc`
    );
    const identity = testState.issueToken.mock.calls.at(-1)?.[0];
    await Array.fromAsync(
      [
        { id: created.id },
        { shortId: created.shortId },
        { slug: created.slug },
      ],
      async (app) => {
        await Array.fromAsync(
          [
            [stagingScope, productionScope],
            [productionScope, stagingScope],
          ],
          async (scopes) => {
            await call(
              appRouter.runtimeSession,
              {
                body: {
                  app,
                  scopes,
                  subjectId: "principal",
                  toolUrl: input.body.toolUrl,
                },
              },
              { context }
            );
            expect(testState.issueToken).toHaveBeenLastCalledWith(identity);
          }
        );
      }
    );
    const tokenCalls = testState.issueToken.mock.calls.length;
    await Array.fromAsync(
      [
        "http://runtime.test",
        "ftp://localhost",
        "https://user:pass@runtime.test",
        "https://runtime.test?redirect=attacker",
        "https://runtime.test#fragment",
      ],
      async (runtimeUrl) => {
        testState.env.APP_RUNTIME_URL = runtimeUrl;

        await expect(
          call(appRouter.runtimeSession, input, { context })
        ).rejects.toMatchObject({
          code: "SERVICE_UNAVAILABLE",
        });
      }
    );
    expect(testState.issueToken.mock.calls).toHaveLength(tokenCalls);
    testState.env.APP_RUNTIME_URL = "http://localhost:8787/other";
    const local = await call(appRouter.runtimeSession, input, { context });
    expect(local.body.url).toBe(
      `http://localhost:8787/p/proj00000001/a/${created.shortId}/rpc`
    );
    testState.env.APP_RUNTIME_URL = undefined;

    await expect(
      call(
        appRouter.runtimeSession,
        { ...input, body: { ...input.body, hook: "sync" } },
        { context }
      )
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await db
      .update(appDeployment)
      .set({ hooks: ["customers.sync"] })
      .where(eq(appDeployment.id, deployment.id));

    const hookApps = await call(
      appRouter.list,
      { body: { scopes: [productionScope] } },
      { context }
    );

    expect(
      hookApps.body.items.find((item) => item.id === created.id)
        ?.currentDeployment?.hooks
    ).toEqual(["customers.sync"]);

    const hookSession = await call(
      appRouter.runtimeSession,
      { ...input, body: { ...input.body, hook: "customers.sync" } },
      { context }
    );

    expect(hookSession.body.identity.hook).toBe("customers.sync");
    expect(testState.issueToken).toHaveBeenLastCalledWith(
      expect.objectContaining({
        hook: "customers.sync",
        installationId: created.id,
      })
    );

    await db
      .update(appTable)
      .set({ currentDeploymentId: null })
      .where(eq(appTable.id, created.id));
    await expect(
      call(appRouter.runtimeSession, input, { context })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
  it("creates immutable usernames with project-wide uniqueness, including concurrent writes", async () => {
    const context = createContext();

    const input = {
      body: {
        description: null,
        name: "Inbox",
        scope: productionScope,
        slug: "shared-inbox",
      },
    };

    const outcomes = await Promise.allSettled([
      call(appRouter.create, input, { context }),
      call(appRouter.create, input, { context }),
    ]);

    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled")
    ).toHaveLength(1);
    expect(
      outcomes.find((outcome) => outcome.status === "rejected")
    ).toMatchObject({ reason: { code: "CONFLICT" } });
    await expect(
      call(
        appRouter.create,
        { body: { ...input.body, scope: stagingScope } },
        { context }
      )
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const otherContext = createContext({
      project: { ...context.project, id: otherProjectId },
    });

    await expect(
      call(appRouter.create, input, { context: otherContext })
    ).resolves.toMatchObject({ body: { slug: "shared-inbox" } });
    const selector = { slug: "shared-inbox" };

    const renamed = await call(
      appRouter.update,
      {
        body: {
          app: selector,
          description: null,
          name: "Renamed",
          scope: productionScope,
        },
      },
      { context }
    );

    expect(renamed.body.slug).toBe("shared-inbox");
    const handler = new OpenAPIHandler({ apps: appRouter });

    const update = await handler.handle(
      new Request("https://platform.test/apps/update", {
        body: JSON.stringify({
          app: selector,
          description: null,
          name: "Renamed",
          scope: productionScope,
          slug: "changed",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      { context }
    );

    expect(update.response?.status).toBe(400);
  });

  it("distinguishes slugs from identical short IDs without bypassing project or scope checks", async () => {
    const context = createContext();
    const id = "55555555-5555-4555-8555-555555555555";
    const shortId = "app000000001";
    const scopedSlug = "staging-inbox";
    await db.insert(appTable).values([
      {
        id,
        name: "Original",
        projectId,
        shortId,
        slug: "original",
        ...canonicalizeScope(productionScope),
      },
      {
        name: "Short ID slug",
        projectId,
        slug: shortId,
        ...canonicalizeScope(productionScope),
      },
      {
        name: "Scoped slug",
        projectId,
        slug: scopedSlug,
        ...canonicalizeScope(stagingScope),
      },
    ]);
    await forEachSequential(
      [
        [{ id }, "Original"],
        [{ shortId }, "Original"],
        [{ slug: shortId }, "Short ID slug"],
        [{ slug: scopedSlug }, "Scoped slug"],
      ] as const,
      async ([app, name]) => {
        const found = await call(
          appRouter.get,
          { body: { app, scopes: [productionScope, stagingScope] } },
          { context }
        );

        expect(found.body.name).toBe(name);
      }
    );
    await expect(
      call(
        appRouter.get,
        { body: { app: { slug: scopedSlug }, scopes: [productionScope] } },
        { context }
      )
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      call(
        appRouter.get,
        { body: { app: { slug: shortId }, scopes: [productionScope] } },
        {
          context: createContext({
            project: { ...context.project, id: otherProjectId },
          }),
        }
      )
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects invalid or ambiguous selectors and invalid slugs at the HTTP boundary", async () => {
    const handler = new OpenAPIHandler({ apps: appRouter });
    const context = createContext();
    await forEachSequential(
      [
        {},
        { id: "invalid" },
        { shortId: "invalid" },
        { slug: "UPPER" },
        { slug: "a".repeat(33) },
        { slug: "55555555-5555-4555-8555-555555555555" },
        { shortId: "app000000001", slug: "valid" },
      ],
      async (app) => {
        const result = await handler.handle(
          new Request("https://platform.test/apps/lookup", {
            body: JSON.stringify({ app, scopes: [productionScope] }),
            headers: { "content-type": "application/json" },
            method: "POST",
          }),
          { context }
        );

        expect(result.response?.status).toBe(400);
      }
    );
    await forEachSequential(
      [
        "",
        "UPPER",
        "has space",
        "-leading",
        "trailing-",
        "double--hyphen",
        "a".repeat(33),
      ],
      async (slug) => {
        const result = await handler.handle(
          new Request("https://platform.test/apps", {
            body: JSON.stringify({
              description: null,
              name: "App",
              scope: productionScope,
              slug,
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
          }),
          { context }
        );

        expect(result.response?.status).toBe(400);
      }
    );
    expect(await db.select().from(appTable)).toHaveLength(0);
    const maxLengthSlug = "a".repeat(32);

    const created = await call(
      appRouter.create,
      {
        body: {
          description: null,
          name: "Max length",
          scope: productionScope,
          slug: maxLengthSlug,
        },
      },
      { context }
    );

    expect(created.body.slug).toBe(maxLengthSlug);

    const found = await call(
      appRouter.get,
      {
        body: { app: { slug: maxLengthSlug }, scopes: [productionScope] },
      },
      { context }
    );

    expect(found.body.id).toBe(created.body.id);
  });
});
