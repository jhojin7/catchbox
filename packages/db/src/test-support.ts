import type { CatchboxDatabase } from "./index";
import { hashPassword } from "./password";
import { users } from "./schema";

interface SyntheticAccountOptions {
  id: string;
  username: string;
  accountKey: string;
  password: string;
}

export async function insertSyntheticAccount(
  database: CatchboxDatabase,
  options: SyntheticAccountOptions,
  now = new Date(),
) {
  const account = { id: options.id, username: options.username };
  const createdAt = now.toISOString();
  database.orm
    .insert(users)
    .values({
      ...account,
      accountKey: options.accountKey,
      passwordHash: await hashPassword(options.password),
      sessionVersion: 1,
      createdAt,
      updatedAt: createdAt,
    })
    .run();
  return account;
}
