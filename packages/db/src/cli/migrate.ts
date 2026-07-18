import { loadOperatorConfig } from "@catchbox/config";
import { openDatabase, runMigrations } from "../index";

try {
  const config = loadOperatorConfig(Bun.env);
  const database = openDatabase(config.dataDir);
  runMigrations(database);
  database.close();
  console.log(JSON.stringify({ event: "migration_complete" }));
} catch (error) {
  console.error(
    JSON.stringify({
      event: "migration_failed",
      message: error instanceof Error ? error.message : "Unknown migration error",
    }),
  );
  process.exitCode = 1;
}
