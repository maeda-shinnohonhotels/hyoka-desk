'use strict';
const sb = supabase.createClient(HYOKA_CONFIG.supabaseUrl, HYOKA_CONFIG.supabaseKey);

const STATUS_LABEL = { preparing: '準備中', self: '自己評価 受付中', primary: '一次評価 期間', final: '最終決定 期間', closed: '締め' };
const ROLE_LABEL = { staff: '一般', evaluator: '評価者', hr: '人事' };
const RUBRIC = [
  [5, '異次元', '【他者への波及】自分ができるだけでなく、周囲の手本となり、他者や組織全体のレベルを引き上げている。'],
  [4, '優秀', '【自立＋アルファ】誰の指示も受けずに完璧にこなし、さらに効率化や改善の提案・実行まで行っている。'],
  [3, '標準', '【自立・合格】指示されたことやマニュアル通りの業務を、一人立ちしてミスなく安定してこなせている。'],
  [2, '不十分', '【要支援・あと一歩】部分的にはできているが、時々ミスや漏れがあり、まだサポートや定期的なチェックが必要。'],
  [1, '未習得', '【要指導】知識やスキルが不足しており、常に付きっきりの指導や指示がないと業務が進められない。'],
];
const SALARY_ITEMS = [
  ['base', '基本給'], ['family', '家族'], ['housing', '住宅'], ['qualification', '資格'],
  ['adjustment', '調整'], ['fixed_ot', '固定残業'], ['homecoming', '帰省'],
];

const S = { me: null, periods: [], period: null, criteria: [], facilities: [], view: null, viewArg: null };

// ---------- utilities ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const yen = (n) => (n == null || n === '' ? '' : Number(n).toLocaleString('ja-JP'));
const fullName = (e) => e ? `${e.last_name} ${e.first_name}`.trim() : '';
const isHR = () => S.me?.role === 'hr';
const facName = (id) => S.facilities.find((f) => f.id === id)?.name ?? '';

function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = err ? 'err' : ''; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), err ? 6000 : 2500);
}
async function q(p) {
  const { data, error } = await p;
  if (error) { toast(error.message, true); throw error; }
  return data;
}
function render(html) { $('#app').innerHTML = html; }
function downloadCSV(name, rows) {
  const csv = rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
  a.download = name; a.click();
}

// ---------- scoring ----------
function sumScores(scores, criteria = S.criteria) {
  return criteria.reduce((t, c) => t + (Number(scores?.[c.id]) || 0) * c.weight, 0);
}
function rankOf(total, period = S.period) {
  const rules = [...(period?.rank_rules ?? [])].sort((a, b) => b.min - a.min);
  return rules.find((r) => total >= r.min) ?? null;
}
function kpiFor(facilityId) {
  return S.kpis?.find((k) => k.facility_id === facilityId)?.kpi_score ?? null;
}
function complete(scores) { return S.criteria.every((c) => scores?.[c.id]); }

function scaleHTML(name, value, { readonly = false, refs = [] } = {}) {
  const opts = [1, 2, 3, 4, 5].map((n) =>
    `<label><input type="radio" name="${name}" value="${n}" ${Number(value) === n ? 'checked' : ''} ${readonly ? 'disabled' : ''}><span>${n}</span></label>`).join('');
  const refHTML = refs.map(([label, v]) => `<div class="ref">${esc(label)}<br><b>${v ?? '–'}</b></div>`).join('');
  return `<div class="row">${refHTML}<div class="scale ${readonly ? 'ro' : ''}">${opts}</div></div>`;
}
function criteriaForm(prefix, scores, opts = {}) {
  return S.criteria.map((c) => `
    <div class="crit">
      <div><div class="name">${esc(c.name)}${c.weight > 1 ? ` <span class="chip">×${c.weight}</span>` : ''}</div><div class="desc">${esc(c.description)}</div></div>
      ${scaleHTML(`${prefix}${c.id}`, scores?.[c.id], { readonly: opts.readonly, refs: (opts.refs ?? []).map(([l, s]) => [l, s?.[c.id]]) })}
    </div>`).join('');
}
function readScores(prefix, root = document) {
  const out = {};
  for (const c of S.criteria) {
    const v = $(`input[name="${prefix}${c.id}"]:checked`, root)?.value;
    if (v) out[c.id] = Number(v);
  }
  return out;
}
function rubricHTML() {
  return `<details class="rubric"><summary>評価基準（1〜5の定義）</summary>
    ${RUBRIC.map(([n, t, d]) => `<div><b>${n}（${t}）</b> ${esc(d)}</div>`).join('')}
    <div style="margin-top:6px">ランク：${(S.period?.rank_rules ?? []).map((r) => `<b>${esc(r.rank)}</b> ${r.min}点〜（+${yen(r.up)}円）`).join(' ／ ')}</div>
  </details>`;
}

// ---------- boot / auth ----------
async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return showLogin();
  const myId = await q(sb.rpc('link_me'));
  if (!myId) {
    $('#who').innerHTML = `${esc(session.user.email)} <button id="logout">ログアウト</button>`;
    $('#logout').onclick = logout;
    return render(`<div class="panel login"><h1>未登録のアカウントです</h1>
      <p>${esc(session.user.email)} は社員名簿に登録されていません。人事部にメールアドレスの登録を依頼してください。</p></div>`);
  }
  S.me = (await q(sb.from('employees').select('*').eq('id', myId).single()));
  [S.facilities, S.periods] = await Promise.all([
    q(sb.from('facilities').select('*').order('sort')),
    q(sb.from('periods').select('*').order('starts_on', { ascending: false })),
  ]);
  const saved = Number(sessionStorage.getItem('period'));
  await setPeriod(S.periods.find((p) => p.id === saved) ?? S.periods.find((p) => p.status !== 'closed' && p.status !== 'preparing') ?? S.periods.find((p) => p.status !== 'closed') ?? S.periods[0]);
  $('#who').innerHTML = `${esc(fullName(S.me))}（${ROLE_LABEL[S.me.role]}） <button id="logout">ログアウト</button>`;
  $('#logout').onclick = logout;
  buildNav();
}
async function setPeriod(p) {
  S.period = p;
  if (!p) { S.criteria = []; S.kpis = []; return; }
  sessionStorage.setItem('period', p.id);
  [S.criteria, S.kpis] = await Promise.all([
    q(sb.from('criteria').select('*').eq('period_id', p.id).order('sort')),
    q(sb.from('facility_kpis').select('*').eq('period_id', p.id)),
  ]);
}
async function logout() { await sb.auth.signOut(); location.reload(); }

function showLogin() {
  $('#nav').innerHTML = ''; $('#who').innerHTML = '';
  render(`<div class="panel login">
    <h1>ログイン</h1>
    <p class="muted">登録済みのメールアドレスを入力してください。ログイン用のリンクをお送りします。</p>
    <form id="lf" class="row"><input id="em" type="email" required placeholder="name@example.com" class="grow" autocomplete="email">
    <button class="primary">リンクを送信</button></form>
    <p id="lmsg" class="muted"></p></div>`);
  // A failed login link comes back as #error=...&error_code=...; show it instead of a silent login form.
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('error')) {
    $('#lmsg').textContent = h.get('error_code') === 'otp_expired'
      ? 'ログインリンクの期限が切れているか、すでに使えなくなっています。もう一度「リンクを送信」を押し、届いた最新のメールのリンクを開いてください。'
      : `ログインできませんでした：${h.get('error_description') ?? h.get('error')}`;
    $('#lmsg').style.color = 'var(--ng)';
    history.replaceState(null, '', location.pathname + location.search);
  }
  $('#lf').onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('#lf button'); btn.disabled = true;
    const { error } = await sb.auth.signInWithOtp({ email: $('#em').value.trim(), options: { emailRedirectTo: location.origin + location.pathname } });
    btn.disabled = false;
    $('#lmsg').textContent = error ? `送信できませんでした：${error.message}` : 'メールを送信しました。届いたリンクを開いてください（迷惑メールフォルダもご確認ください）。';
  };
}

// ---------- navigation ----------
function buildNav() {
  const items = [];
  if (S.me.eval_target) items.push(['self', '自己評価']);
  items.push(['results', '評価結果']);
  if (S.me.role !== 'staff') items.push(['evaluate', '部下の評価']);
  if (isHR()) items.push(['hr-progress', '進捗'], ['hr-list', '評価一覧'], ['hr-salary', '給与改定'], ['hr-staff', '社員・評価者'], ['hr-period', '期間・設定']);
  $('#nav').innerHTML = items.map(([k, l]) => `<button data-v="${k}">${l}</button>`).join('');
  $$('#nav button').forEach((b) => (b.onclick = () => go(b.dataset.v)));
  go(sessionStorage.getItem('view') && items.some(([k]) => k === sessionStorage.getItem('view')) ? sessionStorage.getItem('view') : items[0][0]);
}
function go(view, arg = null) {
  S.view = view; S.viewArg = arg;
  sessionStorage.setItem('view', view);
  $$('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.v === view));
  render('<p class="muted">読み込み中…</p>');
  (VIEWS[view] ?? VIEWS.results)(arg).catch((e) => { console.error(e); render(`<div class="panel">エラー：${esc(e.message)}</div>`); });
}
function periodPicker() {
  return `<select id="pp">${S.periods.map((p) => `<option value="${p.id}" ${p.id === S.period?.id ? 'selected' : ''}>${esc(p.name)}（${STATUS_LABEL[p.status]}）</option>`).join('')}</select>`;
}
function bindPeriodPicker() {
  const el = $('#pp'); if (!el) return;
  el.onchange = async () => { await setPeriod(S.periods.find((p) => p.id === Number(el.value))); go(S.view, S.viewArg); };
}

// ---------- views ----------
const VIEWS = {};

VIEWS.self = async () => {
  const p = S.period;
  const row = (await q(sb.from('self_reviews').select('*').eq('period_id', p.id).eq('employee_id', S.me.id).maybeSingle())) ?? {};
  const editable = p.status === 'self' && !row.submitted_at;
  const total = sumScores(row.scores);
  render(`
    <div class="row"><h1 class="grow">自己評価</h1>${periodPicker()}</div>
    <div class="panel">
      <div class="row"><div class="grow">${esc(fullName(S.me))}　${esc(facName(S.me.facility_id))}</div>
        ${row.submitted_at ? `<span class="chip ok">提出済み ${new Date(row.submitted_at).toLocaleDateString('ja-JP')}</span>` : p.status === 'self' ? '<span class="chip warn">未提出</span>' : `<span class="chip">${STATUS_LABEL[p.status]}</span>`}</div>
      ${!editable && !row.submitted_at ? '<p class="muted">現在は自己評価の受付期間ではありません。</p>' : ''}
      ${rubricHTML()}
      <form id="sf">${criteriaForm('s', row.scores, { readonly: !editable })}
        <p class="muted">項目合計：<b id="stot">${total}</b> / ${S.criteria.reduce((t, c) => t + 5 * c.weight, 0)}点（事業所の実績・成果は人事が記入します）</p>
        <label class="field">今期がんばったこと・来期の目標など<textarea id="sc" ${editable ? '' : 'disabled'}>${esc(row.comment)}</textarea></label>
        ${editable ? '<div class="row" style="margin-top:12px"><button type="button" id="ssave">下書き保存</button><button type="button" id="ssub" class="primary">提出する</button></div>' : ''}
      </form>
    </div>`);
  bindPeriodPicker();
  if (!editable) return;
  $('#sf').onchange = () => ($('#stot').textContent = sumScores(readScores('s')));
  const save = async (submit) => {
    const scores = readScores('s');
    if (submit && !complete(scores)) return toast('すべての項目を選択してください', true);
    if (submit && !confirm('提出すると修正できません。提出しますか？')) return;
    await q(sb.from('self_reviews').upsert({ period_id: p.id, employee_id: S.me.id, scores, comment: $('#sc').value, submitted_at: submit ? new Date().toISOString() : null }));
    toast(submit ? '提出しました' : '保存しました'); go('self');
  };
  $('#ssave').onclick = () => save(false);
  $('#ssub').onclick = () => save(true);
};

VIEWS.results = async () => {
  const rows = await q(sb.from('final_reviews').select('*, periods(name, rank_rules)').eq('employee_id', S.me.id).eq('published', true));
  const allCrit = rows.length ? await q(sb.from('criteria').select('*').in('period_id', rows.map((r) => r.period_id)).order('sort')) : [];
  render(`<h1>評価結果</h1>${rows.length ? rows.map((r) => `
    <div class="panel">
      <h2 style="margin-top:0">${esc(r.periods?.name)}</h2>
      <div class="summary"><div>合計 <span class="big">${r.total}</span> 点</div><div>ランク <span class="big">${esc(r.rank)}</span></div><div>昇給 <b>+${yen(r.up_amount)}円</b>（基本給）</div></div>
      <table style="margin-top:12px"><tr><th>項目</th><th class="num">評価</th></tr>
      <tr><td>事業所の実績・成果</td><td class="num">${r.kpi_score ?? '–'}</td></tr>
      ${allCrit.filter((c) => c.period_id === r.period_id).map((c) => `<tr><td>${esc(c.name)}</td><td class="num">${r.scores?.[c.id] ?? '–'}</td></tr>`).join('')}</table>
      ${r.comment ? `<h2>評価者コメント</h2><p>${esc(r.comment).replace(/\n/g, '<br>')}</p>` : ''}
    </div>`).join('') : '<div class="panel muted">公開された評価結果はまだありません。</div>'}`);
};

async function loadReviews(ids) {
  const p = S.period.id;
  const chunk = (tbl, cols) => ids.length ? q(sb.from(tbl).select(cols).eq('period_id', p).in('employee_id', ids)) : [];
  const [self, prim, fin] = await Promise.all([
    chunk('self_reviews', 'employee_id, scores, comment, submitted_at'),
    chunk('primary_reviews', 'employee_id, scores, comment, interview_note, submitted_at'),
    chunk('final_reviews', '*'),
  ]);
  const by = (arr) => Object.fromEntries(arr.map((r) => [r.employee_id, r]));
  return { self: by(self), prim: by(prim), fin: by(fin) };
}
function stageChip(id, R) {
  const f = R.fin[id];
  if (f?.published) return '<span class="chip ok">公開済み</span>';
  if (f?.approved_at) return '<span class="chip ok">人事承認済み</span>';
  if (f?.submitted_at) return '<span class="chip ok">最終提出済み</span>';
  if (R.prim[id]?.submitted_at) return '<span class="chip warn">一次評価済み</span>';
  if (R.self[id]?.submitted_at) return '<span class="chip warn">自己評価提出済み</span>';
  return '<span class="chip">未着手</span>';
}

VIEWS.evaluate = async (empId) => {
  if (empId) return evalDetail(empId);
  const links = await q(sb.from('employee_evaluators').select('employee_id, employees!employee_evaluators_employee_id_fkey(*)').eq('evaluator_id', S.me.id));
  const emps = links.map((l) => l.employees).filter((e) => e?.active && e.eval_target)
    .sort((a, b) => a.facility_id - b.facility_id || a.last_name.localeCompare(b.last_name, 'ja'));
  const R = await loadReviews(emps.map((e) => e.id));
  render(`
    <div class="row"><h1 class="grow">部下の評価</h1>${periodPicker()}</div>
    <p class="muted">${esc(S.period.name)}：${STATUS_LABEL[S.period.status]}　／　担当 ${emps.length}名</p>
    ${emps.length ? `<div class="grid-cards">${emps.map((e) => `
      <div class="card" data-id="${e.id}">
        <div class="row"><b class="grow">${esc(fullName(e))}</b>${R.fin[e.id]?.rank ? `<span class="rank">${esc(R.fin[e.id].rank)}</span>` : ''}</div>
        <div class="muted">${esc(facName(e.facility_id))}　${esc(e.grade)}</div>
        <div style="margin-top:6px">${stageChip(e.id, R)}</div>
      </div>`).join('')}</div>` : '<div class="panel muted">担当する社員が登録されていません。人事部に評価者の設定を依頼してください。</div>'}`);
  bindPeriodPicker();
  $$('.card').forEach((c) => (c.onclick = () => go('evaluate', c.dataset.id)));
};

async function evalDetail(empId) {
  const p = S.period;
  const emp = await q(sb.from('employees').select('*').eq('id', empId).single());
  const R = await loadReviews([empId]);
  const self = R.self[empId] ?? {}, prim = R.prim[empId] ?? {}, fin = R.fin[empId] ?? {};
  const kpi = fin.kpi_score ?? kpiFor(emp.facility_id);
  const primEditable = (isHR() || (['self', 'primary'].includes(p.status) && !prim.submitted_at)) && p.status !== 'closed';
  const finEditable = (isHR() ? !fin.approved_at : ['primary', 'final'].includes(p.status) && !fin.submitted_at) && p.status !== 'closed';
  const finScores = Object.keys(fin.scores ?? {}).length ? fin.scores : prim.scores;
  const totalWith = (scores) => sumScores(scores) + (kpi ?? 0) * p.kpi_weight;
  render(`
    <div class="row"><button id="back">← 一覧へ</button><h1 class="grow" style="margin:0">${esc(fullName(emp))}</h1>${stageChip(empId, R)}</div>
    <p class="muted">${esc(facName(emp.facility_id))}　${esc(emp.grade)}　入社 ${esc(emp.hire_date)}　／　${esc(p.name)}</p>
    ${rubricHTML()}
    <div class="panel">
      <h2 style="margin-top:0">本人の自己評価 ${self.submitted_at ? '<span class="chip ok">提出済み</span>' : '<span class="chip">未提出</span>'}</h2>
      ${self.comment ? `<p>${esc(self.comment).replace(/\n/g, '<br>')}</p>` : '<p class="muted">コメントなし</p>'}
    </div>
    <div class="panel">
      <h2 style="margin-top:0">一次評価 ${prim.submitted_at ? '<span class="chip ok">提出済み</span>' : ''}</h2>
      <form id="pf">${criteriaForm('p', prim.scores, { readonly: !primEditable, refs: [['自己', self.scores]] })}
        <p>事業所の実績・成果：<b>${kpi ?? '未設定'}</b> ×${p.kpi_weight}　／　見込み合計 <b id="ptot">${totalWith(prim.scores)}</b>点 → <b id="prank">${esc(rankOf(totalWith(prim.scores))?.rank ?? '')}</b></p>
        <label class="field">評価コメント（本人には公開されません）<textarea id="pc" ${primEditable ? '' : 'disabled'}>${esc(prim.comment)}</textarea></label>
        <label class="field">面談メモ（自己評価とのギャップ・確認ポイント）<textarea id="pi" ${primEditable ? '' : 'disabled'}>${esc(prim.interview_note)}</textarea></label>
        ${primEditable ? '<div class="row" style="margin-top:12px"><button type="button" id="psave">下書き保存</button><button type="button" id="psub" class="primary">一次評価を提出</button></div>' : ''}
      </form>
    </div>
    <div class="panel">
      <h2 style="margin-top:0">最終決定（面談後） ${fin.submitted_at ? '<span class="chip ok">提出済み</span>' : ''}</h2>
      ${!['primary', 'final', 'closed'].includes(p.status) && !isHR() ? '<p class="muted">一次評価期間になると入力できます。</p>' : `
      <form id="ff">${criteriaForm('f', finScores, { readonly: !finEditable, refs: [['自己', self.scores], ['一次', prim.scores]] })}
        <p>合計 <b id="ftot">${totalWith(finScores)}</b>点 → ランク <b id="frank">${esc(rankOf(totalWith(finScores))?.rank ?? '')}</b>（+${yen(rankOf(totalWith(finScores))?.up)}円）</p>
        <label class="field">本人へのフィードバック（公開時に本人に表示されます）<textarea id="fc" ${finEditable ? '' : 'disabled'}>${esc(fin.comment)}</textarea></label>
        ${finEditable ? '<div class="row" style="margin-top:12px"><button type="button" id="fsave">下書き保存</button><button type="button" id="fsub" class="primary">最終評価を提出</button></div>' : ''}
      </form>`}
      ${isHR() ? `<div class="row" style="margin-top:12px;border-top:1px solid var(--line);padding-top:12px">
        <span class="grow muted">人事操作</span>
        ${fin.submitted_at && !fin.approved_at ? '<button id="hrback" class="danger">評価者へ差し戻し</button><button id="hrok" class="primary">承認</button>' : ''}
        ${fin.approved_at && !fin.published ? '<button id="hrunok">承認取消</button><button id="hrpub" class="primary">本人に公開</button>' : ''}
        ${fin.published ? '<button id="hrunpub">公開を取り消す</button>' : ''}
      </div>` : ''}
    </div>`);
  $('#back').onclick = () => go(isHR() && S.view !== 'evaluate' ? S.view : 'evaluate');
  const recalc = (prefix, tot, rank) => {
    const t = totalWith(readScores(prefix));
    $(tot).textContent = t; $(rank).textContent = rankOf(t)?.rank ?? '';
  };
  if ($('#pf')) $('#pf').onchange = () => recalc('p', '#ptot', '#prank');
  if ($('#ff')) $('#ff').onchange = () => recalc('f', '#ftot', '#frank');
  const back = () => evalDetail(empId).catch((e) => toast(e.message, true));
  if (primEditable) {
    const save = async (submit) => {
      const scores = readScores('p');
      if (submit && !complete(scores)) return toast('すべての項目を選択してください', true);
      await q(sb.from('primary_reviews').upsert({ period_id: p.id, employee_id: empId, scores, comment: $('#pc').value, interview_note: $('#pi').value,
        submitted_at: submit ? new Date().toISOString() : prim.submitted_at ?? null, submitted_by: S.me.id }));
      toast(submit ? '一次評価を提出しました' : '保存しました'); back();
    };
    $('#psave').onclick = () => save(false);
    $('#psub').onclick = () => save(true);
  }
  if (finEditable && $('#ff')) {
    const save = async (submit) => {
      const scores = readScores('f');
      if (submit && !complete(scores)) return toast('すべての項目を選択してください', true);
      if (submit && !confirm('最終評価を提出します。提出後は人事の承認待ちになります。')) return;
      await q(sb.from('final_reviews').upsert({ period_id: p.id, employee_id: empId, scores, comment: $('#fc').value,
        kpi_score: kpi, submitted_at: submit ? new Date().toISOString() : fin.submitted_at ?? null, submitted_by: S.me.id }));
      toast(submit ? '最終評価を提出しました' : '保存しました'); back();
    };
    $('#fsave').onclick = () => save(false);
    $('#fsub').onclick = () => save(true);
  }
  const hr = (patch, msg) => async () => {
    await q(sb.from('final_reviews').update(patch).eq('period_id', p.id).eq('employee_id', empId));
    toast(msg); back();
  };
  if ($('#hrok')) $('#hrok').onclick = hr({ approved_at: new Date().toISOString() }, '承認しました');
  if ($('#hrback')) $('#hrback').onclick = hr({ submitted_at: null }, '差し戻しました');
  if ($('#hrunok')) $('#hrunok').onclick = hr({ approved_at: null }, '承認を取り消しました');
  if ($('#hrpub')) $('#hrpub').onclick = hr({ published: true }, '公開しました');
  if ($('#hrunpub')) $('#hrunpub').onclick = hr({ published: false }, '公開を取り消しました');
}

// ---------- HR: progress ----------
async function targets() {
  return (await q(sb.from('employees').select('*').eq('active', true).eq('eval_target', true).order('last_name')))
    .sort((a, b) => (S.facilities.find((f) => f.id === a.facility_id)?.sort ?? 99) - (S.facilities.find((f) => f.id === b.facility_id)?.sort ?? 99));
}
VIEWS['hr-progress'] = async () => {
  const emps = await targets();
  const R = await loadReviews(emps.map((e) => e.id));
  const ee = await q(sb.from('employee_evaluators').select('employee_id'));
  const hasEval = new Set(ee.map((r) => r.employee_id));
  const byFac = S.facilities.map((f) => {
    const list = emps.filter((e) => e.facility_id === f.id);
    const n = (pred) => list.filter(pred).length;
    return { f, total: list.length, self: n((e) => R.self[e.id]?.submitted_at), prim: n((e) => R.prim[e.id]?.submitted_at),
      fin: n((e) => R.fin[e.id]?.submitted_at), ok: n((e) => R.fin[e.id]?.approved_at), noEval: n((e) => !hasEval.has(e.id)), kpi: kpiFor(f.id) };
  }).filter((r) => r.total);
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const cell = (a, b) => `<td class="num">${a}/${b}<div class="bar"><i style="width:${pct(a, b)}%"></i></div></td>`;
  render(`
    <div class="row"><h1 class="grow">進捗</h1>${periodPicker()}</div>
    <p class="muted">${STATUS_LABEL[S.period.status]}　／　評価対象 ${emps.length}名</p>
    <div class="panel scroll"><table>
      <tr><th>施設</th><th class="num">対象</th><th class="num">自己評価</th><th class="num">一次評価</th><th class="num">最終提出</th><th class="num">人事承認</th><th class="num">KPI点</th><th>注意</th></tr>
      ${byFac.map((r) => `<tr><td>${esc(r.f.name)}</td><td class="num">${r.total}</td>${cell(r.self, r.total)}${cell(r.prim, r.total)}${cell(r.fin, r.total)}${cell(r.ok, r.total)}
        <td class="num">${r.kpi ?? '<span class="chip warn">未設定</span>'}</td><td>${r.noEval ? `<span class="chip ng">評価者未設定 ${r.noEval}名</span>` : ''}</td></tr>`).join('')}
    </table></div>`);
  bindPeriodPicker();
};

// ---------- HR: list ----------
VIEWS['hr-list'] = async () => {
  const emps = await targets();
  const R = await loadReviews(emps.map((e) => e.id));
  const fac = Number(sessionStorage.getItem('fac')) || 0;
  const list = emps.filter((e) => !fac || e.facility_id === fac);
  const tot = (s) => (s && Object.keys(s).length ? sumScores(s) : '');
  render(`
    <div class="row"><h1 class="grow">評価一覧</h1>${periodPicker()}
      <select id="fac"><option value="0">全施設</option>${S.facilities.map((f) => `<option value="${f.id}" ${f.id === fac ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select>
      <button id="approveAll">提出済みを一括承認</button><button id="publishAll" class="primary">承認済みを一括公開</button><button id="csv">CSV出力</button></div>
    <div class="panel scroll"><table>
      <tr><th>施設</th><th>氏名</th><th>等級</th><th class="num">自己</th><th class="num">一次</th><th class="num">KPI</th><th class="num">最終合計</th><th>ランク</th><th class="num">昇給額</th><th>状況</th></tr>
      ${list.map((e) => { const f = R.fin[e.id]; return `<tr data-id="${e.id}" style="cursor:pointer">
        <td>${esc(facName(e.facility_id))}</td><td>${esc(fullName(e))}</td><td>${esc(e.grade)}</td>
        <td class="num">${tot(R.self[e.id]?.scores)}</td><td class="num">${tot(R.prim[e.id]?.scores)}</td><td class="num">${f?.kpi_score ?? kpiFor(e.facility_id) ?? ''}</td>
        <td class="num"><b>${f?.total ?? ''}</b></td><td><b>${esc(f?.rank)}</b></td><td class="num">${f ? yen(f.up_amount) : ''}</td><td>${stageChip(e.id, R)}</td></tr>`; }).join('')}
    </table></div>`);
  bindPeriodPicker();
  $('#fac').onchange = () => { sessionStorage.setItem('fac', $('#fac').value); go('hr-list'); };
  $$('tr[data-id]').forEach((tr) => (tr.onclick = () => evalDetail(tr.dataset.id).catch((e) => toast(e.message, true))));
  const ids = list.map((e) => e.id);
  $('#approveAll').onclick = async () => {
    const t = ids.filter((id) => R.fin[id]?.submitted_at && !R.fin[id]?.approved_at);
    if (!t.length) return toast('承認待ちはありません');
    if (!confirm(`${t.length}名の最終評価を承認します。`)) return;
    await q(sb.from('final_reviews').update({ approved_at: new Date().toISOString() }).eq('period_id', S.period.id).in('employee_id', t));
    toast('承認しました'); go('hr-list');
  };
  $('#publishAll').onclick = async () => {
    const t = ids.filter((id) => R.fin[id]?.approved_at && !R.fin[id]?.published);
    if (!t.length) return toast('公開待ちはありません');
    if (!confirm(`${t.length}名の評価結果を本人に公開します。`)) return;
    await q(sb.from('final_reviews').update({ published: true }).eq('period_id', S.period.id).in('employee_id', t));
    toast('公開しました'); go('hr-list');
  };
  $('#csv').onclick = () => downloadCSV(`評価一覧_${S.period.name}.csv`, [
    ['施設', '氏名', '等級', '自己合計', '一次合計', 'KPI点', ...S.criteria.map((c) => `最終:${c.name}`), '最終合計', 'ランク', '昇給額', '承認', '公開'],
    ...list.map((e) => { const f = R.fin[e.id] ?? {}; return [facName(e.facility_id), fullName(e), e.grade, tot(R.self[e.id]?.scores), tot(R.prim[e.id]?.scores),
      f.kpi_score ?? '', ...S.criteria.map((c) => f.scores?.[c.id] ?? ''), f.total ?? '', f.rank ?? '', f.up_amount ?? '', f.approved_at ? '済' : '', f.published ? '済' : '']; }),
  ]);
};

// ---------- HR: salary ----------
const monthly = (r, side) => SALARY_ITEMS.reduce((t, [k]) => t + (Number(r[`${k}_${side}`]) || 0), 0);
// Rank and raise used for the salary revision: a hand-entered value (e.g. a recommendation) wins over the final review.
const salaryEval = (r, f) => ({
  rank: r.eval_rank ?? f?.rank ?? null,
  up: r.eval_up ?? (r.eval_rank != null ? (S.period?.rank_rules ?? []).find((x) => x.rank === r.eval_rank)?.up ?? null : f?.up_amount ?? null),
  manual: r.eval_rank != null || r.eval_up != null,
});
function evalCell(r, f, editable) {
  const ev = salaryEval(r, f);
  const ref = f?.rank ? `評価 ${esc(f.rank)} +${yen(f.up_amount)}` : esc(r.legacy_eval);
  if (editable) {
    return `<input class="xs" data-k="eval_rank" value="${esc(r.eval_rank)}" placeholder="${esc(f?.rank ?? '')}">
      +<input class="sm" data-k="eval_up" value="${r.eval_up ?? ''}" placeholder="${f?.up_amount ?? ''}" inputmode="numeric">
      <div class="muted" style="font-size:12px">${ref}</div>`;
  }
  if (!ev.rank && ev.up == null) return esc(r.legacy_eval);
  return `<b>${esc(ev.rank)}</b> +${yen(ev.up)}${ev.manual ? ` <span class="chip warn" title="手打ち">手打ち</span><div class="muted" style="font-size:12px">${ref}</div>` : ''}`;
}
VIEWS['hr-salary'] = async () => {
  const p = S.period;
  const [rows, emps, fins] = await Promise.all([
    q(sb.from('salary_revisions').select('*').eq('period_id', p.id)),
    q(sb.from('employees').select('*').eq('active', true)),
    q(sb.from('final_reviews').select('employee_id, rank, up_amount, approved_at').eq('period_id', p.id)),
  ]);
  const empBy = Object.fromEntries(emps.map((e) => [e.id, e]));
  const finBy = Object.fromEntries(fins.map((f) => [f.employee_id, f]));
  const fac = Number(sessionStorage.getItem('fac')) || 0;
  const list = rows.filter((r) => empBy[r.employee_id] && (!fac || empBy[r.employee_id].facility_id === fac))
    .sort((a, b) => (S.facilities.find((f) => f.id === empBy[a.employee_id].facility_id)?.sort ?? 99) - (S.facilities.find((f) => f.id === empBy[b.employee_id].facility_id)?.sort ?? 99));
  const sumB = list.reduce((t, r) => t + monthly(r, 'before'), 0), sumA = list.reduce((t, r) => t + (r.base_after != null ? monthly(r, 'after') : monthly(r, 'before')), 0);
  const editable = p.status !== 'closed';
  const inp = (r, k, cls = 'sm') => editable ? `<input class="${cls}" data-k="${k}" value="${r[k] ?? ''}" ${cls === 'sm' ? 'inputmode="numeric"' : ''}>` : esc(cls === 'sm' ? yen(r[k]) : r[k]);
  render(`
    <div class="row"><h1 class="grow">給与改定</h1>${periodPicker()}
      <select id="fac"><option value="0">全施設</option>${S.facilities.map((f) => `<option value="${f.id}" ${f.id === fac ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select>
      ${editable ? '<button id="seed">前期の改定後を取り込む</button><button id="apply">評価ランクの昇給額を反映</button>' : ''}<button id="csv">CSV出力</button></div>
    <p class="muted">月額計（通勤手当を除く）：改定前 ${yen(sumB)}円 → 改定後 ${yen(sumA)}円（差額 ${yen(sumA - sumB)}円／${sumB ? ((sumA / sumB - 1) * 100).toFixed(2) : 0}%）　${list.length}名</p>
    <div class="panel scroll"><table id="st">
      <tr><th>施設</th><th>氏名</th><th>等級</th><th>評価</th><th class="num">基本給(前)</th><th class="num">基本給(後)</th>${SALARY_ITEMS.slice(1).map(([, l]) => `<th class="num">${l}(後)</th>`).join('')}<th class="num">月額計(前)</th><th class="num">月額計(後)</th><th class="num">差額</th><th>備考</th>${editable ? '<th></th>' : ''}</tr>
      ${list.map((r) => { const e = empBy[r.employee_id], f = finBy[r.employee_id]; const a = r.base_after != null ? monthly(r, 'after') : null; return `<tr data-id="${r.employee_id}">
        <td>${esc(facName(e.facility_id))}</td><td>${esc(fullName(e))}</td><td>${esc(r.grade_before)}${r.grade_after && r.grade_after !== r.grade_before ? '→' + esc(r.grade_after) : ''}</td>
        <td style="white-space:nowrap">${evalCell(r, f, editable)}</td>
        <td class="num">${yen(r.base_before)}</td><td class="num">${inp(r, 'base_after')}</td>
        ${SALARY_ITEMS.slice(1).map(([k]) => `<td class="num">${inp(r, `${k}_after`)}</td>`).join('')}
        <td class="num">${yen(monthly(r, 'before'))}</td><td class="num">${a == null ? '' : yen(a)}</td><td class="num">${a == null ? '' : yen(a - monthly(r, 'before'))}</td>
        <td>${inp(r, 'note', '')}</td>${editable ? '<td><button class="rs">保存</button></td>' : ''}</tr>`; }).join('')}
    </table></div>
    <p class="muted">固定残業手当は基本給に連動するため、改定後の金額を確認して入力してください。</p>`);
  bindPeriodPicker();
  $('#fac').onchange = () => { sessionStorage.setItem('fac', $('#fac').value); go('hr-salary'); };
  $('#csv').onclick = () => downloadCSV(`給与改定_${p.name}.csv`, [
    ['施設', '姓', '名', '等級(前)', '等級(後)', '評価', '昇給額', ...SALARY_ITEMS.flatMap(([, l]) => [`${l}(前)`, `${l}(後)`]), '通勤(前)', '通勤(後)', '月額計(前)', '月額計(後)', '差額', '備考'],
    ...list.map((r) => { const e = empBy[r.employee_id], f = finBy[r.employee_id]; const a = r.base_after != null ? monthly(r, 'after') : ''; return [
      facName(e.facility_id), e.last_name, e.first_name, r.grade_before, r.grade_after, salaryEval(r, f).rank ?? r.legacy_eval ?? '', salaryEval(r, f).up ?? '',
      ...SALARY_ITEMS.flatMap(([k]) => [r[`${k}_before`], r[`${k}_after`]]), r.commute_before, r.commute_after,
      monthly(r, 'before'), a, a === '' ? '' : a - monthly(r, 'before'), r.note]; }),
  ]);
  if (!editable) return;
  $$('#st .rs').forEach((b) => (b.onclick = async () => {
    const tr = b.closest('tr'); const patch = {};
    $$('input', tr).forEach((i) => (patch[i.dataset.k] = ['note', 'eval_rank'].includes(i.dataset.k) ? i.value.trim() || null : i.value === '' ? null : Number(i.value.replace(/,/g, ''))));
    await q(sb.from('salary_revisions').update(patch).eq('period_id', p.id).eq('employee_id', tr.dataset.id));
    toast('保存しました'); go('hr-salary');
  }));
  $('#seed').onclick = async () => {
    const prev = S.periods.filter((x) => x.starts_on < p.starts_on).sort((a, b) => (a.starts_on < b.starts_on ? 1 : -1))[0];
    if (!prev) return toast('前期がありません', true);
    const prevRows = await q(sb.from('salary_revisions').select('*').eq('period_id', prev.id));
    const have = new Set(rows.map((r) => r.employee_id));
    const ins = prevRows.filter((r) => empBy[r.employee_id] && !have.has(r.employee_id)).map((r) => {
      const o = { period_id: p.id, employee_id: r.employee_id, grade_before: r.grade_after ?? r.grade_before };
      for (const [k] of [...SALARY_ITEMS, ['commute']]) {
        o[`${k}_before`] = r.base_after != null ? r[`${k}_after`] ?? r[`${k}_before`] : r[`${k}_before`];
        if (k !== 'base') o[`${k}_after`] = o[`${k}_before`];
      }
      o.grade_after = o.grade_before;
      return o;
    });
    if (!ins.length) return toast('取り込む対象はありません');
    if (!confirm(`${prev.name} の改定後給与を、${ins.length}名分「改定前」として取り込みます。`)) return;
    await q(sb.from('salary_revisions').insert(ins));
    toast(`${ins.length}名を取り込みました`); go('hr-salary');
  };
  $('#apply').onclick = async () => {
    const t = list.filter((r) => (finBy[r.employee_id]?.approved_at || r.eval_up != null) && r.base_before != null);
    if (!t.length) return toast('人事承認済みの評価・手打ちの昇給額がありません', true);
    if (!confirm(`人事承認済み・手打ちの ${t.length}名の基本給(後)を「基本給(前)＋昇給額」で上書きします。`)) return;
    for (const r of t) {
      await q(sb.from('salary_revisions').update({ base_after: r.base_before + (salaryEval(r, finBy[r.employee_id]).up ?? 0) }).eq('period_id', p.id).eq('employee_id', r.employee_id));
    }
    toast('反映しました'); go('hr-salary');
  };
};

// ---------- HR: staff & evaluators ----------
VIEWS['hr-staff'] = async () => {
  const [emps, links] = await Promise.all([
    q(sb.from('employees').select('*').order('last_name')),
    q(sb.from('employee_evaluators').select('*')),
  ]);
  const by = Object.fromEntries(emps.map((e) => [e.id, e]));
  const fac = Number(sessionStorage.getItem('sfac')) || 0;
  const kw = sessionStorage.getItem('skw') ?? '';
  const list = emps.filter((e) => (!fac || e.facility_id === fac) && (!kw || fullName(e).includes(kw) || (e.email ?? '').includes(kw)))
    .sort((a, b) => (S.facilities.find((f) => f.id === a.facility_id)?.sort ?? 99) - (S.facilities.find((f) => f.id === b.facility_id)?.sort ?? 99) || Number(b.role !== 'staff') - Number(a.role !== 'staff'));
  const evaluators = emps.filter((e) => e.active && e.role !== 'staff');
  const evOf = (id) => links.filter((l) => l.employee_id === id).map((l) => by[l.evaluator_id]).filter(Boolean);
  const facOpts = (sel) => S.facilities.map((f) => `<option value="${f.id}" ${f.id === sel ? 'selected' : ''}>${esc(f.name)}</option>`).join('');
  const noEmail = emps.filter((e) => e.active && !e.email).length;
  render(`
    <div class="row"><h1 class="grow">社員・評価者</h1>
      <select id="sfac"><option value="0">全施設</option>${facOpts(fac)}</select>
      <input id="skw" placeholder="氏名・メールで検索" value="${esc(kw)}"><button id="csv">CSV出力</button></div>
    ${noEmail ? `<p class="muted"><span class="chip warn">メール未登録 ${noEmail}名</span>　メールアドレスを登録するとログインできるようになります。</p>` : ''}
    <div class="panel">
      <h2 style="margin-top:0">評価者の一括設定</h2>
      <div class="row">
        <select id="bfac">${facOpts(fac)}</select> の評価対象者全員に
        <select id="bev">${evaluators.map((e) => `<option value="${e.id}">${esc(fullName(e))}（${esc(facName(e.facility_id))}）</option>`).join('')}</select>
        を評価者として <button id="badd">追加</button><button id="bdel" class="danger">外す</button>
      </div>
      <p class="muted">評価者の候補は、権限が「評価者」または「人事」の社員です。先に下の一覧で権限を変更してください。</p>
    </div>
    <div class="panel scroll"><table id="et">
      <tr><th>施設</th><th>氏名</th><th>等級</th><th>メール</th><th>権限</th><th>評価対象</th><th>在籍</th><th>評価者</th><th></th></tr>
      ${list.map((e) => `<tr data-id="${e.id}">
        <td><select data-k="facility_id">${facOpts(e.facility_id)}</select></td>
        <td>${esc(fullName(e))}${e.user_id ? ' <span class="chip ok" title="ログイン済み">✓</span>' : ''}</td>
        <td><input class="xs" data-k="grade" value="${esc(e.grade)}"></td>
        <td><input data-k="email" type="email" value="${esc(e.email)}" placeholder="未登録"></td>
        <td><select data-k="role">${Object.entries(ROLE_LABEL).map(([k, l]) => `<option value="${k}" ${e.role === k ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
        <td><input type="checkbox" data-k="eval_target" ${e.eval_target ? 'checked' : ''}></td>
        <td><input type="checkbox" data-k="active" ${e.active ? 'checked' : ''}></td>
        <td>${e.eval_target ? (evOf(e.id).map((v) => esc(fullName(v))).join('、') || '<span class="chip ng">未設定</span>') : ''}</td>
        <td><button class="es">保存</button></td></tr>`).join('')}
    </table></div>
    <div class="panel">
      <h2 style="margin-top:0">社員を追加</h2>
      <form id="af" class="row">
        <input name="last_name" placeholder="姓" required class="sm"><input name="first_name" placeholder="名" class="sm">
        <select name="facility_id">${facOpts(fac)}</select><input name="grade" placeholder="等級" class="xs">
        <input name="hire_date" type="date"><input name="email" type="email" placeholder="メールアドレス">
        <button class="primary">追加</button></form>
    </div>`);
  $('#sfac').onchange = () => { sessionStorage.setItem('sfac', $('#sfac').value); go('hr-staff'); };
  $('#skw').onchange = () => { sessionStorage.setItem('skw', $('#skw').value.trim()); go('hr-staff'); };
  $$('#et .es').forEach((b) => (b.onclick = async () => {
    const tr = b.closest('tr'); const patch = {};
    $$('[data-k]', tr).forEach((i) => {
      const k = i.dataset.k;
      patch[k] = i.type === 'checkbox' ? i.checked : k === 'facility_id' ? Number(i.value) : i.value.trim() || null;
    });
    if (tr.dataset.id === S.me.id && patch.role !== 'hr' && !confirm('自分の人事権限を外すと、この画面に戻れなくなります。続けますか？')) return;
    await q(sb.from('employees').update(patch).eq('id', tr.dataset.id));
    toast('保存しました'); go('hr-staff');
  }));
  const bulk = async (add) => {
    const f = Number($('#bfac').value), ev = $('#bev').value;
    if (!ev) return toast('評価者を選んでください', true);
    const ids = emps.filter((e) => e.facility_id === f && e.active && e.eval_target && e.id !== ev).map((e) => e.id);
    if (add) await q(sb.from('employee_evaluators').upsert(ids.map((id) => ({ employee_id: id, evaluator_id: ev })), { ignoreDuplicates: true }));
    else await q(sb.from('employee_evaluators').delete().eq('evaluator_id', ev).in('employee_id', ids));
    toast(`${ids.length}名に${add ? '設定' : '解除'}しました`); go('hr-staff');
  };
  $('#badd').onclick = () => bulk(true);
  $('#bdel').onclick = () => bulk(false);
  $('#af').onsubmit = async (ev) => {
    ev.preventDefault();
    const o = Object.fromEntries(new FormData(ev.target));
    for (const k in o) if (o[k] === '') o[k] = null;
    o.facility_id = Number(o.facility_id);
    await q(sb.from('employees').insert(o));
    toast('追加しました'); go('hr-staff');
  };
  $('#csv').onclick = () => downloadCSV('社員一覧.csv', [['施設', '姓', '名', '等級', '入社日', 'メール', '権限', '評価対象', '在籍', '評価者'],
    ...list.map((e) => [facName(e.facility_id), e.last_name, e.first_name, e.grade, e.hire_date, e.email, ROLE_LABEL[e.role], e.eval_target ? '○' : '', e.active ? '○' : '', evOf(e.id).map(fullName).join('、')])]);
};

// ---------- HR: periods & settings ----------
VIEWS['hr-period'] = async () => {
  const p = S.period;
  const rules = [...p.rank_rules].sort((a, b) => b.min - a.min);
  render(`
    <div class="row"><h1 class="grow">期間・設定</h1>${periodPicker()}</div>
    <div class="panel">
      <h2 style="margin-top:0">${esc(p.name)}</h2>
      <div class="row"><label class="field">状態<select id="pst">${Object.entries(STATUS_LABEL).map(([k, l]) => `<option value="${k}" ${p.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="field">KPIの倍率<input id="pkw" class="xs" type="number" min="0" value="${p.kpi_weight}"></label>
        <button id="psave" class="primary" style="align-self:flex-end">保存</button></div>
      <p class="muted">準備中 → 自己評価 受付中（本人が入力）→ 一次評価 期間（評価者が入力）→ 最終決定 期間（面談後に確定）→ 締め（すべて編集不可）</p>
      <h2>ランク基準</h2>
      <table id="rr" style="max-width:420px"><tr><th>ランク</th><th class="num">最低点</th><th class="num">昇給額(円)</th></tr>
        ${rules.map((r) => `<tr><td><input class="xs" data-k="rank" value="${esc(r.rank)}"></td><td class="num"><input class="xs" data-k="min" type="number" value="${r.min}"></td><td class="num"><input class="sm" data-k="up" type="number" value="${r.up}"></td></tr>`).join('')}
      </table>
    </div>
    <div class="panel">
      <h2 style="margin-top:0">事業所の実績・成果（KPI）</h2>
      <p class="muted">達成率の目安：1＝80%未満／2＝80〜94%／3＝95〜104%／4＝105〜119%／5＝120%以上。達成率を入れると点数を自動で入れます。</p>
      <table id="kt" style="max-width:520px"><tr><th>施設</th><th class="num">達成率(%)</th><th class="num">点数</th></tr>
        ${S.facilities.map((f) => { const k = S.kpis.find((x) => x.facility_id === f.id) ?? {}; return `<tr data-f="${f.id}"><td>${esc(f.name)}</td>
          <td class="num"><input class="sm" data-k="rate" type="number" step="0.1" value="${k.kpi_rate != null ? Math.round(k.kpi_rate * 1000) / 10 : ''}"></td>
          <td class="num"><select data-k="score"><option value=""></option>${[1, 2, 3, 4, 5].map((n) => `<option ${k.kpi_score === n ? 'selected' : ''}>${n}</option>`).join('')}</select></td></tr>`; }).join('')}
      </table>
      <button id="ksave" class="primary" style="margin-top:8px">KPIを保存</button>
    </div>
    <div class="panel">
      <h2 style="margin-top:0">評価項目</h2>
      <table id="ct"><tr><th>#</th><th>項目名</th><th>説明</th><th class="num">倍率</th></tr>
        ${S.criteria.map((c) => `<tr data-id="${c.id}"><td>${c.sort}</td><td><input data-k="name" value="${esc(c.name)}"></td><td><input data-k="description" value="${esc(c.description)}" style="width:100%"></td><td class="num"><input class="xs" type="number" min="1" data-k="weight" value="${c.weight}"></td></tr>`).join('')}
      </table>
      <div class="row" style="margin-top:8px"><button id="csave">項目を保存</button><button id="cadd">項目を追加</button>
        <span class="muted">評価が始まってから項目を変えると、入力済みの点数と合わなくなるので注意してください。</span></div>
    </div>
    <div class="panel">
      <h2 style="margin-top:0">新しい期間を作成</h2>
      <form id="nf" class="row"><input name="name" placeholder="例：2027.10～2028.9期" required><input name="starts_on" type="date" required><input name="ends_on" type="date" required>
        <button class="primary">作成（現在の期間の項目・基準を引き継ぐ）</button></form>
    </div>`);
  bindPeriodPicker();
  const reloadPeriods = async (id) => {
    S.periods = await q(sb.from('periods').select('*').order('starts_on', { ascending: false }));
    await setPeriod(S.periods.find((x) => x.id === id)); go('hr-period');
  };
  $('#psave').onclick = async () => {
    const rank_rules = $$('#rr tr').slice(1).map((tr) => ({ rank: $('[data-k=rank]', tr).value.trim(), min: Number($('[data-k=min]', tr).value), up: Number($('[data-k=up]', tr).value) }));
    await q(sb.from('periods').update({ status: $('#pst').value, kpi_weight: Number($('#pkw').value), rank_rules }).eq('id', p.id));
    toast('保存しました'); reloadPeriods(p.id);
  };
  $$('#kt [data-k=rate]').forEach((i) => (i.onchange = () => {
    const v = Number(i.value); if (i.value === '') return;
    $('[data-k=score]', i.closest('tr')).value = v < 80 ? 1 : v < 95 ? 2 : v < 105 ? 3 : v < 120 ? 4 : 5;
  }));
  $('#ksave').onclick = async () => {
    const rows = $$('#kt tr[data-f]').map((tr) => ({ period_id: p.id, facility_id: Number(tr.dataset.f),
      kpi_rate: $('[data-k=rate]', tr).value === '' ? null : Number($('[data-k=rate]', tr).value) / 100,
      kpi_score: $('[data-k=score]', tr).value === '' ? null : Number($('[data-k=score]', tr).value) }));
    await q(sb.from('facility_kpis').upsert(rows));
    toast('保存しました'); reloadPeriods(p.id);
  };
  $('#csave').onclick = async () => {
    for (const tr of $$('#ct tr[data-id]')) {
      await q(sb.from('criteria').update({ name: $('[data-k=name]', tr).value, description: $('[data-k=description]', tr).value, weight: Number($('[data-k=weight]', tr).value) }).eq('id', tr.dataset.id));
    }
    toast('保存しました'); reloadPeriods(p.id);
  };
  $('#cadd').onclick = async () => {
    const name = prompt('追加する項目名'); if (!name) return;
    await q(sb.from('criteria').insert({ period_id: p.id, name, sort: S.criteria.length + 1 }));
    reloadPeriods(p.id);
  };
  $('#nf').onsubmit = async (ev) => {
    ev.preventDefault();
    const o = Object.fromEntries(new FormData(ev.target));
    const np = await q(sb.from('periods').insert({ ...o, status: 'preparing', kpi_weight: p.kpi_weight, rank_rules: p.rank_rules }).select().single());
    await q(sb.from('criteria').insert(S.criteria.map(({ sort, name, description, weight }) => ({ period_id: np.id, sort, name, description, weight }))));
    toast('作成しました'); reloadPeriods(np.id);
  };
};

// getSession() waits for the client to finish reading a login link in the URL, so no auth listener is needed.
boot().catch((e) => render(`<div class="panel">エラー：${esc(e.message)}</div>`));
