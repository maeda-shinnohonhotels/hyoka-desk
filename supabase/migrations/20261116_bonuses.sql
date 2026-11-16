-- 賞与: one round per payout (e.g. 2026年冬季賞与), one row per employee.
-- 賞与 = 基本給 × 在籍係数 × 出勤係数 × 評価係数（円未満切り捨て）、支給額 = 賞与 + 在籍加算.
create table public.bonus_rounds (
  id serial primary key,
  name text not null unique,
  eval_from date,
  eval_to date,
  salary_period_id integer references public.periods(id), -- 基本給 is 給与改定の「基本給(前)」 of this period
  created_at timestamptz not null default now()
);

create table public.bonuses (
  round_id integer not null references public.bonus_rounds(id) on delete cascade,
  employee_id uuid not null references public.employees(id),
  base_salary integer,
  enroll_coef numeric(6,3) check (enroll_coef >= 0),
  attend_coef numeric(6,3) check (attend_coef >= 0),
  eval_coef numeric(6,3) check (eval_coef >= 0),
  bonus integer generated always as (floor(base_salary * enroll_coef * attend_coef * eval_coef)::integer) stored,
  enroll_add integer,
  total integer generated always as (floor(base_salary * enroll_coef * attend_coef * eval_coef)::integer + coalesce(enroll_add, 0)) stored,
  note text,
  updated_at timestamptz not null default now(),
  primary key (round_id, employee_id)
);

-- Pay data: only 人事・取締役.
alter table public.bonus_rounds enable row level security;
alter table public.bonuses enable row level security;
create policy hr_all on public.bonus_rounds for all to authenticated using ((select public.is_hr())) with check ((select public.is_hr()));
create policy hr_all on public.bonuses for all to authenticated using ((select public.is_hr())) with check ((select public.is_hr()));
revoke all on public.bonus_rounds, public.bonuses from anon;
revoke all on sequence public.bonus_rounds_id_seq from anon;

-- The first round: 2026年冬季賞与（評価期間 2026.4～2026.9）, 基本給 = 2025.10～2026.9期の基本給(前)（2026年9月時点）.
with r as (
  insert into public.bonus_rounds (name, eval_from, eval_to, salary_period_id)
  values ('2026年冬季賞与', '2026-04-01', '2026-09-30', 1) returning id
)
insert into public.bonuses (round_id, employee_id, base_salary)
select r.id, s.employee_id, s.base_before
from r, public.salary_revisions s join public.employees e on e.id = s.employee_id
where s.period_id = 1 and e.active;
