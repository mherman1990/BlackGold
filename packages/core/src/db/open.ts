import { accessSync, constants } from "node:fs";
import { dirname } from "node:path";
import { migrate, openDatabase, type Db } from "@blackgold/shared";
import type { AppConfig } from "../config/schema.ts";
import { CORE_MIGRATIONS } from "./migrations.ts";

/**
 * The data directory exists but this process cannot write to it.
 *
 * Raised in preference to SQLite's own "unable to open database file", which is true but says nothing an
 * operator can act on: it names no path, no uid, and no cause. The realistic cause on an appliance install
 * is a bind mount, because a bind mount keeps the HOST directory's ownership and ignores whatever the image
 * chowned `/data` to at build time. `release-verify.yml` hit exactly this and reported only the SQLite text.
 */
export class DataDirNotWritableError extends Error {
  constructor(dir: string, dbPath: string) {
    const uid = process.getuid?.() ?? -1;
    const gid = process.getgid?.() ?? -1;
    super(
      `Cannot write to ${dir}, which is needed for the SQLite database at ${dbPath}. ` +
        `This process runs as uid ${uid}:${gid}. In a container the data directory is usually a bind mount, ` +
        `and a bind mount keeps the host directory's ownership rather than the image's, so fix it on the host: ` +
        `chown -R ${uid}:${gid} <host data dir>. umbrelOS owns APP_DATA_DIR as uid 1000, which is why the ` +
        `compose services declare user "1000:1000".`,
    );
    this.name = "DataDirNotWritableError";
  }
}

/**
 * Fail with a diagnosable error before SQLite fails with an opaque one.
 *
 * Checks the parent directory rather than the database file, because on a first run the file does not exist
 * yet and creating it is what needs the directory's write and search bits.
 */
function assertDataDirWritable(dbPath: string): void {
  const dir = dirname(dbPath);
  try {
    accessSync(dir, constants.W_OK | constants.X_OK);
  } catch {
    throw new DataDirNotWritableError(dir, dbPath);
  }
}

/** Open the core SQLite database (WAL, single writer) and apply pending migrations. */
export function openCoreDb(config: Pick<AppConfig, "dbPath">): { db: Db; applied: string[] } {
  assertDataDirWritable(config.dbPath);
  const db = openDatabase(config.dbPath);
  const { applied } = migrate(db, CORE_MIGRATIONS);
  return { db, applied };
}
