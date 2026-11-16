-- 在籍加算 is paid with some bonuses only (夏季 yes, 冬季 no).
alter table public.bonus_rounds add column has_enroll_add boolean not null default true;
update public.bonus_rounds set has_enroll_add = false where name = '2026年冬季賞与';
-- 冬季: no 在籍加算, and every coefficient starts at 1 so 賞与・支給額 show right away (people who differ are fixed by CSV or ✎).
update public.bonuses b set enroll_add = null,
  enroll_coef = coalesce(enroll_coef, 1), attend_coef = coalesce(attend_coef, 1), eval_coef = coalesce(eval_coef, 1), updated_at = now()
from public.bonus_rounds r where r.id = b.round_id and r.name = '2026年冬季賞与';
