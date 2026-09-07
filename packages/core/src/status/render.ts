import { daysBehind, type JobStatus, type SourceCoverage, type StatusReport } from "./model.ts";

/**
 * Render the status report as one self-contained HTML document.
 *
 * Self-contained is a hard requirement, not a preference: the core process never makes an outbound request
 * (`docs/THREAT_MODEL.md` F-boundaries), and a page that pulled a font or a script from a CDN would both
 * break that property and fail on a Pi with no egress. So CSS is inline, there is no JavaScript, and there
 * are no images beyond an inline SVG-free layout.
 *
 * Read-only by construction: no form, no button, no fetch. The listener already refuses any method other
 * than GET and HEAD; this keeps the document itself incapable of asking for a mutation.
 *
 * Designed to be read on a phone over Tailscale, because that is how the operator will actually check it.
 */
export function renderStatusPage(r: StatusReport): string {
  const h = r.health;
  const state = h.ok ? "OK" : "DEGRADED";
  const sealAge = daysBehind(h.at, h.lastSeal?.date);
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Black Gold ${esc(h.version)} - ${state}</title>
<style>${CSS}</style>
</head><body>
<header class="bar ${h.ok ? "ok" : "bad"}">
  <div>
    <h1>Black Gold <span class="dim">${esc(h.version)}</span></h1>
    <p class="sub">Evidence-first research for one ring-fenced sleeve</p>
  </div>
  <div class="state">${state}</div>
</header>

<section class="banner">
  <strong>Live trading is absent from this build.</strong>
  Mode <code>${esc(h.mode)}</code>, <code>liveCapable=${String(h.liveCapable)}</code>. No broker credential and no
  order path exist in this image. This page is read-only and shows no account balances or dollar amounts.
</section>

<div class="grid">
  ${card("Now", [
    kv("As of", `<code>${esc(h.at)}</code>`),
    kv("Next session", `<code>${esc(h.nextSession)}</code>`),
    kv("Running since", r.firstEventAt ? `<code>${esc(r.firstEventAt)}</code>` : muted("no ledger events yet")),
  ])}
  ${card("Ledger", [
    kv("Events", num(h.ledgerEvents)),
    kv("Hash chain", h.ledgerChain.ok ? pill("intact", "good") : pill(`broken at ${String(h.ledgerChain.brokenAt)}`, "bad")),
    kv(
      "Last daily seal",
      h.lastSeal
        ? `<code>${esc(h.lastSeal.date)}</code> ${sealAge !== undefined && sealAge > 3 ? pill(`${sealAge}d ago`, "warn") : `<span class="dim">${sealAge ?? 0}d ago</span>`}`
        : muted("none yet"),
    ),
    kv(
      "Unsealed days",
      h.unsealedDays.length === 0 ? pill("none", "good") : pill(h.unsealedDays.slice(0, 3).join(", ") + (h.unsealedDays.length > 3 ? " …" : ""), "warn"),
    ),
  ])}
  ${card("Resources", [
    kv("Free disk", bytes(h.freeDiskBytes)),
    kv("SQLite WAL", bytes(h.walSizeBytes)),
    kv("Raw artifacts", `${num(r.data.artifacts)} <span class="dim">(${bytes(r.data.artifactBytesCompressed)} compressed)</span>`),
  ])}
</div>

<h2>Scheduled jobs</h2>
${r.jobs.length === 0 ? empty("No jobs registered. A running <code>serve</code> registers the heartbeat and the daily ledger seal.") : jobTable(r.jobs)}

<h2>Data coverage</h2>
${
  r.data.observations === 0
    ? empty(
        "No observations ingested. Every number below the surface depends on this, and an ingest needs the source " +
          "credentials in the app environment. Until then the research kernel has nothing to read and no result can exist.",
      )
    : sourceTable(r.data.sources, h.at) +
      `<p class="note">${num(r.data.observations)} observations across ${num(r.data.entities)} entities, ${num(r.data.snapshots)} point-in-time snapshot(s).
       Every decision-time read filters on <code>availableAt + processingDelay &lt;= decisionAt</code>, so the newest row is
       deliberately not the newest usable row.</p>`
}

<h2>Research evidence</h2>
${evidenceBlock(r)}

<h2>Health checks</h2>
<table class="tbl"><thead><tr><th>Component</th><th>State</th><th>Detail</th></tr></thead><tbody>
${h.checks
  .map(
    (c) =>
      `<tr><td><code>${esc(c.component)}</code></td><td>${c.ok ? pill("ok", "good") : pill("FAIL", "bad")}</td><td class="detail">${esc(c.detail)}</td></tr>`,
  )
  .join("\n")}
</tbody></table>

<footer>
  <p>Served locally by <code>blackgold-core</code>. Not investment advice. No positions, no broker, and no model
  provider are reachable from this build.</p>
</footer>
</body></html>
`;
}

function evidenceBlock(r: StatusReport): string {
  const e = r.evidence;
  if (e.experiments === 0) {
    return empty(
      "No experiment is registered, so <strong>no result exists</strong> - not a hidden one, not a provisional one. " +
        "Registering an experiment requires an approved Alpha Charter, and the charter is the operator's to sign. " +
        "The sealed holdout has never been opened.",
    );
  }
  return `<div class="grid">
  ${card("Registered", [kv("Experiments", num(e.experiments)), kv("Trials recorded", num(e.trials))])}
  ${card("Irreversible acts", [
    kv("Results viewed", e.resultsViewed === 0 ? pill("never", "good") : pill(String(e.resultsViewed), "warn")),
    kv("Holdouts opened", e.holdoutsOpened === 0 ? pill("sealed", "good") : pill(String(e.holdoutsOpened), "warn")),
    kv("Promotion evidence claimed", e.promotionEvidenceClaimed === 0 ? muted("none") : pill(String(e.promotionEvidenceClaimed), "warn")),
  ])}
</div>
<p class="note">The trial count is the multiple-testing denominator: it is append-only and includes every trial ever
run, which is what keeps a favourable result from being quietly reselected.</p>`;
}

function jobTable(jobs: JobStatus[]): string {
  return `<table class="tbl"><thead><tr><th>Job</th><th>Schedule</th><th>Last run</th><th>When</th><th>Missed</th><th>Failed</th></tr></thead><tbody>
${jobs
  .map((j) => {
    const tone = j.lastStatus === "succeeded" ? "good" : j.lastStatus === "failed" ? "bad" : j.lastStatus === "missed" ? "warn" : "neutral";
    return `<tr>
  <td><code>${esc(j.jobId)}</code><div class="dim">${esc(j.name)}</div>${j.lastError ? `<div class="err">${esc(j.lastError)}</div>` : ""}</td>
  <td><code>${esc(j.scheduleKind)}</code>${j.enabled ? "" : ` ${pill("disabled", "warn")}`}</td>
  <td>${j.lastStatus ? pill(j.lastStatus, tone) : muted("never run")}</td>
  <td>${j.lastFinishedAt ? `<code>${esc(j.lastFinishedAt)}</code>` : j.lastScheduledFor ? `<span class="dim">due ${esc(j.lastScheduledFor)}</span>` : muted("-")}</td>
  <td class="n">${j.missedCount === 0 ? "0" : pill(String(j.missedCount), "warn")}</td>
  <td class="n">${j.failedCount === 0 ? "0" : pill(String(j.failedCount), "bad")}</td>
</tr>`;
  })
  .join("\n")}
</tbody></table>
<p class="note">A run the scheduler could not perform is recorded as <code>missed</code> rather than run late, so a
missed count is history, not a backlog. The seal job sweeps any unsealed days on its next successful run.</p>`;
}

function sourceTable(sources: SourceCoverage[], now: string): string {
  return `<table class="tbl"><thead><tr><th>Source</th><th>Observations</th><th>Earliest available</th><th>Latest available</th><th>Age</th></tr></thead><tbody>
${sources
  .map((s) => {
    const age = daysBehind(now as never, s.latestAvailableAt);
    return `<tr>
  <td><code>${esc(s.sourceId)}</code></td>
  <td class="n">${num(s.observations)}</td>
  <td>${s.earliestAvailableAt ? `<code>${esc(s.earliestAvailableAt.slice(0, 10))}</code>` : muted("-")}</td>
  <td>${s.latestAvailableAt ? `<code>${esc(s.latestAvailableAt.slice(0, 10))}</code>` : muted("-")}</td>
  <td>${age === undefined ? muted("-") : age > 7 ? pill(`${age}d stale`, "warn") : `<span class="dim">${age}d</span>`}</td>
</tr>`;
  })
  .join("\n")}
</tbody></table>`;
}

function card(title: string, rows: string[]): string {
  return `<div class="card"><h3>${esc(title)}</h3><dl>${rows.join("")}</dl></div>`;
}
function kv(k: string, v: string): string {
  return `<dt>${esc(k)}</dt><dd>${v}</dd>`;
}
function pill(text: string, tone: "good" | "bad" | "warn" | "neutral"): string {
  return `<span class="pill ${tone}">${esc(text)}</span>`;
}
function muted(text: string): string {
  return `<span class="dim">${esc(text)}</span>`;
}
function empty(html: string): string {
  return `<p class="empty">${html}</p>`;
}
function num(n: number): string {
  return `<span class="n">${n.toLocaleString("en-US")}</span>`;
}

/** Binary units, because this describes disk and a WAL file rather than a marketed capacity. */
export function bytes(n: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const s = i === 0 ? String(v) : v.toFixed(v < 10 ? 1 : 0);
  return `<span class="n">${s} ${units[i]}</span>`;
}

/** Escape for HTML text and quoted attribute contexts. Every dynamic value on the page goes through this. */
export function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const CSS = `
:root{--bg:#f7f7f5;--fg:#1a1a18;--dim:#6b6b66;--line:#dcdcd6;--card:#fff;--good:#0a7f3f;--bad:#b3261e;--warn:#8a5a00;--accent:#1a1a18}
@media (prefers-color-scheme:dark){:root{--bg:#131312;--fg:#eceae4;--dim:#9a9a93;--line:#2d2d2a;--card:#1c1c1a;--good:#4ec97f;--bad:#ff8a80;--warn:#e0a83c;--accent:#eceae4}}
*{box-sizing:border-box}
body{margin:0;padding:0 1rem 3rem;background:var(--bg);color:var(--fg);
font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
max-width:60rem;margin-inline:auto}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.88em}
h1{font-size:1.35rem;margin:0}
h2{font-size:1.05rem;margin:2.2rem 0 .6rem;padding-bottom:.3rem;border-bottom:1px solid var(--line)}
h3{font-size:.78rem;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);margin:0 0 .6rem}
.bar{display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;
padding:1.1rem 0 .9rem;border-bottom:2px solid var(--line);margin-bottom:1rem}
.bar .sub{margin:.2rem 0 0;color:var(--dim);font-size:.86rem}
.state{font-weight:650;letter-spacing:.04em;padding:.3rem .7rem;border-radius:999px;border:1px solid currentColor;font-size:.8rem}
.bar.ok .state{color:var(--good)}
.bar.bad .state{color:var(--bad)}
.banner{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--good);
padding:.7rem .9rem;border-radius:6px;font-size:.86rem;color:var(--dim)}
.banner strong{color:var(--fg)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));gap:.8rem;margin:1rem 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:.85rem .95rem}
dl{margin:0;display:grid;grid-template-columns:auto 1fr;gap:.35rem .8rem;align-items:baseline}
dt{color:var(--dim);font-size:.85rem;white-space:nowrap}
dd{margin:0;text-align:right;overflow-wrap:anywhere}
.tbl{width:100%;border-collapse:collapse;font-size:.87rem;background:var(--card);
border:1px solid var(--line);border-radius:8px;overflow:hidden;display:table}
.tbl th{text-align:left;font-size:.74rem;text-transform:uppercase;letter-spacing:.05em;color:var(--dim);
padding:.5rem .6rem;border-bottom:1px solid var(--line);font-weight:600}
.tbl td{padding:.55rem .6rem;border-bottom:1px solid var(--line);vertical-align:top}
.tbl tr:last-child td{border-bottom:0}
.tbl td.n,.tbl th.n{text-align:right;font-variant-numeric:tabular-nums}
.n{font-variant-numeric:tabular-nums}
.detail{color:var(--dim);overflow-wrap:anywhere}
.pill{display:inline-block;padding:.08rem .45rem;border-radius:999px;font-size:.76rem;font-weight:600;
border:1px solid currentColor;white-space:nowrap}
.pill.good{color:var(--good)}.pill.bad{color:var(--bad)}.pill.warn{color:var(--warn)}.pill.neutral{color:var(--dim)}
.dim{color:var(--dim)}
.err{color:var(--bad);font-size:.78rem;margin-top:.25rem;overflow-wrap:anywhere}
.empty{background:var(--card);border:1px dashed var(--line);border-radius:8px;padding:.9rem;color:var(--dim);margin:.4rem 0}
.empty strong{color:var(--fg)}
.note{color:var(--dim);font-size:.82rem;margin:.5rem 0 0}
footer{margin-top:2.5rem;padding-top:.9rem;border-top:1px solid var(--line);color:var(--dim);font-size:.8rem}
/* Tables become the page's only wide content; let them scroll rather than the body. */
@media (max-width:34rem){
  h1{font-size:1.15rem}
  dd{text-align:left}
  dl{grid-template-columns:1fr;gap:.1rem .5rem}
  dt{margin-top:.4rem}
  .tbl{display:block;overflow-x:auto;white-space:nowrap}
  .tbl .detail,.tbl .err{white-space:normal}
}
`;
