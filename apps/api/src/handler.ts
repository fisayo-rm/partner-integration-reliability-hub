import { createLambdaHandler } from "./lambda-handler.js";
import { createApiDependencies } from "./runtime.js";

let handler: ReturnType<typeof createLambdaHandler> | undefined;
let runtime: Awaited<ReturnType<typeof createApiDependencies>> | undefined;

export async function httpApiHandler(
  event: Parameters<ReturnType<typeof createLambdaHandler>>[0],
) {
  if (handler === undefined) {
    runtime = await createApiDependencies({ localProcess: false });
    handler = createLambdaHandler(runtime.dependencies);
  }
  try {
    return await handler(event);
  } finally {
    await runtime?.flush();
  }
}
