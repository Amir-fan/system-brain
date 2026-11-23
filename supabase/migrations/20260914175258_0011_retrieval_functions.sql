-- K15 Retrieval V1: the two candidate retrievers, as SQL functions.
--
-- Project isolation is enforced IN THE SQL (project_id = p_project_id), never by
-- fetching another project's rows and filtering them in application memory.
-- Filters are applied inside the same query, before LIMIT, so a narrow filter
-- still returns a full candidate pool.

-- ---------------------------------------------------------------- semantic
create or replace function public.kip_retrieve_vector(
  p_project_id uuid,
  p_model_id text,
  p_query vector(1536),
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
  select
    c.id,
    c.document_id,
    c.source_id,
    c.logical_path,
    c.heading_context,
    c.text_content,
    c.content_sha256,
    1 - (e.embedding <=> p_query) as score
  from public.chunk_embeddings e
  join public.document_chunks c on c.id = e.chunk_id
  where e.project_id = p_project_id
    and e.model_id = p_model_id
    and (p_source_ids is null or c.source_id = any (p_source_ids))
    and (p_document_ids is null or c.document_id = any (p_document_ids))
  order by e.embedding <=> p_query
  limit greatest(1, least(coalesce(p_limit, 30), 200));
$$;

-- ---------------------------------------------------------------- lexical
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
      ts_rank(c.lexical_simple, plainto_tsquery('simple', q.norm)),
      0.9 * ts_rank(c.lexical_arabic, plainto_tsquery('arabic', q.norm)),
      word_similarity(q.norm, c.lexical_text)
    ) as score
  from public.document_chunks c, q
  where c.project_id = p_project_id
    and q.norm is not null
    and (
      c.lexical_simple @@ plainto_tsquery('simple', q.norm)
      or c.lexical_arabic @@ plainto_tsquery('arabic', q.norm)
      or word_similarity(q.norm, c.lexical_text) >= 0.6
    )
    and (p_source_ids is null or c.source_id = any (p_source_ids))
    and (p_document_ids is null or c.document_id = any (p_document_ids))
  order by score desc, c.id
  limit greatest(1, least(coalesce(p_limit, 30), 200));
$$;

comment on function public.kip_retrieve_vector is
  'K15 semantic candidates: cosine over HNSW, project-scoped in SQL, wider than the final top-K.';
comment on function public.kip_retrieve_lexical is
  'K15 lexical candidates: language-neutral FTS + Arabic morphology + trigram word similarity, project-scoped in SQL.';
