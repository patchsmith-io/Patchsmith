import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { issueAgentToken } from "@patchsmith/api-utils/agent-token";
import { hashSecret } from "@patchsmith/api-utils/hashing";
import { app, appDeployment } from "@patchsmith/db/schema/apps";
import { organization } from "@patchsmith/db/schema/auth";
import { cliToken } from "@patchsmith/db/schema/cli-auth";
import { project } from "@patchsmith/db/schema/project";
import { Effect } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { env } from "#env";
import { canonicalizeScope } from "#scope";
import type { Scope } from "#scope";
import { attempt } from "#services";
import { createTestDb } from "#test/pglite";
import { testServices } from "#test/services";

const requireValue = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) {
    throw new Error("Expected a defined value.");
  }

  return value;
};

const mocks = {
  apiKey: vi.fn<
    (input: { body: { configId: string; key: string } }) => Promise<{
      valid: boolean;
      key?: { metadata?: { projectId?: string } };
    }>
  >(),
  storage: {
    createDownloadUrl: vi.fn(),
    createUploadUrl: vi.fn(),
    delete: vi.fn(),
    head: vi.fn(),
    type: "s3" as const,
  },
};

const { createContext, contextErrorResponse } = await import("#context");
const { appRouter } = await import("./apps");
const { deploymentRouter } = await import("./deployments");
const { cliAuthRouter } = await import("./cli-auth");

const handler = new OpenAPIHandler({
  apps: appRouter,
  cliAuth: cliAuthRouter,
  deployments: deploymentRouter,
});

const projectId = "22222222-2222-4222-8222-222222222222";
const organizationId = "11111111-1111-4111-8111-111111111111";
const tokenSecret = "issued-cli-token";

const scope = canonicalizeScope({
  name: "user",
  value: { userId: "user-one" },
});

const http = vi.fn<typeof fetch>();
let services: ReturnType<typeof testServices>;
let database: Awaited<ReturnType<typeof createTestDb>>;
let jwt: string;
let sourceTokenId: string;
let authorizedAppId: string;
let sameScopeAppId: string;
let otherScopeAppId: string;
let otherProjectAppId: string;

interface AgentRequestBody {
  [field: string]: z.core.util.JSONType | Scope | Scope[];
}

const request = (path: string, body: AgentRequestBody = {}, secret = jwt) =>
  new Request(`https://platform.test/api/platform${path}`, {
    body: JSON.stringify(body),
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    },
    method: "POST",
  });

const responseBodySchema = z.looseObject({
  deployment: z.looseObject({ id: z.string() }).optional(),
  id: z.string().optional(),
});

const post = async (path: string, body: AgentRequestBody = {}) => {
  const input = request(path, body);
  let context;

  try {
    context = await createContext({ request: input, ...services });
  } catch (error) {
    const response = contextErrorResponse(error);

    return {
      body: responseBodySchema.parse(await response.json()),
      status: response.status,
    };
  }

  const result = await handler.handle(input, {
    context,
    prefix: "/api/platform",
  });

  if (!result.response) {
    throw new Error("Expected HTTP response");
  }

  return {
    body: responseBodySchema.parse(await result.response.json()),
    status: result.response.status,
  };
};

const deploymentInput = (appId: string) => ({
  app: { id: appId },
  assets: [
    {
      checksum: "a".repeat(64),
      contentLength: 10,
      contentType: "application/javascript",
      encoding: "gzip",
      objectKey: "client.js",
    },
  ],
  scope: scope.scope,
});

beforeEach(async () => {
  http.mockReset();
  vi.clearAllMocks();
  database = await createTestDb();
  services = testServices({
    credentials: {
      verifyProjectKey: (key) =>
        attempt(async () => {
          const result = await mocks.apiKey({
            body: { configId: "project-host", key },
          });

          return {
            projectId: result?.key?.metadata?.projectId,
            valid: result?.valid ?? false,
          };
        }),
    },
    database: database.db,
    fetch: http,
    storage: { get: Effect.succeed(mocks.storage) },
  });
  const { db } = database;
  await db.insert(organization).values({
    createdAt: new Date(),
    id: organizationId,
    name: "Team",
    shortId: "team00000001",
    slug: "team",
  });
  const otherProjectId = "33333333-3333-4333-8333-333333333333";
  await db.insert(project).values([
    { id: projectId, name: "Project", organizationId, slug: "project" },
    { id: otherProjectId, name: "Other", organizationId, slug: "other" },
  ]);

  const [source] = await db
    .insert(cliToken)
    .values({
      projectId,

      ...scope,

      expiresAt: new Date(Date.now() + 3_600_000),

      tokenHash: hashSecret(tokenSecret, requireValue(env.AUTH_SECRET)),
    })
    .returning();

  sourceTokenId = requireValue(source).id;

  const apps = await db
    .insert(app)
    .values([
      { projectId, ...scope, name: "Allowed", shortId: "app000000001" },
      { projectId, ...scope, name: "Same scope", shortId: "app000000004" },
      {
        projectId,
        ...canonicalizeScope({ name: "user", value: { userId: "user-two" } }),
        name: "Other scope",
        shortId: "app000000002",
      },
      {
        projectId: otherProjectId,
        ...scope,
        name: "Other project",
        shortId: "app000000003",
      },
    ])
    .returning();

  authorizedAppId = requireValue(apps[0]).id;
  sameScopeAppId = requireValue(apps[1]).id;
  otherScopeAppId = requireValue(apps[2]).id;
  otherProjectAppId = requireValue(apps[3]).id;
  jwt = await issueAgentToken(
    {
      appId: authorizedAppId,
      cliTokenId: sourceTokenId,
      projectId,
      scope: scope.scope,
    },
    requireValue(env.AUTH_SECRET),
    requireValue(env.OPENAPI_SERVER_URL)
  );
  mocks.storage.createUploadUrl.mockResolvedValue({
    uploadUrl: "https://uploads.test/client.js",
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await database.client.close();
});

it("deploys with an agent JWT through the existing endpoint without a host key", async () => {
  const created = await post("/deployments", deploymentInput(authorizedAppId));
  expect(created.status).toBe(200);
  expect(created.body.deployment).toMatchObject({
    appId: authorizedAppId,
    status: "uploading",
  });
  expect(mocks.apiKey).not.toHaveBeenCalled();
});

it("keeps the one-hour grant valid after the source CLI token expires", async () => {
  await database.db.update(cliToken).set({ expiresAt: new Date(0) });

  const awaitedResult1 = await post(
    "/deployments",
    deploymentInput(authorizedAppId)
  );

  expect(awaitedResult1.status).toBe(200);
});

it.each(["expired", "revoked", "invalid", "malformed-scope"])(
  "rejects %s agent credentials",
  async (state) => {
    if (state === "expired") {
      vi.useFakeTimers();
      vi.advanceTimersByTime(3_600_000);
    }

    if (state === "revoked") {
      await database.db.update(cliToken).set({ revokedAt: new Date() });
    }

    if (state === "malformed-scope") {
      await database.db.update(cliToken).set({ scopeKey: "0".repeat(32) });
    }

    if (state === "invalid") {
      jwt = `${jwt.slice(0, jwt.lastIndexOf(".") + 1)}invalid`;
    }

    expect(
      await post("/deployments", deploymentInput(authorizedAppId))
    ).toMatchObject({
      body: { code: "UNAUTHORIZED" },
      status: 401,
    });
  }
);

it("cannot change the authorized scope", async () => {
  expect(
    await post("/deployments", {
      ...deploymentInput(authorizedAppId),
      scope: {
        name: "user",
        value: { userId: "user-two" },
      },
    })
  ).toMatchObject({ body: { code: "FORBIDDEN" }, status: 403 });
});

it("rejects apps outside the scope or project", async () => {
  await Array.fromAsync([otherScopeAppId, otherProjectAppId], async (appId) => {
    expect(await post("/deployments", deploymentInput(appId))).toMatchObject({
      body: { code: "NOT_FOUND" },
      status: 404,
    });

    const [deployment] = await database.db
      .insert(appDeployment)
      .values({
        appId,
        status: "uploading",
      })
      .returning();

    expect(
      await post(`/deployments/${requireValue(deployment).id}`, {
        scope: scope.scope,
      })
    ).toMatchObject({
      body: { code: "NOT_FOUND" },
      status: 404,
    });
  });
});

it("keeps ordinary CLI tokens on the host authentication path", async () => {
  await expect(
    createContext({
      request: request("/deployments", {}, tokenSecret),
      ...services,
    })
  ).rejects.toThrow("Invalid API key");
  expect(mocks.apiKey).toHaveBeenCalled();
});

it("publishes a verified upload to the authorized app", async () => {
  const created = await post("/deployments", deploymentInput(authorizedAppId));
  mocks.storage.head.mockResolvedValue({
    checksumSha256: Buffer.from("a".repeat(64), "hex").toString("base64"),
    contentEncoding: "gzip",
    contentLength: 10,
    contentType: "application/javascript",
  });
  mocks.storage.createDownloadUrl.mockResolvedValue({
    url: "https://uploads.test/client.js",
  });
  http.mockResolvedValue(new Response("client-code"));

  const published = await post(
    `/deployments/${requireValue(created.body.deployment).id}`,
    {
      rollout: true,
      scope: scope.scope,
    }
  );

  expect(published).toMatchObject({
    body: { status: "published" },
    status: 200,
  });

  const selectedApp = await database.db.query.app.findFirst({
    where: { id: authorizedAppId },
  });

  expect(selectedApp?.currentDeploymentId).toBe(
    requireValue(created.body.deployment).id
  );

  const otherApp = await database.db.query.app.findFirst({
    where: { id: otherScopeAppId },
  });

  expect(otherApp?.currentDeploymentId).toBeNull();
});

it("uses the same CLI permissions for verification, listing, app creation, and deployment", async () => {
  expect(
    await post("/cli-auth/verify-token", { deployToken: jwt })
  ).toMatchObject({
    body: { scope: scope.scope },
    status: 200,
  });
  expect(await post("/apps/list", { scopes: [scope.scope] })).toMatchObject({
    status: 200,
  });

  const created = await post("/apps", {
    description: null,
    name: "New app",
    scope: scope.scope,
  });

  expect(created).toMatchObject({ body: { scope: scope.scope }, status: 200 });

  const awaitedResult2 = await post("/apps/lookup", {
    app: { id: sameScopeAppId },
    scopes: [scope.scope],
  });

  expect(awaitedResult2.status).toBe(200);

  const awaitedResult3 = await post(
    "/deployments",
    deploymentInput(sameScopeAppId)
  );

  expect(awaitedResult3.status).toBe(200);

  const awaitedResult4 = await post(
    "/deployments",
    deploymentInput(requireValue(created.body.id))
  );

  expect(awaitedResult4.status).toBe(200);
});

it("reports database outages as 503 rather than rejecting a valid JWT", async () => {
  vi.spyOn(database.db.query.cliToken, "findFirst").mockRejectedValueOnce(
    new Error("database unavailable")
  );
  expect(await post("/deployments", deploymentInput(authorizedAppId))).toEqual({
    body: {
      code: "SERVICE_UNAVAILABLE",
      message: "Platform is temporarily unavailable.",
    },
    status: 503,
  });
});

it("maps missing credentials to 401 and unavailable dependencies to 503", () => {
  expect(contextErrorResponse(new Error("storage unavailable")).status).toBe(
    503
  );
});

it("keeps runtime-only metadata private from CLI credentials", async () => {
  const { getRuntimeBundle } = await import("./app-runtime");
  const input = request(`/apps/${authorizedAppId}/runtime`);
  const context = await createContext({ request: input, ...services });

  const result = await new OpenAPIHandler({ runtime: getRuntimeBundle }).handle(
    input,
    {
      context,
      prefix: "/api/platform",
    }
  );

  expect(requireValue(result.response).status).toBe(403);
});

it("validates all supplied scope selectors rather than accepting an authorized decoy", async () => {
  expect(
    await post("/apps/list", {
      scope: scope.scope,
      scopes: [{ name: "user", value: { userId: "user-two" } }],
    })
  ).toMatchObject({ body: { code: "FORBIDDEN" }, status: 403 });
});
