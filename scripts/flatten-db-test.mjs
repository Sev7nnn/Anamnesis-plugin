// Démo option B : aplatir une database Notion en 1 note/ligne + vue reconstituée.
// Lecture seule côté Notion. Écrit dans un vault de test LOCAL.
// Usage: NOTION_TOKEN=... node scripts/flatten-db-test.mjs "TODO Thèse"

import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";

const TOKEN = process.env.NOTION_TOKEN;
const NV = "2022-06-28";
const DB_NAME = process.argv[2] || "TODO Thèse";
const OUT = path.join(process.env.HOME, "Anamnesis-plugin", ".test-vault");

async function api(p, method = "GET", body) {
  const r = await fetch("https://api.notion.com/v1" + p, {
    method,
    headers: { Authorization: "Bearer " + TOKEN, "Notion-Version": NV, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}
const plain = (arr = []) => arr.map((t) => t.plain_text ?? t.text?.content ?? "").join("");
const slug = (s) => (s || "sans-titre").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "sans-titre";

// propriété Notion -> valeur frontmatter
function prop(p) {
  switch (p?.type) {
    case "title": return plain(p.title);
    case "rich_text": return plain(p.rich_text);
    case "select": return p.select?.name ?? "";
    case "status": return p.status?.name ?? "";
    case "multi_select": return p.multi_select.map((s) => s.name);
    case "date": return p.date?.start ?? "";
    case "people": return p.people.map((x) => x.name ?? x.id);
    case "checkbox": return p.checkbox;
    case "number": return p.number ?? "";
    case "url": return p.url ?? "";
    default: return "";
  }
}
function yaml(obj) {
  const esc = (v) => (/[:#\-?{}\[\],&*!|>'"%@`]/.test(v) || v === "") ? JSON.stringify(v) : v;
  const line = (k, v) => Array.isArray(v)
    ? `${k}:${v.length ? "\n" + v.map((x) => `  - ${esc(String(x))}`).join("\n") : " []"}`
    : `${k}: ${typeof v === "boolean" || typeof v === "number" ? v : esc(String(v))}`;
  return "---\n" + Object.entries(obj).map(([k, v]) => line(k, v)).join("\n") + "\n---\n";
}

// mini-convertisseur de blocs (corps de la ligne-page)
async function bodyOf(pageId) {
  const d = await api(`/blocks/${pageId}/children?page_size=100`);
  const out = [];
  for (const b of d.results) {
    const t = b.type, x = b[t] ?? {}, rt = plain(x.rich_text ?? []);
    if (t === "paragraph") out.push(rt);
    else if (t === "heading_1") out.push("# " + rt);
    else if (t === "heading_2") out.push("## " + rt);
    else if (t === "heading_3") out.push("### " + rt);
    else if (t === "bulleted_list_item") out.push("- " + rt);
    else if (t === "numbered_list_item") out.push("1. " + rt);
    else if (t === "to_do") out.push(`- [${x.checked ? "x" : " "}] ${rt}`);
    else if (t === "quote") out.push("> " + rt);
    else if (t === "code") out.push("```" + (x.language ?? ""), rt, "```");
    else if (t === "toggle") out.push(`<details><summary>${rt}</summary></details>`);
    else if (t === "callout") out.push(`> [!note] ${x.icon?.emoji ?? ""} ${rt}`);
  }
  return out.join("\n\n");
}

// --- run ---
const s = await api("/search", "POST", { query: DB_NAME, filter: { property: "object", value: "database" } });
const db = s.results.find((r) => plain(r.title).trim() === DB_NAME) || s.results[0];
if (!db) throw new Error("Database introuvable : " + DB_NAME);
const dbTitle = plain(db.title);
console.log(`Database : « ${dbTitle} »  (${db.id})`);
console.log(`Propriétés : ${Object.keys(db.properties).join(", ")}\n`);

const rows = [];
let cursor;
do {
  const q = await api(`/databases/${db.id}/query`, "POST", cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 });
  rows.push(...q.results);
  cursor = q.has_more ? q.next_cursor : null;
} while (cursor);
console.log(`${rows.length} lignes → ${rows.length} notes\n`);

// détecter titre + champ statut (pour la vue)
const titleKey = Object.keys(db.properties).find((k) => db.properties[k].type === "title");
const statusKey = Object.keys(db.properties).find((k) => ["status", "select"].includes(db.properties[k].type)
  && /statut|status|état|etat/i.test(k)) || Object.keys(db.properties).find((k) => ["status", "select"].includes(db.properties[k].type));

const folder = path.join(OUT, slug(dbTitle));
await rm(OUT, { recursive: true, force: true });
await mkdir(folder, { recursive: true });

let sample = "";
for (const row of rows) {
  const props = row.properties;
  const title = prop(props[titleKey]) || "Sans titre";
  const fm = { notion_id: row.id, notion_url: row.url, notion_last_edited: row.last_edited_time };
  for (const [k, v] of Object.entries(props)) {
    if (k === titleKey) { fm.title = title; continue; }
    const val = prop(v);
    if (val !== "" && !(Array.isArray(val) && val.length === 0)) fm[k.toLowerCase().replace(/\s+/g, "_")] = val;
  }
  const body = await bodyOf(row.id);
  const content = yaml(fm) + "\n# " + title + (body ? "\n\n" + body : "") + "\n";
  const file = path.join(folder, slug(title) + ".md");
  await writeFile(file, content);
  if (!sample) sample = content;
}

// vue reconstituée : Dataview groupé par statut (approx Kanban) + note sur Bases
if (statusKey) {
  const view = `---
type: vue
---
# ${dbTitle} — Vue (reconstituée)

> Vue Kanban/tableau rebâtie par-dessus les notes du dossier. En natif Obsidian on utiliserait un fichier \`.base\` ; ci-dessous l'équivalent Dataview (portable).

\`\`\`dataview
TABLE ${statusKey.toLowerCase().replace(/\s+/g, "_")} AS "Statut", ${Object.keys(db.properties).filter(k => k !== titleKey && k !== statusKey).slice(0, 3).map(k => k.toLowerCase().replace(/\s+/g, "_")).join(", ")}
FROM "${slug(dbTitle)}"
GROUP BY ${statusKey.toLowerCase().replace(/\s+/g, "_")}
\`\`\`
`;
  await writeFile(path.join(folder, "_Vue.md"), view);
}

console.log("========== ARBORESCENCE PRODUITE ==========");
const { execSync } = await import("node:child_process");
console.log(execSync(`ls -1 "${folder}"`).toString());
console.log("========== EXEMPLE DE NOTE (1 ligne) ==========\n");
console.log(sample);
console.log("========== FICHIER DE VUE (_Vue.md) ==========\n");
console.log(execSync(`cat "${path.join(folder, "_Vue.md")}" 2>/dev/null || echo '(pas de champ statut détecté)'`).toString());
