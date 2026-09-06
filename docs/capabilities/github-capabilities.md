# GitHub and Claude Code capability register

## Verified 2026-09-06

| ID | Claim | Source |
|---|---|---|
| GH-01 | `.claude/rules/*.md` files are discovered recursively; files with `paths:` YAML frontmatter load only when Claude works with matching files; files without `paths` load at launch | https://code.claude.com/docs/en/memory |
| GH-02 | CLAUDE.md target is under 200 lines; it is context, not enforcement; use PreToolUse hooks or settings `permissions.deny` for enforcement | same |
| GH-03 | `CLAUDE.local.md` is loaded alongside `CLAUDE.md` and should be gitignored | same |
| GH-04 | Claude Code reads `CLAUDE.md`, not `AGENTS.md`; import with `@AGENTS.md` if cross-agent compatibility is needed | same |
| GH-05 | Auto memory lives outside the repository and is machine-local; repository documents remain authoritative | same |
| GH-06 | Repository `mherman1990/BlackGold` exists, is public, and has no branches or commits | `git ls-remote` in this session |

## UNVERIFIED (check in Phase 0)

| ID | Question | Probe |
|---|---|---|
| GH-07 | `claude --worktree` creates `worktree-<name>` branches (claimed by the source prompt citing https://code.claude.com/docs/en/worktrees) | Read the page; inspect actual branch after first use |
| GH-08 | `docker/setup-qemu-action` + `docker/setup-buildx-action` + `docker/build-push-action` build `linux/amd64,linux/arm64` in one job on `ubuntu-latest`; native ARM runners may be available and faster | Read action READMEs; run a PR-CI dry build |
| GH-09 | GHCR public packages allow anonymous pull; package visibility is set per package after first push | Read GHCR docs; verify after first authorized publish |
| GH-10 | Branch protection rulesets support "require status checks", "require PR", "block force push", and tag protection on the free plan for public repositories | Read GitHub docs; configure in settings |
| GH-11 | Claude GitHub App review (`@claude review this PR`) availability and required secrets | Only if Matt authorizes installation |

## Constraints for this repository

- Claude Code sessions never push to `main`, never force-push, never merge.
- Workflows, repository secrets, and GitHub App installation are external permission changes and need separate authorization each time.
- Secret scanning: enable GitHub secret scanning and push protection on the repository (Matt, settings) and run `gitleaks` in CI (Phase 0).
