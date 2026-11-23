-- Register the production Naqaa integration scope and its trusted proxy actor.
--
-- The UUID is part of the existing Naqaa proxy contract
-- (`NAQAA_PROJECT_ID`). The proxy token itself is intentionally not stored in
-- Postgres or source control; KIP maps it to this actor through
-- `KIP_PROXY_TOKENS` at runtime.

do $$
declare
  naqaa_project_id constant uuid := '33333333-3333-3333-3333-333333333333';
  naqaa_project_name constant text := 'Naqaa Production';
  naqaa_proxy_actor constant text := 'naqaa-kip-proxy';
begin
  if exists (
    select 1
    from public.projects
    where id = naqaa_project_id
      and (name <> naqaa_project_name or status <> 'active')
  ) then
    raise exception 'Naqaa project UUID is already assigned to a conflicting project';
  end if;

  if exists (
    select 1
    from public.projects
    where name = naqaa_project_name
      and id <> naqaa_project_id
  ) then
    raise exception 'Naqaa project name is already assigned to a different UUID';
  end if;

  insert into public.projects (id, name, status)
  values (naqaa_project_id, naqaa_project_name, 'active')
  on conflict (id) do nothing;

  if exists (
    select 1
    from public.project_memberships
    where project_id = naqaa_project_id
      and actor_subject = naqaa_proxy_actor
      and role <> 'service'
  ) then
    raise exception 'Naqaa proxy actor already has a conflicting project role';
  end if;

  insert into public.project_memberships (project_id, actor_subject, role)
  values (naqaa_project_id, naqaa_proxy_actor, 'service')
  on conflict (project_id, actor_subject) do nothing;
end
$$;
