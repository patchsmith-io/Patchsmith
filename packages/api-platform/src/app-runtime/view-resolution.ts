import { ORPCError, RPCJsonSerializer } from "@orpc/server";
import type { RPCJsonSerializationMeta } from "@orpc/server";
import type { ViewInstance } from "@patchsmith/app/client";
import { createClient, reference } from "@patchsmith/app/client/connection";
import type { Session } from "@patchsmith/app/client/connection";
import { Effect } from "effect";
import { z } from "zod";

const viewPath = z.string().startsWith("/").max(1024);
const contextValues = z.record(z.string(), z.unknown());
const contextSerializer = new RPCJsonSerializer();
const contextSegment = z.union([z.string(), z.number()]);

export const runtimeViewContexts = z
  .array(
    z.discriminatedUnion("status", [
      z.strictObject({
        context: contextValues,
        contextBlobs: z
          .array(
            z.object({
              data: z.string(),
              lastModified: z.number().optional(),
              name: z.string().optional(),
              type: z.string(),
            })
          )
          .optional(),
        contextMaps: z.array(z.array(contextSegment)).optional(),
        contextMeta: z
          .array(z.object({ path: z.array(contextSegment), type: z.string() }))
          .optional(),
        path: viewPath,
        status: z.literal("ready"),
      }),
      z.strictObject({
        path: viewPath,
        status: z.enum(["loading", "error"]),
      }),
    ])
  )
  .refine(
    (views) => new Set(views.map((view) => view.path)).size === views.length,
    "View contexts must have unique paths."
  );

export const runtimeViewWarning = z.object({
  appId: z.string(),
  code: z.literal("INSTANCE_RESOLUTION_TIMEOUT"),
  message: z.literal("View resolution timed out"),
  path: viewPath,
});

const instancesSchema = z
  .array(
    z.object({
      data: z.unknown(),
      key: z.string().min(1),
      metadata: z.record(z.string(), z.unknown()),
    })
  )
  .refine(
    (instances) =>
      new Set(instances.map((instance) => instance.key)).size ===
      instances.length,
    "Instance keys must be unique."
  );

interface RuntimeInstallation {
  id: string;
  views: {
    slot: string;
    path: string;
    instances?: true;
    staticInstances?: ViewInstance[];
    disabled?: true;
  }[];
}

const resolver = reference<
  "action",
  {
    slot: string;
    path: string;
    context: Extract<
      z.infer<typeof runtimeViewContexts>[number],
      { status: "ready" }
    >["context"];
  },
  ViewInstance[]
>("_patchsmith.instances.resolve", "action");

/** Shared wall-clock budget for session issuance and all concurrent instance calls. */
export const instanceResolutionTimeoutMs = 1000;

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Promise rejection reasons are untyped at the backend transport boundary.
const resolutionFailure = (cause: unknown) =>
  new ORPCError("BAD_GATEWAY", {
    cause,
    message: "Unable to resolve views",
  });

/** Only the platform calls app backends; the host supplies validated view contexts. */
export const resolveRuntimeViews = <TApp extends RuntimeInstallation>(
  apps: TApp[],
  input: { slot: string; contexts: z.infer<typeof runtimeViewContexts> },
  options: {
    createSession: (app: TApp) => Promise<Session>;
    fetch?: typeof fetch;
  }
) =>
  Effect.suspend(() => {
    const pending = new Map<string, string>();

    const completed = new Map<
      string,
      (z.infer<typeof instancesSchema>[number] & { app: TApp })[]
    >();

    return Effect.gen(function* resolveViews() {
      const contexts = input.contexts.toSorted(
        (left, right) =>
          right.path.split("/").filter(Boolean).length -
          left.path.split("/").filter(Boolean).length
      );

      const selected = apps.flatMap((app) => {
        const context = contexts.find((candidate) =>
          app.views.some(
            (view) =>
              view.slot === input.slot &&
              view.path === candidate.path &&
              !view.disabled
          )
        );

        const view = app.views.find(
          (candidate) =>
            candidate.slot === input.slot &&
            candidate.path === context?.path &&
            !candidate.disabled
        );

        return context && view?.instances ? [{ app, context, view }] : [];
      });

      if (selected.some(({ context }) => context.status === "error")) {
        return yield* Effect.fail(
          new ORPCError("BAD_REQUEST", { message: "Invalid view context" })
        );
      }

      if (selected.some(({ context }) => context.status === "loading")) {
        return { status: "loading" as const };
      }

      const decodedContexts = new Map<string, z.infer<typeof contextValues>>();

      const resolved = yield* Effect.try({
        catch: () =>
          new ORPCError("BAD_REQUEST", { message: "Invalid view context" }),
        try: () =>
          selected.flatMap(({ app, context, view }) => {
            if (context.status !== "ready") {
              return [];
            }

            const cached = decodedContexts.get(context.path);

            if (cached !== undefined) {
              return [
                {
                  app,
                  context: cached,
                  path: context.path,
                  staticInstances: view.staticInstances,
                },
              ];
            }

            const blobs = context.contextBlobs?.map((blob) => {
              const bytes = Uint8Array.from(
                atob(blob.data),
                (character) => character.codePointAt(0) ?? 0
              );

              return blob.name === undefined
                ? new Blob([bytes], { type: blob.type })
                : new File([bytes], blob.name, {
                    lastModified: blob.lastModified,
                    type: blob.type,
                  });
            });

            if ((context.contextMaps?.length ?? 0) !== (blobs?.length ?? 0)) {
              throw new Error("Invalid binary context metadata");
            }

            const json = structuredClone(context.context);

            const meta = context.contextMeta?.map<RPCJsonSerializationMeta>(
              ({ type, path }) => [type, ...path]
            );

            const serialized =
              context.contextMaps === undefined
                ? { json, meta }
                : {
                    blobs: blobs ?? [],
                    json,
                    maps: context.contextMaps,
                    meta,
                  };

            const decoded = contextValues.parse(
              contextSerializer.deserialize(serialized)
            );

            decodedContexts.set(context.path, decoded);

            return [
              {
                app,
                context: decoded,
                path: context.path,
                staticInstances: view.staticInstances,
              },
            ];
          }),
      });

      for (const { app, path, staticInstances } of resolved) {
        if (staticInstances === undefined) {
          pending.set(app.id, path);
          continue;
        }

        const entries = yield* Effect.try({
          catch: resolutionFailure,
          try: () => instancesSchema.parse(staticInstances),
        });

        completed.set(
          app.id,
          entries.map((instance) => ({ ...instance, app }))
        );
      }

      const instances = yield* Effect.forEach(
        resolved,
        ({ app, context, path }) => {
          const snapshot = completed.get(app.id);

          if (snapshot !== undefined) {
            return Effect.succeed(snapshot);
          }

          return Effect.gen(function* resolveInstallation() {
            const session = yield* Effect.tryPromise({
              catch: resolutionFailure,
              try: async () => await options.createSession(app),
            });

            return yield* Effect.acquireUseRelease(
              Effect.sync(() =>
                createClient({
                  fetch: options.fetch,
                  // oxlint-disable-next-line require-await -- The platform has already issued this request's authorized session.
                  getSession: async () => session,
                })
              ),
              (backend) =>
                Effect.tryPromise({
                  catch: resolutionFailure,
                  try: async () => {
                    const result = instancesSchema.parse(
                      await backend.action(resolver, {
                        context,
                        path,
                        slot: input.slot,
                      })
                    );

                    return result.map((instance) => ({ ...instance, app }));
                  },
                }),
              (backend) =>
                Effect.sync(() => {
                  backend.close();
                })
            ).pipe(
              Effect.tap((appInstances) =>
                Effect.sync(() => {
                  completed.set(app.id, appInstances);
                  pending.delete(app.id);
                })
              )
            );
          });
        },
        { concurrency: "unbounded" }
      );

      return { data: instances.flat(), status: "ready" as const, warnings: [] };
    }).pipe(
      Effect.timeoutOrElse({
        duration: instanceResolutionTimeoutMs,
        orElse: () =>
          completed.size > 0
            ? Effect.succeed({
                data: apps.flatMap((app) => completed.get(app.id) ?? []),
                status: "ready" as const,
                warnings: [...pending].map(([appId, path]) => ({
                  appId,
                  code: "INSTANCE_RESOLUTION_TIMEOUT" as const,
                  message: "View resolution timed out" as const,
                  path,
                })),
              })
            : Effect.fail(
                new ORPCError("GATEWAY_TIMEOUT", {
                  message: "View resolution timed out",
                })
              ),
      })
    );
  });
