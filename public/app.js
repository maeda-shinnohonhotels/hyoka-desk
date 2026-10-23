'use strict';
const sb = supabase.createClient(HYOKA_CONFIG.supabaseUrl, HYOKA_CONFIG.supabaseKey);

const STATUS_LABEL = { preparing: '準備中', self: '自己評価 受付中', primary: '一次評価 期間', final: '最終決定 期間', closed: '締め' };
const ROLE_LABEL = { staff: '一般', evaluator1: '評価者（1次）', evaluator2: '評価者（2次）', hr: '人事', director: '取締役' };
const HR_ROLES = ['hr', 'director'];
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
const isHR = () => HR_ROLES.includes(S.me?.role);
const facName = (id) => S.facilities.find((f) => f.id === id)?.name ?? '';
// Sort facilities in their configured order, not alphabetically.
const facSort = (id) => S.facilities.find((f) => f.id === id)?.sort ?? 99;

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
// Filter values live in sessionStorage so they survive the re-render after each save.
const filterVal = (key) => sessionStorage.getItem(key) ?? '';
function bindFilters(view, map) {
  for (const [id, key] of Object.entries(map)) {
    const el = $(`#${id}`);
    if (el) el.onchange = () => { sessionStorage.setItem(key, el.value.trim()); go(view); };
  }
}
const optionsHTML = (opts, sel) => opts.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === sel ? 'selected' : ''}>${esc(l)}</option>`).join('');

// Click a column header to sort by it; click again to reverse. Cells may hold inputs, so read their values;
// a td can override its sort value with data-sort. Blank cells always sort last.
function sortable(table, key) {
  if (!table) return;
  const head = table.rows[0];
  const ths = [...head.cells];
  const cellVal = (td) => {
    if (td.dataset.sort != null) return td.dataset.sort;
    const el = td.querySelector('select, input');
    if (!el) return td.innerText.trim();
    if (el.type === 'checkbox') return el.checked ? '1' : '0';
    return el.tagName === 'SELECT' ? el.selectedOptions[0]?.text ?? '' : el.value.trim();
  };
  const num = (s) => { const t = s.replace(/[,+円\s]/g, ''); return t !== '' && !isNaN(t) ? Number(t) : null; };
  const apply = (st) => {
    ths.forEach((th, i) => { if (i === st?.col) th.dataset.dir = st.dir; else delete th.dataset.dir; th.textContent = th.dataset.label + (i === st?.col ? (st.dir === 'asc' ? ' ▲' : ' ▼') : ''); });
    if (!st) return;
    const rows = [...table.rows].slice(1);
    rows.sort((a, b) => {
      const va = cellVal(a.cells[st.col]), vb = cellVal(b.cells[st.col]);
      if (!va || !vb) return !va - !vb;
      const na = num(va), nb = num(vb);
      const c = na != null && nb != null ? na - nb : va.localeCompare(vb, 'ja');
      return st.dir === 'asc' ? c : -c;
    });
    head.parentNode.append(...rows);
  };
  ths.forEach((th, i) => {
    th.dataset.label = th.textContent;
    if (!th.dataset.label) return;
    th.classList.add('sort');
    th.title = 'クリックで並べ替え';
    th.onclick = () => {
      const cur = JSON.parse(sessionStorage.getItem(`sort:${key}`) || 'null');
      const st = { col: i, dir: cur?.col === i && cur.dir === 'asc' ? 'desc' : 'asc' };
      sessionStorage.setItem(`sort:${key}`, JSON.stringify(st));
      apply(st);
    };
  });
  apply(JSON.parse(sessionStorage.getItem(`sort:${key}`) || 'null'));
}
function downloadCSV(name, rows) {
  const csv = rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
  a.download = name; a.click();
}

// ---------- scoring ----------
// Two evaluation tracks: general staff (level x weight + KPI, ranked) and managers (points per level, 100 points, no KPI or rank).
const TRACK_LABEL = { general: '一般', manager: '管理者' };
const trackOf = (e) => e?.eval_track ?? 'general';
const isMgr = (e) => trackOf(e) === 'manager';
const critOf = (track = 'general') => S.criteria.filter((c) => (c.track ?? 'general') === track);
// A review keeps the track of the items it was scored on (as compute_final does), even if the employee's 評価区分 changed later.
const scoredTrack = (...scoresList) => {
  for (const s of scoresList) {
    const c = s && S.criteria.find((x) => String(x.id) in s);
    if (c) return c.track ?? 'general';
  }
  return null;
};
const pointsOf = (c, level) => (c.points ? c.points[level - 1] : level * c.weight);
const maxScore = (criteria) => criteria.reduce((t, c) => t + pointsOf(c, 5), 0);
function sumScores(scores, criteria = critOf()) {
  return criteria.reduce((t, c) => t + (Number(scores?.[c.id]) ? pointsOf(c, Number(scores[c.id])) : 0), 0);
}
function rankOf(total, period = S.period) {
  const rules = [...(period?.rank_rules ?? [])].sort((a, b) => b.min - a.min);
  return rules.find((r) => total >= r.min) ?? null;
}
function kpiFor(facilityId) {
  return S.kpis?.find((k) => k.facility_id === facilityId)?.kpi_score ?? null;
}
function complete(scores, criteria = critOf()) { return criteria.every((c) => scores?.[c.id]); }

// Scores are stored as levels 1..5; the buttons and references show each level's points.
function scaleHTML(name, value, c, { readonly = false, refs = [] } = {}) {
  const opts = [1, 2, 3, 4, 5].map((n) =>
    `<label><input type="radio" name="${name}" value="${n}" ${Number(value) === n ? 'checked' : ''} ${readonly ? 'disabled' : ''}><span>${pointsOf(c, n) / (c.points ? 1 : c.weight)}</span></label>`).join('');
  const refHTML = refs.map(([label, v]) => `<div class="ref">${esc(label)}<br><b>${v ? (c.points ? pointsOf(c, v) : v) : '–'}</b></div>`).join('');
  return `<div class="row">${refHTML}<div class="scale ${readonly ? 'ro' : ''}">${opts}</div></div>`;
}
// opts.actions shows the employee's 主要アクション per item (管理シート); opts.actionsEdit makes them editable.
function criteriaForm(prefix, scores, opts = {}) {
  return (opts.crit ?? critOf()).map((c) => {
    const act = opts.actions?.[c.id];
    const actionHTML = !c.action_label || !(opts.actionsEdit || opts.actions) ? ''
      : `<div class="action"><div class="desc">${esc(c.action_label)}</div>${opts.actionsEdit
        ? `<textarea name="a${c.id}" rows="3">${esc(act)}</textarea>`
        : `<div class="action-text">${act ? esc(act).replace(/\n/g, '<br>') : '<span class="muted">（記入なし）</span>'}</div>`}</div>`;
    return `
    <div class="crit">
      <div><div class="name">${esc(c.name)}${c.points ? ` <span class="chip">${pointsOf(c, 5)}点</span>` : c.weight > 1 ? ` <span class="chip">×${c.weight}</span>` : ''}</div><div class="desc">${esc(c.description)}</div>${c.note ? `<div class="desc note">${esc(c.note)}</div>` : ''}</div>
      ${scaleHTML(`${prefix}${c.id}`, scores?.[c.id], c, { readonly: opts.readonly, refs: (opts.refs ?? []).map(([l, s]) => [l, s?.[c.id]]) })}
      ${actionHTML}
    </div>`;
  }).join('');
}
function readActions(criteria, root = document) {
  const out = {};
  for (const c of criteria) {
    const v = $(`textarea[name="a${c.id}"]`, root)?.value.trim();
    if (v) out[c.id] = v;
  }
  return out;
}
function readScores(prefix, criteria = critOf(), root = document) {
  const out = {};
  for (const c of criteria) {
    const v = $(`input[name="${prefix}${c.id}"]:checked`, root)?.value;
    if (v) out[c.id] = Number(v);
  }
  return out;
}
function rubricHTML(track = 'general') {
  if (track === 'manager') {
    return `<p class="rubric">管理者評価：${critOf('manager').length}項目・${maxScore(critOf('manager'))}点満点。項目ごとに配点が違います（ボタンの数字が点数）。事業所の実績・ランクはなく、昇給額は人事が給与改定で決めます。</p>`;
  }
  return `<details class="rubric"><summary>評価基準（1〜5の定義）</summary>
    ${RUBRIC.map(([n, t, d]) => `<div><b>${n}（${t}）</b> ${esc(d)}</div>`).join('')}
    <div style="margin-top:6px">ランク：${(S.period?.rank_rules ?? []).map((r) => `<b>${esc(r.rank)}</b> ${r.min}点〜（+${yen(r.up)}円）`).join(' ／ ')}</div>
  </details>`;
}

// ---------- boot / auth ----------
async function boot() {
  // A fresh login (email link or password) starts on the default period and first screen, not on what was open before.
  const freshLogin = /access_token=/.test(location.hash) || sessionStorage.getItem('freshLogin');
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return showLogin();
  if (freshLogin) ['freshLogin', 'period', 'view'].forEach((k) => sessionStorage.removeItem(k));
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
  // Open on the period in progress; if none, the latest one that has started (skip periods still 準備中).
  await setPeriod(S.periods.find((p) => p.id === saved) ?? S.periods.find((p) => p.status !== 'closed' && p.status !== 'preparing')
    ?? S.periods.find((p) => p.status !== 'preparing') ?? S.periods[0]);
  $('#who').innerHTML = `${esc(fullName(S.me))}（${ROLE_LABEL[S.me.role]}） <button id="pwset">パスワード設定</button><button id="logout">ログアウト</button>`;
  $('#pwset').onclick = () => go('password');
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
async function logout() { await sb.auth.signOut(); ['period', 'view'].forEach((k) => sessionStorage.removeItem(k)); location.reload(); }

function showLogin() {
  $('#nav').innerHTML = ''; $('#who').innerHTML = '';
  render(`<div class="panel login">
    <h1>ログイン</h1>
    <p class="muted">登録済みのメールアドレスを入力してください。ログイン用のリンクをお送りします。</p>
    <form id="lf" class="row"><input id="em" type="email" required placeholder="name@example.com" class="grow" autocomplete="email">
    <button class="primary">リンクを送信</button></form>
    <p id="lmsg" class="muted"></p>
    <details id="pwbox" style="margin-top:16px"><summary class="muted">パスワードでログイン（人事からパスワードを受け取った方）</summary>
      <form id="pf" style="display:flex;flex-direction:column;gap:8px;margin-top:8px">
        <input id="pem" type="email" required placeholder="メールアドレス" autocomplete="username">
        <input id="ppw" type="password" required placeholder="パスワード" autocomplete="current-password">
        <button class="primary">ログイン</button></form>
      <p id="pmsg" class="muted"></p></details></div>`);
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
    // Send the site root without a trailing slash so it matches the Redirect URL saved in Supabase exactly.
    const back = location.origin + (location.pathname === '/' ? '' : location.pathname);
    const { error } = await sb.auth.signInWithOtp({ email: $('#em').value.trim(), options: { emailRedirectTo: back } });
    btn.disabled = false;
    $('#lmsg').textContent = error ? `送信できませんでした：${error.message}` : 'メールを送信しました。届いたリンクを開いてください（迷惑メールフォルダもご確認ください）。';
  };
  // Password login for accounts HR created in Supabase (e.g. directors), so no email has to be sent.
  $('#pf').onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('#pf button'); btn.disabled = true;
    const { error } = await sb.auth.signInWithPassword({ email: $('#pem').value.trim(), password: $('#ppw').value });
    btn.disabled = false;
    if (error) {
      $('#pmsg').textContent = /invalid/i.test(error.message) ? 'メールアドレスかパスワードが違います。' : `ログインできませんでした：${error.message}`;
      $('#pmsg').style.color = 'var(--ng)';
      return;
    }
    sessionStorage.setItem('freshLogin', '1');
    location.reload();
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
  if (view === 'password' && S.view && S.view !== 'password') sessionStorage.setItem('prevView', S.view);
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

// Any signed-in user can set their own password, so they can use パスワードでログイン next time.
VIEWS.password = async () => {
  render(`
    <h1>パスワード設定</h1>
    <div class="panel" style="max-width:460px">
      <p class="muted">次からは、ログイン画面の「パスワードでログイン」で、メールアドレスとこのパスワードでログインできます。</p>
      <form id="pwf" style="display:flex;flex-direction:column;gap:8px">
        <input type="email" value="${esc(S.me.email)}" autocomplete="username" readonly hidden>
        <label class="field">新しいパスワード（8文字以上）<input id="np1" type="password" required minlength="8" autocomplete="new-password"></label>
        <label class="field">確認のため、もう一度<input id="np2" type="password" required minlength="8" autocomplete="new-password"></label>
        <div class="row"><button class="primary">保存</button><button type="button" id="pwback">戻る</button></div>
      </form>
    </div>`);
  $('#pwback').onclick = () => go(sessionStorage.getItem('prevView') || 'results');
  $('#pwf').onsubmit = async (e) => {
    e.preventDefault();
    const p1 = $('#np1').value, p2 = $('#np2').value;
    if (p1 !== p2) return toast('2回入れたパスワードが違います', true);
    if (p1.length < 8) return toast('パスワードは8文字以上にしてください', true);
    const { error } = await sb.auth.updateUser({ password: p1 });
    if (error) return toast(`保存できませんでした：${error.message}`, true);
    $('#np1').value = $('#np2').value = '';
    toast('パスワードを保存しました');
  };
};

VIEWS.self = async () => {
  const p = S.period;
  const row = (await q(sb.from('self_reviews').select('*').eq('period_id', p.id).eq('employee_id', S.me.id).maybeSingle())) ?? {};
  const editable = p.status === 'self' && !row.submitted_at;
  const crit = critOf(trackOf(S.me));
  const total = sumScores(row.scores, crit);
  render(`
    <div class="row"><h1 class="grow">自己評価</h1>${periodPicker()}</div>
    <div class="panel">
      <div class="row"><div class="grow">${esc(fullName(S.me))}　${esc(facName(S.me.facility_id))}</div>
        ${row.submitted_at ? `<span class="chip ok">提出済み ${new Date(row.submitted_at).toLocaleDateString('ja-JP')}</span>` : p.status === 'self' ? '<span class="chip warn">未提出</span>' : `<span class="chip">${STATUS_LABEL[p.status]}</span>`}</div>
      ${!editable && !row.submitted_at ? '<p class="muted">現在は自己評価の受付期間ではありません。</p>' : ''}
      ${rubricHTML(trackOf(S.me))}
      <form id="sf">${criteriaForm('s', row.scores, { readonly: !editable, crit, actions: row.actions ?? {}, actionsEdit: editable })}
        <p class="muted">項目合計：<b id="stot">${total}</b> / ${maxScore(crit)}点${isMgr(S.me) ? '' : '（事業所の実績・成果は人事が記入します）'}</p>
        <label class="field">今期がんばったこと・来期の目標など<textarea id="sc" ${editable ? '' : 'disabled'}>${esc(row.comment)}</textarea></label>
        ${editable ? '<div class="row" style="margin-top:12px"><button type="button" id="ssave">下書き保存</button><button type="button" id="ssub" class="primary">提出する</button></div>' : ''}
      </form>
    </div>`);
  bindPeriodPicker();
  if (!editable) return;
  $('#sf').onchange = () => ($('#stot').textContent = sumScores(readScores('s', crit), crit));
  const save = async (submit) => {
    const scores = readScores('s', crit);
    if (submit && !complete(scores, crit)) return toast('すべての項目を選択してください', true);
    if (submit && !confirm('提出すると修正できません。提出しますか？')) return;
    await q(sb.from('self_reviews').upsert({ period_id: p.id, employee_id: S.me.id, scores, actions: readActions(crit), comment: $('#sc').value, submitted_at: submit ? new Date().toISOString() : null }));
    toast(submit ? '提出しました' : '保存しました'); go('self');
  };
  $('#ssave').onclick = () => save(false);
  $('#ssub').onclick = () => save(true);
};

VIEWS.results = async () => {
  const rows = await q(sb.from('final_reviews').select('*, periods(name, rank_rules)').eq('employee_id', S.me.id).eq('published', true));
  const allCrit = rows.length ? await q(sb.from('criteria').select('*').in('period_id', rows.map((r) => r.period_id)).order('sort')) : [];
  const trackOfRow = (r) => allCrit.find((c) => c.period_id === r.period_id && String(c.id) in (r.scores ?? {}))?.track ?? trackOf(S.me);
  render(`<h1>評価結果</h1>${rows.length ? rows.map((r) => { const mgr = trackOfRow(r) === 'manager'; return `
    <div class="panel">
      <h2 style="margin-top:0">${esc(r.periods?.name)}</h2>
      <div class="summary"><div>合計 <span class="big">${r.total}</span> 点</div>${mgr ? '' : `<div>ランク <span class="big">${esc(r.rank)}</span></div><div>昇給 <b>+${yen(r.up_amount)}円</b>（基本給）</div>`}</div>
      <table style="margin-top:12px"><tr><th>項目</th><th class="num">${mgr ? '点数' : '評価'}</th></tr>
      ${mgr ? '' : `<tr><td>事業所の実績・成果</td><td class="num">${r.kpi_score ?? '–'}</td></tr>`}
      ${allCrit.filter((c) => c.period_id === r.period_id && (c.track ?? 'general') === trackOfRow(r)).map((c) => `<tr><td>${esc(c.name)}</td><td class="num">${r.scores?.[c.id] ? (c.points ? pointsOf(c, r.scores[c.id]) : r.scores[c.id]) : '–'}</td></tr>`).join('')}</table>
      ${r.comment ? `<h2>評価者コメント</h2><p>${esc(r.comment).replace(/\n/g, '<br>')}</p>` : ''}
    </div>`; }).join('') : '<div class="panel muted">公開された評価結果はまだありません。</div>'}`);
};

async function loadReviews(ids) {
  const p = S.period.id;
  const chunk = (tbl, cols) => ids.length ? q(sb.from(tbl).select(cols).eq('period_id', p).in('employee_id', ids)) : [];
  const [self, prim, fin] = await Promise.all([
    chunk('self_reviews', 'employee_id, scores, actions, comment, submitted_at'),
    chunk('primary_reviews', 'employee_id, scores, comment, interview_note, submitted_at'),
    chunk('final_reviews', '*'),
  ]);
  const by = (arr) => Object.fromEntries(arr.map((r) => [r.employee_id, r]));
  return { self: by(self), prim: by(prim), fin: by(fin) };
}
const STAGES = [['未着手', ''], ['自己評価提出済み', 'warn'], ['一次評価済み', 'warn'], ['最終提出済み', 'ok'], ['人事承認済み', 'ok'], ['公開済み', 'ok']];
function stageLabel(id, R) {
  const f = R.fin[id];
  if (f?.published) return '公開済み';
  if (f?.approved_at) return '人事承認済み';
  if (f?.submitted_at) return '最終提出済み';
  if (R.prim[id]?.submitted_at) return '一次評価済み';
  if (R.self[id]?.submitted_at) return '自己評価提出済み';
  return '未着手';
}
function stageChip(id, R) {
  const l = stageLabel(id, R);
  return `<span class="chip ${STAGES.find(([s]) => s === l)[1]}">${l}</span>`;
}
const rankOptions = (all) => [['', all], ...(S.period?.rank_rules ?? []).map((r) => [r.rank, r.rank]).sort(), ['-', '評価なし']];

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
  const track = scoredTrack(fin.scores, prim.scores, self.scores) ?? trackOf(emp);
  const mgr = track === 'manager', crit = critOf(track);
  const kpi = mgr ? null : fin.kpi_score ?? kpiFor(emp.facility_id);
  // 1次 enters the primary review, 2次 the final decision; HR and directors can do both.
  const primEditable = (isHR() || (S.me.role === 'evaluator1' && ['self', 'primary'].includes(p.status) && !prim.submitted_at)) && p.status !== 'closed';
  const finEditable = (isHR() ? !fin.approved_at : S.me.role === 'evaluator2' && ['primary', 'final'].includes(p.status) && !fin.submitted_at) && p.status !== 'closed';
  const finScores = Object.keys(fin.scores ?? {}).length ? fin.scores : prim.scores;
  const totalWith = (scores) => sumScores(scores, crit) + (kpi ?? 0) * p.kpi_weight;
  const rankTxt = (t) => (mgr ? '' : rankOf(t)?.rank ?? '');
  render(`
    <div class="row"><button id="back">← 一覧へ</button><h1 class="grow" style="margin:0">${esc(fullName(emp))}</h1>${mgr ? '<span class="chip">管理者</span>' : ''}${stageChip(empId, R)}</div>
    <p class="muted">${esc(facName(emp.facility_id))}　${esc(emp.grade)}　入社 ${esc(emp.hire_date)}　／　${esc(p.name)}</p>
    ${track !== trackOf(emp) ? `<p class="muted"><span class="chip warn">区分の変更</span>　この期の評価は「${TRACK_LABEL[track]}」の項目で入力されています（今の評価区分は「${TRACK_LABEL[trackOf(emp)]}」）。</p>` : ''}
    ${rubricHTML(track)}
    <div class="panel">
      <h2 style="margin-top:0">本人の自己評価 ${self.submitted_at ? '<span class="chip ok">提出済み</span>' : '<span class="chip">未提出</span>'}</h2>
      ${self.comment ? `<p>${esc(self.comment).replace(/\n/g, '<br>')}</p>` : '<p class="muted">コメントなし</p>'}
    </div>
    <div class="panel">
      <h2 style="margin-top:0">一次評価 ${prim.submitted_at ? '<span class="chip ok">提出済み</span>' : ''}</h2>
      <form id="pf">${criteriaForm('p', prim.scores, { readonly: !primEditable, refs: [['自己', self.scores]], crit, actions: crit.some((c) => c.action_label) ? self.actions ?? {} : null })}
        <p>${mgr ? `見込み合計 <b id="ptot">${totalWith(prim.scores)}</b> / ${maxScore(crit)}点<b id="prank"></b>`
          : `事業所の実績・成果：<b>${kpi ?? '未設定'}</b> ×${p.kpi_weight}　／　見込み合計 <b id="ptot">${totalWith(prim.scores)}</b>点 → <b id="prank">${esc(rankTxt(totalWith(prim.scores)))}</b>`}</p>
        <label class="field">評価コメント（本人には公開されません）<textarea id="pc" ${primEditable ? '' : 'disabled'}>${esc(prim.comment)}</textarea></label>
        <label class="field">面談メモ（自己評価とのギャップ・確認ポイント）<textarea id="pi" ${primEditable ? '' : 'disabled'}>${esc(prim.interview_note)}</textarea></label>
        ${primEditable ? '<div class="row" style="margin-top:12px"><button type="button" id="psave">下書き保存</button><button type="button" id="psub" class="primary">一次評価を提出</button></div>' : ''}
      </form>
    </div>
    <div class="panel">
      <h2 style="margin-top:0">最終決定（面談後） ${fin.submitted_at ? '<span class="chip ok">提出済み</span>' : ''}</h2>
      ${!['primary', 'final', 'closed'].includes(p.status) && !isHR() ? `<p class="muted">${S.me.role === 'evaluator2' ? '一次評価期間になると入力できます。' : '最終決定は評価者（2次）が入力します。'}</p>` : `
      <form id="ff">${criteriaForm('f', finScores, { readonly: !finEditable, refs: [['自己', self.scores], ['一次', prim.scores]], crit })}
        <p>${mgr ? `合計 <b id="ftot">${totalWith(finScores)}</b> / ${maxScore(crit)}点<b id="frank"></b>（昇給額は給与改定で決めます）`
          : `合計 <b id="ftot">${totalWith(finScores)}</b>点 → ランク <b id="frank">${esc(rankTxt(totalWith(finScores)))}</b>（+${yen(rankOf(totalWith(finScores))?.up)}円）`}</p>
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
    const t = totalWith(readScores(prefix, crit));
    $(tot).textContent = t; $(rank).textContent = rankTxt(t);
  };
  if ($('#pf')) $('#pf').onchange = () => recalc('p', '#ptot', '#prank');
  if ($('#ff')) $('#ff').onchange = () => recalc('f', '#ftot', '#frank');
  const back = () => evalDetail(empId).catch((e) => toast(e.message, true));
  if (primEditable) {
    const save = async (submit) => {
      const scores = readScores('p', crit);
      if (submit && !complete(scores, crit)) return toast('すべての項目を選択してください', true);
      await q(sb.from('primary_reviews').upsert({ period_id: p.id, employee_id: empId, scores, comment: $('#pc').value, interview_note: $('#pi').value,
        submitted_at: submit ? new Date().toISOString() : prim.submitted_at ?? null, submitted_by: S.me.id }));
      toast(submit ? '一次評価を提出しました' : '保存しました'); back();
    };
    $('#psave').onclick = () => save(false);
    $('#psub').onclick = () => save(true);
  }
  if (finEditable && $('#ff')) {
    const save = async (submit) => {
      const scores = readScores('f', crit);
      if (submit && !complete(scores, crit)) return toast('すべての項目を選択してください', true);
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
  const track = filterVal('ltrack') || 'general', mgr = track === 'manager', crit = critOf(track);
  const kw = filterVal('lkw'), rk = mgr ? '' : filterVal('lrank'), stg = filterVal('lstage');
  // Group by the items each review was scored on, falling back to the employee's current 評価区分.
  const trackFor = (e) => scoredTrack(R.fin[e.id]?.scores, R.prim[e.id]?.scores, R.self[e.id]?.scores) ?? trackOf(e);
  const inTrack = emps.filter((e) => trackFor(e) === track);
  // The bulk buttons and CSV act on exactly the rows shown, so the tab and filters also narrow their targets.
  const list = inTrack.filter((e) => (!fac || e.facility_id === fac) && (!kw || fullName(e).includes(kw))
    && (!rk || (R.fin[e.id]?.rank ?? '-') === rk) && (!stg || stageLabel(e.id, R) === stg));
  const tot = (s) => (s && Object.keys(s).length ? sumScores(s, crit) : '');
  const count = (t) => emps.filter((e) => trackFor(e) === t).length;
  render(`
    <div class="row"><h1 class="grow">評価一覧</h1>${periodPicker()}
      <button id="approveAll">提出済みを一括承認</button><button id="publishAll" class="primary">承認済みを一括公開</button><button id="csv">CSV出力</button></div>
    <div class="row filters tabs">${Object.entries(TRACK_LABEL).map(([k, l]) => `<button data-track="${k}" class="${k === track ? 'on' : ''}">${l}（${count(k)}名）</button>`).join('')}</div>
    <div class="row filters">
      <select id="fac"><option value="0">全施設</option>${S.facilities.map((f) => `<option value="${f.id}" ${f.id === fac ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select>
      <input id="lkw" placeholder="氏名で検索" value="${esc(kw)}">
      ${mgr ? '' : `<select id="lrank">${optionsHTML(rankOptions('全ランク'), rk)}</select>`}
      <select id="lstage">${optionsHTML([['', '全状況'], ...STAGES.map(([s]) => [s, s])], stg)}</select>
      <span class="muted">${list.length} / ${inTrack.length}名</span></div>
    ${mgr ? `<p class="muted">管理者：${crit.length}項目・${maxScore(crit)}点満点。事業所の実績・ランクはなく、昇給額は給与改定で決めます。</p>` : ''}
    <div class="panel scroll"><table id="lt">
      <tr><th>施設</th><th>氏名</th><th>等級</th><th class="num">自己</th><th class="num">一次</th>${mgr ? '' : '<th class="num">KPI</th>'}<th class="num">最終合計</th>${mgr ? '' : '<th>ランク</th><th class="num">昇給額</th>'}<th>状況</th></tr>
      ${list.map((e) => { const f = R.fin[e.id]; return `<tr data-id="${e.id}" style="cursor:pointer">
        <td data-sort="${facSort(e.facility_id)}">${esc(facName(e.facility_id))}</td><td>${esc(fullName(e))}</td><td>${esc(e.grade)}</td>
        <td class="num">${tot(R.self[e.id]?.scores)}</td><td class="num">${tot(R.prim[e.id]?.scores)}</td>${mgr ? '' : `<td class="num">${f?.kpi_score ?? kpiFor(e.facility_id) ?? ''}</td>`}
        <td class="num"><b>${f?.total ?? ''}</b></td>${mgr ? '' : `<td><b>${esc(f?.rank)}</b></td><td class="num">${f ? yen(f.up_amount) : ''}</td>`}<td data-sort="${STAGES.findIndex(([s]) => s === stageLabel(e.id, R))}">${stageChip(e.id, R)}</td></tr>`; }).join('')}
    </table></div>`);
  bindPeriodPicker();
  bindFilters('hr-list', { fac: 'fac', lkw: 'lkw', lrank: 'lrank', lstage: 'lstage' });
  $$('[data-track]').forEach((b) => (b.onclick = () => { sessionStorage.setItem('ltrack', b.dataset.track); go('hr-list'); }));
  sortable($('#lt'), `hr-list:${track}`);
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
  $('#csv').onclick = () => downloadCSV(`評価一覧_${TRACK_LABEL[track]}_${S.period.name}.csv`, [
    ['施設', '氏名', '等級', '自己合計', '一次合計', 'KPI点', ...crit.map((c) => `最終:${c.name}`), '最終合計', 'ランク', '昇給額', '承認', '公開'],
    ...list.map((e) => { const f = R.fin[e.id] ?? {}; return [facName(e.facility_id), fullName(e), e.grade, tot(R.self[e.id]?.scores), tot(R.prim[e.id]?.scores),
      f.kpi_score ?? '', ...crit.map((c) => (f.scores?.[c.id] ? pointsOf(c, f.scores[c.id]) : '')), f.total ?? '', f.rank ?? '', f.up_amount ?? '', f.approved_at ? '済' : '', f.published ? '済' : '']; }),
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
  const ref = f?.rank ? `評価 ${esc(f.rank)} +${yen(f.up_amount)}` : f?.total != null ? `${f.total}点` : esc(r.legacy_eval);
  if (editable) {
    return `<input class="xs" data-k="eval_rank" value="${esc(r.eval_rank)}" placeholder="${esc(f?.rank ?? '')}">
      +<input class="sm" data-k="eval_up" value="${r.eval_up ?? ''}" placeholder="${f?.up_amount ?? ''}" inputmode="numeric">
      <div class="muted" style="font-size:12px">${ref}</div>`;
  }
  if (!ev.rank && ev.up == null) return f?.total != null && !f.rank ? ref : esc(r.legacy_eval);
  return `<b>${esc(ev.rank)}</b> +${yen(ev.up)}${ev.manual ? ` <span class="chip warn" title="評価欄で上書き">上書き</span><div class="muted" style="font-size:12px">${ref}</div>` : ''}`;
}
VIEWS['hr-salary'] = async () => {
  const p = S.period;
  const [rows, emps, fins] = await Promise.all([
    q(sb.from('salary_revisions').select('*').eq('period_id', p.id)),
    q(sb.from('employees').select('*').eq('active', true)),
    q(sb.from('final_reviews').select('employee_id, scores, total, rank, up_amount, approved_at').eq('period_id', p.id)),
  ]);
  const empBy = Object.fromEntries(emps.map((e) => [e.id, e]));
  const finBy = Object.fromEntries(fins.map((f) => [f.employee_id, f]));
  // Same split as 評価一覧: by the items the review was scored on, else the employee's current 評価区分.
  const trackFor = (r) => scoredTrack(finBy[r.employee_id]?.scores) ?? trackOf(empBy[r.employee_id]);
  const track = filterVal('ltrack') || 'general', mgr = track === 'manager';
  const fac = Number(sessionStorage.getItem('fac')) || 0;
  const kw = filterVal('salkw'), rk = mgr ? '' : filterVal('salrank'), man = filterVal('salman');
  const valid = rows.filter((r) => empBy[r.employee_id]);
  const count = (t) => valid.filter((r) => trackFor(r) === t).length;
  const inScope = valid.filter((r) => trackFor(r) === track && (!fac || empBy[r.employee_id].facility_id === fac));
  const list = inScope.filter((r) => {
    const ev = salaryEval(r, finBy[r.employee_id]);
    return (!kw || fullName(empBy[r.employee_id]).includes(kw)) && (!rk || (ev.rank ?? '-') === rk) && (!man || ev.manual === (man === '1'));
  })
    .sort((a, b) => (S.facilities.find((f) => f.id === empBy[a.employee_id].facility_id)?.sort ?? 99) - (S.facilities.find((f) => f.id === empBy[b.employee_id].facility_id)?.sort ?? 99));
  const sumB = list.reduce((t, r) => t + monthly(r, 'before'), 0), sumA = list.reduce((t, r) => t + (r.base_after != null ? monthly(r, 'after') : monthly(r, 'before')), 0);
  // Rows are read-only; HR and directors press ✎ to edit one row, even after the period is closed.
  // The bulk buttons only run while the period is open.
  const editable = isHR(), open = p.status !== 'closed';
  const byId = Object.fromEntries(list.map((r) => [r.employee_id, r]));
  const rowHTML = (r, editing = false) => {
    const e = empBy[r.employee_id], f = finBy[r.employee_id];
    const a = r.base_after != null ? monthly(r, 'after') : null;
    const inp = (k, cls = 'sm') => editing ? `<input class="${cls}" data-k="${k}" value="${esc(r[k] ?? '')}" ${cls === 'sm' ? 'inputmode="numeric"' : ''}>` : esc(cls === 'sm' ? yen(r[k]) : r[k]);
    return `<tr data-id="${r.employee_id}"${editing ? ' class="editing"' : ''}>
      <td data-sort="${facSort(e.facility_id)}">${esc(facName(e.facility_id))}</td><td>${esc(fullName(e))}</td>
      <td style="white-space:nowrap">${editing ? `${esc(r.grade_before)}→${inp('grade_after', 'xs')}` : `${esc(r.grade_before)}${r.grade_after && r.grade_after !== r.grade_before ? '→' + esc(r.grade_after) : ''}`}</td>
      <td style="white-space:nowrap" data-sort="${esc(salaryEval(r, f).rank ?? '')}">${evalCell(r, f, editing)}</td>
      <td class="num">${yen(r.base_before)}</td><td class="num">${inp('base_after')}</td>
      ${SALARY_ITEMS.slice(1).map(([k]) => `<td class="num">${inp(`${k}_after`)}</td>`).join('')}
      <td class="num">${yen(monthly(r, 'before'))}</td><td class="num">${a == null ? '' : yen(a)}</td><td class="num">${a == null ? '' : yen(a - monthly(r, 'before'))}</td>
      <td>${inp('note', '')}</td>
      ${editable ? `<td style="white-space:nowrap">${editing ? '<button class="rs primary">保存</button><button class="rc">取消</button>' : '<button class="re" title="この行を修正">✎</button>'}</td>` : ''}</tr>`;
  };
  render(`
    <div class="row"><h1 class="grow">給与改定</h1>${periodPicker()}
      ${open ? `<button id="seed">前期の改定後を取り込む</button><button id="apply">${mgr ? '上書きの昇給額を反映' : '評価ランクの昇給額を反映'}</button>` : ''}<button id="csv">CSV出力</button></div>
    ${open || !editable ? '' : '<p class="muted"><span class="chip warn">締め</span>　締めた期です。右端の ✎ で直せますが、保存すると確定済みの給与が変わります。</p>'}
    <div class="row filters tabs">${Object.entries(TRACK_LABEL).map(([k, l]) => `<button data-track="${k}" class="${k === track ? 'on' : ''}">${l}（${count(k)}名）</button>`).join('')}</div>
    <div class="row filters">
      <select id="fac"><option value="0">全施設</option>${S.facilities.map((f) => `<option value="${f.id}" ${f.id === fac ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select>
      <input id="salkw" placeholder="氏名で検索" value="${esc(kw)}">
      ${mgr ? '' : `<select id="salrank">${optionsHTML(rankOptions('全ランク'), rk)}</select>`}
      <select id="salman">${optionsHTML([['', '上書きを含む'], ['1', '上書きだけ'], ['0', '上書きを除く']], man)}</select></div>
    <p class="muted">月額計（通勤手当を除く）：改定前 ${yen(sumB)}円 → 改定後 ${yen(sumA)}円（差額 ${yen(sumA - sumB)}円／${sumB ? ((sumA / sumB - 1) * 100).toFixed(2) : 0}%）　${list.length} / ${inScope.length}名</p>
    <div class="panel scroll"><table id="st">
      <tr><th>施設</th><th>氏名</th><th>等級</th><th>評価</th><th class="num">基本給(前)</th><th class="num">基本給(後)</th>${SALARY_ITEMS.slice(1).map(([, l]) => `<th class="num">${l}(後)</th>`).join('')}<th class="num">月額計(前)</th><th class="num">月額計(後)</th><th class="num">差額</th><th>備考</th>${editable ? '<th></th>' : ''}</tr>
      ${list.map((r) => rowHTML(r)).join('')}
    </table></div>
    <p class="muted">固定残業手当は基本給に連動するため、改定後の金額を確認して入力してください。</p>`);
  bindPeriodPicker();
  bindFilters('hr-salary', { fac: 'fac', salkw: 'salkw', salrank: 'salrank', salman: 'salman' });
  $$('[data-track]').forEach((b) => (b.onclick = () => { sessionStorage.setItem('ltrack', b.dataset.track); go('hr-salary'); }));
  sortable($('#st'), `hr-salary:${track}`);
  $('#csv').onclick = () => downloadCSV(`給与改定_${TRACK_LABEL[track]}_${p.name}.csv`, [
    ['施設', '姓', '名', '等級(前)', '等級(後)', '評価', '昇給額', ...SALARY_ITEMS.flatMap(([, l]) => [`${l}(前)`, `${l}(後)`]), '通勤(前)', '通勤(後)', '月額計(前)', '月額計(後)', '差額', '備考'],
    ...list.map((r) => { const e = empBy[r.employee_id], f = finBy[r.employee_id]; const a = r.base_after != null ? monthly(r, 'after') : ''; return [
      facName(e.facility_id), e.last_name, e.first_name, r.grade_before, r.grade_after, salaryEval(r, f).rank ?? r.legacy_eval ?? '', salaryEval(r, f).up ?? '',
      ...SALARY_ITEMS.flatMap(([k]) => [r[`${k}_before`], r[`${k}_after`]]), r.commute_before, r.commute_after,
      monthly(r, 'before'), a, a === '' ? '' : a - monthly(r, 'before'), r.note]; }),
  ]);
  if (!editable) return;
  // One table-level handler, so rows swapped between view and edit keep working.
  $('#st').onclick = async (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    const tr = b.closest('tr'), r = byId[tr?.dataset.id]; if (!r) return;
    const swap = (editing) => { tr.outerHTML = rowHTML(r, editing); };
    if (b.classList.contains('re')) {
      if ($('#st tr.editing')) return toast('修正中の行を保存するか取消してください', true);
      swap(true); $(`#st tr[data-id="${r.employee_id}"] input`)?.focus();
    } else if (b.classList.contains('rc')) {
      swap(false);
    } else if (b.classList.contains('rs')) {
      const patch = {};
      $$('input', tr).forEach((i) => (patch[i.dataset.k] = ['note', 'eval_rank', 'grade_after'].includes(i.dataset.k) ? i.value.trim() || null : i.value === '' ? null : Number(i.value.replace(/,/g, ''))));
      if (!open && !confirm('締めた期の給与を変更します。保存しますか？')) return;
      await q(sb.from('salary_revisions').update(patch).eq('period_id', p.id).eq('employee_id', r.employee_id));
      toast('保存しました'); go('hr-salary');
    }
  };
  if (!open) return;
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
    // Managers have no rank, so an approved review alone has no raise to apply; skip them until a raise is typed in.
    const t = list.filter((r) => (finBy[r.employee_id]?.approved_at || r.eval_up != null) && r.base_before != null && salaryEval(r, finBy[r.employee_id]).up != null);
    if (!t.length) return toast('人事承認済みの評価・上書きした昇給額がありません', true);
    if (!confirm(`人事承認済み・上書きした ${t.length}名の基本給(後)を「基本給(前)＋昇給額」で上書きします。`)) return;
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
  const role = filterVal('srole'), trk = filterVal('strack'), tgt = filterVal('stgt'), act = filterVal('sact'), evf = filterVal('sev');
  const list = emps.filter((e) => (!fac || e.facility_id === fac) && (!kw || fullName(e).includes(kw) || (e.email ?? '').includes(kw))
    && (!role || e.role === role) && (!trk || trackOf(e) === trk) && (!tgt || e.eval_target === (tgt === '1')) && (!act || e.active === (act === '1'))
    && (!evf || (evf === 'none' ? e.eval_target && !links.some((l) => l.employee_id === e.id) : links.some((l) => l.employee_id === e.id && l.evaluator_id === evf))))
    .sort((a, b) => (S.facilities.find((f) => f.id === a.facility_id)?.sort ?? 99) - (S.facilities.find((f) => f.id === b.facility_id)?.sort ?? 99) || Number(b.role !== 'staff') - Number(a.role !== 'staff'));
  const evaluators = emps.filter((e) => e.active && e.role !== 'staff');
  const evOf = (id) => links.filter((l) => l.employee_id === id).map((l) => by[l.evaluator_id]).filter(Boolean);
  const facOpts = (sel) => S.facilities.map((f) => `<option value="${f.id}" ${f.id === sel ? 'selected' : ''}>${esc(f.name)}</option>`).join('');
  const noEmail = emps.filter((e) => e.active && !e.email).length;
  render(`
    <div class="row"><h1 class="grow">社員・評価者</h1><button id="csv">CSV出力</button></div>
    <div class="row filters">
      <select id="sfac"><option value="0">全施設</option>${facOpts(fac)}</select>
      <input id="skw" placeholder="氏名・メールで検索" value="${esc(kw)}">
      <select id="srole">${optionsHTML([['', '全権限'], ...Object.entries(ROLE_LABEL)], role)}</select>
      <select id="strack">${optionsHTML([['', '全区分'], ...Object.entries(TRACK_LABEL)], trk)}</select>
      <select id="stgt">${optionsHTML([['', '評価対象：すべて'], ['1', '評価対象のみ'], ['0', '評価対象外のみ']], tgt)}</select>
      <select id="sact">${optionsHTML([['', '在籍：すべて'], ['1', '在籍のみ'], ['0', '退職のみ']], act)}</select>
      <select id="sev">${optionsHTML([['', '評価者：すべて'], ['none', '評価者未設定'], ...evaluators.map((e) => [e.id, fullName(e)])], evf)}</select>
      <span class="muted">${list.length} / ${emps.length}名</span></div>
    ${noEmail ? `<p class="muted"><span class="chip warn">メール未登録 ${noEmail}名</span>　メールアドレスを登録するとログインできるようになります。</p>` : ''}
    <div class="panel">
      <h2 style="margin-top:0">評価者の一括設定</h2>
      <div class="row">
        <select id="bfac">${facOpts(fac)}</select> の評価対象者全員に
        <select id="bev">${evaluators.map((e) => `<option value="${e.id}">${esc(fullName(e))}（${esc(facName(e.facility_id))}）</option>`).join('')}</select>
        を評価者として <button id="badd">追加</button><button id="bdel" class="danger">外す</button>
      </div>
      <p class="muted">評価者の候補は、権限が「一般」以外の社員です。評価者（1次）は一次評価、評価者（2次）は最終決定を入力します。先に下の一覧で権限を変更してください。</p>
    </div>
    <div class="panel scroll"><table id="et">
      <tr><th>施設</th><th>氏名</th><th>等級</th><th>メール</th><th>権限</th><th>評価区分</th><th>評価対象</th><th>在籍</th><th>評価者</th><th></th></tr>
      ${list.map((e) => `<tr data-id="${e.id}">
        <td data-sort="${facSort(e.facility_id)}"><select data-k="facility_id">${facOpts(e.facility_id)}</select></td>
        <td>${esc(fullName(e))}${e.user_id ? ' <span class="chip ok" title="ログイン済み">✓</span>' : ''}</td>
        <td><input class="xs" data-k="grade" value="${esc(e.grade)}"></td>
        <td><input data-k="email" type="email" value="${esc(e.email)}" placeholder="未登録"></td>
        <td data-sort="${Object.keys(ROLE_LABEL).indexOf(e.role)}"><select data-k="role">${Object.entries(ROLE_LABEL).map(([k, l]) => `<option value="${k}" ${e.role === k ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
        <td data-sort="${Object.keys(TRACK_LABEL).indexOf(trackOf(e))}"><select data-k="eval_track">${optionsHTML(Object.entries(TRACK_LABEL), trackOf(e))}</select></td>
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
        <select name="role">${optionsHTML(Object.entries(ROLE_LABEL), 'staff')}</select>
        <select name="eval_track">${optionsHTML(Object.entries(TRACK_LABEL), 'general')}</select>
        <button class="primary">追加</button></form>
    </div>`);
  bindFilters('hr-staff', { sfac: 'sfac', skw: 'skw', srole: 'srole', strack: 'strack', stgt: 'stgt', sact: 'sact', sev: 'sev' });
  sortable($('#et'), 'hr-staff');
  $$('#et .es').forEach((b) => (b.onclick = async () => {
    const tr = b.closest('tr'); const patch = {};
    $$('[data-k]', tr).forEach((i) => {
      const k = i.dataset.k;
      patch[k] = i.type === 'checkbox' ? i.checked : k === 'facility_id' ? Number(i.value) : i.value.trim() || null;
    });
    if (tr.dataset.id === S.me.id && !HR_ROLES.includes(patch.role) && !confirm('自分の人事権限を外すと、この画面に戻れなくなります。続けますか？')) return;
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
  $('#csv').onclick = () => downloadCSV('社員一覧.csv', [['施設', '姓', '名', '等級', '入社日', 'メール', '権限', '評価区分', '評価対象', '在籍', '評価者'],
    ...list.map((e) => [facName(e.facility_id), e.last_name, e.first_name, e.grade, e.hire_date, e.email, ROLE_LABEL[e.role], TRACK_LABEL[trackOf(e)], e.eval_target ? '○' : '', e.active ? '○' : '', evOf(e.id).map(fullName).join('、')])]);
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
    ${Object.entries(TRACK_LABEL).map(([trk, label]) => `
    <div class="panel">
      <h2 style="margin-top:0">評価項目（${label}）<span class="muted" style="font-size:13px;font-weight:400">　${maxScore(critOf(trk))}点満点${trk === 'manager' ? '・KPIなし' : `＋KPI ${5 * p.kpi_weight}点`}</span></h2>
      <table class="ct"><tr><th>#</th><th>項目名</th><th>説明</th><th class="num">${trk === 'manager' ? '配点（5〜1段階）' : '倍率'}</th></tr>
        ${critOf(trk).map((c) => `<tr data-id="${c.id}"><td>${c.sort}</td><td><input data-k="name" value="${esc(c.name)}"></td><td><input data-k="description" value="${esc(c.description)}" style="width:100%"></td>
          <td class="num">${trk === 'manager' ? `<input class="sm" data-k="points" value="${(c.points ?? [1, 2, 3, 4, 5].map((n) => n * c.weight)).slice().reverse().join('/')}" title="5段階の点数を高い順に「/」で区切って入力">` : `<input class="xs" type="number" min="1" data-k="weight" value="${c.weight}">`}</td></tr>
          ${trk === 'manager' ? `<tr data-sub="${c.id}"><td></td><td colspan="3"><div class="row"><input data-k="action_label" class="grow" placeholder="主要アクションの欄（空欄なら欄なし）" value="${esc(c.action_label)}"><input data-k="note" class="grow" placeholder="注意書き（例：※KPIは各事業所の予実管理表にて確認）" value="${esc(c.note)}"></div></td></tr>` : ''}`).join('')}
      </table>
      <div class="row" style="margin-top:8px"><button class="csave">項目を保存</button><button class="cadd" data-track="${trk}">項目を追加</button>
        <span class="muted">${trk === 'manager' ? '配点は高い順に「20/16/10/4/0」のように入力します。' : ''}評価が始まってから項目を変えると、入力済みの点数と合わなくなるので注意してください。</span></div>
    </div>`).join('')}
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
  // Manager points are typed high to low ("20/16/10/4/0") and stored for levels 1..5.
  const parsePoints = (s) => {
    const v = s.split(/[\/,、\s]+/).filter(Boolean).map(Number);
    return v.length === 5 && v.every((n) => Number.isInteger(n) && n >= 0) ? v.reverse() : null;
  };
  $$('.csave').forEach((b) => (b.onclick = async () => {
    const rows = $$('tr[data-id]', b.closest('.panel'));
    const bad = rows.find((tr) => $('[data-k=points]', tr) && !parsePoints($('[data-k=points]', tr).value));
    if (bad) return toast(`${$('[data-k=name]', bad).value}：配点は5つの整数を「/」で区切って入力してください`, true);
    for (const tr of rows) {
      const patch = { name: $('[data-k=name]', tr).value, description: $('[data-k=description]', tr).value };
      if ($('[data-k=points]', tr)) {
        patch.points = parsePoints($('[data-k=points]', tr).value);
        const sub = $(`tr[data-sub="${tr.dataset.id}"]`, b.closest('.panel'));
        patch.action_label = $('[data-k=action_label]', sub).value.trim() || null;
        patch.note = $('[data-k=note]', sub).value.trim() || null;
      } else patch.weight = Number($('[data-k=weight]', tr).value);
      await q(sb.from('criteria').update(patch).eq('id', tr.dataset.id));
    }
    toast('保存しました'); reloadPeriods(p.id);
  }));
  $$('.cadd').forEach((b) => (b.onclick = async () => {
    const name = prompt('追加する項目名'); if (!name) return;
    const track = b.dataset.track;
    await q(sb.from('criteria').insert({ period_id: p.id, track, name, sort: critOf(track).length + 1, points: track === 'manager' ? [0, 1, 3, 4, 5] : null }));
    reloadPeriods(p.id);
  }));
  $('#nf').onsubmit = async (ev) => {
    ev.preventDefault();
    const o = Object.fromEntries(new FormData(ev.target));
    const np = await q(sb.from('periods').insert({ ...o, status: 'preparing', kpi_weight: p.kpi_weight, rank_rules: p.rank_rules }).select().single());
    await q(sb.from('criteria').insert(S.criteria.map(({ sort, name, description, weight, track, points, action_label, note }) => ({ period_id: np.id, sort, name, description, weight, track, points, action_label, note }))));
    toast('作成しました'); reloadPeriods(np.id);
  };
};

// getSession() waits for the client to finish reading a login link in the URL, so no auth listener is needed.
boot().catch((e) => render(`<div class="panel">エラー：${esc(e.message)}</div>`));
