# Runbooks

Operator procedures for Black Gold. Phase 0 provides the local-development and container procedures below. Broker, model, live, and incident runbooks arrive with the phases that introduce those capabilities (see `PLAN.md`).

| Runbook | Phase | Status |
|---|---|---|
| `local-dev.md` | 0 | Available |
| `backup-and-restore.md` | 0 | Available |
| `first-ingestion.md` | 1 → 2 | Available |
| `umbrel-install-update-remove.md` | 0 (design) / first release | Draft until first published image |
| Startup, shutdown, reboot, missed jobs | 5 | Not yet written |
| Provider outage, token expiry, stale data, disk full | 5–6 | Not yet written |
| `UNKNOWN` order, partial fill, missing protection, unexpected position | 6 | Not yet written |
| Drawdown halt, manual re-arm, emergency flatten | 6–7 | Not yet written |
| Restricted-list add/remove and cooling period | 4 | Not yet written |
| Promotion and downgrade | 7 | Not yet written |
| Incident severity, containment, postmortem | 5 | Not yet written |

**On the Pi, a new command is written `bg <cmd>`** (D-60): the wrappers in `scripts/pi/` ship inside the image and
are installed once with the `docker cp` line in `umbrel-install-update-remove.md`, "Install the Pi wrappers".
Older runbook lines keep the full `sudo docker exec blackgold-trading_core_1 node packages/core/dist/main.js ...`
form, which `bg` abbreviates and which still works. The owner's weekly pastes are in `docs/OWNER_QUEUE.md`,
generated from `docs/owner-queue.yaml` by `npm run owner-queue`.
