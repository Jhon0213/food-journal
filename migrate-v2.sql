-- ============================================================
-- 饭记 v2：从「一人一餐」改成「一餐多人」
--   一顿饭 = 共享实体（店名/日期/菜单）
--   每个人在这一餐下留一条 meal_review（评分 + 评论）
--   每道菜每个人可以单独打分（dish_review）
-- 执行：Supabase SQL Editor 整段粘贴运行（可重复执行）
-- ============================================================

-- ---------- 1. 新表：每人对一顿饭的评价（同时也是「我吃了」的报名记录） ----------
create table if not exists public.meal_reviews (
  meal_id       uuid not null references public.meals(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  reviewer_name text not null default '',
  rating        int check (rating between 1 and 5),   -- null 表示已报名但还没打分
  comment       text default '',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (meal_id, user_id)
);
create index if not exists meal_reviews_meal_idx on public.meal_reviews (meal_id);

-- ---------- 2. 新表：每人对每道菜的评价 ----------
create table if not exists public.dish_reviews (
  dish_id       uuid not null references public.dishes(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  reviewer_name text not null default '',
  rating        int not null check (rating between 1 and 5),
  note          text default '',
  created_at    timestamptz not null default now(),
  primary key (dish_id, user_id)
);
create index if not exists dish_reviews_dish_idx on public.dish_reviews (dish_id);

-- ---------- 3. 辅助函数 ----------
create or replace function public.dish_meal(did uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select meal_id from public.dishes where id = did;
$$;

create or replace function public.is_participant(mid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.meal_reviews r
    where r.meal_id = mid and r.user_id = auth.uid()
  );
$$;

-- ---------- 4. 迁移旧数据：原来的 meals.rating 变成创建者的评价 ----------
insert into public.meal_reviews (meal_id, user_id, reviewer_name, rating, comment)
select m.id,
       m.created_by,
       coalesce(split_part(u.email, '@', 1), '某人'),
       m.rating,
       coalesce(m.note, '')
from public.meals m
left join auth.users u on u.id = m.created_by
on conflict (meal_id, user_id) do nothing;

-- 旧的个人备注已经搬进 review，餐上的 note 留空（以后是这一餐的公共说明）
update public.meals set note = '' where note is not null and note <> '';

-- ---------- 5. 去掉单点评分字段 ----------
alter table public.meals  drop column if exists rating;
alter table public.dishes drop column if exists rating;
alter table public.dishes drop column if exists note;

-- ---------- 6. RLS ----------
alter table public.meal_reviews enable row level security;
alter table public.dish_reviews enable row level security;

drop policy if exists meal_reviews_select on public.meal_reviews;
drop policy if exists meal_reviews_insert on public.meal_reviews;
drop policy if exists meal_reviews_update on public.meal_reviews;
drop policy if exists meal_reviews_delete on public.meal_reviews;

create policy meal_reviews_select on public.meal_reviews
  for select using (public.is_member(public.meal_workspace(meal_id)));
create policy meal_reviews_insert on public.meal_reviews
  for insert with check (user_id = auth.uid() and public.is_member(public.meal_workspace(meal_id)));
create policy meal_reviews_update on public.meal_reviews
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy meal_reviews_delete on public.meal_reviews
  for delete using (user_id = auth.uid());

drop policy if exists dish_reviews_select on public.dish_reviews;
drop policy if exists dish_reviews_insert on public.dish_reviews;
drop policy if exists dish_reviews_update on public.dish_reviews;
drop policy if exists dish_reviews_delete on public.dish_reviews;

create policy dish_reviews_select on public.dish_reviews
  for select using (public.is_member(public.meal_workspace(public.dish_meal(dish_id))));
create policy dish_reviews_insert on public.dish_reviews
  for insert with check (user_id = auth.uid() and public.is_participant(public.dish_meal(dish_id)));
create policy dish_reviews_update on public.dish_reviews
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy dish_reviews_delete on public.dish_reviews
  for delete using (user_id = auth.uid());

grant all on public.meal_reviews, public.dish_reviews to authenticated;
grant execute on function public.dish_meal(uuid)     to authenticated;
grant execute on function public.is_participant(uuid) to authenticated;

-- ---------- 7. 自检 ----------
select
  (select count(*) from public.meals)        as meals,
  (select count(*) from public.dishes)       as dishes,
  (select count(*) from public.meal_reviews) as meal_reviews,
  (select count(*) from public.dish_reviews) as dish_reviews;
