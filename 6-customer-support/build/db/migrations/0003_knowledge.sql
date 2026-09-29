create extension if not exists vector with schema extensions;

create table if not exists public.kb_chunks (
  id              text primary key,             -- 'frequently-asked-questions/how-does-relaypay-charge-fees'
  source_title    text not null,                -- the ## heading
  heading         text not null,                -- the ### heading, or the ## heading for an overview
  content         text not null,
  source_summary  text not null,                -- first sentence, derived not generated
  content_hash    text not null,
  embedding       extensions.vector(1024),
  embedding_model text,
  -- The heading is weighted A: an FAQ whose question matches the caller's question should outrank a chunk
  -- that only shares words in its body. Content keeps the default weight, so KB_FTS_STRONG keeps its scale.
  fts             tsvector generated always as (setweight(to_tsvector('english', heading), 'A') || to_tsvector('english', content)) stored,
  retired_at      timestamptz,
  updated_at      timestamptz not null default now()
);
create index if not exists kb_chunks_embedding on public.kb_chunks using hnsw (embedding extensions.vector_cosine_ops);
create index if not exists kb_chunks_fts on public.kb_chunks using gin (fts);

create table if not exists public.query_embeddings (
  query_hash text primary key,                  -- sha256(model + ':' + normalised query)
  model      text not null,
  embedding  extensions.vector(1024) not null,
  created_at timestamptz not null default now()
);

-- Hybrid search. Full text is ORed across terms, because a spoken question
-- rarely contains every word of the chunk that answers it, and each term is a
-- PREFIX match, because callers say "crypto" and the KB says "Cryptocurrency".
-- Reciprocal rank fusion (k = 60) merges the two rankings without comparing
-- their scales.
create or replace function public.search_kb(query_text text, query_embedding extensions.vector(1024), match_count int default 4)
returns table (id text, source_title text, heading text, content text, source_summary text,
               similarity real, fts_rank real, rrf real)
language sql stable
set search_path = public, extensions
as $$
  with q as (
    select case when t.s is null then null else to_tsquery('simple', t.s) end as tsq
    from (select string_agg(quote_literal(lexeme) || ':*', ' | ') as s from unnest(to_tsvector('english', query_text))) t
  ),
  v as (
    select c.id, (1 - (c.embedding <=> query_embedding))::real as similarity,
           row_number() over (order by c.embedding <=> query_embedding) as r
    from public.kb_chunks c
    where query_embedding is not null and c.embedding is not null and c.retired_at is null
    order by c.embedding <=> query_embedding
    limit 20
  ),
  f as (
    select c.id, ts_rank_cd(c.fts, q.tsq)::real as fts_rank,
           row_number() over (order by ts_rank_cd(c.fts, q.tsq) desc) as r
    from public.kb_chunks c, q
    where q.tsq is not null and c.fts @@ q.tsq and c.retired_at is null
    order by fts_rank desc
    limit 20
  )
  select c.id, c.source_title, c.heading, c.content, c.source_summary,
         coalesce(v.similarity, 0)::real, coalesce(f.fts_rank, 0)::real,
         (coalesce(1.0 / (60 + v.r), 0) + coalesce(1.0 / (60 + f.r), 0))::real as rrf
  from public.kb_chunks c
  left join v on v.id = c.id
  left join f on f.id = c.id
  where v.id is not null or f.id is not null
  -- Ties are real (first by vector and second by text vs the reverse fuse to the same score), and an
  -- unordered tie makes retrieval logs unreproducible. Lexical rank breaks them, then similarity, then id.
  order by rrf desc, fts_rank desc, similarity desc, id
  limit match_count;
$$;
