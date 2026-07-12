// Test de couverture du lexique Notion→Markdown sur une vraie page.
// Usage: NOTION_TOKEN=... node scripts/notion-coverage-test.mjs <pageId>
// Convertisseur pur (indépendant d'Obsidian) — sera porté ensuite dans src/lexicon.ts.

const TOKEN = process.env.NOTION_TOKEN;
const NV = "2022-06-28";
const PAGE = process.argv[2] || "39ae3846-d8d7-812d-a01d-fe2299038bb1";

const coverage = new Map(); // type -> { verdict, note }
const mark = (type, verdict, note = "") => { if (!coverage.has(type)) coverage.set(type, { verdict, note }); };

async function api(path) {
  const r = await fetch("https://api.notion.com/v1" + path, {
    headers: { Authorization: "Bearer " + TOKEN, "Notion-Version": NV },
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

// Récupère les blocs + leurs enfants (récursif)
async function getBlocks(blockId) {
  const out = [];
  let cursor;
  do {
    const q = cursor ? `?start_cursor=${cursor}&page_size=100` : `?page_size=100`;
    const d = await api(`/blocks/${blockId}/children${q}`);
    for (const b of d.results) {
      if (b.has_children) b._children = await getBlocks(b.id);
      out.push(b);
    }
    cursor = d.has_more ? d.next_cursor : null;
  } while (cursor);
  return out;
}

// --- rich text → markdown inline (annotations + liens) ---
function rich(arr = []) {
  return arr.map((t) => {
    let s = t.plain_text ?? t.text?.content ?? "";
    const a = t.annotations ?? {};
    if (a.code) s = "`" + s + "`";
    if (a.bold) s = "**" + s + "**";
    if (a.italic) s = "*" + s + "*";
    if (a.strikethrough) s = "~~" + s + "~~";
    const href = t.href ?? t.text?.link?.url;
    if (href) s = `[${s}](${href})`;
    return s;
  }).join("");
}

const CALLOUT_COLOR = (c = "") => c.replace("_background", "");

// --- convertisseur principal ---
function convert(blocks, depth = 0) {
  const lines = [];
  const pad = "  ".repeat(depth);
  let numIdx = 0;

  for (const b of blocks) {
    const t = b.type;
    const d = b[t] ?? {};
    const rt = d.rich_text ?? [];
    if (t !== "numbered_list_item") numIdx = 0;

    switch (t) {
      case "heading_1":
      case "heading_2":
      case "heading_3": {
        const lvl = { heading_1: "#", heading_2: "##", heading_3: "###" }[t];
        if (d.is_toggleable) {
          // Toggle heading → <details> (lexique : repliable + round-trippable)
          mark(t + " (toggle)", "lexique", "titre repliable → <details>");
          lines.push(`<details><summary>${lvl} ${rich(rt)}</summary>`, "");
          if (b._children) lines.push(convert(b._children, depth));
          lines.push("", "</details>");
        } else {
          mark(t, "natif");
          lines.push(`${lvl} ${rich(rt)}`);
        }
        break;
      }
      case "paragraph":
        mark(t, "natif");
        lines.push(pad + rich(rt));
        break;
      case "bulleted_list_item":
        mark(t, "natif");
        lines.push(`${pad}- ${rich(rt)}`);
        if (b._children) lines.push(convert(b._children, depth + 1));
        break;
      case "numbered_list_item":
        mark(t, "natif");
        lines.push(`${pad}${++numIdx}. ${rich(rt)}`);
        if (b._children) lines.push(convert(b._children, depth + 1));
        break;
      case "to_do":
        mark(t, "natif");
        lines.push(`${pad}- [${d.checked ? "x" : " "}] ${rich(rt)}`);
        break;
      case "quote":
        mark(t, "natif");
        lines.push(`> ${rich(rt)}`);
        break;
      case "callout": {
        // Lexique : callout Notion → callout Obsidian (emoji + couleur préservés en meta)
        mark(t, "lexique", "→ > [!note] Obsidian (emoji/couleur conservés)");
        const emoji = d.icon?.emoji ? d.icon.emoji + " " : "";
        lines.push(`> [!note] ${emoji}${rich(rt)}`);
        if (b._children) for (const l of convert(b._children, 0).split("\n")) lines.push("> " + l);
        break;
      }
      case "code":
        mark(t, "natif");
        lines.push("```" + (d.language ?? ""), rich(rt), "```");
        break;
      case "divider":
        mark(t, "natif");
        lines.push("---");
        break;
      case "toggle": {
        // Lexique : toggle block → <details> (round-trippable + rendu Obsidian)
        mark(t, "lexique", "→ <details><summary>");
        lines.push(`<details><summary>${rich(rt)}</summary>`, "");
        if (b._children) lines.push(convert(b._children, depth));
        lines.push("", "</details>");
        break;
      }
      case "table": {
        mark(t, "natif", "→ tableau Markdown");
        const rows = (b._children ?? []).filter((r) => r.type === "table_row");
        rows.forEach((r, i) => {
          const cells = r.table_row.cells.map((c) => rich(c));
          lines.push(`| ${cells.join(" | ")} |`);
          if (i === 0 && d.has_column_header) lines.push(`| ${cells.map(() => "---").join(" | ")} |`);
        });
        break;
      }
      case "image": {
        mark(t, "natif", "→ ![](url) (à terme : téléchargé en local)");
        const url = d.type === "external" ? d.external?.url : d.file?.url;
        lines.push(`![${rich(d.caption ?? [])}](${url})`);
        break;
      }
      case "equation":
        mark(t, "natif", "→ $$…$$");
        lines.push(`$$${d.expression ?? ""}$$`);
        break;
      case "column_list": {
        // Lexique : layout colonnes → contenu séquentiel + marqueur (layout non représentable en MD)
        mark(t, "lexique", "colonnes → contenu séquentiel + marqueur <!--col-->");
        for (const col of b._children ?? []) {
          lines.push("<!-- col -->");
          if (col._children) lines.push(convert(col._children, depth));
        }
        break;
      }
      case "bookmark":
      case "embed":
      case "video":
      case "file":
      case "pdf": {
        mark(t, "lexique", "→ lien Markdown");
        const url = d.url ?? d.external?.url ?? d.file?.url ?? "";
        lines.push(`[${t}: ${url}](${url})`);
        break;
      }
      default:
        // Rien perdu en silence : marqueur visible (comme Notional)
        mark(t, "missing", "→ > [!missing]");
        lines.push(`> [!missing] Bloc Notion non pris en charge : \`${t}\``);
        break;
    }
  }
  return lines.join("\n");
}

// --- run ---
const blocks = await getBlocks(PAGE);
const md = convert(blocks);

console.log("========== MARKDOWN PRODUIT ==========\n");
console.log(md);
console.log("\n========== CATALOGUE DE COUVERTURE ==========\n");
const order = { natif: 0, lexique: 1, missing: 2 };
const icon = { natif: "🟢 natif   ", lexique: "🟡 lexique ", missing: "🔴 manquant" };
[...coverage.entries()].sort((a, b) => order[a[1].verdict] - order[b[1].verdict]).forEach(([type, v]) => {
  console.log(`${icon[v.verdict]}  ${type.padEnd(22)} ${v.note}`);
});
const n = { natif: 0, lexique: 0, missing: 0 };
for (const v of coverage.values()) n[v.verdict]++;
console.log(`\nTotal types rencontrés : ${coverage.size}  →  🟢 ${n.natif} natifs · 🟡 ${n.lexique} via lexique · 🔴 ${n.missing} manquants`);
