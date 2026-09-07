import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { name: string; version: string };

export const CORE_PACKAGE_NAME: string = pkg.name;
export const CORE_VERSION: string = pkg.version;
