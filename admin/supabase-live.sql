-- ============================================================================
-- RUSONG TV — управление эфиром из админки (выполнить ОДИН раз в Supabase → SQL Editor)
-- Требует admin/supabase-schema.sql RUSONG (функция private.is_admin()).
-- ============================================================================

-- Живое состояние эфира: одна строка (id = 1). Формат data — как у tracklist.json:
--   {"start":"2026-10-23T18:00:00Z","offset":0,"title":"…","tracks":[…],"end":3600}
--   {"idle":true}  — заставка «ожидание эфира»
--   {}             — нет данных → виджет берёт tracklist.json из репозитория
create table if not exists public.live_state (
  id         int primary key default 1 check (id = 1),
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
insert into public.live_state (id) values (1) on conflict do nothing;

alter table public.live_state enable row level security;

drop policy if exists "live_state public read"  on public.live_state;
drop policy if exists "live_state admin write"  on public.live_state;
create policy "live_state public read" on public.live_state for select using (true);   -- виджет сайта читает без входа
create policy "live_state admin write" on public.live_state for update
  using ((select private.is_admin())) with check ((select private.is_admin()));

-- Библиотека эпизодов (сохранённые треклисты)
create table if not exists public.episodes (
  id         uuid primary key default gen_random_uuid(),
  title      text not null check (char_length(title) between 1 and 200),
  data       jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.episodes enable row level security;
drop policy if exists "episodes admin all" on public.episodes;
create policy "episodes admin all" on public.episodes for all
  using ((select private.is_admin())) with check ((select private.is_admin()));
