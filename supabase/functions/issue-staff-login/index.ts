// Issues (or re-issues) a login for an employee: ID = 社員番号, with a temporary password.
// Only 人事/取締役 may call it, and only for employees who are not 人事/取締役 (those go through 権限の申請).
// The login's address is <社員番号>@hyoka-desk.local, which never receives mail; the person signs in with the number.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const DOMAIN = 'hyoka-desk.local';

// 10 characters without look-alikes (0/O, 1/l/I).
function tempPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  return [...crypto.getRandomValues(new Uint32Array(10))].map((n) => chars[n % chars.length]).join('');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const jwt = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const { data: { user } } = await admin.auth.getUser(jwt);
  if (!user) return json({ error: 'ログインしてください。' }, 401);
  const { data: me } = await admin.from('employees').select('id, active, role').eq('user_id', user.id).maybeSingle();
  if (!me?.active || !['hr', 'director'].includes(me.role)) return json({ error: '人事・取締役だけがIDを発行できます。' }, 403);

  let body: { employee_id?: string };
  try { body = await req.json(); } catch { return json({ error: '内容が読み取れません。' }, 400); }
  const { data: emp } = await admin.from('employees').select('*').eq('id', body.employee_id ?? '').maybeSingle();
  if (!emp) return json({ error: '社員が見つかりません。' }, 404);
  if (['hr', 'director'].includes(emp.role)) return json({ error: '人事・取締役のログインは「権限の申請」で作ります。' }, 403);
  if (!emp.active) return json({ error: '退職の社員にはIDを発行できません。' }, 400);
  const no = (emp.employee_no ?? '').trim();
  if (!/^[A-Za-z0-9_-]{1,30}$/.test(no)) return json({ error: '先に社員番号（英数字）を登録して保存してください。' }, 400);
  const email = `${no.toLowerCase()}@${DOMAIN}`;
  const password = tempPassword();

  if (emp.user_id) {
    // Re-issue: only for logins made here (number-based), never for someone's real e-mail login.
    const { data: cur, error } = await admin.auth.admin.getUserById(emp.user_id);
    if (error || !cur.user) return json({ error: 'いまのログインが見つかりません。' }, 500);
    if (!cur.user.email?.endsWith(`@${DOMAIN}`)) return json({ error: 'この社員はメールアドレスでログインしています。パスワードは本人が「パスワード設定」で変えます。' }, 409);
    // Follow a changed 社員番号 too.
    const { error: upErr } = await admin.auth.admin.updateUserById(emp.user_id, { email, email_confirm: true, password });
    if (upErr) return json({ error: `再発行できませんでした：${upErr.message}` }, 500);
    return json({ ok: true, login_id: no, temp_password: password, reissued: true });
  }

  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error || !created.data.user) return json({ error: `IDを作れませんでした：${created.error?.message}` }, 500);
  const { error: linkErr } = await admin.from('employees').update({ user_id: created.data.user.id }).eq('id', emp.id);
  if (linkErr) {
    await admin.auth.admin.deleteUser(created.data.user.id);
    return json({ error: `社員とのひも付けに失敗しました：${linkErr.message}` }, 500);
  }
  return json({ ok: true, login_id: no, temp_password: password, reissued: false });
});
