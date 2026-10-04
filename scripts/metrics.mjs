// Generates profile metric cards (metrics/*.svg) from the GitHub GraphQL API.
// Counts private repos and contributions, which the public stat card services can't see.
// Only aggregate numbers are rendered; repo names never appear in the output.
//
// Usage: METRICS_TOKEN=<token> node scripts/metrics.mjs

import { mkdir, writeFile } from "node:fs/promises";

const TOKEN = process.env.METRICS_TOKEN;
if (!TOKEN) {
  console.error("METRICS_TOKEN is not set.");
  process.exit(1);
}

const OUT_DIR = new URL("../metrics/", import.meta.url);

const THEME = {
  bg: "#0d1117",
  brand: "#0a9efa",
  text: "#c9d1d9",
  muted: "#8b949e",
  track: "#21262d",
  font: "'Segoe UI', Ubuntu, 'Helvetica Neue', Sans-Serif",
};

const W = 400;
const H = 140;
const PAD = 25;
const TOP_LANGS = 6;

async function gql(query, variables = {}) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  const body = await res.json();
  if (body.errors) throw new Error(`GitHub API errors: ${JSON.stringify(body.errors)}`);
  return body.data;
}

async function fetchCalendar() {
  // No from/to: GitHub returns the trailing year up to today.
  const data = await gql(`{
    viewer {
      contributionsCollection {
        contributionCalendar {
          totalContributions
          weeks { contributionDays { date contributionCount } }
        }
      }
    }
  }`);
  return data.viewer.contributionsCollection.contributionCalendar;
}

async function fetchRepos() {
  const repos = [];
  let after = null;
  do {
    const data = await gql(
      `query($after: String) {
        viewer {
          repositories(first: 100, after: $after, ownerAffiliations: OWNER, isFork: false) {
            pageInfo { hasNextPage endCursor }
            nodes {
              pushedAt
              languages(first: 20) { edges { size node { name color } } }
            }
          }
        }
      }`,
      { after },
    );
    const page = data.viewer.repositories;
    repos.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return repos;
}

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const fmt = (n) => n.toLocaleString("en-US");

// Some linguist colors (e.g. PowerShell #012456) vanish on the dark background; lift them toward white.
function readable(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex ?? "")) return THEME.muted;
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const lum = rgb
    .map((c) => c / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    .reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
  if (lum >= 0.08) return hex;
  const mix = 0.5;
  return `#${rgb.map((c) => Math.round(c + (255 - c) * mix).toString(16).padStart(2, "0")).join("")}`;
}

function card(title, body, ariaLabel) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(ariaLabel)}">
  <style>
    text { font-family: ${THEME.font}; }
    .title { font-size: 18px; font-weight: 600; fill: ${THEME.brand}; }
    .big { font-size: 34px; font-weight: 700; fill: ${THEME.text}; }
    .label { font-size: 12px; fill: ${THEME.muted}; }
    .value { font-size: 13px; font-weight: 600; fill: ${THEME.text}; }
    .lang { font-size: 12px; fill: ${THEME.text}; }
  </style>
  <rect width="${W}" height="${H}" rx="4.5" fill="${THEME.bg}"/>
  <text x="${PAD}" y="35" class="title">${esc(title)}</text>
${body}
</svg>
`;
}

function activityCard(calendar, repos) {
  const days = calendar.weeks.flatMap((w) => w.contributionDays);
  const total = calendar.totalContributions;
  const activeDays = days.filter((d) => d.contributionCount > 0).length;

  const byMonth = new Map();
  for (const d of days) {
    const key = d.date.slice(0, 7);
    byMonth.set(key, (byMonth.get(key) ?? 0) + d.contributionCount);
  }
  const [bestKey] = [...byMonth].sort((a, b) => b[1] - a[1])[0] ?? ["-"];
  const bestMonth =
    bestKey === "-"
      ? "-"
      : new Date(`${bestKey}-01T00:00:00Z`).toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

  const yearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
  const activeRepos = repos.filter((r) => r.pushedAt && Date.parse(r.pushedAt) >= yearAgo).length;

  // Weekly sparkline along the bottom edge.
  const weekly = calendar.weeks.map((w) => w.contributionDays.reduce((s, d) => s + d.contributionCount, 0));
  const max = Math.max(1, ...weekly);
  const x0 = PAD;
  const x1 = W - PAD;
  const yBase = 130;
  const amp = 18;
  const step = (x1 - x0) / Math.max(1, weekly.length - 1);
  const pts = weekly.map((v, i) => `${(x0 + i * step).toFixed(1)},${(yBase - (v / max) * amp).toFixed(1)}`);
  const line = `M${pts.join(" L")}`;
  const area = `${line} L${x1},${yBase} L${x0},${yBase} Z`;

  const stats = [
    ["Active days", fmt(activeDays)],
    ["Repos pushed to", fmt(activeRepos)],
    ["Busiest month", bestMonth],
  ];
  const statRows = stats
    .map(
      ([label, value], i) =>
        `  <text x="215" y="${62 + i * 20}" class="label">${esc(label)}</text>\n` +
        `  <text x="${W - PAD}" y="${62 + i * 20}" class="value" text-anchor="end">${esc(value)}</text>`,
    )
    .join("\n");

  const body = `  <text x="${PAD}" y="80" class="big">${fmt(total)}</text>
  <text x="${PAD}" y="99" class="label">contributions, incl. private</text>
${statRows}
  <path d="${area}" fill="${THEME.brand}" fill-opacity="0.15"/>
  <path d="${line}" fill="none" stroke="${THEME.brand}" stroke-width="1.5" stroke-linejoin="round"/>`;

  return card(
    "Activity, last 12 months",
    body,
    `${fmt(total)} contributions in the last 12 months, ${activeDays} active days, ${activeRepos} repos pushed to, busiest month ${bestMonth}`,
  );
}

function languagesCard(repos) {
  const totals = new Map();
  for (const r of repos) {
    for (const { size, node } of r.languages.edges) {
      const cur = totals.get(node.name) ?? { size: 0, color: readable(node.color) };
      cur.size += size;
      totals.set(node.name, cur);
    }
  }
  const sum = [...totals.values()].reduce((s, l) => s + l.size, 0) || 1;
  const sorted = [...totals].map(([name, l]) => ({ name, ...l })).sort((a, b) => b.size - a.size);
  const top = sorted.slice(0, TOP_LANGS);
  const rest = sorted.slice(TOP_LANGS).reduce((s, l) => s + l.size, 0);
  if (rest > 0) top.push({ name: "Other", size: rest, color: THEME.muted });

  // Stacked bar, clipped to rounded ends.
  const barX = PAD;
  const barW = W - PAD * 2;
  let x = barX;
  const segs = top
    .map((l) => {
      const w = (l.size / sum) * barW;
      const seg = `    <rect x="${x.toFixed(2)}" y="50" width="${w.toFixed(2)}" height="8" fill="${l.color ?? THEME.muted}"/>`;
      x += w;
      return seg;
    })
    .join("\n");

  // Legend: two columns, filled top to bottom (up to 4 rows when "Other" is present).
  const rows = Math.ceil(top.length / 2);
  const legend = top
    .map((l, i) => {
      const col = Math.floor(i / rows);
      const row = i % rows;
      const lx = PAD + col * 180;
      const ly = 80 + row * 17;
      const pct = ((l.size / sum) * 100).toFixed(1);
      return (
        `  <circle cx="${lx + 5}" cy="${ly - 4}" r="5" fill="${l.color ?? THEME.muted}"/>\n` +
        `  <text x="${lx + 16}" y="${ly}" class="lang">${esc(l.name)} <tspan fill="${THEME.muted}">${pct}%</tspan></text>`
      );
    })
    .join("\n");

  const body = `  <clipPath id="bar"><rect x="${barX}" y="50" width="${barW}" height="8" rx="4"/></clipPath>
  <rect x="${barX}" y="50" width="${barW}" height="8" rx="4" fill="${THEME.track}"/>
  <g clip-path="url(#bar)">
${segs}
  </g>
${legend}`;

  const summary = top.map((l) => `${l.name} ${((l.size / sum) * 100).toFixed(1)}%`).join(", ");
  return card("Languages, all repos", body, `Languages across all repos: ${summary}`);
}

const [calendar, repos] = await Promise.all([fetchCalendar(), fetchRepos()]);
await mkdir(OUT_DIR, { recursive: true });
await writeFile(new URL("activity.svg", OUT_DIR), activityCard(calendar, repos));
await writeFile(new URL("languages.svg", OUT_DIR), languagesCard(repos));
console.log(`Wrote metrics for ${repos.length} repos, ${calendar.totalContributions} contributions.`);
