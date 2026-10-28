-- 社員番号 (the company's number), entered by HR; later used as the login ID for staff.
alter table public.employees add column if not exists employee_no text;
create unique index if not exists employees_employee_no_key on public.employees (employee_no) where employee_no is not null;
