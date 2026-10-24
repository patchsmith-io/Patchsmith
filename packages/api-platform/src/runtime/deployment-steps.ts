import type { relations } from "@patchsmith/db/relations";
import { app, appDeployment } from "@patchsmith/db/schema/apps";
import { and, eq, gt, inArray } from "drizzle-orm";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { PgAsyncDatabase } from "drizzle-orm/pg-core/async";
import { Effect } from "effect";

import { PlatformDependencyError } from "#errors";
import { attempt, PlatformDatabase, runPlatform } from "#services";

import { warmRuntimeInstallationEffect } from "./publication";

export interface RuntimeRollout {
  projectId: string;
  appId: string;
  deploymentId: string;
}

/** The owner's row serializes competing rollouts; delayed publications are ignored. */
export const selectRuntimeDeployment = async <TResult extends PgQueryResultHKT>(
  input: RuntimeRollout,
  database: Pick<PgAsyncDatabase<TResult, typeof relations>, "transaction">
) =>
  await database.transaction(async (tx) => {
    const [owner] = await tx
      .select({ deploymentId: app.currentDeploymentId })
      .from(app)
      .where(and(eq(app.id, input.appId), eq(app.projectId, input.projectId)))
      .for("update");

    if (owner?.deploymentId !== input.deploymentId) {
      return false;
    }

    await tx
      .update(app)
      .set({ currentDeploymentId: input.deploymentId })
      .where(
        and(
          eq(app.projectId, input.projectId),
          inArray(
            app.currentDeploymentId,
            tx
              .select({ id: appDeployment.id })
              .from(appDeployment)
              .where(eq(appDeployment.appId, input.appId))
          )
        )
      );

    return true;
  });

export const listRuntimeInstallationsEffect = (
  input: RuntimeRollout,
  cursor?: string
) =>
  Effect.gen(function* listRuntimeInstallations() {
    const db = yield* PlatformDatabase;

    const rows = yield* attempt(
      async () =>
        await db
          .select({ id: app.id })
          .from(app)
          .where(
            and(
              eq(app.projectId, input.projectId),
              eq(app.currentDeploymentId, input.deploymentId),
              cursor === undefined ? undefined : gt(app.id, cursor)
            )
          )
          .orderBy(app.id)
          .limit(50)
    );

    console.info("Listed runtime installations", {
      count: rows.length,
      deploymentId: input.deploymentId,
    });

    return rows.map(({ id }) => id);
  });

export const warmRuntimeDeploymentEffect = (projectId: string, appId: string) =>
  Effect.gen(function* warmRuntimeDeployment() {
    const db = yield* PlatformDatabase;

    // Resolve each target afresh on retries; never post an older workflow's selection.
    const installation = yield* attempt(
      async () =>
        await db.query.app.findFirst({
          where: { id: appId, projectId },
          with: {
            currentDeployment: {
              where: { status: "published" },
              with: { app: { columns: { shortId: true } } },
            },
          },
        })
    );

    const deployment = installation?.currentDeployment;

    if (!installation || !deployment) {
      return;
    }

    const sourceShortId = deployment.app?.shortId;

    if (sourceShortId === undefined || sourceShortId === "") {
      // oxlint-disable-next-line typescript/consistent-return -- This failure returns never; successful warm-ups return void.
      return yield* new PlatformDependencyError({
        cause: undefined,
        message: "Deployment source missing",
      });
    }

    const project = yield* attempt(
      async () =>
        await db.query.project.findFirst({
          columns: { shortId: true },
          where: { id: projectId },
        })
    );

    if (!project) {
      return;
    }

    const file = yield* attempt(
      async () =>
        await db.query.appDeploymentFile.findFirst({
          where: {
            appDeploymentId: deployment.id,
            objectKey: `projects/${project.shortId}/apps/${sourceShortId}/deployments/${deployment.shortId}/server/server.js`,
            status: "verified",
          },
        })
    );

    if (
      file?.checksum === undefined ||
      file.checksum === null ||
      file.checksum === ""
    ) {
      return;
    }

    yield* warmRuntimeInstallationEffect(
      {
        appId,
        checksum: file.checksum,
        contentEncoding: file.encoding === "gzip" ? "gzip" : undefined,
        contentLength: file.contentLength,
        deploymentId: deployment.id,
        objectKey: file.objectKey,
        projectId,
      },
      installation.shortId
    );
    console.info("Warmed runtime installation", {
      appId,
      deploymentId: deployment.id,
    });
  });

export const listRuntimeInstallations = async (
  input: RuntimeRollout,
  cursor?: string
) => {
  "use step";

  return await runPlatform(listRuntimeInstallationsEffect(input, cursor));
};

export const warmRuntimeDeployment = async (
  projectId: string,
  appId: string
) => {
  "use step";
  await runPlatform(warmRuntimeDeploymentEffect(projectId, appId));
};

export const selectRuntimeDeploymentEffect = (input: RuntimeRollout) =>
  Effect.gen(function* selectDeployment() {
    const database = yield* PlatformDatabase;

    return yield* attempt(
      async () => await selectRuntimeDeployment(input, database)
    );
  });
