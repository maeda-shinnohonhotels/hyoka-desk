-- Nothing here is for people who are not signed in: take away what anon got by default.
revoke all on public.role_requests from anon;
revoke execute on function public.is_approver() from public, anon;
revoke execute on function public.is_evaluator_of(uuid, text) from public, anon;
grant execute on function public.is_approver() to authenticated;
grant execute on function public.is_evaluator_of(uuid, text) to authenticated;
-- New tables and functions made from now on do not go to anon either.
alter default privileges for role postgres in schema public revoke all on tables from anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;
alter default privileges for role postgres in schema public revoke execute on functions from anon;

-- Staff no longer read their evaluators' rows (grade, note, ...); the app never showed them.
drop policy if exists read_emp on public.employees;
create policy read_emp on public.employees for select to authenticated using (
  id = (select public.current_employee_id()) or (select public.is_hr()) or public.is_evaluator_of(id));

-- The copy of 給与改定の備考 taken on 2026-10-23 is no longer needed.
drop table if exists public._backup_salary_notes_20261023;
