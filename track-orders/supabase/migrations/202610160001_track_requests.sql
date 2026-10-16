-- Track-order requests shared by BRIDGE TV and RUSONG TV.
-- Apply to a NEW, dedicated Supabase project. Do not run on the SMS/chat database.
begin;

create extension if not exists pgcrypto;
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;

create table if not exists public.track_request_admins (
  user_id uuid not null references auth.users(id) on delete cascade,
  channel text not null check (channel in ('btv', 'rtv', 'all')),
  created_at timestamptz not null default now(),
  primary key (user_id, channel)
);
alter table public.track_request_admins enable row level security;
revoke all on public.track_request_admins from public, anon, authenticated;
grant all on public.track_request_admins to service_role;

create or replace function private.can_moderate_track_channel(p_channel text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.track_request_admins a
    where a.user_id = (select auth.uid())
      and (a.channel = p_channel or a.channel = 'all')
  );
$$;
revoke all on function private.can_moderate_track_channel(text) from public, anon;
grant execute on function private.can_moderate_track_channel(text) to authenticated;

create table if not exists public.track_requests (
  id uuid primary key default gen_random_uuid(),
  channel text not null check (channel in ('btv', 'rtv')),
  artist text not null check (char_length(btrim(artist)) between 1 and 160),
  track_title text check (track_title is null or char_length(btrim(track_title)) <= 180),
  clip_url text not null check (char_length(clip_url) between 12 and 1000 and clip_url ~ '^https://'),
  clip_provider text not null check (clip_provider in ('youtube', 'vk')),
  catalog_provider text check (catalog_provider is null or catalog_provider in ('musicbrainz', 'discogs')),
  catalog_match jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  moderator_note text check (moderator_note is null or char_length(moderator_note) <= 1000),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists track_requests_channel_status_created_idx
  on public.track_requests (channel, status, created_at desc);
create index if not exists track_requests_created_idx
  on public.track_requests (created_at desc);

alter table public.track_requests enable row level security;
revoke all on public.track_requests from public, anon, authenticated;
grant select on public.track_requests to authenticated;
grant update (status, moderator_note, reviewed_by, reviewed_at) on public.track_requests to authenticated;
grant all on public.track_requests to service_role;

drop policy if exists "track admins read their channels" on public.track_requests;
create policy "track admins read their channels"
  on public.track_requests for select to authenticated
  using (private.can_moderate_track_channel(channel));

drop policy if exists "track admins moderate their channels" on public.track_requests;
create policy "track admins moderate their channels"
  on public.track_requests for update to authenticated
  using (private.can_moderate_track_channel(channel))
  with check (
    private.can_moderate_track_channel(channel)
    and (reviewed_by is null or reviewed_by = (select auth.uid()))
  );

-- Server-only request and catalog rate limits. Hashed client identities only;
-- raw IP addresses are not stored.
create table if not exists public.track_request_rate_limits (
  key_hash text not null check (char_length(key_hash) = 64),
  bucket_start timestamptz not null,
  attempts integer not null default 0 check (attempts >= 0),
  primary key (key_hash, bucket_start)
);
alter table public.track_request_rate_limits enable row level security;
revoke all on public.track_request_rate_limits from public, anon, authenticated;
grant all on public.track_request_rate_limits to service_role;

create or replace function public.track_orders_consume_rate_limit(
  p_key_hash text,
  p_bucket_start timestamptz
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempts integer;
begin
  delete from public.track_request_rate_limits
   where bucket_start < now() - interval '2 days';

  insert into public.track_request_rate_limits (key_hash, bucket_start, attempts)
  values (p_key_hash, p_bucket_start, 1)
  on conflict (key_hash, bucket_start)
  do update set attempts = public.track_request_rate_limits.attempts + 1
  returning attempts into v_attempts;

  return v_attempts;
end;
$$;
revoke all on function public.track_orders_consume_rate_limit(text, timestamptz) from public, anon, authenticated;
grant execute on function public.track_orders_consume_rate_limit(text, timestamptz) to service_role;

-- Shared global throttle so concurrent Edge Function instances still respect
-- third-party catalogue limits.
create table if not exists public.track_catalog_api_state (
  provider text primary key check (provider in ('musicbrainz', 'discogs')),
  next_allowed_at timestamptz not null
);
alter table public.track_catalog_api_state enable row level security;
revoke all on public.track_catalog_api_state from public, anon, authenticated;
grant all on public.track_catalog_api_state to service_role;

create or replace function public.track_orders_claim_catalog_slot(
  p_provider text,
  p_min_gap_ms integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claimed boolean;
begin
  if p_provider not in ('musicbrainz', 'discogs') or p_min_gap_ms < 500 or p_min_gap_ms > 10000 then
    return false;
  end if;

  insert into public.track_catalog_api_state as s (provider, next_allowed_at)
  values (p_provider, clock_timestamp() + (p_min_gap_ms * interval '1 millisecond'))
  on conflict (provider) do update
    set next_allowed_at = clock_timestamp() + (p_min_gap_ms * interval '1 millisecond')
    where s.next_allowed_at <= clock_timestamp()
  returning true into v_claimed;

  return coalesce(v_claimed, false);
end;
$$;
revoke all on function public.track_orders_claim_catalog_slot(text, integer) from public, anon, authenticated;
grant execute on function public.track_orders_claim_catalog_slot(text, integer) to service_role;

create table if not exists public.track_catalog_cache (
  cache_key text primary key check (char_length(cache_key) = 64),
  provider text not null check (provider in ('musicbrainz', 'discogs')),
  response jsonb not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table public.track_catalog_cache enable row level security;
revoke all on public.track_catalog_cache from public, anon, authenticated;
grant all on public.track_catalog_cache to service_role;

do $$
begin
  alter publication supabase_realtime add table public.track_requests;
exception when duplicate_object then null;
end $$;

commit;

-- After creating moderator users in Authentication -> Users, add their UID:
-- INSERT INTO public.track_request_admins (user_id, channel)
-- VALUES ('AUTH-USER-UUID-HERE', 'all'); -- or 'btv' / 'rtv'
