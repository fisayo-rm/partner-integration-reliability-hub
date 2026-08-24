import { createLambdaHandler } from "./lambda-handler.js";
import { createApiDependencies } from "./runtime.js";

let handler: ReturnType<typeof createLambdaHandler> | undefined;

export async function httpApiHandler(
  event: Parameters<ReturnType<typeof createLambdaHandler>>[0],
) {
  if (handler === undefined) {
    const runtime = await createApiDependencies();
    handler = createLambdaHandler(runtime.dependencies);
  }
  return await handler(event);
}
