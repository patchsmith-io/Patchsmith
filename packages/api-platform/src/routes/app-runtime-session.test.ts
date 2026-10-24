import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { call } from "@orpc/server";
import { app as appTable, appDeployment } from "@patchsmith/db/schema/apps";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import { canonicalizeScope } from "#scope";
import {
  appTestFixture,
  projectId,
  otherProjectId,
  productionScope,
  stagingScope,
} from "#test/apps";

import { appRouter } from "./apps";

describe("platform app-runtime-session", () => {
  const fixture = appTestFixture();
  const { createContext, testState } = fixture;

  it("authorizes backend sessions with existing scopes and resolves canonical installation identities", async () => {
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
      throw new Error("Expected test app");
    }

    const [deployment] = await fixture.db
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

    await fixture.db
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
    await fixture.db
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

    await fixture.db
      .update(appTable)
      .set({ currentDeploymentId: null })
      .where(eq(appTable.id, created.id));
    await expect(
      call(appRouter.runtimeSession, input, { context })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
