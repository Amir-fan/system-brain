-- K17 Source Role V1: generic retrieval-policy metadata on the existing source record.
-- Role is policy ONLY ("how should this project use this source?"). It is NOT truth,
-- authority, permission or domain. A single column — changing it must never re-ingest,
-- re-chunk or re-embed (nothing in the pipeline reads it as a work trigger).

alter table public.sources
  add column if not exists role text not null default 'supporting'
  check (role in ('primary', 'supporting', 'reference'));