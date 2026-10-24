import { gzipSync } from "node:zlib";

import { call } from "@orpc/server";
import { maxDeploymentBytes } from "@patchsmith/asset-delivery";
import { asyncFixture } from "@patchsmith/config/testing";
import {
  app as appTable,
  appDeployment,
  appDeploymentFile,
} from "@patchsmith/db/schema/apps";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vite-plus/test";

import type { Context } from "#context";
import { canonicalizeScope } from "#scope";
import {
  deploymentTestFixture,
  requireValue,
  describeFile,
  projectId,
  logoChecksum,
  logoChecksumBase64,
  productionScope,
} from "#test/deployments";

import { deploymentRouter } from "./deployments";

describe("platform deployments-verification", () => {
  const fixture = deploymentTestFixture();

  const {
    createLogoDeployment,
    createGzipClientDeployment,
    http,
    publishContext,
  } = fixture;

  it.each([
    { encoding: "gzip", extraBytes: 0 },
    { encoding: "gzip", extraBytes: 1 },
    { encoding: "utf-8", extraBytes: 0 },
    { encoding: "utf-8", extraBytes: 1 },
  ] as const)(
    "checks the decoded client, $encoding server, and both logos together ($extraBytes bytes over)",
    async ({ encoding, extraBytes }) => {
      const currentApp = requireValue(await fixture.db.query.app.findFirst());
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

      const files = await fixture.db.query.appDeploymentFile.findMany({
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
          await fixture.db.query.appDeployment.findFirst({
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
      const currentApp = await fixture.db.query.app.findFirst();

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

      const files = await fixture.db.query.appDeploymentFile.findMany({
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
      const source = requireValue(await fixture.db.query.app.findFirst());

      const [previous, deployment] = await fixture.db
        .insert(appDeployment)
        .values([
          { appId: source.id, status: "published" },
          { appId: source.id, status: "uploading" },
        ])
        .returning();

      if (!previous || !deployment) {
        throw new Error("Expected rollout deployments");
      }

      await fixture.db
        .update(appTable)
        .set({ currentDeploymentId: previous.id })
        .where(eq(appTable.id, source.id));

      const [installation] = await fixture.db
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

      await fixture.db.insert(appDeploymentFile).values({
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
        await fixture.db.query.app.findFirst({ where: { id: source.id } })
      ).toMatchObject({ currentDeploymentId: expected });
      expect(
        await fixture.db.query.app.findFirst({ where: { id: installation.id } })
      ).toMatchObject({ currentDeploymentId: expected });
    }
  );

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

    const deployment = await fixture.db.query.appDeployment.findFirst({
      where: { id: created.body.deployment.id },
    });

    const file = await fixture.db.query.appDeploymentFile.findFirst({
      where: { appDeploymentId: created.body.deployment.id },
    });

    const currentApp = await fixture.db.query.app.findFirst();
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

    const file = await fixture.db.query.appDeploymentFile.findFirst({
      where: { appDeploymentId: created.body.deployment.id },
    });

    expect(file?.status).toBe("verified");
    const currentApp = await fixture.db.query.app.findFirst();
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

      const file = await fixture.db.query.appDeploymentFile.findFirst({
        where: { appDeploymentId: created.body.deployment.id },
      });

      expect(file?.status).toBe("failed");
    }
  );

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

    const failed = await fixture.db.query.appDeploymentFile.findFirst({
      where: { appDeploymentId: deployment.id, status: "failed" },
    });

    if (!failed) {
      throw new Error("Missing failed verification record");
    }

    const persisted = await fixture.db.query.appDeployment.findFirst({
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
    await fixture.db.query.appDeploymentFile.findMany();

    const afterCompletion = await fixture.db.query.appDeploymentFile.findFirst({
      where: { id: failed.id },
    });

    expect(afterCompletion?.status).toBe("failed");
  });
});
