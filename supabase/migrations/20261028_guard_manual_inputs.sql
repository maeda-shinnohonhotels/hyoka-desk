-- The typed-in totals, rank and raise (total_manual / rank_manual / up_manual) are for 人事/取締役 only.
-- Evaluators and staff may not set them, and the KPI on a 最終決定 always comes from the facility.
-- SQL run by the owner and the Edge Functions (no auth.uid()) pass.
create or replace function public.guard_manual() returns trigger
  language plpgsql set search_path to '' as $$
begin
  if auth.uid() is null or public.is_hr() then return new; end if;
  if tg_op = 'INSERT' then
    if new.total_manual is not null then raise exception '合計の直接入力は人事・取締役だけができます。'; end if;
    if tg_table_name = 'final_reviews' then
      if new.rank_manual is not null or new.up_manual is not null then
        raise exception 'ランク・昇給額の直接入力は人事・取締役だけができます。';
      end if;
      new.kpi_score := null; -- compute_final fills in the facility's KPI
    end if;
  else
    if new.total_manual is distinct from old.total_manual then raise exception '合計の直接入力は人事・取締役だけができます。'; end if;
    if tg_table_name = 'final_reviews' then
      if new.rank_manual is distinct from old.rank_manual or new.up_manual is distinct from old.up_manual then
        raise exception 'ランク・昇給額の直接入力は人事・取締役だけができます。';
      end if;
      new.kpi_score := old.kpi_score;
    end if;
  end if;
  return new;
end $$;

-- Named "aa_" so it runs before final_reviews_compute (triggers fire in name order).
drop trigger if exists aa_guard_manual on public.self_reviews;
create trigger aa_guard_manual before insert or update on public.self_reviews
  for each row execute function public.guard_manual();
drop trigger if exists aa_guard_manual on public.primary_reviews;
create trigger aa_guard_manual before insert or update on public.primary_reviews
  for each row execute function public.guard_manual();
drop trigger if exists aa_guard_manual on public.final_reviews;
create trigger aa_guard_manual before insert or update on public.final_reviews
  for each row execute function public.guard_manual();
