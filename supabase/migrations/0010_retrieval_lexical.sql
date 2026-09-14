-- K15 Retrieval V1: multilingual lexical path + retrieval support.
--
-- Deterministic, retrieval-only normalization. The ORIGINAL text is never
-- rewritten: normalization produces an additional retrieval signal.
--
-- Deliberately conservative:
--   * unify alef variants (أ إ آ ٱ -> ا)              — explicitly requested
--   * remove Arabic diacritics and tatweel
--   * ASCII digits for Arabic-Indic digits (number/identifier lookup)
--   * lowercase Latin, punctuation -> space, collapse whitespace
--   * KEEP ة and ى untouched — collapsing them can harm meaning; the `arabic`
--     text-search configuration already covers those variants by stemming.
--
-- Live evidence (PG 17) driving this shape:
--   to_tsvector('simple','المستندات') @@ plainto_tsquery('simple','مستندات') = false
--   to_tsvector('arabic','إدارة')     @@ plainto_tsquery('arabic','ادارة') = true
--   to_tsvector('arabic','معالجة')    @@ plainto_tsquery('arabic','معالجه') = true
-- hence: `simple` as the language-neutral base, `arabic` as a morphological
-- companion, plus trigram similarity for exact/fuzzy terms and identifiers.

create extension if not exists pg_trgm;

create or replace function public.kip_retrieval_normalize(p_text text)
returns text
language sql
immutable
as $$
  select nullif(
    trim(
      regexp_replace(
        regexp_replace(
          lower(
            translate(
              regexp_replace(coalesce(p_text, ''), '[\u064B-\u0652\u0670\u0640]', '', 'g'),
              'أإآٱ٠١٢٣٤٥٦٧٨٩',
              'اااا0123456789'
            )
          ),
          '[^[:alnum:] ء-ي]', ' ', 'g'
        ),
        '\s+', ' ', 'g'
      )
    ),
    ''
  );
$$;

-- Lexical columns on document_chunks: one language-neutral vector, one Arabic
-- morphological vector, plus the normalized text used for trigram similarity.
alter table public.document_chunks
  add column if not exists lexical_text text
    generated always as (public.kip_retrieval_normalize(text_content)) stored,
  add column if not exists lexical_simple tsvector
    generated always as (to_tsvector('simple', public.kip_retrieval_normalize(text_content))) stored,
  add column if not exists lexical_arabic tsvector
    generated always as (to_tsvector('arabic', public.kip_retrieval_normalize(text_content))) stored;

create index if not exists document_chunks_lexical_simple_idx
  on public.document_chunks using gin (lexical_simple);
create index if not exists document_chunks_lexical_arabic_idx
  on public.document_chunks using gin (lexical_arabic);
create index if not exists document_chunks_lexical_trgm_idx
  on public.document_chunks using gin (lexical_text gin_trgm_ops);

-- Embedding coverage lookups (retrieval joins embeddings -> chunks by project).
create index if not exists chunk_embeddings_project_model_idx
  on public.chunk_embeddings (project_id, model_id, chunk_id);
