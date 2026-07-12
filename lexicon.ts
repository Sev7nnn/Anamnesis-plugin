/**
 * lexicon.ts — Lexique de traduction Notion → Markdown (Anamnesis).
 *
 * Convertisseur PUR (aucune dépendance Obsidian) : source unique des règles
 * de traduction, réutilisée par le plugin et par les harnais de test.
 *
 * Entrée : un arbre de blocs Notion dont les enfants sont attachés sous
 * `block.children` (le code appelant est responsable de récupérer récursivement
 * les enfants via l'API Notion).
 *
 * Conventions du lexique (v1) :
 *   - toggle / toggle-heading  → <details><summary>…</summary>…</details>
 *   - callout                  → > [!note] {emoji} …
 *   - colonnes (column_list)   → contenu séquentiel + marqueur <!-- col -->
 *   - bloc inconnu             → > [!missing] … (jamais perdu en silence)
 */

export interface NBlock {
  type: string;
  children?: NBlock[];
  // le reste des propriétés Notion est dynamique
  [key: string]: unknown;
}

interface RichText {
  plain_text?: string;
  text?: { content?: string; link?: { url?: string } | null };
  href?: string | null;
  annotations?: {
    bold?: boolean;
    italic?: boolean;
    code?: boolean;
    strikethrough?: boolean;
  };
}

/** Texte riche Notion → Markdown inline (annotations + liens). */
export function richText(items: RichText[] = []): string {
  return items
    .map((t) => {
      let s = t.plain_text ?? t.text?.content ?? '';
      const a = t.annotations ?? {};
      if (a.code) s = '`' + s + '`';
      if (a.bold) s = '**' + s + '**';
      if (a.italic) s = '*' + s + '*';
      if (a.strikethrough) s = '~~' + s + '~~';
      const href = t.href ?? t.text?.link?.url;
      if (href) s = `[${s}](${href})`;
      return s;
    })
    .join('');
}

const data = (b: NBlock): Record<string, any> => (b[b.type] as Record<string, any>) ?? {};
const rt = (b: NBlock): RichText[] => (data(b).rich_text as RichText[]) ?? [];

/** Un arbre de blocs Notion → Markdown. */
export function blocksToMarkdown(blocks: NBlock[] = [], depth = 0): string {
  const lines: string[] = [];
  const pad = '  '.repeat(depth);
  let numIdx = 0;

  for (const b of blocks) {
    const t = b.type;
    const d = data(b);
    if (t !== 'numbered_list_item') numIdx = 0;

    switch (t) {
      case 'heading_1':
      case 'heading_2':
      case 'heading_3': {
        const lvl = t === 'heading_1' ? '#' : t === 'heading_2' ? '##' : '###';
        if (d.is_toggleable) {
          lines.push(`<details><summary>${lvl} ${richText(rt(b))}</summary>`, '');
          if (b.children?.length) lines.push(blocksToMarkdown(b.children, depth));
          lines.push('', '</details>');
        } else {
          lines.push(`${lvl} ${richText(rt(b))}`);
        }
        break;
      }
      case 'paragraph':
        lines.push(pad + richText(rt(b)));
        break;
      case 'bulleted_list_item':
        lines.push(`${pad}- ${richText(rt(b))}`);
        if (b.children?.length) lines.push(blocksToMarkdown(b.children, depth + 1));
        break;
      case 'numbered_list_item':
        lines.push(`${pad}${++numIdx}. ${richText(rt(b))}`);
        if (b.children?.length) lines.push(blocksToMarkdown(b.children, depth + 1));
        break;
      case 'to_do':
        lines.push(`${pad}- [${d.checked ? 'x' : ' '}] ${richText(rt(b))}`);
        break;
      case 'quote':
        lines.push(`> ${richText(rt(b))}`);
        break;
      case 'callout': {
        const emoji = d.icon?.emoji ? d.icon.emoji + ' ' : '';
        lines.push(`> [!note] ${emoji}${richText(rt(b))}`);
        if (b.children?.length) {
          for (const l of blocksToMarkdown(b.children).split('\n')) lines.push('> ' + l);
        }
        break;
      }
      case 'code':
        lines.push('```' + (d.language ?? ''), richText(rt(b)), '```');
        break;
      case 'divider':
        lines.push('---');
        break;
      case 'toggle':
        lines.push(`<details><summary>${richText(rt(b))}</summary>`, '');
        if (b.children?.length) lines.push(blocksToMarkdown(b.children, depth));
        lines.push('', '</details>');
        break;
      case 'table': {
        const rows = (b.children ?? []).filter((r) => r.type === 'table_row');
        rows.forEach((r, i) => {
          const cells = (data(r).cells as RichText[][]).map((c) => richText(c));
          lines.push(`| ${cells.join(' | ')} |`);
          if (i === 0 && d.has_column_header) {
            lines.push(`| ${cells.map(() => '---').join(' | ')} |`);
          }
        });
        break;
      }
      case 'image': {
        const url = d.type === 'external' ? d.external?.url : d.file?.url;
        lines.push(`![${richText((d.caption as RichText[]) ?? [])}](${url})`);
        break;
      }
      case 'equation':
        lines.push(`$$${d.expression ?? ''}$$`);
        break;
      case 'column_list':
        for (const col of b.children ?? []) {
          lines.push('<!-- col -->');
          if (col.children?.length) lines.push(blocksToMarkdown(col.children, depth));
        }
        break;
      case 'bookmark':
      case 'embed':
      case 'video':
      case 'file':
      case 'pdf': {
        const url = d.url ?? d.external?.url ?? d.file?.url ?? '';
        lines.push(`[${t}: ${url}](${url})`);
        break;
      }
      default:
        // Rien perdu en silence.
        lines.push(`> [!missing] Bloc Notion non pris en charge : \`${t}\``);
        break;
    }
  }

  return lines.join('\n');
}

/* ==========================================================================
 * SENS INVERSE : Markdown → blocs Notion (lexique inverse, pour vault→Notion)
 * ======================================================================== */

type NotionRT = { type: 'text'; text: { content: string; link?: { url: string } | null }; annotations?: Record<string, boolean> };

/** Markdown inline → rich_text Notion (gras/italique/code/barré/liens). */
export function inlineToRich(text: string): NotionRT[] {
  const out: NotionRT[] = [];
  const re = /(\[([^\]]+)\]\(([^)]+)\))|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(`([^`]+)`)|(~~([^~]+)~~)/g;
  const push = (content: string, ann: Record<string, boolean>, link?: string) => {
    if (!content) return;
    const o: NotionRT = { type: 'text', text: { content, link: link ? { url: link } : null } };
    if (Object.keys(ann).length) o.annotations = ann;
    out.push(o);
  };
  let last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) push(text.slice(last, m.index), {});
    if (m[1]) push(m[2], {}, m[3]);
    else if (m[4]) push(m[5], { bold: true });
    else if (m[6]) push(m[7], { italic: true });
    else if (m[8]) push(m[9], { code: true });
    else if (m[10]) push(m[11], { strikethrough: true });
    last = re.lastIndex;
  }
  if (last < text.length) push(text.slice(last), {});
  return out.length ? out : [{ type: 'text', text: { content: text } }];
}

const para = (t: string): any => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: inlineToRich(t) } });

/** Markdown → blocs Notion (create). Réciproque de blocksToMarkdown pour notre lexique. */
export function mdToNotionBlocks(md: string): any[] {
  const lines = md.replace(/\r/g, '').split('\n');
  const blocks: any[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === '') { i++; continue; }

    // Bloc de code ```
    if (trimmed.startsWith('```')) {
      const lang = trimmed.slice(3).trim();
      const buf: string[] = []; i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) { buf.push(lines[i]); i++; }
      i++; // ferme ```
      blocks.push({ object: 'block', type: 'code', code: { rich_text: [{ type: 'text', text: { content: buf.join('\n') } }], language: lang || 'plain text' } });
      continue;
    }

    // Toggle / toggle-heading : <details><summary>…</summary> … </details>
    if (trimmed.startsWith('<details>')) {
      const sum = (trimmed.match(/<summary>(.*?)<\/summary>/)?.[1] ?? '').trim();
      const buf: string[] = []; i++;
      while (i < lines.length && lines[i].trim() !== '</details>') { buf.push(lines[i]); i++; }
      i++; // ferme </details>
      const children = mdToNotionBlocks(buf.join('\n'));
      const hMatch = sum.match(/^(#{1,3})\s+(.*)$/);
      if (hMatch) {
        const lvl = hMatch[1].length as 1 | 2 | 3;
        const key = `heading_${lvl}`;
        blocks.push({ object: 'block', type: key, [key]: { rich_text: inlineToRich(hMatch[2]), is_toggleable: true, children } });
      } else {
        blocks.push({ object: 'block', type: 'toggle', toggle: { rich_text: inlineToRich(sum), children } });
      }
      continue;
    }

    // Callout Obsidian : > [!note] … (+ lignes « > » suivantes)
    const callout = trimmed.match(/^>\s*\[!(\w+)\][+-]?\s*(.*)$/);
    if (callout) {
      const emojiM = callout[2].match(/^(\p{Emoji})\s*(.*)$/u);
      const emoji = emojiM ? emojiM[1] : undefined;
      const head = emojiM ? emojiM[2] : callout[2];
      const inner: string[] = []; i++;
      while (i < lines.length && lines[i].trim().startsWith('>')) { inner.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      const b: any = { object: 'block', type: 'callout', callout: { rich_text: inlineToRich(head) } };
      if (emoji) b.callout.icon = { type: 'emoji', emoji };
      const children = mdToNotionBlocks(inner.join('\n'));
      if (children.length) b.callout.children = children;
      blocks.push(b);
      continue;
    }

    // Citation
    if (trimmed.startsWith('> ')) { blocks.push({ object: 'block', type: 'quote', quote: { rich_text: inlineToRich(trimmed.slice(2)) } }); i++; continue; }

    // Divider
    if (trimmed === '---') { blocks.push({ object: 'block', type: 'divider', divider: {} }); i++; continue; }

    // Image ![alt](url)
    const img = trimmed.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (img) { blocks.push({ object: 'block', type: 'image', image: { type: 'external', external: { url: img[2] } } }); i++; continue; }

    // Équation $$…$$
    const eq = trimmed.match(/^\$\$(.+)\$\$$/);
    if (eq) { blocks.push({ object: 'block', type: 'equation', equation: { expression: eq[1] } }); i++; continue; }

    // Marqueur de colonne : ignoré (contenu rendu séquentiellement)
    if (trimmed === '<!-- col -->') { i++; continue; }

    // Titres
    const h = trimmed.match(/^(#{1,3})\s+(.*)$/);
    if (h) { const lvl = h[1].length; const key = `heading_${lvl}`; blocks.push({ object: 'block', type: key, [key]: { rich_text: inlineToRich(h[2]) } }); i++; continue; }

    // Tableau Markdown
    if (/^\|.*\|$/.test(trimmed)) {
      const rows: string[] = [];
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) { rows.push(lines[i].trim()); i++; }
      const parsed = rows.filter(r => !/^\|[\s:|-]+\|$/.test(r)).map(r => r.slice(1, -1).split('|').map(c => c.trim()));
      const width = parsed[0]?.length ?? 1;
      blocks.push({
        object: 'block', type: 'table',
        table: {
          table_width: width, has_column_header: true, has_row_header: false,
          children: parsed.map(cells => ({ object: 'block', type: 'table_row', table_row: { cells: cells.map(c => inlineToRich(c)) } })),
        },
      });
      continue;
    }

    // To-do
    const todo = trimmed.match(/^-\s+\[([ xX])\]\s+(.*)$/);
    if (todo) { blocks.push({ object: 'block', type: 'to_do', to_do: { rich_text: inlineToRich(todo[2]), checked: todo[1].toLowerCase() === 'x' } }); i++; continue; }

    // Puces
    const bul = trimmed.match(/^[-*]\s+(.*)$/);
    if (bul) { blocks.push({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: inlineToRich(bul[1]) } }); i++; continue; }

    // Numéros
    const num = trimmed.match(/^\d+\.\s+(.*)$/);
    if (num) { blocks.push({ object: 'block', type: 'numbered_list_item', numbered_list_item: { rich_text: inlineToRich(num[1]) } }); i++; continue; }

    // Défaut : paragraphe
    blocks.push(para(trimmed));
    i++;
  }

  return blocks;
}
