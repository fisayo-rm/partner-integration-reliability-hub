import { createServer } from "node:http";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const service = process.env.SERVICE_NAME ?? "placeholder";
const server = createServer((request, response) => {
  const healthy =
    request.url === "/health/live" ||
    request.url === "/health/ready" ||
    request.url === "/";
  response.writeHead(healthy ? 200 : 404, {
    "content-type": "application/json",
  });
  response.end(
    JSON.stringify({
      service,
      status: healthy ? "ok" : "not_found",
      mode: "skeleton",
    }),
  );
});
server.listen(port, "0.0.0.0");
