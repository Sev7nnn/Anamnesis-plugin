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
