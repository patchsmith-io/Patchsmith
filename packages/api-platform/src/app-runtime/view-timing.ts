import { SpanStatusCode } from "@opentelemetry/api";
import { withSpan } from "@patchsmith/observability";

import { RuntimeResponseError } from "./runtime-response-error";

interface RuntimeTransportAttributes {
  "http.response.status_code": number;
  "patchsmith.runtime.roundtrip_ms": number;
  [name: string]: string | number;
}

const phases = new Set([
  "runtime_gateway",
  "runtime_gateway_auth",
  "runtime_installation",
  "runtime_auth",
  "runtime_queue",
  "runtime_metadata",
  "runtime_metadata_kv",
  "runtime_metadata_platform",
  "runtime_bundle",
  "runtime_prepare",
  "runtime_execute",
]);

const durationEntry =
  /^(?<phase>runtime_[a-z_]+);dur=(?<duration>\d+(?:\.\d+)?)$/u;

const rayPattern = /^[a-f0-9]{16,32}-[A-Z]{3}$/u;
const placementPattern = /^(?:local|remote)-[A-Z]{3}$/u;

const runtimeDurations = (headers: Headers) => {
  const durations = new Map<string, number>();
  const header = headers.get("server-timing") ?? "";

  if (header.length > 8192) {
    return durations;
  }

  for (const entry of header.split(",")) {
    const match = durationEntry.exec(entry.trim());
    const name = match?.groups?.phase ?? "";
    const duration = Number(match?.groups?.duration);

    if (
      name !== "" &&
      phases.has(name) &&
      Number.isFinite(duration) &&
      duration <= 60_000
    ) {
      durations.set(name, Math.max(durations.get(name) ?? 0, duration));
    }
  }

  return durations;
};

/** Server-side correlation only; never forward worker headers or caller data. */
export const runtimeTransportAttributes = (
  response: Response,
  roundtripMs: number
) => {
  const attributes: RuntimeTransportAttributes = {
    "http.response.status_code": response.status,
    "patchsmith.runtime.roundtrip_ms": roundtripMs,
  };

  const ray = response.headers.get("cf-ray");
  const placement = response.headers.get("cf-placement");

  if (ray !== null && rayPattern.test(ray)) {
    attributes["patchsmith.runtime.cf_ray"] = ray;
  }

  if (placement !== null && placementPattern.test(placement)) {
    attributes["patchsmith.runtime.cf_placement"] = placement;
  }

  const durations = runtimeDurations(response.headers);

  for (const [phase, duration] of durations) {
    attributes[`patchsmith.runtime.${phase}_ms`] = duration;
  }

  const gatewayMs = durations.get("runtime_gateway");

  if (gatewayMs !== undefined) {
    // Includes connection setup, routing and dispatch outside the worker timer.
    // Cloudflare's I/O-driven clock means this is not a pure network measurement.
    attributes["patchsmith.runtime.transport_dispatch_ms"] = Math.max(
      0,
      roundtripMs - gatewayMs
    );
  }

  return attributes;
};

/** Maxima across concurrent installations; these overlapping durations are not additive. */
export class ViewResolutionTimings {
  readonly #maxima = new Map<string, number>();
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  constructor(fetcher: typeof fetch = fetch, now = () => performance.now()) {
    this.#fetch = fetcher;
    this.#now = now;
  }

  #record(name: string, duration: number) {
    this.#maxima.set(name, Math.max(this.#maxima.get(name) ?? 0, duration));
  }

  async session<T>(create: () => Promise<T>): Promise<T> {
    const started = this.#now();

    try {
      return await create();
    } finally {
      this.#record("views_session", this.#now() - started);
    }
  }

  readonly fetch: typeof fetch = async (input, init) => {
    try {
      return await withSpan("runtime.views.fetch", async (span) => {
        const started = this.#now();
        const response = await this.#fetch(input, init);
        const roundtripMs = this.#now() - started;
        this.#record("runtime_roundtrip", roundtripMs);

        for (const [name, duration] of runtimeDurations(response.headers)) {
          this.#record(name, duration);
        }

        // Record unsuccessful responses too: resolution errors omit timing headers
        // from the host response, but the server trace must retain the evidence.
        span.setAttributes(runtimeTransportAttributes(response, roundtripMs));

        if (response.status >= 500) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw new RuntimeResponseError(response);
        }

        return response;
      });
    } catch (error) {
      if (error instanceof RuntimeResponseError) {
        return error.response;
      }

      throw error;
    }
  };

  header() {
    return [...this.#maxima]
      .map(([name, duration]) => `${name}_max;dur=${duration.toFixed(1)}`)
      .join(", ");
  }
}
