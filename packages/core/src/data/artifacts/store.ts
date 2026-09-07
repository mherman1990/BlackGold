import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { constants as zc, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { nowUtc, sha256Hex, utc, type Db, type UtcInstant } from "@blackgold/shared";

/**
 * Content-addressed raw artifact store (docs/DATA_PROVENANCE_SPEC.md section 7).
 * Path: <root>/sha256/<aa>/<bb>/<full hex>.zst. The hash is of the UNCOMPRESSED bytes as received, so it
 * equals every referencing observation's rawContentHash. There is no update path; corrections are new
 * artifacts. Metadata lives in SQLite so the daily ledger seal covers it.
 */
export type ArtifactMeta = {
  hash: string; // "sha256:<hex>"
  bytesRaw: number;
  bytesCompressed: number;
  mime: string;
  firstLocator: string;
  firstIngestedAt: UtcInstant;
  lastVerifiedAt: UtcInstant | null;
  etag: string | null;
  lastModified: string | null;
  retentionClass: string;
  path: string;
};

export type PutResult = { hash: string; deduplicated: boolean; bytesRaw: number; bytesCompressed: number };

export type VerifyResult = { hash: string; ok: boolean; reason?: "missing" | "hash_mismatch" | "decompress_failed" };

export class ArtifactIntegrityError extends Error {
  constructor(hash: string, reason: string) {
    super(`Artifact ${hash} failed integrity: ${reason}`);
    this.name = "ArtifactIntegrityError";
  }
}

export type RetentionClass = "ledger" | "filings" | "macro" | "market" | "evidence" | "other";

export class ArtifactStore {
  readonly root: string;
  private readonly db: Db;
  private readonly clock: () => number;

  constructor(root: string, db: Db, clock: () => number = Date.now) {
    this.root = root;
    this.db = db;
    this.clock = clock;
    mkdirSync(root, { recursive: true });
  }

  pathFor(hex: string): string {
    return join(this.root, "sha256", hex.slice(0, 2), hex.slice(2, 4), `${hex}.zst`);
  }

  /** Store bytes. Identical content is deduplicated (metadata gets a fresh last-verified time only). */
  put(
    bytes: Uint8Array,
    meta: { locator: string; mime?: string; etag?: string; lastModified?: string; retention?: RetentionClass; level?: number },
  ): PutResult {
    const hex = sha256Hex(bytes);
    const hash = `sha256:${hex}`;
    const existing = this.meta(hash);
    const now = nowUtc(this.clock);
    if (existing && existsSync(existing.path)) {
      this.db.prepare("UPDATE artifacts SET last_verified_at = ? WHERE hash = ?").run(now, hash);
      return { hash, deduplicated: true, bytesRaw: existing.bytesRaw, bytesCompressed: existing.bytesCompressed };
    }
    const level = meta.level ?? 9;
    const compressed = zstdCompressSync(bytes, { params: { [zc.ZSTD_c_compressionLevel]: level } });
    const path = this.pathFor(hex);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, compressed, { flag: "w" });
    if (existing) {
      // Metadata existed but the file was gone: restore the file, keep original provenance.
      this.db.prepare("UPDATE artifacts SET last_verified_at = ?, bytes_compressed = ? WHERE hash = ?").run(now, compressed.byteLength, hash);
    } else {
      this.db
        .prepare(
          `INSERT INTO artifacts (hash, bytes_raw, bytes_compressed, mime, first_locator, first_ingested_at, last_verified_at, etag, last_modified, retention_class, path)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          hash,
          bytes.byteLength,
          compressed.byteLength,
          meta.mime ?? "application/octet-stream",
          meta.locator,
          now,
          now,
          meta.etag ?? null,
          meta.lastModified ?? null,
          meta.retention ?? "other",
          path,
        );
    }
    return { hash, deduplicated: false, bytesRaw: bytes.byteLength, bytesCompressed: compressed.byteLength };
  }

  /** Read and verify. Throws ArtifactIntegrityError on a missing file or a hash mismatch. */
  get(hash: string): Uint8Array {
    const m = this.meta(hash);
    if (!m || !existsSync(m.path)) throw new ArtifactIntegrityError(hash, "missing");
    let raw: Buffer;
    try {
      raw = zstdDecompressSync(readFileSync(m.path));
    } catch {
      throw new ArtifactIntegrityError(hash, "decompress_failed");
    }
    if (`sha256:${sha256Hex(raw)}` !== hash) throw new ArtifactIntegrityError(hash, "hash_mismatch");
    return raw;
  }

  getText(hash: string): string {
    return Buffer.from(this.get(hash)).toString("utf8");
  }

  has(hash: string): boolean {
    const m = this.meta(hash);
    return m !== undefined && existsSync(m.path);
  }

  meta(hash: string): ArtifactMeta | undefined {
    const r = this.db.prepare("SELECT * FROM artifacts WHERE hash = ?").get(hash) as
      | Record<string, string | number | bigint | null>
      | undefined;
    if (!r) return undefined;
    const text = (k: string): string | null => {
      const v = r[k];
      return v === null || v === undefined ? null : String(v);
    };
    return {
      hash,
      bytesRaw: Number(r["bytes_raw"]),
      bytesCompressed: Number(r["bytes_compressed"]),
      mime: text("mime") ?? "",
      firstLocator: text("first_locator") ?? "",
      firstIngestedAt: utc(text("first_ingested_at") ?? ""),
      lastVerifiedAt: text("last_verified_at") === null ? null : utc(text("last_verified_at") ?? ""),
      etag: text("etag"),
      lastModified: text("last_modified"),
      retentionClass: text("retention_class") ?? "other",
      path: text("path") ?? "",
    };
  }

  verify(hash: string): VerifyResult {
    try {
      this.get(hash);
    } catch (err) {
      if (err instanceof ArtifactIntegrityError) {
        const reason = err.message.includes("missing") ? "missing" : err.message.includes("decompress") ? "decompress_failed" : "hash_mismatch";
        return { hash, ok: false, reason };
      }
      throw err;
    }
    this.db.prepare("UPDATE artifacts SET last_verified_at = ? WHERE hash = ?").run(nowUtc(this.clock), hash);
    return { hash, ok: true };
  }

  /** Verify a deterministic sample (by hash order offset) so the daily job covers the store over time. */
  verifySample(sampleSize: number, offset = 0): VerifyResult[] {
    const hashes = (this.db.prepare("SELECT hash FROM artifacts ORDER BY hash").all() as { hash: string }[]).map((r) => r.hash);
    if (hashes.length === 0) return [];
    const out: VerifyResult[] = [];
    for (let i = 0; i < Math.min(sampleSize, hashes.length); i++) {
      const h = hashes[(offset + i) % hashes.length];
      if (h !== undefined) out.push(this.verify(h));
    }
    return out;
  }

  /** Bytes on disk under the store root; the input to storage-budget checks. */
  diskUsageBytes(): number {
    let total = 0;
    const walk = (dir: string): void => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) walk(full);
        else total += st.size;
      }
    };
    walk(this.root);
    return total;
  }

  count(): number {
    return (this.db.prepare("SELECT count(*) AS n FROM artifacts").get() as { n: number }).n;
  }
}
