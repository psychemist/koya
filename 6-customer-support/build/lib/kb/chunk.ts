import { sha256 } from '../hash.ts';
export type KbChunk = { id: string; source_title: string; heading: string; content: string; source_summary: string; content_hash: string };

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
function firstSentence(content: string): string {
  const flat = content.replace(/^\s*[-*]\s+/gm, '').replace(/\s+/g, ' ').trim();
  const m = flat.match(/^(.+?[.!?])(\s|$)/);
  return (m ? m[1] : flat).slice(0, 200);
}

export function chunkMarkdown(md: string): KbChunk[] {
  const out: KbChunk[] = [];
  let h2 = '', h3 = '', buf: string[] = [];
  const flush = () => {
    const content = buf.join('\n').trim(); buf = [];
    if (!h2 || !content) return;
    const heading = h3 || h2;
    out.push({ id: `${slug(h2)}/${slug(h3 || 'overview')}`, source_title: h2, heading, content,
      source_summary: firstSentence(content), content_hash: sha256(`${h2}\n${heading}\n${content}`) });
  };
  for (const line of md.split(/\r?\n/)) {
    if (/^###\s+/.test(line)) { flush(); h3 = line.replace(/^###\s+/, '').trim(); continue; }
    if (/^##\s+/.test(line)) { flush(); h2 = line.replace(/^##\s+/, '').trim(); h3 = ''; continue; }
    if (/^#\s+/.test(line)) { flush(); h2 = ''; h3 = ''; continue; }
    if (h2) buf.push(line);
  }
  flush();
  return out;
}
