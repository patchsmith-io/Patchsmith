import { AppDeployment } from "@patchsmith/db/schema/apps";
import { expect, it } from "vite-plus/test";

const schema = AppDeployment.shape.views;
const view = { instances: true, path: "/", slot: "page" };
const entry = { data: { section: "reports" }, key: "reports", metadata: {} };

it("accepts legacy views and preserves populated and empty static snapshots", () => {
  expect(schema.parse([view])).toEqual([view]);

  for (const staticInstances of [[], [entry]]) {
    const views = [{ ...view, staticInstances }];
    expect(schema.parse(views)).toEqual(views);
  }
});

it.each([
  { ...view, staticInstances: [entry, entry] },
  { ...view, staticInstances: [{ ...entry, key: "" }] },
  { ...view, instances: undefined, staticInstances: [] },
  {
    ...view,
    staticInstances: Array.from({ length: 1001 }, (_, key) => ({
      ...entry,
      key: String(key),
    })),
  },
])("rejects invalid static snapshots: %j", (invalid) => {
  expect(schema.safeParse([invalid]).success).toBe(false);
});
