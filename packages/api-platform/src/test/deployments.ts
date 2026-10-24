import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import { call } from "@orpc/server";
import { asyncFixture } from "@patchsmith/config/testing";
import {
  app as appTable,
  appDeployment,
  appDeploymentFile,
} from "@patchsmith/db/schema/apps";
import { organization } from "@patchsmith/db/schema/auth";
import { project as projectTable } from "@patchsmith/db/schema/project";
import { Effect } from "effect";
import { afterEach, beforeEach, vi } from "vite-plus/test";

import type { Context } from "#context";
import { deploymentRouter } from "#routes/deployments";
import { canonicalizeScope } from "#scope";
import { createTestDb } from "#test/pglite";
import { testServices } from "#test/services";

export const requireValue = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) {
    throw new Error("Expected a defined value.");
  }

  return value;
};

export const describeFile = (bytes: Buffer) => ({
  checksum: createHash("sha256").update(bytes).digest("hex"),
  contentLength: bytes.byteLength,
});

export const organizationId = "11111111-1111-4111-8111-111111111111";
export const projectId = "22222222-2222-4222-8222-222222222222";
export const logoChecksum = "b".repeat(64);

export const logoChecksumBase64 = Buffer.from(logoChecksum, "hex").toString(
  "base64"
);

export const productionScope = {
  name: "environment",
  value: { environment: "production" },
};

export const deploymentTestFixture = () => {
  const http = vi.fn<typeof fetch>();
  let services: ReturnType<typeof testServices>;

  const publishContextImplementation = (downloadUrl: string): Context => ({
    ...services,
    organization: {
      createdAt: new Date(),
      id: organizationId,
      logo: null,
      metadata: null,
      name: "Analytical Engines",
      shortId: "team00000001",
      slug: "analytical-engines",
    },
    project: {
      createdAt: new Date(),
      id: projectId,
      name: "Compiler",
      organizationId,
      shortId: "proj00000001",
      slug: "compiler",
      updatedAt: new Date(),
    },
    storage: {
      createDownloadUrl: vi.fn().mockResolvedValue({ url: downloadUrl }),
      createUploadUrl: vi.fn(),
      delete: vi.fn(),
      head: vi.fn().mockResolvedValue({
        checksumSha256: logoChecksumBase64,
        contentLength: 11,
        contentType: "image/svg+xml",
      }),
      type: "s3",
    },
  });

  let client: Awaited<ReturnType<typeof createTestDb>>["client"];
  let db: Awaited<ReturnType<typeof createTestDb>>["db"];

  beforeEach(async () => {
    http.mockReset();
    const testDb = await createTestDb();
    ({ client } = testDb);
    ({ db } = testDb);
    services = testServices({
      database: db,
      fetch: http,
      runtime: { enqueueWarmup: () => Effect.void },
    });

    await db.insert(organization).values({
      createdAt: new Date(),
      id: organizationId,
      name: "Analytical Engines",
      shortId: "team00000001",
      slug: "analytical-engines",
    });
    await db.insert(projectTable).values({
      createdAt: new Date(),
      id: projectId,
      name: "Compiler",
      organizationId,
      slug: "compiler",
      updatedAt: new Date(),
    });
    await db.insert(appTable).values({
      name: "Inbox",
      projectId,
      shortId: "app000000001",
      ...canonicalizeScope(productionScope),
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    await client.close();
    vi.restoreAllMocks();
  });

  const createLogoDeployment = async () => {
    const currentApp = await db.query.app.findFirst();

    if (!currentApp) {
      throw new Error("Test app was not created.");
    }

    const [deployment] = await db
      .insert(appDeployment)
      .values({
        appId: currentApp.id,
        shortId: "dep000000001",
        status: "uploading",
      })
      .returning();

    if (!deployment) {
      throw new Error("Test deployment was not created.");
    }

    await db.insert(appDeploymentFile).values({
      appDeploymentId: deployment.id,
      checksum: logoChecksum,
      contentLength: 11,
      contentType: "image/svg+xml",
      encoding: null,
      objectKey: "projects/proj00000001/apps/app000000001/logos/legacy.svg",
    });

    return deployment;
  };

  const publishContext = publishContextImplementation;

  const createGzipClientDeployment = async (decoded: Uint8Array) => {
    const bytes = gzipSync(decoded);
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const context = publishContext("https://uploads.example/client.js");
    context.storage.createUploadUrl = vi.fn<
      typeof context.storage.createUploadUrl
    >(
      asyncFixture(({ key }) => ({
        key,
        uploadUrl: `https://uploads.example/${key}`,
      }))
    );
    context.storage.head = vi.fn<typeof context.storage.head>(
      asyncFixture(({ key }) => ({
        checksumSha256: Buffer.from(checksum, "hex").toString("base64"),
        contentEncoding: "gzip",
        contentLength: bytes.byteLength,
        contentType: "application/javascript",
        key,
      }))
    );
    const currentApp = await db.query.app.findFirst();

    if (!currentApp) {
      throw new Error("Missing app");
    }

    const created = await call(
      deploymentRouter.create,
      {
        body: {
          app: { id: currentApp.id },
          assets: [
            {
              checksum,
              contentLength: bytes.byteLength,
              contentType: "application/javascript",
              encoding: "gzip",
              objectKey: "client.js",
            },
          ],
          scope: productionScope,
        },
      },
      { context }
    );

    return { context, created };
  };

  return {
    createGzipClientDeployment,
    createLogoDeployment,
    get db() {
      return db;
    },
    http,
    publishContext,
    get services() {
      return services;
    },
  };
};
