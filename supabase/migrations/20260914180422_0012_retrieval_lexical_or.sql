-- K15 retrieval fix: lexical candidate query must OR its terms, not AND them.
--
-- Evidence: the first frozen-gold run scored LEXICAL Recall@5 38.1% / Recall@8 42.9%
-- because plainto_tsquery ANDs every term, so a multi-word or mixed Arabic/English
-- query matched only chunks containing ALL tokens (often none). Building the query
-- as the OR of the normalized terms — the standard recall-oriented lexical shape —
-- raised the same frozen benchmark to Recall@5 71.4% / Recall@8 76.2%.
--
-- Normalization and project scoping are unchanged: project_id is still enforced in
-- the SQL, and the query goes through kip_retrieval_normalize exactly once.

create or replace function public.kip_retrieve_lexical(
  p_project_id uuid,
  p_query text,
  p_limit integer default 30,
  p_source_ids uuid[] default null,
  p_document_ids uuid[] default null
)
returns table (
  chunk_id uuid,
  document_id uuid,
  source_id uuid,
  logical_path text,
  heading_context text,
  text_content text,
  content_sha256 text,
  score double precision
)
language sql
stable
as $$
  with q as (
    select public.kip_retrieval_normalize(p_query) as norm
  ),
  terms as (
    select string_agg(distinct t, ' | ') as ts
    from unnest(string_to_array((select norm from q), ' ')) as t
    where length(t) > 1
  )
  select
    c.id,
    c.document_id,
    c.source_id,
    c.logical_path,
    c.heading_context,
    c.text_content,
    c.content_sha256,
    greatest(
      ts_rank(c.lexical_simple, to_tsquery('simple', (select ts from terms))),
      0.9 * ts_rank(c.lexical_arabic, to_tsquery('arabic', (select ts from terms))),
      word_similarity((select norm from q), c.lexical_text)
    ) as score
  from public.document_chunks c, q
  where c.project_id = p_project_id
    and q.norm is not null
    and (select ts from terms) is not null
    and (
      c.lexical_simple @@ to_tsquery('simple', (select ts from terms))
      or c.lexical_arabic @@ to_tsquery('arabic', (select ts from terms))
      or word_similarity(q.norm, c.lexical_text) >= 0.6
    )
    and (p_source_ids is null or c.source_id = any (p_source_ids))
    and (p_document_ids is null or c.document_id = any (p_document_ids))
  order by score desc, c.id
  limit greatest(1, least(coalesce(p_limit, 30), 200));
$$;
