import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { asyncFixture } from "@patchsmith/config/testing";
import { afterEach, expect, it } from "vite-plus/test";

import {
  runtimeTransportAttributes,
  ViewResolutionTimings,
} from "./view-timing";

const exporter = new InMemorySpanExporter();

const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});

afterEach(async () => {
  trace.disable();
  await provider.forceFlush();
  exporter.reset();
});

it("keeps runtime phase maxima and session timing without forwarding arbitrary headers", async () => {
  let now = 0;
  let calls = 0;

  const timings = new ViewResolutionTimings(
    asyncFixture(() => {
      calls += 1;
      now += 20;

      return new Response("unchanged", {
        headers: {
          "server-timing": `runtime_execute;dur=${calls * 3}, runtime_metadata;dur=2.0, secret;desc=private, runtime_unknown;dur=3, runtime_bundle;dur=999999, runtime_auth;dur=NaN`,
        },
      });
    }),
    () => now
  );

  expect(
    await timings.session(
      asyncFixture(() => {
        now += 5;

        return "session";
      })
    )
  ).toBe("session");
  const response = await timings.fetch("https://runtime.test");
  expect(await response.text()).toBe("unchanged");
  await timings.fetch("https://runtime.test");
  expect(timings.header()).toBe(
    "views_session_max;dur=5.0, runtime_roundtrip_max;dur=20.0, runtime_execute_max;dur=6.0, runtime_metadata_max;dur=2.0"
  );
  expect(new ViewResolutionTimings().header()).toBe("");
});

it("correlates failed runtime calls without recording credentials or response bodies", async () => {
  const response = new Response("private resolver output", {
    headers: {
      authorization: "Bearer private-token",
      "cf-placement": "remote-IAD",
      "cf-ray": "0123456789abcdef-IAD",
      "server-timing":
        "runtime_gateway;dur=12.0, runtime_auth;dur=1.0, secret;desc=private",
      "set-cookie": "session=private",
    },
    status: 401,
  });

  expect(runtimeTransportAttributes(response, 134)).toEqual({
    "http.response.status_code": 401,
    "patchsmith.runtime.cf_placement": "remote-IAD",
    "patchsmith.runtime.cf_ray": "0123456789abcdef-IAD",
    "patchsmith.runtime.roundtrip_ms": 134,
    "patchsmith.runtime.runtime_auth_ms": 1,
    "patchsmith.runtime.runtime_gateway_ms": 12,
    "patchsmith.runtime.transport_dispatch_ms": 122,
  });
  expect(await response.text()).toBe("private resolver output");
});

it("rejects malformed correlation headers and unbounded timing input", () => {
  const attributes = runtimeTransportAttributes(
    new Response(null, {
      headers: {
        "cf-placement": "private arbitrary value",
        "cf-ray": "0123456789abcdef-IAD?token=private",
        "server-timing": `runtime_gateway;dur=12.0, ${"x".repeat(8192)}`,
      },
    }),
    134
  );

  expect(attributes).toEqual({
    "http.response.status_code": 200,
    "patchsmith.runtime.roundtrip_ms": 134,
  });
});

it.each([401, 503])(
  "keeps an HTTP %s response and records its finished span",
  async (status) => {
    expect(trace.setGlobalTracerProvider(provider)).toBe(true);
    let now = 0;

    const failure = new Response("Unauthorized", {
      headers: { "server-timing": "runtime_gateway;dur=2.0" },
      status,
    });

    const timings = new ViewResolutionTimings(
      asyncFixture(() => {
        now += 10;

        return failure;
      }),
      () => now
    );

    const response = await timings.fetch("https://runtime.test");

    expect(response).toBe(failure);
    expect(response.status).toBe(status);
    expect(await response.text()).toBe("Unauthorized");
    expect(timings.header()).toContain("runtime_gateway_max;dur=2.0");

    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const [span] = spans;
    expect(span?.name).toBe("runtime.views.fetch");
    expect(span?.attributes).toMatchObject({
      "http.response.status_code": status,
      "patchsmith.runtime.roundtrip_ms": 10,
      "patchsmith.runtime.runtime_gateway_ms": 2,
      "patchsmith.runtime.transport_dispatch_ms": 8,
    });
    expect(span?.status.code).toBe(
      status >= 500 ? SpanStatusCode.ERROR : SpanStatusCode.OK
    );
  }
);

it("preserves fetch rejections instead of treating them as HTTP responses", async () => {
  const failure = new Error("Connection failed");

  const timings = new ViewResolutionTimings(
    asyncFixture(() => {
      throw failure;
    })
  );

  await expect(timings.fetch("https://runtime.test")).rejects.toBe(failure);
});
