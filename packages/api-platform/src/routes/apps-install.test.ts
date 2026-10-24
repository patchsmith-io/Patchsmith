import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { call } from "@orpc/server";
import {
  issueAgentToken,
  verifyAgentToken,
} from "@patchsmith/api-utils/agent-token";
import {
  app as appTable,
  appDeployment,
  appDeploymentFile,
} from "@patchsmith/db/schema/apps";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { canonicalizeScope } from "#scope";
import {
  appTestFixture,
  projectId,
  otherProjectId,
  productionScope,
  stagingScope,
} from "#test/apps";

import { appRouter } from "./apps";

describe("platform apps-install", () => {
  const fixture = appTestFixture();
  const { createContext, seedRuntimeApp, testState } = fixture;

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

    const [deployment] = await fixture.db
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

    const [clientFile] = await fixture.db
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

    await fixture.db
      .update(appDeployment)
      .set({ clientEntryFileId: clientFile.id })
      .where(eq(appDeployment.id, deployment.id));
    await fixture.db.insert(appDeploymentFile).values({
      appDeploymentId: deployment.id,
      checksum: "b".repeat(64),
      contentLength: 20,
      contentType: "application/javascript",
      encoding: "gzip",
      objectKey: `${keyBase}/deployments/${deployment.shortId}/server/server.js`,
      status: "verified",
    });
    await fixture.db
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
    const { getRuntimeBundle } = await import("./app-runtime");

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
    await fixture.db
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
      await fixture.db.query.app.findFirst({ where: { id: source.id } })
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

    await fixture.db.insert(appDeployment).values({
      appId: source.id,
      shortId: "published001",
      status: "published",
    });

    // Insert the dependency during deletion so the initial check cannot see it.
    await fixture.client.exec(`
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
      await fixture.db.query.app.findFirst({ where: { id: source.id } })
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

      await fixture.client.exec(`
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

    const [deployment] = await fixture.db
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

    await fixture.db
      .update(appTable)
      .set({ currentDeploymentId: deployment.id })
      .where(eq(appTable.id, source.id));
    await expect(
      call(appRouter.install, input, { context })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await fixture.db
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
    expect(await fixture.db.select().from(appTable)).toHaveLength(1);
    const installed = await call(appRouter.install, input, { context });
    expect(installed.body.id).not.toBe(source.id);
  });

  it.each(["uploading", "deploying", "verifying", "published"] as const)(
    "publishes verified runtime metadata only for a published deployment (%s)",
    async (status) => {
      const context = createContext();

      const [created] = await fixture.db
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

      const [deployment] = await fixture.db
        .insert(appDeployment)
        .values({ appId: created.id, shortId: "runtime00002", status })
        .returning();

      if (!deployment) {
        throw new Error("Expected test deployment");
      }

      const objectKey = `projects/${context.project.shortId}/apps/${created.shortId}/deployments/${deployment.shortId}/server/server.js`;
      await fixture.db.insert(appDeploymentFile).values({
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

      const [installation] = await fixture.db
        .insert(appTable)
        .values({
          currentDeploymentId: source.deployment.id,
          name: "Installed rollout",
          projectId,
          ...canonicalizeScope(stagingScope),
        })
        .returning();

      const [deployment] = await fixture.db
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
        await fixture.db.insert(appDeploymentFile).values({
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
        await fixture.db.query.app.findFirst({ where: { id: installation.id } })
      ).toMatchObject({ currentDeploymentId: deployment.id });

      if (server === "verified") {
        expect(testState.publishMetadata).toHaveBeenCalledOnce();
      } else {
        expect(testState.publishMetadata).not.toHaveBeenCalled();
      }
    }
  );
});
