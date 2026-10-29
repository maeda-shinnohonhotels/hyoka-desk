// Approves or rejects a 人事/取締役 role request. Only the approver (employees.is_approver) may call it.
// On approval of 人事/取締役 for someone without a login, it creates the login with a temporary password
// and returns that password once, for the approver to hand over.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// 12 characters without look-alikes (0/O, 1/l/I).
function tempPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const buf = crypto.getRandomValues(new Uint32Array(12));
  return [...buf].map((n) => chars[n % chars.length]).join('');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const jwt = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const { data: { user } } = await admin.auth.getUser(jwt);
  if (!user) return json({ error: 'ログインしてください。' }, 401);
  const { data: me } = await admin.from('employees').select('id, active, is_approver').eq('user_id', user.id).maybeSingle();
  if (!me?.active || !me.is_approver) return json({ error: '承認者だけが承認・却下できます。' }, 403);

  let body: { request_id?: number; approve?: boolean; note?: string };
  try { body = await req.json(); } catch { return json({ error: '内容が読み取れません。' }, 400); }
  const { data: r } = await admin.from('role_requests').select('*').eq('id', body.request_id ?? -1).maybeSingle();
  if (!r) return json({ error: '申請が見つかりません。' }, 404);
  if (r.status !== 'pending') return json({ error: 'この申請はもう処理されています。' }, 409);
  const decided = { decided_by: me.id, decided_at: new Date().toISOString(), decision_note: body.note?.trim() || null };

  if (!body.approve) {
    await admin.from('role_requests').update({ status: 'rejected', ...decided }).eq('id', r.id).eq('status', 'pending');
    return json({ ok: true, status: 'rejected' });
  }

  const { data: emp } = await admin.from('employees').select('*').eq('id', r.employee_id).single();
  if (r.role_from !== emp.role) return json({ error: '申請のあとで権限が変わっています。却下して申請し直してください。' }, 409);
  const privileged = ['hr', 'director'].includes(r.role_to);
  const patch: Record<string, unknown> = { role: r.role_to };
  let password: string | null = null;

  if (privileged) {
    const email = (r.email ?? emp.email ?? '').toLowerCase();
    if (!email) return json({ error: 'メールアドレスがありません。' }, 400);
    patch.email = email;
    patch.active = true;
    if (!emp.user_id) {
      password = tempPassword();
      const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      let uid = created.data.user?.id ?? null;
      if (created.error) {
        const { data: list, error } = await admin.auth.admin.listUsers({ perPage: 1000 });
        if (error) return json({ error: `ログインの確認に失敗しました：${error.message}` }, 500);
        const found = list.users.find((u) => u.email?.toLowerCase() === email);
        if (!found) return json({ error: `ログインを作れませんでした：${created.error.message}` }, 500);
        if (found.email_confirmed_at) {
          // A confirmed login with this address already exists: link it and keep its password.
          password = null;
          uid = found.id;
        } else {
          // An unconfirmed login may have been registered by someone else in advance, with a password they know:
          // never link it; replace it with a fresh one.
          const { data: owner } = await admin.from('employees').select('id').eq('user_id', found.id).maybeSingle();
          if (owner) return json({ error: 'このメールのログインは、ほかの社員にひも付いています。' }, 409);
          const { error: delErr } = await admin.auth.admin.deleteUser(found.id);
          if (delErr) return json({ error: `ログインを作り直せませんでした：${delErr.message}` }, 500);
          const again = await admin.auth.admin.createUser({ email, password, email_confirm: true });
          if (again.error || !again.data.user) return json({ error: `ログインを作れませんでした：${again.error?.message}` }, 500);
          uid = again.data.user.id;
        }
      }
      const { data: taken } = await admin.from('employees').select('id').eq('user_id', uid).neq('id', emp.id).maybeSingle();
      if (taken) return json({ error: 'このメールのログインは、ほかの社員にひも付いています。' }, 409);
      patch.user_id = uid;
    } else {
      // They already have a login (e.g. from an earlier grant): move it to the approved address,
      // so the sign-in address always matches the one on file.
      const { data: cur, error } = await admin.auth.admin.getUserById(emp.user_id);
      if (error || !cur.user) return json({ error: 'いまのログインが見つかりません。' }, 500);
      if (cur.user.email?.toLowerCase() !== email) {
        const { error: mvErr } = await admin.auth.admin.updateUserById(emp.user_id, { email, email_confirm: true });
        if (mvErr) return json({ error: `ログインのメールアドレスを変えられませんでした：${mvErr.message}` }, 500);
      }
    }
  }

  const { error: upErr } = await admin.from('employees').update(patch).eq('id', emp.id);
  if (upErr) return json({ error: `社員の更新に失敗しました：${upErr.message}` }, 500);
  await admin.from('role_requests').update({ status: 'approved', ...decided }).eq('id', r.id);
  return json({ ok: true, status: 'approved', email: patch.email ?? emp.email ?? null, temp_password: password });
});
