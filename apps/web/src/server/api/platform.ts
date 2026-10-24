import {
  createContext,
  contextErrorResponse,
} from "@patchsmith/api-platform/context";
import {
  initializeObservability,
  recordException,
  sanitizeErrorForLog,
  setSpanAttributes,
} from "@patchsmith/observability";

import { createApiEntry } from "./entry";

const createOpenAPIHandler = async () => {
  const [
    { OpenAPIHandler },
    { onError },
    { platformRouter },
    { RateLimitHandlerPlugin },
  ] = await Promise.all([
    import("@orpc/openapi/fetch"),
    import("@orpc/server"),
    import("@patchsmith/api-platform"),
    import("@patchsmith/api-utils/rate-limiting"),
  ]);

  return new OpenAPIHandler(platformRouter, {
    interceptors: [
      onError((failure) => {
        recordException(failure, { "patchsmith.adapter": "orpc-openapi" });
        console.error("OpenAPI request failed", sanitizeErrorForLog(failure));
      }),
    ],
    plugins: [new RateLimitHandlerPlugin()],
  });
};

let openAPIHandler: ReturnType<typeof createOpenAPIHandler> | undefined;

export const handlePlatformRequest = async ({
  request,
}: {
  request: Request;
}) => {
  await initializeObservability("patchsmith-web");
  setSpanAttributes({
    "patchsmith.adapter": "orpc-openapi",
    "patchsmith.package": "apps-web",
  });

  const { pathname } = new URL(request.url);

  if (request.method === "GET" && pathname === "/api/platform/runtime/keys") {
    const { appRuntimeKeysResponse } =
      await import("@patchsmith/api-platform/routes/app-runtime");

    return appRuntimeKeysResponse();
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- JavaScript may reject with arbitrary values; this boundary records or preserves the original failure.
  const context = await createContext({ request }).catch((error: unknown) => {
    recordException(error, { "patchsmith.adapter": "orpc-openapi" });
    console.error("OpenAPI authorization failed", sanitizeErrorForLog(error));
    // oxlint-disable-next-line typescript/only-throw-error -- Preserve the transport failure object, including its code and metadata, for the existing downstream error mapping.
    throw contextErrorResponse(error);
  });

  const handler = await (openAPIHandler ??= createOpenAPIHandler());

  const rpcResult = await handler.handle(request, {
    context,
    prefix: "/api/platform",
  });

  if (rpcResult.response) {
    return rpcResult.response;
  }

  return new Response("Not found", { status: 404 });
};

export default createApiEntry(handlePlatformRequest, [
  "DELETE",
  "GET",
  "HEAD",
  "PATCH",
  "POST",
  "PUT",
]);
