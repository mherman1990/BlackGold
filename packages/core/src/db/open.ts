import { migrate, openDatabase, type Db } from "@blackgold/shared";
import type { AppConfig } from "../config/schema.ts";
import { CORE_MIGRATIONS } from "./migrations.ts";

/** Open the core SQLite database (WAL, single writer) and apply pending migrations. */
export function openCoreDb(config: Pick<AppConfig, "dbPath">): { db: Db; applied: string[] } {
  const db = openDatabase(config.dbPath);
  const { applied } = migrate(db, CORE_MIGRATIONS);
  return { db, applied };
}
