-- ============================================================
-- 饭记 · Supabase 建表（第 2 步）
-- 用法：Supabase 控制台 → SQL Editor → 新建查询 → 整段粘贴 → Run
-- 前提：Auth 里开启 Email 登录（默认已开）
-- ============================================================

create extension if not exists pgcrypto;

-- ============================================================
-- 1. 表
-- ============================================================

-- 空格：一圈朋友 = 一个 workspace
create table if not exists public.workspaces (
  id          uuid primary key default gen_random_uuid(),
  name        text not null default '我们的饭记',
  invite_code text not null unique
              default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
  created_by  uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now()
);

create table if not exists public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  role         text not null default 'editor'
               check (role in ('owner', 'editor', 'viewer')),
  joined_at    timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table if not exists public.meals (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  restaurant   text not null,
  eaten_on     date not null default current_date,
  meal_type    text not null default '晚餐'
               check (meal_type in ('早餐', '午餐', '下午茶', '晚餐', '夜宵')),
  rating       int  not null default 4 check (rating between 1 and 5),
  note         text default '',
  created_by   uuid not null default auth.uid() references auth.users(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists meals_ws_date_idx on public.meals (workspace_id, eaten_on desc);

create table if not exists public.dishes (
  id       uuid primary key default gen_random_uuid(),
  meal_id  uuid not null references public.meals(id) on delete cascade,
  name     text not null,
  rating   int  not null default 4 check (rating between 1 and 5),
  note     text default '',
  position int  not null default 0
);
create index if not exists dishes_meal_idx on public.dishes (meal_id);

create table if not exists public.photos (
  id           uuid primary key default gen_random_uuid(),
  meal_id      uuid not null references public.meals(id) on delete cascade,
  storage_path text not null,          -- meal-photos/{workspace_id}/{meal_id}/{uuid}.jpg
  created_by   uuid not null default auth.uid() references auth.users(id),
  created_at   timestamptz not null default now()
);
create index if not exists photos_meal_idx on public.photos (meal_id);

-- ============================================================
-- 2. 权限辅助函数
--    security definer：函数以表属主身份跑，绕过 RLS，
--    否则在 workspace_members 的策略里查自己会「无限递归」。
-- ============================================================

create or replace function public.is_member(ws uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws and m.user_id = auth.uid()
  );
$$;

create or replace function public.can_edit(ws uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws and m.user_id = auth.uid()
      and m.role in ('owner', 'editor')
  );
$$;

-- dishes / photos 的策略要按 meal_id 反查工作区，同样不能直接子查询 meals（会被 RLS 过滤）
create or replace function public.meal_workspace(mid uuid)
returns uuid
language sql stable security definer set search_path = public as $$
  select workspace_id from public.meals where id = mid;
$$;

-- ============================================================
-- 3. RLS
-- ============================================================
alter table public.workspaces        enable row level security;
alter table public.workspace_members enable row level security;
alter table public.meals             enable row level security;
alter table public.dishes            enable row level security;
alter table public.photos            enable row level security;

-- workspaces
drop policy if exists ws_select on public.workspaces;
drop policy if exists ws_insert on public.workspaces;
drop policy if exists ws_update on public.workspaces;
create policy ws_select on public.workspaces
  for select using (public.is_member(id));
create policy ws_insert on public.workspaces
  for insert with check (created_by = auth.uid());
create policy ws_update on public.workspaces
  for update using (public.can_edit(id));

-- 成员表：能看同空间其他成员，但只能通过 join_workspace / create 流程自助加入
drop policy if exists wm_select on public.workspace_members;
create policy wm_select on public.workspace_members
  for select using (public.is_member(workspace_id));

-- meals
drop policy if exists meals_select on public.meals;
drop policy if exists meals_insert on public.meals;
drop policy if exists meals_update on public.meals;
drop policy if exists meals_delete on public.meals;
create policy meals_select on public.meals
  for select using (public.is_member(workspace_id));
create policy meals_insert on public.meals
  for insert with check (public.can_edit(workspace_id));
create policy meals_update on public.meals
  for update using (public.can_edit(workspace_id));
create policy meals_delete on public.meals
  for delete using (public.can_edit(workspace_id));

-- dishes
drop policy if exists dishes_all on public.dishes;
create policy dishes_all on public.dishes
  for all using (public.is_member(public.meal_workspace(meal_id)))
  with check (public.can_edit(public.meal_workspace(meal_id)));

-- photos
drop policy if exists photos_all on public.photos;
create policy photos_all on public.photos
  for all using (public.is_member(public.meal_workspace(meal_id)))
  with check (public.can_edit(public.meal_workspace(meal_id)));

-- ============================================================
-- 4. 建空间 / 用邀请码加入
--    两个都必须走 security definer 函数：前端没有、也不该有
--    直接插入 workspace_members 的权限，否则任何人可以把自己
--    塞进任意空间。
-- ============================================================
create or replace function public.create_workspace(ws_name text)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  new_id uuid := gen_random_uuid();
begin
  if auth.uid() is null then
    raise exception '需要登录';
  end if;
  insert into public.workspaces (id, name, created_by)
  values (new_id, coalesce(nullif(trim(ws_name), ''), '我们的饭记'), auth.uid());

  insert into public.workspace_members (workspace_id, user_id, role)
  values (new_id, auth.uid(), 'owner')
  on conflict (workspace_id, user_id) do nothing;

  return new_id;
end;
$$;

create or replace function public.join_workspace(code text)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  ws uuid;
begin
  if auth.uid() is null then
    raise exception '需要登录';
  end if;
  select id into ws from public.workspaces where invite_code = upper(trim(code));
  if ws is null then
    raise exception '邀请码无效';
  end if;
  insert into public.workspace_members (workspace_id, user_id, role)
  values (ws, auth.uid(), 'editor')
  on conflict (workspace_id, user_id) do nothing;
  return ws;
end;
$$;

-- ============================================================
-- 5. 存储桶（照片）
--    路径约定：{workspace_id}/{meal_id}/{uuid}.jpg
-- ============================================================
insert into storage.buckets (id, name, public)
values ('meal-photos', 'meal-photos', false)
on conflict (id) do nothing;

drop policy if exists meal_photos_read on storage.objects;
drop policy if exists meal_photos_write on storage.objects;
drop policy if exists meal_photos_delete on storage.objects;

create policy meal_photos_read on storage.objects
  for select using (
    bucket_id = 'meal-photos'
    and public.is_member(((storage.foldername(name))[1])::uuid)
  );
create policy meal_photos_write on storage.objects
  for insert with check (
    bucket_id = 'meal-photos'
    and public.can_edit(((storage.foldername(name))[1])::uuid)
  );
create policy meal_photos_delete on storage.objects
  for delete using (
    bucket_id = 'meal-photos'
    and public.can_edit(((storage.foldername(name))[1])::uuid)
  );

-- ============================================================
-- 6. 基础授权（Supabase 默认已给，这里显式写一遍保险）
-- ============================================================
grant usage on schema public to anon, authenticated;
grant all on public.workspaces, public.workspace_members, public.meals,
              public.dishes, public.photos to authenticated;
grant execute on function public.is_member(uuid)        to authenticated;
grant execute on function public.can_edit(uuid)         to authenticated;
grant execute on function public.meal_workspace(uuid)   to authenticated;
grant execute on function public.create_workspace(text) to authenticated;
grant execute on function public.join_workspace(text)   to authenticated;
