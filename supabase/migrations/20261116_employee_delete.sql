-- Deleting an employee is only for rows entered by mistake. Evaluations and 給与改定 would go with the row
-- (their foreign keys cascade), so from the app a row that has any of them, or a login, cannot be deleted:
-- such people are set to 退職 instead. 賞与 rows go with the employee.
alter table public.bonuses drop constraint bonuses_employee_id_fkey;
alter table public.bonuses add constraint bonuses_employee_id_fkey
  foreign key (employee_id) references public.employees(id) on delete cascade;

create or replace function public.guard_employee_delete() returns trigger
  language plpgsql security definer set search_path to '' as $$
begin
  if auth.uid() is null then return old; end if;
  if old.user_id is not null then
    raise exception 'ログインがある社員は削除できません。在籍のチェックを外して「退職」にしてください。';
  end if;
  if exists (select 1 from public.self_reviews where employee_id = old.id)
     or exists (select 1 from public.primary_reviews where employee_id = old.id)
     or exists (select 1 from public.final_reviews where employee_id = old.id)
     or exists (select 1 from public.salary_revisions where employee_id = old.id) then
    raise exception '評価または給与改定のデータがある社員は削除できません。在籍のチェックを外して「退職」にしてください。';
  end if;
  return old;
end $$;
revoke execute on function public.guard_employee_delete() from public, anon;

create trigger guard_employee_delete before delete on public.employees
  for each row execute function public.guard_employee_delete();
