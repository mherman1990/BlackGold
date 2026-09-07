---
paths:
  - "umbrel-app-store.yml"
  - "blackgold-trading/**"
  - ".github/workflows/**"
  - "Dockerfile*"
  - "docker-compose*.yml"
---

# Umbrel identity and release rules

- Identifiers are frozen in `docs/IDENTITY.md`: store id `blackgold`, app id `blackgold-trading`, image `ghcr.io/mherman1990/blackgold`. Changing any of them is a migration and requires a decision record first.
- The app id must begin with the store id followed by a hyphen. A CI test enforces this.
- `umbrel-app.yml` `version`, `docker-compose.yml` image tag, `package.json` version, and `CHANGELOG.md` must agree. A CI check enforces it. Never rely on a human to find every version location.
- Compose pins an immutable semver tag (and preferably a digest). Never `latest`.
- All mutable state lives under `${APP_DATA_DIR}`. Nothing writable lives in the image.
- No secret in the image, the store repository, a workflow log, or a manifest.
- PR CI builds `linux/amd64` and `linux/arm64` without publishing. Release publication runs only from `release.yml`, which will not publish anything that is not already merged: the commit must be an ancestor of `origin/main` and the version must match `package.json` read from that commit.
- Two ways to start a release, both publishing the same thing (D-38): dispatch `release.yml` with the bare version, or push a `v<semver>` tag. Claude Code uses the dispatch path because GitHub refuses its credential any tag ref; on that path the workflow creates the tag itself, after the full check passes and never before. Do not attempt `git push origin v<version>` from a Claude Code session.
- A published version is immutable. `release.yml` refuses a tag that already exists rather than moving it, because compose pins the image by digest and re-pointing a tag would change what an installed app resolves on its next pull. To ship a fix, bump `package.json`.
- A new GHCR package is private by default and umbrelOS pulls anonymously, so the owner must make it public once, on the first release of a package. Until then the Umbrel install fails with `unauthorized`.
- Never build a production image on the Pi.
