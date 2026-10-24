import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import { call } from "@orpc/server";
import { maxDeploymentBytes } from "@patchsmith/asset-delivery";
import { asyncFixture } from "@patchsmith/config/testing";
import {
  app as appTable,
  appDeployment,
  appDeploymentFile,
} from "@patchsmith/db/schema/apps";
import { organization } from "@patchsmith/db/schema/auth";
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

import type { Context } from "#context";
import { createTestDb } from "#test/pglite";
import { testServices } from "#test/services";

const requireValue = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) {
    throw new Error("Expected a defined value.");
  }

  return value;
};

const { deploymentRouter, mapReturnedFilesByAssetPath } =
  await import("./deployments");

const { canonicalizeScope } = await import("#scope");

const describeFile = (bytes: Buffer) => ({
  checksum: createHash("sha256").update(bytes).digest("hex"),
  contentLength: bytes.byteLength,
});

const organizationId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const logoChecksum = "b".repeat(64);
const logoChecksumBase64 = Buffer.from(logoChecksum, "hex").toString("base64");

const productionScope = {
  name: "environment",
  value: { environment: "production" },
};

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

describe("platform deployment uploads", () => {
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

  it.each([0, 1])(
    "checks the combined upload budget with %i bytes over the limit",
    async (extraBytes) => {
      const currentApp = requireValue(await db.query.app.findFirst());
      const context = publishContext("https://uploads.example/bundle");
      context.storage.createUploadUrl = vi.fn<
        typeof context.storage.createUploadUrl
      >(
        asyncFixture(({ key }) => ({
          key,
          uploadUrl: `https://uploads.example/${key}`,
        }))
      );

      const metadata = {
        checksum: "a".repeat(64),
        contentType: "application/javascript" as const,
        encoding: "utf-8" as const,
      };

      const logo = {
        checksum: logoChecksum,
        contentLength: 11,
        contentType: "image/svg+xml" as const,
      };

      const create = call(
        deploymentRouter.create,
        {
          body: {
            app: { id: currentApp.id },
            assets: [
              {
                ...metadata,
                contentLength: 6 * 1024 * 1024,
                objectKey: "client.js",
              },
            ],
            logos: { dark: logo, light: logo },
            scope: productionScope,
            server: {
              ...metadata,
              contentLength: 4 * 1024 * 1024 - 22 + extraBytes,
              objectKey: "server.js",
            },
          },
        },
        { context }
      );

      if (extraBytes > 0) {
        await expect(create).rejects.toThrow("Input validation failed");
        expect(context.storage.createUploadUrl).not.toHaveBeenCalled();

        return;
      }

      await expect(create).resolves.toMatchObject({
        body: { deployment: { status: "uploading" } },
      });
    }
  );

  it.each([
    { encoding: "gzip", extraBytes: 0 },
    { encoding: "gzip", extraBytes: 1 },
    { encoding: "utf-8", extraBytes: 0 },
    { encoding: "utf-8", extraBytes: 1 },
  ] as const)(
    "checks the decoded client, $encoding server, and both logos together ($extraBytes bytes over)",
    async ({ encoding, extraBytes }) => {
      const currentApp = requireValue(await db.query.app.findFirst());
      const logo = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
      const clientBundle = Buffer.alloc(6 * 1024 * 1024, 120);

      const server = Buffer.alloc(
        maxDeploymentBytes -
          clientBundle.byteLength -
          2 * logo.byteLength +
          extraBytes,
        121
      );

      const uploadedClient = gzipSync(clientBundle);
      const uploadedServer = encoding === "gzip" ? gzipSync(server) : server;
      const context = publishContext("https://uploads.example/bundle");
      context.storage.createUploadUrl = vi.fn<
        typeof context.storage.createUploadUrl
      >(
        asyncFixture(({ key }) => ({
          key,
          uploadUrl: `https://uploads.example/${key}`,
        }))
      );

      const logoMetadata = {
        ...describeFile(logo),
        contentType: "image/svg+xml" as const,
      };

      const created = await call(
        deploymentRouter.create,
        {
          body: {
            app: { id: currentApp.id },
            assets: [
              {
                ...describeFile(uploadedClient),
                contentType: "application/javascript",
                encoding: "gzip",
                objectKey: "client.js",
              },
            ],
            logos: { dark: logoMetadata, light: logoMetadata },
            scope: productionScope,
            server: {
              ...describeFile(uploadedServer),
              contentType: "application/javascript",
              encoding,
              objectKey: "server.js",
            },
          },
        },
        { context }
      );

      const files = await db.query.appDeploymentFile.findMany({
        where: { appDeploymentId: created.body.deployment.id },
      });

      context.storage.head = vi.fn<typeof context.storage.head>(
        asyncFixture(({ key }) => {
          const file = requireValue(
            files.find((entry) => entry.objectKey === key)
          );

          return {
            checksumSha256: Buffer.from(
              requireValue(file.checksum),
              "hex"
            ).toString("base64"),
            contentEncoding: file.encoding === "gzip" ? "gzip" : undefined,
            contentLength: file.contentLength,
            contentType: file.contentType,
            key,
          };
        })
      );
      context.storage.createDownloadUrl = vi.fn<
        typeof context.storage.createDownloadUrl
      >(
        asyncFixture(({ key }) => ({
          key,
          url: `https://uploads.example/${key}`,
        }))
      );

      const fetchMock = http.mockImplementation(
        asyncFixture((input) => {
          const url = input instanceof Request ? input.url : String(input);

          if (url.endsWith("/client.js")) {
            return new Response(clientBundle);
          }

          if (url.endsWith("/server.js")) {
            return new Response(server);
          }

          return new Response(logo);
        })
      );

      const publish = call(
        deploymentRouter.publish,
        {
          body: { rollout: false, scope: productionScope },
          params: { deploymentId: created.body.deployment.id },
        },
        { context }
      );

      if (extraBytes > 0) {
        await expect(publish).rejects.toThrow(
          `Combined deployment assets cannot exceed ${maxDeploymentBytes} bytes after decompression.`
        );
        expect(
          await db.query.appDeployment.findFirst({
            where: { id: created.body.deployment.id },
          })
        ).toMatchObject({ status: "uploading" });

        return;
      }

      await expect(publish).resolves.toMatchObject({
        body: { status: "published" },
      });
      expect(fetchMock).toHaveBeenCalledTimes(encoding === "gzip" ? 3 : 2);
    }
  );

  it("hides a deployment when its app has a malformed stored scope", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const deployment = await createLogoDeployment();
    await db
      .update(appTable)
      .set({ scope: { name: "environment", value: {} } })
      .where(eq(appTable.id, deployment.appId));
    await expect(
      call(
        deploymentRouter.get,
        {
          body: { scopes: [productionScope] },
          params: { deploymentId: deployment.id },
        },
        { context: publishContext("https://uploads.example/logo-dark.svg") }
      )
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(warn).toHaveBeenCalledWith(
      "Deployment app has an invalid stored scope.",
      expect.objectContaining({
        appId: deployment.appId,
        deploymentId: deployment.id,
      })
    );
  });

  it("hides a deployment when its stored scope key does not match its scope", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const deployment = await createLogoDeployment();
    await db
      .update(appTable)
      .set({ scopeKey: "0".repeat(32) })
      .where(eq(appTable.id, deployment.appId));

    await expect(
      call(
        deploymentRouter.get,
        {
          body: { scopes: [productionScope] },
          params: { deploymentId: deployment.id },
        },
        { context: publishContext("https://uploads.example/logo-dark.svg") }
      )
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(warn).toHaveBeenCalledWith(
      "Deployment app has an invalid stored scope.",
      expect.objectContaining({
        appId: deployment.appId,
        deploymentId: deployment.id,
      })
    );
  });

  it.each(["utf-8", "gzip"] as const)(
    "uploads and verifies %s client and private server code",
    async (encoding) => {
      const context = publishContext("https://private.example/server");

      const uploads = vi.fn(
        asyncFixture(({ key }: { key: string }) => ({
          key,
          uploadUrl: `https://uploads.example/${key}`,
        }))
      );

      context.storage.createUploadUrl = uploads;
      const currentApp = await db.query.app.findFirst();

      if (!currentApp) {
        throw new Error("Missing app");
      }

      const metadata = {
        checksum: logoChecksum,
        contentLength: 11,
        contentType: "application/javascript" as const,
        encoding,
      };

      const created = await call(
        deploymentRouter.create,
        {
          body: {
            app: { id: currentApp.id },
            assets: [{ ...metadata, objectKey: "client.js" }],
            hooks: ["sync", "billing.updated"],
            scope: productionScope,
            server: { ...metadata, objectKey: "server.js" },
            views: [
              { instances: true, path: "/", slot: "page" },
              { disabled: true, path: "/disabled", slot: "page" },
            ],
          },
        },
        { context }
      );

      expect(created.body.assets[0]?.file.objectKey).toMatch(
        /\/client\/client\.js$/u
      );
      expect(created.body.server?.file.objectKey).toMatch(
        /\/server\/server\.js$/u
      );
      expect(created.body.deployment.hooks).toEqual([
        "sync",
        "billing.updated",
      ]);
      expect(created.body.deployment.views).toEqual([
        { instances: true, path: "/", slot: "page" },
        { disabled: true, path: "/disabled", slot: "page" },
      ]);
      expect(uploads).toHaveBeenCalledTimes(2);
      expect(uploads).toHaveBeenCalledWith(
        expect.objectContaining({
          contentEncoding: encoding === "gzip" ? "gzip" : undefined,
          key: created.body.assets[0]?.file.objectKey,
        })
      );
      expect(uploads).toHaveBeenCalledWith(
        expect.objectContaining({
          contentEncoding: encoding === "gzip" ? "gzip" : undefined,
          key: created.body.server?.file.objectKey,
        })
      );
      await expect(
        call(
          deploymentRouter.runtime,
          { body: {}, params: { appId: currentApp.id } },
          { context: { ...context, runtimeService: true } }
        )
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(context.storage.createDownloadUrl).not.toHaveBeenCalled();
      context.storage.head = vi.fn().mockResolvedValue({
        checksumSha256: logoChecksumBase64,
        contentEncoding: encoding === "gzip" ? "gzip" : undefined,
        contentLength: 11,
        contentType: "application/javascript",
      });

      if (encoding === "gzip") {
        vi.mocked(context.storage.head).mockResolvedValueOnce({
          checksumSha256: logoChecksumBase64,
          contentLength: 11,
          contentType: "application/javascript",
          key: requireValue(created.body.assets[0]).file.objectKey,
        });
        await expect(
          call(
            deploymentRouter.publish,
            {
              body: { rollout: true, scope: productionScope },
              params: { deploymentId: created.body.deployment.id },
            },
            { context }
          )
        ).rejects.toThrow(
          "Uploaded file content encoding does not match deployment record."
        );
      }

      const fetchMock = http.mockImplementation(
        asyncFixture(() => new Response("client-code"))
      );

      const published = await call(
        deploymentRouter.publish,
        {
          body: { rollout: true, scope: productionScope },
          params: { deploymentId: created.body.deployment.id },
        },
        { context }
      );

      expect(published.body.hooks).toEqual(["sync", "billing.updated"]);
      await expect(
        call(
          deploymentRouter.runtime,
          { body: {}, params: { appId: currentApp.id } },
          { context }
        )
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      const runtime = await call(
        deploymentRouter.runtime,
        { body: {}, params: { appId: currentApp.id } },
        { context: { ...context, runtimeService: true } }
      );

      await expect(
        call(
          deploymentRouter.runtime,
          { body: {}, params: { appId: currentApp.id } },
          {
            context: {
              ...context,
              project: {
                ...context.project,
                id: "33333333-3333-4333-8333-333333333333",
              },
              runtimeService: true,
            },
          }
        )
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(runtime.body).toEqual(
        encoding === "gzip"
          ? {
              appId: currentApp.id,
              checksum: logoChecksum,
              contentEncoding: "gzip",
              contentLength: 11,
              deploymentId: created.body.deployment.id,
              objectKey: created.body.server?.file.objectKey,
              projectId: context.project.id,
            }
          : {
              appId: currentApp.id,
              checksum: logoChecksum,
              contentLength: 11,
              deploymentId: created.body.deployment.id,
              objectKey: created.body.server?.file.objectKey,
              projectId: context.project.id,
            }
      );

      if (encoding === "gzip") {
        expect(context.storage.createDownloadUrl).toHaveBeenCalledTimes(2);
        expect(context.storage.createDownloadUrl).toHaveBeenCalledWith({
          expiresInSeconds: 60,
          key: requireValue(created.body.assets[0]).file.objectKey,
        });
        expect(context.storage.createDownloadUrl).toHaveBeenCalledWith({
          expiresInSeconds: 60,
          key: requireValue(created.body.server).file.objectKey,
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
      } else {
        expect(context.storage.createDownloadUrl).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
      }

      const files = await db.query.appDeploymentFile.findMany({
        where: { appDeploymentId: created.body.deployment.id },
      });

      expect(files).toHaveLength(2);
      expect(files.every((file) => file.status === "verified")).toBe(true);
    }
  );

  it.each([true, false])(
    "advances installations for client-only publication only with rollout enabled (%s)",
    async (rollout) => {
      const context = publishContext("https://uploads.example/client.js");
      const source = requireValue(await db.query.app.findFirst());

      const [previous, deployment] = await db
        .insert(appDeployment)
        .values([
          { appId: source.id, status: "published" },
          { appId: source.id, status: "uploading" },
        ])
        .returning();

      if (!previous || !deployment) {
        throw new Error("Expected rollout deployments");
      }

      await db
        .update(appTable)
        .set({ currentDeploymentId: previous.id })
        .where(eq(appTable.id, source.id));

      const [installation] = await db
        .insert(appTable)
        .values({
          currentDeploymentId: previous.id,
          name: "Installed Inbox",
          projectId,
          ...canonicalizeScope({
            name: "environment",
            value: { environment: "staging" },
          }),
        })
        .returning();

      if (!installation) {
        throw new Error("Expected rollout installation");
      }

      await db.insert(appDeploymentFile).values({
        appDeploymentId: deployment.id,
        checksum: logoChecksum,
        contentLength: 11,
        contentType: "application/javascript",
        objectKey: `projects/${context.project.shortId}/apps/${source.shortId}/deployments/${deployment.shortId}/client/client.js`,
      });
      context.storage.head = vi.fn().mockResolvedValue({
        checksumSha256: logoChecksumBase64,
        contentLength: 11,
        contentType: "application/javascript",
      });

      await call(
        deploymentRouter.publish,
        {
          body: { rollout, scope: productionScope },
          params: { deploymentId: deployment.id },
        },
        { context }
      );

      const expected = rollout ? deployment.id : previous.id;

      expect(
        await db.query.app.findFirst({ where: { id: source.id } })
      ).toMatchObject({ currentDeploymentId: expected });
      expect(
        await db.query.app.findFirst({ where: { id: installation.id } })
      ).toMatchObject({ currentDeploymentId: expected });
    }
  );

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

  it("rejects oversized inflated client code before publication and cancels the decoded stream", async () => {
    const decoded = new Uint8Array(maxDeploymentBytes + 1);
    const { context, created } = await createGzipClientDeployment(decoded);
    const cancel = vi.fn();
    let position = 0;

    const chunks = [
      decoded.subarray(0, maxDeploymentBytes),
      decoded.subarray(maxDeploymentBytes),
      new Uint8Array(1),
    ];

    const body = new ReadableStream<Uint8Array>(
      {
        cancel,
        pull(controller) {
          controller.enqueue(requireValue(chunks[(position += 1) - 1]));
        },
      },
      { highWaterMark: 0 }
    );

    const fetchMock = http.mockResolvedValue(
      new Response(body, { headers: { "Content-Encoding": "gzip" } })
    );

    await expect(
      call(
        deploymentRouter.publish,
        {
          body: { rollout: true, scope: productionScope },
          params: { deploymentId: created.body.deployment.id },
        },
        { context }
      )
    ).rejects.toThrow(
      `Combined deployment assets cannot exceed ${maxDeploymentBytes} bytes after decompression.`
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(position).toBe(2);
    const expectedSignalMatcher1: unknown = expect.any(AbortSignal);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://uploads.example/client.js"),
      expect.objectContaining({
        redirect: "error",
        signal: expectedSignalMatcher1,
      })
    );

    const deployment = await db.query.appDeployment.findFirst({
      where: { id: created.body.deployment.id },
    });

    const file = await db.query.appDeploymentFile.findFirst({
      where: { appDeploymentId: created.body.deployment.id },
    });

    const currentApp = await db.query.app.findFirst();
    expect(deployment?.status).toBe("uploading");
    expect(file?.status).toBe("failed");
    expect(currentApp?.currentDeploymentId).toBeNull();
  });

  it("publishes gzip client code whose decoded size is exactly 10 MiB", async () => {
    const decoded = new Uint8Array(maxDeploymentBytes);
    const { context, created } = await createGzipClientDeployment(decoded);
    http.mockResolvedValue(
      new Response(decoded, { headers: { "Content-Encoding": "gzip" } })
    );

    const published = await call(
      deploymentRouter.publish,
      {
        body: { rollout: true, scope: productionScope },
        params: { deploymentId: created.body.deployment.id },
      },
      { context }
    );

    expect(published.body.status).toBe("published");

    const file = await db.query.appDeploymentFile.findFirst({
      where: { appDeploymentId: created.body.deployment.id },
    });

    expect(file?.status).toBe("verified");
    const currentApp = await db.query.app.findFirst();
    expect(currentApp?.currentDeploymentId).toBe(published.body.id);
  });

  it.each(["stream-error", "missing-body", "upstream-failure"])(
    "rejects gzip client inspection with %s",
    async (failure) => {
      const { context, created } = await createGzipClientDeployment(
        new TextEncoder().encode("client-code")
      );

      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error("Invalid gzip"));
        },
      });

      const response =
        failure === "stream-error"
          ? new Response(body)
          : new Response(null, {
              status: failure === "upstream-failure" ? 503 : 200,
            });

      http.mockResolvedValue(response);
      await expect(
        call(
          deploymentRouter.publish,
          {
            body: { rollout: true, scope: productionScope },
            params: { deploymentId: created.body.deployment.id },
          },
          { context }
        )
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });

      const file = await db.query.appDeploymentFile.findFirst({
        where: { appDeploymentId: created.body.deployment.id },
      });

      expect(file?.status).toBe("failed");
    }
  );

  it("maps reordered returned files using their generated file IDs", () => {
    const assets = [
      { asset: { objectKey: "client.js" }, fileId: "client-file-id" },
      {
        asset: { objectKey: `logos/${logoChecksum}.svg` },
        fileId: "logo-file-id",
      },
    ];

    const returnedFiles = [
      { id: "logo-file-id", objectKey: "stored-logo" },
      { id: "client-file-id", objectKey: "stored-client" },
    ];

    const filesByAssetPath = mapReturnedFilesByAssetPath(assets, returnedFiles);

    expect(filesByAssetPath.get("client.js")?.id).toBe("client-file-id");
    expect(filesByAssetPath.get(`logos/${logoChecksum}.svg`)?.id).toBe(
      "logo-file-id"
    );
  });

  it("creates optional logo assets alongside the client bundle", async () => {
    const createUploadUrl = vi.fn(
      asyncFixture(({ key }: { key: string }) => ({
        key,
        uploadUrl: `https://uploads.example/${key}`,
      }))
    );

    const context = {
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
        createDownloadUrl: vi.fn(),
        createUploadUrl,
        delete: vi.fn(),
        head: vi.fn().mockRejectedValue({ name: "NoSuchKey" }),
        type: "s3",
      },
    } satisfies Context;

    const app = await db.query.app.findFirst();

    if (!app) {
      throw new Error("Test app was not created.");
    }

    const result = await call(
      deploymentRouter.create,
      {
        body: {
          app: { id: app.id },
          assets: [
            {
              checksum: "a".repeat(64),
              contentLength: maxDeploymentBytes - 2 * 262_144,
              contentType: "application/javascript",
              encoding: "utf-8",
              objectKey: "client.js",
            },
          ],
          logos: {
            dark: {
              checksum: "b".repeat(64),
              contentLength: 262_144,
              contentType: "image/svg+xml",
            },
            light: {
              checksum: "b".repeat(64),
              contentLength: 262_144,
              contentType: "image/svg+xml",
            },
          },
          scope: productionScope,
        },
      },
      { context }
    );

    expect(result.body.assets).toHaveLength(1);
    expect(result.body.logos?.dark?.file.objectKey).toMatch(
      new RegExp(`/logos/${"b".repeat(64)}\\.svg$`, "u")
    );
    expect(result.body.logos?.light?.file.id).toBe(
      result.body.logos?.dark?.file.id
    );
    const publishedDeployment = result.body.deployment;
    expect(publishedDeployment).toMatchObject({
      logoDarkPath: `logos/${"b".repeat(64)}.svg`,
      logoLightPath: `logos/${"b".repeat(64)}.svg`,
    });
    expect(publishedDeployment.clientEntryFileId).toBeTypeOf("string");
    expect(publishedDeployment.logoDarkFileId).toBeTypeOf("string");
    expect(publishedDeployment.logoLightFileId).toBeTypeOf("string");
    expect(createUploadUrl).toHaveBeenCalledTimes(2);
  });

  it("reuses a matching app logo without creating another upload URL", async () => {
    const createUploadUrl = vi.fn(
      asyncFixture(({ key }: { key: string }) => ({
        key,
        uploadUrl: `https://uploads.example/${key}`,
      }))
    );

    const context = {
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
        createDownloadUrl: vi.fn(),
        createUploadUrl,
        delete: vi.fn(),
        head: vi.fn().mockResolvedValue({
          checksumSha256: logoChecksumBase64,
          contentLength: 262_144,
          contentType: "image/svg+xml",
        }),
        type: "s3",
      },
    } satisfies Context;

    const currentApp = await db.query.app.findFirst();

    if (!currentApp) {
      throw new Error("Test app was not created.");
    }

    const result = await call(
      deploymentRouter.create,
      {
        body: {
          app: { id: currentApp.id },
          assets: [
            {
              checksum: "a".repeat(64),
              contentLength: 1,
              contentType: "application/javascript",
              encoding: "utf-8",
              objectKey: "client.js",
            },
          ],
          logos: {
            dark: {
              checksum: logoChecksum,
              contentLength: 262_144,
              contentType: "image/svg+xml",
            },
          },
          scope: productionScope,
        },
      },
      { context }
    );

    expect(result.body.logos?.dark?.uploadUrl).toBeUndefined();
    expect(createUploadUrl).toHaveBeenCalledTimes(1);
    expect(context.storage.head).toHaveBeenCalledWith({
      key: `projects/proj00000001/apps/app000000001/logos/${logoChecksum}.svg`,
    });
  });

  it("rejects the client assets array when it exceeds 10 MiB", async () => {
    const createUploadUrl = vi.fn();

    const context = {
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
        createDownloadUrl: vi.fn(),
        createUploadUrl,
        delete: vi.fn(),
        head: vi.fn(),
        type: "s3",
      },
    } satisfies Context;

    const app = await db.query.app.findFirst();

    if (!app) {
      throw new Error("Test app was not created.");
    }

    await expect(
      call(
        deploymentRouter.create,
        {
          body: {
            app: { id: app.id },
            assets: [
              {
                checksum: "a".repeat(64),
                contentLength: maxDeploymentBytes + 1,
                contentType: "application/javascript",
                encoding: "utf-8",
                objectKey: "client.js",
              },
            ],
            scope: productionScope,
          },
        },
        { context }
      )
    ).rejects.toThrow("Input validation failed");
    expect(createUploadUrl).not.toHaveBeenCalled();
  });

  it("rejects non-HTTPS logo inspection URLs before fetching", async () => {
    const deployment = await createLogoDeployment();
    const fetchMock = vi.fn();
    http.mockImplementation(fetchMock);

    await expect(
      call(
        deploymentRouter.publish,
        {
          body: { rollout: true, scope: productionScope },
          params: { deploymentId: deployment.id },
        },
        { context: publishContext("http://uploads.example/logo-dark.svg") }
      )
    ).rejects.toThrow("Logo download URL must use HTTPS.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts logo inspection while reading the response body", async () => {
    const deployment = await createLogoDeployment();
    vi.useFakeTimers();
    http.mockImplementation(
      async (_input, init) =>
        await Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                init?.signal?.addEventListener(
                  "abort",
                  () => {
                    controller.error(new DOMException("Aborted", "AbortError"));
                  },
                  { once: true }
                );
              },
            })
          )
        )
    );

    const publish = call(
      deploymentRouter.publish,
      {
        body: { rollout: true, scope: productionScope },
        params: { deploymentId: deployment.id },
      },
      { context: publishContext("https://uploads.example/logo-dark.svg") }
    );

    const advanceTimers = vi.advanceTimersByTimeAsync(10_000);
    await expect(publish).rejects.toThrow("Aborted");
    await advanceTimers;
  });
  it("restores retryable state on cancellation and ignores late storage completion", async () => {
    const deployment = await createLogoDeployment();
    const waiting = Promise.withResolvers<boolean>();

    const released =
      Promise.withResolvers<Awaited<ReturnType<Context["storage"]["head"]>>>();

    const context = publishContext("https://uploads.example/logo.svg");
    context.storage.head = vi.fn(async () => {
      waiting.resolve(true);

      return await released.promise;
    });
    const controller = new AbortController();

    const publication = call(
      deploymentRouter.publish,
      {
        body: { rollout: true, scope: productionScope },
        params: { deploymentId: deployment.id },
      },
      { context, signal: controller.signal }
    );

    const completed = expect(publication).rejects.toBeDefined();
    await waiting.promise;
    controller.abort(new Error("Request cancelled"));
    await completed;

    const failed = await db.query.appDeploymentFile.findFirst({
      where: { appDeploymentId: deployment.id, status: "failed" },
    });

    if (!failed) {
      throw new Error("Missing failed verification record");
    }

    const persisted = await db.query.appDeployment.findFirst({
      where: { id: deployment.id },
    });

    expect(persisted?.status).toBe("uploading");
    released.resolve({
      checksumSha256: logoChecksumBase64,
      contentLength: 11,
      contentType: "image/svg+xml",
      key: "late-storage-completion",
    });
    // A database read queues behind any accidental write after the released storage promise.
    await db.query.appDeploymentFile.findMany();

    const afterCompletion = await db.query.appDeploymentFile.findFirst({
      where: { id: failed.id },
    });

    expect(afterCompletion?.status).toBe("failed");
  });
});
