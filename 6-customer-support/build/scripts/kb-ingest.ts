import { readFile } from 'node:fs/promises';
import { embedderFromEnv } from '../lib/kb/embed.ts';
import { ingestKb } from '../lib/kb/search.ts';
import { pool } from '../lib/db.ts';

/** Chunks the approved knowledge base and embeds only what changed. Safe to re-run. */
const md = await readFile(new URL('../../assets/relaypay-knowledge-base.md', import.meta.url), 'utf8');
const e = embedderFromEnv();
console.log({ model: e.model, ...(await ingestKb(md, e)) });
await pool().end();
