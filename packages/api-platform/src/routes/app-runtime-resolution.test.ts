import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { call } from "@orpc/server";
import { asyncFixture } from "@patchsmith/config/testing";
import { app as appTable, appDeployment } from "@patchsmith/db/schema/apps";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { canonicalizeScope } from "#scope";
import {
  appTestFixture,
  projectId,
  otherProjectId,
  userId,
  productionScope,
  stagingScope,
} from "#test/apps";

import { appRouter } from "./apps";

describe("platform app-runtime-resolution", () => {
  const fixture = appTestFixture();
  const { createContext, http, seedRuntimeApp, testState } = fixture;

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

    const findMany = vi.spyOn(fixture.db.query.app, "findMany");
    const findFirst = vi.spyOn(fixture.db.query.app, "findFirst");

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

    const [next] = await fixture.db
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

    await fixture.db
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
    await fixture.db.insert(appTable).values(
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

    const findMany = vi.spyOn(fixture.db.query.app, "findMany");

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
    await fixture.db.insert(appTable).values(
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

    const installations = await fixture.db.query.app.findMany({
      orderBy: { createdAt: "desc", id: "desc" },
      with: {
        currentDeployment: {
          with: { app: { columns: { shortId: true } } },
        },
      },
    });

    // Model an offset shifted by a concurrent insert, repeating the last app from page one.
    const findMany = vi
      .spyOn(fixture.db.query.app, "findMany")
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
});
