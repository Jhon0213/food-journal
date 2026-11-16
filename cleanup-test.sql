-- 清理联调测试账号（只删 fanji.% 测试邮箱，不动真实用户）
delete from public.meals
where workspace_id in (
  select id from public.workspaces
  where created_by in (select id from auth.users where email like 'fanji.%')
);

delete from public.workspaces
where created_by in (select id from auth.users where email like 'fanji.%');

delete from auth.users where email like 'fanji.%';

select
  (select count(*) from auth.users) as users_left,
  (select count(*) from public.workspaces) as workspaces_left,
  (select count(*) from public.meals) as meals_left,
  (select string_agg(email, ',') from auth.users) as remaining_users;
