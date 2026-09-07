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
- PR CI builds `linux/amd64` and `linux/arm64` without publishing. Release publication runs only from an explicit `v*` tag after merge and only when the owner has authorized a release.
- Never build a production image on the Pi.
