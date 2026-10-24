import { OpenAPIHandler } from "@orpc/openapi/fetch";
import type { ORPCError } from "@orpc/server";
import { call } from "@orpc/server";
import { RateLimitHandlerPlugin } from "@patchsmith/api-utils/rate-limiting";
import {
  app as appTable,
  appDeployment,
  appDeploymentFile,
} from "@patchsmith/db/schema/apps";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { forEachSequential } from "#for-each-sequential";
import { canonicalizeScope } from "#scope";
import {
  appTestFixture,
  projectId,
  otherProjectId,
  productionScope,
  stagingScope,
} from "#test/apps";

import { appRouter } from "./apps";

const createdAtImplementation = (day: number) =>
  new Date(`2026-01-${String(day).padStart(2, "0")}T00:00:00.000Z`);

describe("platform apps-crud", () => {
  const fixture = appTestFixture();
  const { createContext } = fixture;

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
    expect(await fixture.db.select().from(appTable)).toEqual([]);
  });

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

    await fixture.db.insert(appTable).values({
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

    const [createdApp] = await fixture.db
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

    const [deployment] = await fixture.db
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

    const [clientEntryFile] = await fixture.db
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

    await fixture.db
      .update(appDeployment)
      .set({ clientEntryFileId: clientEntryFile.id })
      .where(eq(appDeployment.id, deployment.id));

    await fixture.db
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

  it("lists apps across selected named scopes with global ordering and pagination", async () => {
    const context = createContext();
    const teamScope = { name: "team", value: { teamId: "team_1" } };
    const userScope = { name: "user", value: { userId: "user_1" } };
    const excludedScope = { name: "team", value: { teamId: "team_2" } };
    const createdAt = createdAtImplementation;

    await fixture.db.insert(appTable).values([
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
    const [created] = await fixture.db
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

    const [otherScopeApp] = await fixture.db
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

  it("uses the JSON body scope for app mutations", async () => {
    const context = createContext();

    const [created] = await fixture.db
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

    const [deployment] = await fixture.db
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
    await fixture.db.insert(appTable).values([
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
    expect(await fixture.db.select().from(appTable)).toHaveLength(0);
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
