import type { Server } from "node:http";
import type { CatchboxConfig } from "@catchbox/config";
import type { Express } from "express";
import type { StructuredLogger } from "./app";

export function startHttpServer(
  app: Express,
  config: Pick<CatchboxConfig, "host" | "port">,
  logger: StructuredLogger,
) {
  return new Promise<Server>((resolve, reject) => {
    const server = app.listen(config.port, config.host, () => {
      logger.info({ event: "startup", host: config.host, port: config.port });
      resolve(server);
    });
    server.once("error", reject);
  });
}
