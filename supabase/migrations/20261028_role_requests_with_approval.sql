-- Granting or removing 人事/取締役 goes through a request that only the approver can approve.
alter table public.employees add column if not exists is_approver boolean not null default false;

create table if not exists public.role_requests (
  id bigint generated always as identity primary key,
  employee_id uuid not null references public.employees(id),
  role_from text not null,
  role_to text not null,
  email text,
  reason text,
  requested_by uuid not null references public.employees(id),
  requested_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by uuid references public.employees(id),
  decided_at timestamptz,
  decision_note text
);
alter table public.role_requests enable row level security;
drop policy if exists read_requests on public.role_requests;
create policy read_requests on public.role_requests for select using ((select public.is_hr()));
-- No insert/update/delete policies: requests are written only by the functions below and the approve-role-request Edge Function.

create or replace function public.is_approver() returns boolean
  language sql stable security definer set search_path to '' as $$
  select exists (select 1 from public.employees where user_id = auth.uid() and active and is_approver)
$$;

-- Requests made from the app (auth.uid() is set) may not touch 人事/取締役 directly.
-- SQL run by the owner and the Edge Function (service role) have no auth.uid() and pass.
create or replace function public.guard_privileged() returns trigger
  language plpgsql set search_path to '' as $$
declare priv text[] := array['hr', 'director'];
begin
  if auth.uid() is null then return coalesce(new, old); end if;
  if tg_op = 'DELETE' then
    if old.role::text = any(priv) or old.is_approver then raise exception '人事・取締役の社員は削除できません。'; end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    if new.role::text = any(priv) then raise exception '人事・取締役の権限は「権限の申請」から申請してください。'; end if;
    if new.is_approver then raise exception '承認者は画面からは設定できません。'; end if;
    return new;
  end if;
  if new.is_approver is distinct from old.is_approver then raise exception '承認者は画面からは設定できません。'; end if;
  if new.role is distinct from old.role and (old.role::text = any(priv) or new.role::text = any(priv)) then
    raise exception '人事・取締役の権限をつける・外すときは「権限の申請」から申請してください。';
  end if;
  if old.role::text = any(priv) then
    if new.email is distinct from old.email or new.active is distinct from old.active then
      raise exception '人事・取締役の社員のメール・在籍は「権限の申請」で承認を受けてから変えてください。';
    end if;
    -- Only the person themself may link their login (link_me), to the address on file.
    if new.user_id is distinct from old.user_id
       and not (old.user_id is null and new.user_id = auth.uid() and lower(new.email) = lower(auth.jwt() ->> 'email')) then
      raise exception '人事・取締役の社員のログインは変えられません。';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists employees_guard_privileged on public.employees;
create trigger employees_guard_privileged before insert or update or delete on public.employees
  for each row execute function public.guard_privileged();

create or replace function public.request_role_change(p_employee uuid, p_role text, p_email text, p_reason text)
  returns bigint language plpgsql security definer set search_path to '' as $$
declare e public.employees; v bigint; me uuid := public.current_employee_id();
begin
  if not public.is_hr() then raise exception '人事・取締役だけが申請できます。'; end if;
  select * into e from public.employees where id = p_employee;
  if e.id is null then raise exception '社員が見つかりません。'; end if;
  if p_role not in ('staff', 'evaluator1', 'evaluator2', 'hr', 'director') then raise exception '権限が正しくありません。'; end if;
  if p_role = e.role::text then raise exception 'いまと同じ権限です。'; end if;
  if not (p_role in ('hr', 'director') or e.role::text in ('hr', 'director')) then
    raise exception '人事・取締役以外の変更は「社員・評価者」の画面で直接できます。';
  end if;
  if p_role in ('hr', 'director') and coalesce(nullif(trim(p_email), ''), e.email) is null then
    raise exception '人事・取締役にするときはメールアドレスが必要です。';
  end if;
  if exists (select 1 from public.role_requests where employee_id = p_employee and status = 'pending') then
    raise exception 'この社員には承認待ちの申請があります。';
  end if;
  insert into public.role_requests (employee_id, role_from, role_to, email, reason, requested_by)
    values (p_employee, e.role::text, p_role, case when p_role in ('hr', 'director') then lower(coalesce(nullif(trim(p_email), ''), e.email)) end, nullif(trim(p_reason), ''), me)
    returning id into v;
  return v;
end $$;

create or replace function public.cancel_role_request(p_id bigint) returns void
  language plpgsql security definer set search_path to '' as $$
begin
  update public.role_requests set status = 'cancelled', decided_by = public.current_employee_id(), decided_at = now()
   where id = p_id and status = 'pending'
     and (requested_by = public.current_employee_id() or public.is_approver());
  if not found then raise exception '取り下げできる申請がありません。'; end if;
end $$;

revoke all on function public.request_role_change(uuid, text, text, text) from public, anon;
revoke all on function public.cancel_role_request(bigint) from public, anon;
grant execute on function public.request_role_change(uuid, text, text, text) to authenticated;
grant execute on function public.cancel_role_request(bigint) to authenticated;
grant select on public.role_requests to authenticated;

-- The approver: 前田 陽介.
update public.employees set is_approver = true where lower(email) = 'y.maeda@shinnihonhotels.co.jp';
