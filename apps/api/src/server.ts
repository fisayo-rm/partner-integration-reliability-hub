import { buildApi } from "./app.js";
import { createApiDependencies } from "./runtime.js";

const port = Number.parseInt(process.env.API_PORT ?? "3000", 10);
const host = process.env.API_HOST ?? "0.0.0.0";
const runtime = await createApiDependencies();
const app = await buildApi(runtime.dependencies);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => void app.close());
app.addHook("onClose", runtime.shutdown);
await app.listen({ host, port });
