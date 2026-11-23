-- K0 Provider Connection Management: platform-level OpenRouter provider config.
-- Platform-level only (no project_id). Supabase Vault stores the secret;
-- provider_configs holds reference metadata only.
-- Applied only to the new KIP Next Supabase project.

create table public.provider_configs (
  id uuid primary key default gen_random_uuid(),
  provider_key text not null unique check (provider_key in ('openrouter')),
  display_name text,
  connection_status text not null default 'not_configured' check (connection_status in ('connected', 'failed', 'not_configured')),
  credential_configured boolean not null default false,
  masked_key text,
  last_tested_at timestamptz,
  secure_secret_reference text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.provider_configs enable row level security;

-- Supabase Vault wrappers callable server-side via PostgREST rpc (security invoker,
-- so Vault's own grants apply). These store/read/delete the provider secret.
create or replace function public.kip_vault_create_secret(p_name text, p_value text)
returns uuid
language plpgsql security invoker
set search_path = 'vault', 'public'
as $$
begin
  return vault.create_secret(p_value, p_name);
end;
$$;

grant execute on function public.kip_vault_create_secret(text, text) to anon, authenticated, service_role, postgres;

create or replace function public.kip_vault_read_secret(p_name text)
returns text
language sql security invoker stable
set search_path = 'vault', 'public'
as $$
  select decrypted_secret from vault.decrypted_secrets where name = p_name limit 1;
$$;

grant execute on function public.kip_vault_read_secret(text) to anon, authenticated, service_role, postgres;

create or replace function public.kip_vault_delete_secret(p_name text)
returns void
language plpgsql security invoker
set search_path = 'vault', 'public'
as $$
begin
  delete from vault.secrets where name = p_name;
end;
$$;

grant execute on function public.kip_vault_delete_secret(text) to anon, authenticated, service_role, postgres;
