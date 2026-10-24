import {
  listRuntimeInstallations,
  warmRuntimeDeployment,
} from "./deployment-steps";
import type { RuntimeRollout } from "./deployment-steps";

export const warmAppDeployment = async (input: RuntimeRollout) => {
  "use workflow";
  let cursor: string | undefined;
  let ids: string[];

  do {
    // oxlint-disable-next-line no-await-in-loop -- Each page depends on the preceding durable cursor.
    ids = await listRuntimeInstallations(input, cursor);

    // Limit each batch to ten active warm-up steps, each independently retryable.
    for (let offset = 0; offset < ids.length; offset += 10) {
      const batch = ids.slice(offset, offset + 10);

      // oxlint-disable-next-line no-await-in-loop -- Await each batch to cap concurrent per-installation warm-ups.
      const results = await Promise.allSettled(
        batch.map(async (id) => {
          await warmRuntimeDeployment(input.projectId, id);
        })
      );

      for (const [index, result] of results.entries()) {
        if (result.status === "rejected") {
          const error: unknown = result.reason;

          console.error("Could not warm app installation", {
            appId: batch[index],
            deploymentId: input.deploymentId,
            error,
            projectId: input.projectId,
          });
        }
      }
    }

    cursor = ids.at(-1);
  } while (ids.length === 50);
};
