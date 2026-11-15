-- Таблицы календаря. Выполнить один раз: Supabase → SQL Editor → вставить всё → Run.
-- Каждый пользователь видит и меняет только свои строки (правила RLS внизу).

create table if not exists public.blocks (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  month      text not null check (month ~ '^\d{4}-\d{2}$'),      -- '2026-11'
  name       text not null default '' check (char_length(name) <= 100),
  note       text not null default '' check (char_length(note) <= 5000),
  position   int  not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.tasks (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  day        date not null,
  name       text not null check (char_length(name) between 1 and 300),
  start_time text check (start_time ~ '^\d{2}:\d{2}$'),            -- '18:00'
  end_time   text check (end_time ~ '^\d{2}:\d{2}$'),
  status     text not null default 'plan' check (status in ('plan', 'done', 'fail')),
  block_id   uuid references public.blocks on delete set null,
  asked      boolean not null default false,
  created_at timestamptz not null default now()
);

-- отметки «итог дня сохранён» (kind = 'evening', key = '2026-11-14')
-- и «итоги месяца сохранены» (kind = 'summary', key = '2026-11')
create table if not exists public.marks (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  kind    text not null check (kind in ('evening', 'summary')),
  key     text not null,
  primary key (user_id, kind, key)
);

create index if not exists tasks_user_day_idx on public.tasks (user_id, day);
create index if not exists blocks_user_month_idx on public.blocks (user_id, month);

alter table public.blocks enable row level security;
alter table public.tasks  enable row level security;
alter table public.marks  enable row level security;

drop policy if exists "own blocks" on public.blocks;
create policy "own blocks" on public.blocks for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "own tasks" on public.tasks;
create policy "own tasks" on public.tasks for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "own marks" on public.marks;
create policy "own marks" on public.marks for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Галочка «В прогресс» (добавлено позже): название направления, например «Практика».
alter table public.tasks add column if not exists track text check (char_length(track) between 1 and 60);
