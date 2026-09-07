#!/usr/bin/env node
/**
 * Cross-file identifier and version consistency check (docs/IDENTITY.md).
 * Runs with plain `node` (erasable TypeScript) and in CI. Exit 1 on any violation.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "yaml";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const STORE_ID = "blackgold";
const APP_ID = "blackgold-trading";
const IMAGE = "ghcr.io/mherman1990/blackgold";
const CORE_CONTAINER = `${APP_ID}_core_1`;

type Problem = string;
const problems: Problem[] = [];
function fail(msg: string): void {
  problems.push(msg);
}

function readYaml(rel: string): Record<string, unknown> {
  return parse(readFileSync(join(ROOT, rel), "utf8")) as Record<string, unknown>;
}

// 1. Store manifest
const store = readYaml("umbrel-app-store.yml");
if (store["id"] !== STORE_ID) fail(`umbrel-app-store.yml id must be ${STORE_ID}, got ${String(store["id"])}`);
if (store["name"] !== "Black Gold") fail(`umbrel-app-store.yml name must be Black Gold`);

// 2. Exactly one app directory, named and prefixed correctly
const appDirs = readdirSync(ROOT).filter(
  (d) => statSync(join(ROOT, d)).isDirectory() && existsSync(join(ROOT, d, "umbrel-app.yml")),
);
if (appDirs.length !== 1 || appDirs[0] !== APP_ID) fail(`expected exactly one app dir ${APP_ID}, found ${appDirs.join(",")}`);
const app = readYaml(`${APP_ID}/umbrel-app.yml`);
if (app["id"] !== APP_ID) fail(`umbrel-app.yml id must be ${APP_ID}`);
if (!String(app["id"]).startsWith(`${STORE_ID}-`)) fail(`app id must be prefixed by store id ${STORE_ID}-`);
if (app["manifestVersion"] !== 1) fail(`manifestVersion must be 1`);
const appVersion = String(app["version"]);
const appPort = Number(app["port"]);

// 3. Version authority: package.json
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };
if (pkg.version !== appVersion) fail(`umbrel-app.yml version ${appVersion} != package.json ${pkg.version}`);
for (const p of ["shared", "core", "broker-gateway"]) {
  const wp = JSON.parse(readFileSync(join(ROOT, "packages", p, "package.json"), "utf8")) as { version: string };
  if (wp.version !== pkg.version) fail(`packages/${p} version ${wp.version} != ${pkg.version}`);
}

// 4. CHANGELOG top heading
const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
const heading = /^## (\S+)/m.exec(changelog)?.[1];
if (heading !== pkg.version) fail(`CHANGELOG.md top heading ${String(heading)} != ${pkg.version}`);

// 5. Compose
const compose = readYaml(`${APP_ID}/docker-compose.yml`) as {
  services: Record<string, { image?: string; environment?: Record<string, unknown>; volumes?: string[]; ports?: unknown; privileged?: unknown }>;
};
const services = compose.services;
const proxy = services["app_proxy"];
if (!proxy) fail("compose must define app_proxy");
if (proxy?.environment?.["APP_HOST"] !== CORE_CONTAINER) fail(`APP_HOST must be ${CORE_CONTAINER}`);
if (Number(proxy?.environment?.["APP_PORT"]) !== appPort) fail(`APP_PORT must equal umbrel-app.yml port ${appPort}`);
for (const [name, svc] of Object.entries(services)) {
  if (name === "app_proxy") continue;
  const image = svc.image ?? "";
  if (!image.startsWith(`${IMAGE}:`)) fail(`service ${name} image must start with ${IMAGE}:`);
  const tag = image.slice(IMAGE.length + 1).split("@")[0];
  if (tag === "latest" || tag === "") fail(`service ${name} must pin a version tag, not latest`);
  if (tag !== pkg.version) fail(`service ${name} image tag ${String(tag)} != ${pkg.version}`);
  if (svc.ports !== undefined) fail(`service ${name} must not publish host ports`);
  if (svc.privileged !== undefined) fail(`service ${name} must not be privileged`);
  for (const v of svc.volumes ?? []) {
    if (!v.startsWith("${APP_DATA_DIR}/")) fail(`service ${name} volume ${v} must live under \${APP_DATA_DIR}/`);
    if (v.includes("docker.sock")) fail(`service ${name} must not mount the docker socket`);
  }
}

// 6. Forbidden prior product name in identifier positions (case-insensitive), outside provenance records
const allowFiles = new Set(["docs/CONTEXT_PROVENANCE.md", "docs/DECISIONS.md", "scripts/check-identity.ts"]);
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (["node_modules", ".git", "dist", "coverage", "data"].includes(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}
const forbidden = /tiller/i;
for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file);
  if (allowFiles.has(rel)) continue;
  if (/\.(png|jpg|svg|lock|json)$/.test(rel) && rel !== "package.json") continue;
  const text = readFileSync(file, "utf8");
  if (forbidden.test(text)) fail(`${rel} contains the retired product name`);
}

// 7. Release workflow trigger filter
const release = readYaml(".github/workflows/release.yml") as { on: { push?: { tags?: string[] }; pull_request?: unknown } };
if (release.on.pull_request !== undefined) fail("release.yml must not run on pull_request");
const tags = release.on.push?.tags ?? [];
if (tags.length !== 1 || !/^v\[0-9\]\+\\?\.\[0-9\]\+\\?\.\[0-9\]\+$/.test(tags[0] ?? "") && tags[0] !== "v[0-9]+.[0-9]+.[0-9]+") {
  fail(`release.yml must trigger only on semver tags, got ${JSON.stringify(tags)}`);
}

if (problems.length > 0) {
  console.error("identity check FAILED:");
  for (const p of problems) console.error(` - ${p}`);
  process.exit(1);
}
console.log(`identity check ok: store=${STORE_ID} app=${APP_ID} image=${IMAGE}:${pkg.version} port=${appPort}`);
