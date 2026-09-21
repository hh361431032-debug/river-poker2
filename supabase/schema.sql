-- 河畔牌局 v2：Supabase 联网数据库
-- 在 Supabase Dashboard → SQL Editor → New query 中完整粘贴并执行

create table if not exists public.poker_users (
  username text primary key check (char_length(username) between 2 and 16),
  password_hash text not null,
  chips integer not null default 1000,
  avatar_url text,
  dealer_image_url text,
  created_at timestamptz not null default now()
);

create table if not exists public.poker_rooms (
  code text primary key,
  name text not null,
  host_name text not null,
  player_count integer not null default 1,
  status text not null default 'waiting',
  state jsonb not null,
  version bigint not null default 1,
  updated_at timestamptz not null default now()
);

create table if not exists public.poker_messages (
  id uuid primary key default gen_random_uuid(),
  room_code text not null references public.poker_rooms(code) on delete cascade,
  username text not null,
  text text not null check (char_length(text) between 1 and 120),
  created_at timestamptz not null default now()
);

alter table public.poker_users add column if not exists avatar_url text;
alter table public.poker_rooms add column if not exists version bigint not null default 0;
alter table public.poker_users add column if not exists dealer_image_url text;

create index if not exists poker_rooms_updated_at_idx on public.poker_rooms(updated_at desc);
create index if not exists poker_messages_room_created_idx on public.poker_messages(room_code, created_at);

alter table public.poker_users enable row level security;
alter table public.poker_rooms enable row level security;
alter table public.poker_messages enable row level security;

-- 为了让朋友无需额外账号配置即可直接联网，这个 Beta 使用公开 API 访问策略。
-- 只用于虚拟筹码测试；正式公开运营前应改为 Supabase Auth + 严格 RLS + 服务端判定。
drop policy if exists "poker_users_public" on public.poker_users;
create policy "poker_users_public" on public.poker_users for all to anon, authenticated using (true) with check (true);

drop policy if exists "poker_rooms_public" on public.poker_rooms;
drop policy if exists "poker_rooms_read_only" on public.poker_rooms;
create policy "poker_rooms_read_only" on public.poker_rooms for select to anon, authenticated using (true);

alter table public.poker_rooms drop constraint if exists poker_rooms_player_count_check;
alter table public.poker_rooms add constraint poker_rooms_player_count_check check (player_count between 0 and 8);
alter table public.poker_rooms drop constraint if exists poker_rooms_version_check;
update public.poker_rooms set version=1 where version=0;
alter table public.poker_rooms add constraint poker_rooms_version_check check (version >= 1);

create or replace function public.enforce_poker_room_version()
returns trigger
language plpgsql
as $
begin
  if TG_OP = 'UPDATE' then
    if new.version <> old.version + 1 then
      raise exception 'ROOM_VERSION_SEQUENCE_INVALID' using errcode = '23514';
    end if;
    if new.updated_at <= old.updated_at then
      raise exception 'ROOM_UPDATED_AT_NOT_MONOTONIC' using errcode = '23514';
    end if;
  elsif TG_OP = 'INSERT' then
    if new.version <> 1 then
      raise exception 'ROOM_INITIAL_VERSION_INVALID' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$;

drop trigger if exists poker_room_version_guard on public.poker_rooms;
create trigger poker_room_version_guard
before insert or update on public.poker_rooms
for each row execute function public.enforce_poker_room_version();

drop policy if exists "poker_messages_public" on public.poker_messages;
create policy "poker_messages_public" on public.poker_messages for all to anon, authenticated using (true) with check (true);

-- Realtime（幂等：重复执行不会因已加入 publication 而失败）
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='poker_rooms') then
    alter publication supabase_realtime add table public.poker_rooms;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='poker_messages') then
    alter publication supabase_realtime add table public.poker_messages;
  end if;
end
$$;
