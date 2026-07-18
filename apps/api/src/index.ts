import { loadApiConfig } from "@catchbox/config";
import { openDatabase } from "@catchbox/db";
import pino from "pino";
import { createApp } from "./app";
import { startHttpServer } from "./server";

const config = loadApiConfig(Bun.env);
const logger = pino({
  level: config.environment === "test" ? "silent" : "info",
  base: { service: "catchbox-api" },
});
const database = openDatabase(config.dataDir);
const app = createApp({ database, config, logger });
const server = await startHttpServer(app, config, logger);

function shutdown() {
  server.close(() => {
    database.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
