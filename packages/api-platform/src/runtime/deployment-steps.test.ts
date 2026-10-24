import {
  app,
  appDeployment,
  appDeploymentFile,
} from "@patchsmith/db/schema/apps";
import { organization } from "@patchsmith/db/schema/auth";
import { project } from "@patchsmith/db/schema/project";
import { eq } from "drizzle-orm";
import { expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { env } from "#env";
import { runPlatform } from "#services";
import { createTestDb } from "#test/pglite";
import { createPlatformFixture } from "#test/platform";
import { testServices } from "#test/services";

import {
  listRuntimeInstallationsEffect,
  selectRuntimeDeployment,
  warmRuntimeDeploymentEffect,
} from "./deployment-steps";

it("rolls out every installation of the source and rejects delayed older rollouts", async () => {
  const { client, db } = await createTestDb();

  try {
    const [org] = await db
      .insert(organization)
      .values({
        createdAt: new Date(),
        name: "Runtime",
        shortId: "org000000001",
        slug: "runtime",
      })
      .returning();

    if (!org) {
      throw new Error("Organization missing");
    }

    const [workspace] = await db
      .insert(project)
      .values({ name: "Runtime", organizationId: org.id, slug: "runtime" })
      .returning();

    if (!workspace) {
      throw new Error("Project missing");
    }

    const scope = { name: "tenant", value: { id: "one" } };

    const installations = await db
      .insert(app)
      .values(
        ["source", "first", "second", "unrelated"].map((name) => ({
          name,
          projectId: workspace.id,
          scope,
          scopeKey: "tenant:one",
          slug: name,
        }))
      )

      .returning();

    const [source, first, second, unrelated] = installations;

    if (!source || !first || !second || !unrelated) {
      throw new Error("Installations missing");
    }

    const [old, next, other] = await db
      .insert(appDeployment)
      .values([
        { appId: source.id, status: "published" as const },
        { appId: source.id, status: "published" as const },
        { appId: unrelated.id, status: "published" as const },
      ])
      .returning();

    if (!old || !next || !other) {
      throw new Error("Deployments missing");
    }

    await db
      .update(app)
      .set({ currentDeploymentId: old.id })
      .where(eq(app.projectId, workspace.id));
    await db
      .update(app)
      .set({ currentDeploymentId: other.id })
      .where(eq(app.id, unrelated.id));
    await db
      .update(app)
      .set({ currentDeploymentId: next.id })
      .where(eq(app.id, source.id));

    const input = {
      appId: source.id,
      deploymentId: next.id,
      projectId: workspace.id,
    };

    expect(await selectRuntimeDeployment(input, db)).toBe(true);
    expect(
      await selectRuntimeDeployment({ ...input, deploymentId: old.id }, db)
    ).toBe(false);

    const rows = await db
      .select({ deploymentId: app.currentDeploymentId, id: app.id })
      .from(app);

    expect(new Map(rows.map((row) => [row.id, row.deploymentId]))).toEqual(
      new Map([
        [source.id, next.id],
        [first.id, next.id],
        [second.id, next.id],
        [unrelated.id, other.id],
      ])
    );
    // An explicit rollback of the owner is also a valid new rollout.
    await db
      .update(app)
      .set({ currentDeploymentId: old.id })
      .where(eq(app.id, source.id));
    expect(
      await selectRuntimeDeployment({ ...input, deploymentId: old.id }, db)
    ).toBe(true);
    expect(
      await db
        .select({ id: app.id })
        .from(app)
        .where(eq(app.currentDeploymentId, old.id))
    ).toHaveLength(3);
  } finally {
    await client.close();
  }
});

it("paginates only installations still selecting the rollout's deployment", async () => {
  const fixture = await createPlatformFixture();

  try {
    const [deployment] = await fixture.db
      .insert(appDeployment)
      .values({ appId: fixture.app.id, status: "published" })
      .returning();

    if (!deployment) {
      throw new Error("Missing deployment");
    }

    await fixture.db.insert(app).values(
      Array.from({ length: 51 }, (_, index) => ({
        currentDeploymentId: deployment.id,
        name: `Installation ${index}`,
        projectId: fixture.project.id,
        ...fixture.scope,
      }))
    );
    const services = testServices({ database: fixture.db });

    const input = {
      appId: fixture.app.id,
      deploymentId: deployment.id,
      projectId: fixture.project.id,
    };

    const first = await runPlatform(
      listRuntimeInstallationsEffect(input),
      services
    );

    const next = await runPlatform(
      listRuntimeInstallationsEffect(input, first.at(-1)),
      services
    );

    expect(first).toHaveLength(50);
    expect(next).toHaveLength(1);
    expect(new Set([...first, ...next]).size).toBe(51);

    const foreign = await runPlatform(
      listRuntimeInstallationsEffect({
        ...input,
        projectId: crypto.randomUUID(),
      }),
      services
    );

    expect(foreign).toEqual([]);
  } finally {
    await fixture.client.close();
  }
});

it("warms the installation's fresh selection using the owning app's verified server", async () => {
  const fixture = await createPlatformFixture();

  try {
    const [old, current] = await fixture.db
      .insert(appDeployment)
      .values([
        { appId: fixture.app.id, status: "published" },
        { appId: fixture.app.id, status: "published" },
      ])
      .returning();

    if (!old || !current) {
      throw new Error("Missing deployments");
    }

    const [installation] = await fixture.db
      .insert(app)
      .values({
        currentDeploymentId: old.id,
        name: "Installed",
        projectId: fixture.project.id,
        ...fixture.scope,
      })
      .returning();

    if (!installation) {
      throw new Error("Missing installation");
    }

    const objectKey = `projects/${fixture.project.shortId}/apps/${fixture.app.shortId}/deployments/${current.shortId}/server/server.js`;

    const [file] = await fixture.db
      .insert(appDeploymentFile)
      .values({
        appDeploymentId: current.id,
        checksum: "a".repeat(64),
        contentLength: 123,
        contentType: "application/javascript",
        encoding: "gzip",
        objectKey,
        status: "verified",
      })
      .returning();

    if (!file) {
      throw new Error("Missing server file");
    }

    await fixture.db
      .update(app)
      .set({ currentDeploymentId: current.id })
      .where(eq(app.id, installation.id));

    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));

    const services = testServices({
      config: {
        ...env,
        APP_RUNTIME_INTERNAL_URL: "https://internal.test",
        APP_RUNTIME_SERVICE_TOKEN: "x".repeat(32),
      },
      database: fixture.db,
      fetch: fetcher,
    });

    await runPlatform(
      warmRuntimeDeploymentEffect(fixture.project.id, installation.id),
      services
    );
    const sent = z.string().parse(fetcher.mock.lastCall?.[1]?.body);
    expect(JSON.parse(sent)).toMatchObject({
      appId: installation.id,
      contentEncoding: "gzip",
      deploymentId: current.id,
      objectKey,
    });
    expect(fetcher.mock.lastCall?.[0]).toEqual(
      new URL(
        `https://internal.test/p/${fixture.project.id}/a/${installation.shortId}/new-deployment`
      )
    );
    fetcher.mockClear();
    await fixture.db
      .update(appDeploymentFile)
      .set({ status: "uploading" })
      .where(eq(appDeploymentFile.id, file.id));
    await runPlatform(
      warmRuntimeDeploymentEffect(fixture.project.id, installation.id),
      services
    );
    await runPlatform(
      warmRuntimeDeploymentEffect(crypto.randomUUID(), installation.id),
      services
    );
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    await fixture.client.close();
  }
});
