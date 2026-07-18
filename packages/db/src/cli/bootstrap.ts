import { loadOperatorConfig } from "@catchbox/config";
import { bootstrapLocalAccount, openDatabase } from "../index";

try {
  const config = loadOperatorConfig(Bun.env);
  const database = openDatabase(config.dataDir);
  const result = await bootstrapLocalAccount(
    database,
    config.bootstrapUsername,
    config.bootstrapPassword,
  );
  database.close();
  console.log(
    JSON.stringify({
      event: result.created ? "account_bootstrapped" : "account_already_bootstrapped",
      username: result.account.username,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      event: "account_bootstrap_failed",
      message: error instanceof Error ? error.message : "Unknown bootstrap error",
    }),
  );
  process.exitCode = 1;
}
