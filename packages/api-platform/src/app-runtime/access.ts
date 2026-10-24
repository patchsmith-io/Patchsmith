import { runPromise } from "@orpc/experimental-effect";
import { runtimeServiceAuthorized } from "@patchsmith/api-utils/app-auth";
import { Effect } from "effect";

import { PlatformDependencyError } from "#errors";
import { attempt } from "#services";

/** Only the trusted runtime can select projects for private bundle metadata lookups. */
export const runtimeProjectAccessEffect = (
  request: Request,
  secret: string | undefined
) =>
  Effect.gen(function* runtimeProjectAccess() {
    const authorized = yield* attempt(
      async () => await runtimeServiceAuthorized(request, secret)
    );

    if (!authorized) {
      return null;
    }

    const path = new URL(request.url).pathname;

    if (
      request.method !== "POST" ||
      !/^\/api\/platform\/apps\/[a-zA-Z0-9_-]+\/runtime\/?$/u.test(path)
    ) {
      return yield* new PlatformDependencyError({
        cause: undefined,
        message: "Runtime credential is restricted to bundle metadata",
      });
    }

    const projectId = request.headers.get("x-patchsmith-project-id");

    if (
      !(projectId !== undefined && projectId !== null && projectId !== "") ||
      projectId.length > 256
    ) {
      return yield* new PlatformDependencyError({
        cause: undefined,
        message: "Runtime project required",
      });
    }

    return projectId;
  });

export const runtimeProjectAccess = async (
  request: Request,
  secret: string | undefined
) => await runPromise(runtimeProjectAccessEffect(request, secret));
