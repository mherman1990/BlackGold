import { describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DataDirNotWritableError, openCoreDb } from "../src/index.ts";

// `release-verify.yml` failed its first run with SQLite's bare "unable to open database file", which named
// no path, no uid, and no cause. The cause was a bind mount carrying the host directory's ownership rather
// than the `chown 1000:1000 /data` the image does at build time. These cover the preflight that replaced it.
describe("data directory preflight", () => {
  it("names the path, the uid, and the fix when the data dir is not writable", () => {
    // Root ignores the write bit, so the check cannot bite and the assertion would be meaningless.
    if (process.getuid?.() === 0) return;
    const dir = mkdtempSync(join(tmpdir(), "bg-ro-"));
    chmodSync(dir, 0o555);
    try {
      const dbPath = join(dir, "x.sqlite");
      expect(() => openCoreDb({ dbPath })).toThrow(DataDirNotWritableError);
      expect(() => openCoreDb({ dbPath })).toThrow(/Cannot write to/);
      // The message has to carry the remedy, not just the diagnosis: an operator on a headless Pi needs the
      // uid to chown to and to know the fix belongs on the host side of the mount.
      expect(() => openCoreDb({ dbPath })).toThrow(/chown/);
      expect(() => openCoreDb({ dbPath })).toThrow(/uid/);
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  it("opens normally when the directory is writable, creating the file on first run", () => {
    // The happy path matters here: the preflight checks the parent directory precisely because the database
    // file does not exist yet on a first run, and checking the file itself would reject every fresh install.
    const dir = mkdtempSync(join(tmpdir(), "bg-rw-"));
    const { db, applied } = openCoreDb({ dbPath: join(dir, "fresh.sqlite") });
    expect(db.path).toContain("fresh.sqlite");
    expect(applied.length).toBeGreaterThan(0);
    db.close();
  });
});
