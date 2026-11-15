'use strict';

const LEGACY_STORE = 'calendar-v1';     // записи, сделанные до появления входа
const THEME = 'calendar-theme';
const TZ_OFFSET_MIN = 5 * 60;           // Костанай, UTC+5
const MIN_Y = 2026, MAX_Y = 2040;
const EVENING_FROM = 22 * 60;           // 22:00
const NIGHT_END = 4 * 60;               // до 4:00 ночи «Итог дня» относится ко вчерашнему дню

const MONTHS = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
const MONTHS_GEN = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
const WEEKDAYS = ['Воскресенье','Понедельник','Вторник','Среда','Четверг','Пятница','Суббота'];
const WD_SHORT = ['вс','пн','вт','ср','чт','пт','сб'];
const WD_IN = ['в воскресенье','в понедельник','во вторник','в среду','в четверг','в пятницу','в субботу'];
const WD_HOW = ['Как прошло воскресенье','Как прошёл понедельник','Как прошёл вторник','Как прошла среда','Как прошёл четверг','Как прошла пятница','Как прошла суббота'];

const ICON = {
  check: '<svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  left: '<svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>',
  right: '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
};

/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
const pad = n => String(n).padStart(2, '0');
const dkey = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
const mkey = (y, m) => `${y}-${pad(m + 1)}`;
const parse = k => { const [y, m, d] = k.split('-').map(Number); return { y, m: m - 1, d }; };
const shift = (k, n) => { const p = parse(k), t = new Date(Date.UTC(p.y, p.m, p.d + n)); return dkey(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()); };
const daysIn = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const weekday = k => { const p = parse(k); return new Date(Date.UTC(p.y, p.m, p.d)).getUTCDay(); };
const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const newId = () => crypto.randomUUID();
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inRange = k => { const y = parse(k).y; return y >= MIN_Y && y <= MAX_Y; };

function now() {
  const t = new Date(Date.now() + TZ_OFFSET_MIN * 60000);
  const y = t.getUTCFullYear(), m = t.getUTCMonth(), d = t.getUTCDate();
  return { key: dkey(y, m, d), y, m, d, min: t.getUTCHours() * 60 + t.getUTCMinutes() };
}
const isLastDay = n => n.d === daysIn(n.y, n.m);
/* «день» для итога дня: ночью до 4:00 это ещё вчера (лёг спать в 00:30 — подводишь итог вчерашнего дня) */
const evDay = () => { const n = now(); return n.min < NIGHT_END ? shift(n.key, -1) : n.key; };
const dayLabel = k => { const p = parse(k); return `${WD_SHORT[weekday(k)]}, ${p.d} ${MONTHS_GEN[p.m]}`; };

/* ---------- Supabase ---------- */
const cfg = window.CALENDAR_CONFIG;
// Пришли по ссылке из письма «сбросить пароль»? Смотрим адрес до того, как Supabase его разберёт.
const hashParams = new URLSearchParams(location.hash.slice(1));
const cameForRecovery = hashParams.get('type') === 'recovery';
const recoveryLinkError = hashParams.get('error_code') || hashParams.get('error');

// Вход запоминается на устройстве: сессия лежит в браузере и сама продлевается, пока не нажмёшь «Выйти».
const sb = supabase.createClient(cfg.url, cfg.key, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit', storageKey: 'calendar-auth' },
});
let user = null;

/* db в памяти: { tasks: {day: [task]}, blocks: {month: [block]}, eveningDone: {day: true}, summaryDone: {month: true} } */
const emptyDb = () => ({ tasks: {}, blocks: {}, eveningDone: {}, summaryDone: {} });
let db = emptyDb();

let pendingWrites = 0;
let saveWarned = false;
async function remote(query) {
  pendingWrites++;
  try {
    const { error } = await query;
    if (error) throw error;
    return true;
  } catch (e) {
    console.error(e);
    if (!saveWarned) {
      saveWarned = true;
      toast('Не получилось сохранить. Проверь интернет и обнови страницу.', [], 8000);
      setTimeout(() => { saveWarned = false; }, 8000);
    }
    return false;
  } finally {
    pendingWrites--;
  }
}

async function fetchAll(table, cols, order) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select(cols).order(order).range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

/* поле track («в прогресс») появилось позже: если в базе его ещё нет, сайт работает как раньше, без галочки */
let hasTrack = true;
const TASK_COLS = 'id,day,name,start_time,end_time,status,block_id,asked';
async function fetchTasks() {
  if (hasTrack) {
    try { return await fetchAll('tasks', TASK_COLS + ',track', 'created_at'); }
    catch (e) { if (!/track/i.test(e.message || '')) throw e; hasTrack = false; }
  }
  return fetchAll('tasks', TASK_COLS, 'created_at');
}

async function loadAll() {
  const [tasks, blocksRows, marks] = await Promise.all([
    fetchTasks(),
    fetchAll('blocks', 'id,month,name,note,position', 'position'),
    fetchAll('marks', 'kind,key', 'key'),
  ]);
  const d = emptyDb();
  for (const r of tasks) {
    (d.tasks[r.day] = d.tasks[r.day] || []).push({
      id: r.id, name: r.name, start: r.start_time || undefined, end: r.end_time || undefined,
      status: r.status, block: r.block_id, asked: r.asked, track: r.track || null,
    });
  }
  for (const r of blocksRows) (d.blocks[r.month] = d.blocks[r.month] || []).push({ id: r.id, name: r.name, note: r.note });
  for (const r of marks) (r.kind === 'evening' ? d.eveningDone : d.summaryDone)[r.key] = true;
  db = d;
}

const taskRow = (day, t) => Object.assign({
  id: t.id, day, name: t.name, start_time: t.start || null, end_time: t.end || null,
  status: t.status, block_id: t.block || null, asked: !!t.asked,
}, hasTrack ? { track: t.track || null } : {});
const saveTask = (day, t) => remote(sb.from('tasks').insert(taskRow(day, t)));
const patchTask = (id, fields) => remote(sb.from('tasks').update(fields).eq('id', id));
const dropTask = id => remote(sb.from('tasks').delete().eq('id', id));
const saveMark = (kind, key) => remote(sb.from('marks').upsert({ user_id: user.id, kind, key }, { onConflict: 'user_id,kind,key', ignoreDuplicates: true }));

/* ---------- блоки месяца ----------
   Пока блоки месяца не трогали, они «черновые»: 5 без названия (или названия с прошлого месяца)
   и в базу не пишутся. В базу они попадают при первом изменении или когда задаче выбрали блок. */
const draftBlocks = {};
function prevMonth(mk) { const [y, m] = mk.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`; }
function blocks(mk) {
  if (db.blocks[mk]) return db.blocks[mk];
  if (!draftBlocks[mk]) {
    const src = db.blocks[prevMonth(mk)];
    draftBlocks[mk] = src
      ? src.map(b => ({ id: newId(), name: b.name, note: '' }))
      : Array.from({ length: 5 }, () => ({ id: newId(), name: '', note: '' }));
  }
  return draftBlocks[mk];
}
async function ensureBlocks(mk) {
  if (db.blocks[mk]) return true;
  const list = blocks(mk);
  db.blocks[mk] = list;
  delete draftBlocks[mk];
  return remote(sb.from('blocks').insert(list.map((b, i) => ({ id: b.id, month: mk, name: b.name, note: b.note || '', position: i }))));
}
const blockLabel = (b, i) => b.name.trim() || `Блок ${i + 1}`;
function findBlock(mk, id) {
  const list = blocks(mk);
  const i = list.findIndex(b => b.id === id);
  return i < 0 ? null : blockLabel(list[i], i);
}

/* правки названий и итогов блоков сохраняем с небольшой задержкой, а не на каждую букву */
const blockTimers = {};
function patchBlockLater(id, fields) {
  clearTimeout(blockTimers[id]?.t);
  const merged = Object.assign(blockTimers[id]?.f || {}, fields);
  blockTimers[id] = { f: merged, t: setTimeout(() => { delete blockTimers[id]; remote(sb.from('blocks').update(merged).eq('id', id)); }, 600) };
}
function flushBlockEdits() {
  for (const id in blockTimers) {
    clearTimeout(blockTimers[id].t);
    remote(sb.from('blocks').update(blockTimers[id].f).eq('id', id));
    delete blockTimers[id];
  }
}

const sortTasks = list => [
  ...list.filter(t => t.start).sort((a, b) => a.start.localeCompare(b.start)),
  ...list.filter(t => !t.start),
];

/* ---------- state ---------- */
const T0 = now();
let sel = inRange(T0.key) ? T0.key : (T0.y < MIN_Y ? dkey(MIN_Y, 0, 1) : dkey(MAX_Y, 11, 31));
let view = { y: parse(sel).y, m: parse(sel).m };
let mode = 'none';
let lastTodayKey = T0.key;
const session = { evening: {}, summary: {} };

/* ---------- month grid ---------- */
function renderMonth() {
  const { y, m } = view;
  $('#monthTitle').textContent = `${MONTHS[m]} ${y}`;
  $('#prev').style.visibility = (y === MIN_Y && m === 0) ? 'hidden' : '';
  $('#next').style.visibility = (y === MAX_Y && m === 11) ? 'hidden' : '';

  const first = (new Date(Date.UTC(y, m, 1)).getUTCDay() + 6) % 7;
  const rows = Math.ceil((first + daysIn(y, m)) / 7);
  const today = now().key;
  let html = '';
  for (let i = 0; i < rows * 7; i++) {
    const t = new Date(Date.UTC(y, m, 1 - first + i));
    const k = dkey(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
    const out = t.getUTCMonth() !== m;
    const list = sortTasks(db.tasks[k] || []);
    const cls = ['cell', out && 'out', k === today && 'today', k === sel && 'sel'].filter(Boolean).join(' ');
    const chips = list.slice(0, 3).map(x =>
      `<span class="chip s-${x.status}"><i></i><b>${x.start ? x.start + ' ' : ''}${esc(x.name)}</b></span>`).join('');
    const more = list.length > 3 ? `<span class="more">ещё ${list.length - 3}</span>` : '';
    html += `<button type="button" class="${cls}" data-k="${k}" aria-label="${t.getUTCDate()} ${MONTHS_GEN[t.getUTCMonth()]}, задач: ${list.length}">` +
      `<span class="num">${t.getUTCDate()}</span><span class="chips">${chips}${more}</span></button>`;
  }
  const grid = $('#grid');
  grid.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;
  grid.innerHTML = html;
}

function goMonth(delta) {
  let { y, m } = view;
  m += delta;
  if (m < 0) { m = 11; y--; }
  if (m > 11) { m = 0; y++; }
  if (y < MIN_Y || y > MAX_Y) return;
  view = { y, m };
  renderMonth();
}

/* ---------- day panel ---------- */
function renderDay() {
  const p = parse(sel), today = now().key;
  $('#dayTitle').textContent = `${WEEKDAYS[weekday(sel)]}, ${p.d} ${MONTHS_GEN[p.m]}`;
  $('#daySub').textContent =
    sel === today ? 'Сегодня' :
    sel === shift(today, 1) ? 'Завтра' :
    sel === shift(today, -1) ? 'Вчера' :
    sel < today ? 'Прошедший день' : 'Будущий день';

  const mk = mkey(p.y, p.m), bl = blocks(mk), selEl = $('#blockSel'), cur = selEl.value;
  selEl.innerHTML = '<option value="">Без блока</option>' +
    bl.map((b, i) => `<option value="${b.id}">${esc(blockLabel(b, i))}</option>`).join('');
  if (bl.some(b => b.id === cur)) selEl.value = cur;

  const list = db.tasks[sel] || [];
  const prevK = shift(sel, -1), nextK = shift(sel, 1);
  const timed = sortTasks(list.filter(t => t.start)), free = list.filter(t => !t.start);
  const row = x => {
    const bn = x.block ? findBlock(mk, x.block) : null;
    return `<li class="task s-${x.status}" data-id="${x.id}">` +
      (x.start ? `<span class="time">${x.start}–${x.end}</span>` : '') +
      `<span class="name">${esc(x.name)}${x.track ? ` <em class="tbadge">${esc(x.track)}</em>` : ''}${bn ? `<small>${esc(bn)}</small>` : ''}</span>` +
      `<span class="tools">` +
      (inRange(prevK) ? `<button type="button" data-act="prev" class="mv" aria-label="Перенести на ${dayLabel(prevK)}" title="Перенести на ${dayLabel(prevK)}">${ICON.left}</button>` : '') +
      (inRange(nextK) ? `<button type="button" data-act="next" class="mv" aria-label="Перенести на ${dayLabel(nextK)}" title="Перенести на ${dayLabel(nextK)}">${ICON.right}</button>` : '') +
      `<button type="button" data-act="done" class="${x.status === 'done' ? 'on' : ''}" aria-label="Получилось" title="Получилось">${ICON.check}</button>` +
      `<button type="button" data-act="fail" class="${x.status === 'fail' ? 'on' : ''}" aria-label="Не получилось" title="Не получилось">${ICON.x}</button>` +
      `<button type="button" data-act="del" aria-label="Удалить" title="Удалить">${ICON.trash}</button>` +
      `</span></li>`;
  };
  let html = '';
  if (timed.length) html += `<h3>По времени</h3><ul>${timed.map(row).join('')}</ul>`;
  if (free.length) html += `<h3>В любое время</h3><ul>${free.map(row).join('')}</ul>`;
  $('#taskList').innerHTML = html || '<p class="empty">На этот день пока пусто. Напиши первую задачу выше.</p>';

  // перенести весь день: кнопка видна, только если есть что переносить
  $('#moveDayBtn').hidden = !list.length;
  $('#movePop').hidden = true;
  $('#moveDayBtn').setAttribute('aria-expanded', 'false');
  $('#moveText').textContent = `Перенести ${list.length === 1 ? 'задачу' : `все ${list.length} ${plural(list.length, 'задачу', 'задачи', 'задач')}`}`;
  $('#movePrev').textContent = `← На ${dayLabel(prevK)}`;
  $('#moveNext').textContent = `На ${dayLabel(nextK)} →`;
  $('#movePrev').hidden = !inRange(prevK);
  $('#moveNext').hidden = !inRange(nextK);
  renderTrackPicker();
  updateButtons();
}
const plural = (n, a, b, c) => { const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? b : c; };

/* ---------- галочка «В прогресс» ---------- */
let trackOn = false, selTrack = null, newTrack = false;
function allTracks() {
  const set = new Set();
  for (const k in db.tasks) for (const t of db.tasks[k]) if (t.track) set.add(t.track);
  return [...set].sort((a, b) => a.localeCompare(b, 'ru'));
}
function renderTrackPicker() {
  $('#trackChk').hidden = !hasTrack;
  $('#trackOn').checked = trackOn;
  const box = $('#trackRow'), list = allTracks();
  box.hidden = !hasTrack || !trackOn;
  if (box.hidden) return;
  if (!list.length) newTrack = true;                       // первый раз — сразу поле для названия
  if (selTrack && !list.includes(selTrack)) selTrack = null;
  if (!selTrack && !newTrack) selTrack = list[0];
  box.querySelector('.chips-row').innerHTML =
    list.map(n => `<button type="button" class="tchip${!newTrack && n === selTrack ? ' on' : ''}" data-track="${esc(n)}">${esc(n)}</button>`).join('') +
    `<button type="button" class="tchip new${newTrack ? ' on' : ''}" data-track="">+ Новый</button>`;
  $('#trackNew').hidden = !newTrack;
}
function chosenTrack() {
  if (!hasTrack || !trackOn) return null;
  return newTrack ? $('#trackNew').value.trim().slice(0, 60) : selTrack;
}

function renderAll() { renderMonth(); renderDay(); updateButtons(); }

function selectDay(k) {
  if (!inRange(k)) return;
  sel = k;
  const p = parse(k);
  view = { y: p.y, m: p.m };
  renderMonth();
  renderDay();
}

function setMode(m) {
  mode = m;
  document.querySelectorAll('.seg button').forEach(b => {
    const on = b.dataset.mode === m;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', on);
  });
  $('#timeFields').hidden = m !== 'time';
  hideError();
  updateDuration();
}

function updateDuration() {
  const s = $('#startTime').value, e = $('#endTime').value, out = $('#duration');
  if (mode !== 'time' || !s || !e) { out.textContent = ''; return; }
  const d = toMin(e) - toMin(s);
  out.textContent = d > 0 ? `Длительность: ${Math.floor(d / 60) ? Math.floor(d / 60) + ' ч ' : ''}${d % 60 ? d % 60 + ' мин' : ''}` : '';
}
function showError(msg) { const e = $('#formError'); e.textContent = msg; e.hidden = false; }
function hideError() { $('#formError').hidden = true; }

async function addTask(ev) {
  ev.preventDefault();
  const name = $('#taskName').value.trim();
  if (!name) { showError('Напиши, что сделать'); $('#taskName').focus(); return; }
  const day = sel, mk = mkey(parse(day).y, parse(day).m);
  const track = chosenTrack();
  if (hasTrack && trackOn && !track) { showError('Напиши название прогресса, например «Практика»'); $('#trackNew').focus(); return; }
  const task = { id: newId(), name, status: 'plan', block: $('#blockSel').value || null, asked: false, track };
  if (track) { selTrack = track; newTrack = false; $('#trackNew').value = ''; }
  if (mode === 'time') {
    const s = $('#startTime').value, e = $('#endTime').value;
    if (!s || !e) { showError('Укажи время начала и конца'); return; }
    if (toMin(e) <= toMin(s)) { showError('Конец должен быть позже начала'); return; }
    task.start = s; task.end = e;
  }
  (db.tasks[day] = db.tasks[day] || []).push(task);
  $('#taskName').value = '';
  $('#taskName').focus();
  renderMonth(); renderDay();
  if (task.block) await ensureBlocks(mk);
  saveTask(day, task);
}

function findTask(k, id) { return (db.tasks[k] || []).find(t => t.id === id); }
function setStatus(k, id, status, toggle = true) {
  const t = findTask(k, id);
  if (!t) return;
  t.status = toggle && t.status === status ? 'plan' : status;
  t.asked = true;
  patchTask(id, { status: t.status, asked: true });
}
function deleteTask(k, id) {
  const list = db.tasks[k] || [];
  const i = list.findIndex(t => t.id === id);
  if (i < 0) return;
  const [removed] = list.splice(i, 1);
  if (!list.length) delete db.tasks[k];
  renderMonth(); renderDay();
  dropTask(id);
  toast(`Задача «${removed.name}» удалена`, [{ label: 'Вернуть', run: () => {
    (db.tasks[k] = db.tasks[k] || []).splice(i, 0, removed);
    renderMonth(); renderDay();
    saveTask(k, removed);
  } }], 6000);
}

/* ---------- перенос задач на соседний день ---------- */
/* blocks привязаны к месяцу: если задача уехала в другой месяц, блок с неё снимаем */
function moveTasks(from, ids, to, blocksBack = {}) {
  if (!inRange(to) || !ids.length) return [];
  const sameMonth = from.slice(0, 7) === to.slice(0, 7);
  const src = db.tasks[from] || [], moved = [];
  for (const id of ids) {
    const i = src.findIndex(t => t.id === id);
    if (i < 0) continue;
    const [t] = src.splice(i, 1);
    const fields = { day: to };
    if (blocksBack[id]) { t.block = blocksBack[id]; fields.block_id = t.block; }
    else if (!sameMonth && t.block) { t.block = null; fields.block_id = null; }
    (db.tasks[to] = db.tasks[to] || []).push(t);
    moved.push(t);
    patchTask(id, fields);
  }
  if (!src.length) delete db.tasks[from];
  return moved;
}
function moveWithUndo(from, ids, delta) {
  const to = shift(from, delta);
  const oldBlocks = {};
  for (const t of db.tasks[from] || []) if (ids.includes(t.id) && t.block) oldBlocks[t.id] = t.block;
  const moved = moveTasks(from, ids, to);
  if (!moved.length) return;
  renderMonth(); renderDay();
  const what = moved.length === 1 ? `«${moved[0].name}»` : `${moved.length} ${plural(moved.length, 'задачу', 'задачи', 'задач')}`;
  toast(`Перенёс ${what} на ${dayLabel(to)}`, [{ label: 'Отменить', run: () => {
    moveTasks(to, moved.map(t => t.id), from, oldBlocks);
    renderMonth(); renderDay();
  } }], 7000);
}

/* ---------- evening check ---------- */
function openEvening() {
  renderEvening();
  $('#eveningDlg').showModal();
}
function renderEvening() {
  const k = evDay(), list = sortTasks(db.tasks[k] || []);
  const tk = shift(k, 1), tp = parse(tk);
  $('#eveningTitle').textContent = `${WD_HOW[weekday(k)]}, ${parse(k).d} ${MONTHS_GEN[parse(k).m]}?`;
  $('#tomorrowLabel').textContent = `Что хочешь сделать ${WD_IN[weekday(tk)]}, ${tp.d} ${MONTHS_GEN[tp.m]}?`;
  $('#eveningList').innerHTML = list.length
    ? list.map(x => `<div class="check-row" data-id="${x.id}"><span>${x.start ? `<span class="t">${x.start}–${x.end}</span>` : ''}${esc(x.name)}</span>` +
        `<span class="yn"><button type="button" data-s="done" class="${x.status === 'done' ? 'on-done' : ''}">Да</button>` +
        `<button type="button" data-s="fail" class="${x.status === 'fail' ? 'on-fail' : ''}">Нет</button></span></div>`).join('')
    : '<p class="empty">На сегодня задач не было. Запиши, что хочешь сделать завтра.</p>';
  const tm = db.tasks[shift(k, 1)] || [];
  $('#tomorrowList').innerHTML = tm.map(x => `<li class="s-plan">${x.start ? x.start + ' ' : ''}${esc(x.name)}</li>`).join('');
}

/* ---------- blocks and month summary ---------- */
let blocksCtx = null;   // { mk, summary }
function openBlocks(mk, summary) {
  blocksCtx = { mk, summary };
  const [y, m] = mk.split('-').map(Number);
  $('#blocksTitle').textContent = summary ? `Итоги ${MONTHS_GEN[m - 1]}` : `Блоки: ${MONTHS[m - 1].toLowerCase()} ${y}`;
  renderBlocks();
  $('#blocksDlg').showModal();
}
function monthCounts(mk) {
  const counts = {}, total = { done: 0, fail: 0, plan: 0 };
  for (const k in db.tasks) {
    if (!k.startsWith(mk + '-')) continue;
    for (const t of db.tasks[k]) {
      total[t.status]++;
      const c = counts[t.block || ''] = counts[t.block || ''] || { done: 0, fail: 0 };
      if (t.status !== 'plan') c[t.status]++;
    }
  }
  return { counts, total };
}
function renderBlocks() {
  const { mk, summary } = blocksCtx, bl = blocks(mk), { counts, total } = monthCounts(mk);
  $('#blocksList').innerHTML = bl.map((b, i) => {
    const c = counts[b.id] || { done: 0, fail: 0 };
    return `<div class="block-item" data-id="${b.id}">` +
      `<div class="row"><input class="bname" value="${esc(b.name)}" maxlength="100" placeholder="Без названия" aria-label="Название блока ${i + 1}">` +
      (bl.length > 1 ? `<button type="button" class="icon del-block" aria-label="Удалить блок">${ICON.trash}</button>` : '') + `</div>` +
      (summary
        ? `<div class="counts"><span><i class="dot s-done"></i>получилось ${c.done}</span><span><i class="dot s-fail"></i>не получилось ${c.fail}</span></div>` +
          `<textarea class="bnote" maxlength="5000" placeholder="Что получилось в этом блоке, что нет" aria-label="Итог блока ${i + 1}">${esc(b.note || '')}</textarea>`
        : '') +
      `</div>`;
  }).join('');
  $('#blocksTotal').textContent = summary
    ? `За месяц: получилось ${total.done}, не получилось ${total.fail}, не отмечено ${total.plan}.`
    : 'Названия блоков видны в списке при добавлении задачи.';
}

/* ---------- прогресс ----------
   Считает только задачи с галочкой «В прогресс» выбранного направления.
   Месяц: первый — с дня старта плана, остальные — целиком. День «сделан», если все его задачи зелёные. */
const MONTHS_SHORT = ['янв','фев','мар','апр','мая','июн','июл','авг','сен','окт','ноя','дек'];
const nextMonth = mk => { const [y, m] = mk.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`; };
let progTrack = null, progMonth = null;
function trackDays(track) {
  const out = {};
  for (const k in db.tasks) { const l = db.tasks[k].filter(t => t.track === track); if (l.length) out[k] = l; }
  return out;
}
const dayStatus = l => !l || !l.length ? 'empty' : l.some(t => t.status === 'fail') ? 'fail' : l.every(t => t.status === 'done') ? 'done' : 'plan';
const daysBetween = (a, b) => Math.round((Date.UTC(...ymd(b)) - Date.UTC(...ymd(a))) / 86400000);
const ymd = k => { const p = parse(k); return [p.y, p.m, p.d]; };

function openProgress() {
  const list = allTracks();
  if (!list.length) return;
  if (!list.includes(progTrack)) progTrack = list[0];
  progMonth = null;
  renderProgress();
  $('#progressDlg').showModal();
}
function renderProgress() {
  const tracks = allTracks();
  if (!tracks.includes(progTrack)) progTrack = tracks[0];
  $('#trackSel').innerHTML = tracks.map(n => `<option${n === progTrack ? ' selected' : ''}>${esc(n)}</option>`).join('');
  $('#trackSel').hidden = tracks.length < 2;
  $('#progTitle').textContent = tracks.length < 2 && progTrack ? progTrack : 'Прогресс';
  const days = trackDays(progTrack), keys = Object.keys(days).sort();
  if (!keys.length) { $('#progMonths').innerHTML = ''; $('#progBody').innerHTML = '<p class="empty">Здесь пока пусто. Поставь галочку «В прогресс», когда добавляешь задачу.</p>'; return; }
  const today = now().key, first = keys[0], last = keys[keys.length - 1];

  // месяцы плана
  const months = [];
  for (let mk = first.slice(0, 7); mk <= last.slice(0, 7); mk = nextMonth(mk)) months.push(mk);
  if (!months.includes(progMonth)) progMonth = months.includes(today.slice(0, 7)) ? today.slice(0, 7) : (today < first ? months[0] : months[months.length - 1]);
  const [py, pm] = progMonth.split('-').map(Number);
  const start = progMonth === first.slice(0, 7) ? first : `${progMonth}-01`;
  const end = `${progMonth}-${pad(daysIn(py, pm - 1))}`;
  $('#progMonths').innerHTML = months.map(mk => {
    const [y, m] = mk.split('-').map(Number), s = mk === first.slice(0, 7) ? parse(first).d : 1;
    return `<button type="button" data-mk="${mk}" class="${mk === progMonth ? 'on' : ''}">${MONTHS[m - 1]}${y !== parse(today).y ? ' ' + y : ''} <small>${s}–${daysIn(y, m - 1)}</small></button>`;
  }).join('');
  $('#progMonths').hidden = months.length < 2;

  // дни месяца и их статусы
  const range = [];
  for (let k = start; k <= end; k = shift(k, 1)) range.push(k);
  const st = k => dayStatus(days[k]);
  const N = range.length;
  const done = range.filter(k => st(k) === 'done').length, fail = range.filter(k => st(k) === 'fail').length;
  const left = range.filter(k => k > today).length;
  const pct = Math.round(done / N * 100);
  const sub = end < today ? `${pct}% · месяц закончился` : start > today ? `${pct}% · месяц ещё не начался` : `${pct}% месяца · осталось ${left} ${plural(left, 'день', 'дня', 'дней')}`;

  // огонёк: сколько дней с заданиями подряд всё сделано (сегодня ещё можно успеть, поэтому не сбивает)
  let streak = 0;
  for (const k of keys.filter(k => k <= today).reverse()) {
    if (k === today && st(k) !== 'done') continue;
    if (st(k) === 'done') streak++; else break;
  }

  // темп и прогноз по всему плану
  const all = keys.flatMap(k => days[k].map(t => ({ k, t })));
  const behind = all.filter(x => x.k < today && x.t.status === 'plan').length;
  const leftTasks = all.filter(x => x.t.status === 'plan').length;
  const doneTasks = all.filter(x => x.t.status === 'done').length;
  let forecast;
  if (!leftTasks) forecast = 'Всё сделано';
  else if (today < first) forecast = `Старт ${parse(first).d} ${MONTHS_GEN[parse(first).m]}`;
  else if (!doneTasks) forecast = 'Отметь первое задание';
  else {
    const pace = doneTasks / (daysBetween(first, today) + 1);
    const f = parse(shift(today, Math.ceil(leftTasks / pace)));
    forecast = `Закончишь ${f.d} ${MONTHS_GEN[f.m]}`;
  }

  // недели плана: по 7 дней от дня старта (как в самом плане: 15–21, 22–28…)
  const weeks = [], weekNo = [];
  for (const k of range) {
    const w = Math.floor(daysBetween(first, k) / 7);
    if (weekNo[weekNo.length - 1] !== w) { weeks.push([]); weekNo.push(w); }
    weeks[weeks.length - 1].push(k);
  }
  const wLabel = w => { const a = parse(w[0]), b = parse(w[w.length - 1]); return `${a.d}${a.d === b.d ? '' : '–' + b.d} ${MONTHS_SHORT[b.m]}`; };
  const openW = weeks.findIndex(w => w[0] <= today && today <= w[w.length - 1]);

  const rowsOf = w => w.filter(k => days[k]).map(k => days[k].map((t, i) =>
    `<button type="button" class="prow${k === today ? ' today' : ''}${t.status === 'done' ? ' done' : ''}${k < today && t.status === 'plan' ? ' late' : ''}" data-k="${k}">` +
    `<span class="pd">${i ? '' : `<b>${parse(k).d}</b>${WD_SHORT[weekday(k)]}`}</span>` +
    `<span class="pn">${esc(t.name)}${k === today && !i ? '<em>сегодня</em>' : ''}${k < today && t.status === 'plan' ? '<em class="late-tag">не отмечено</em>' : ''}</span>` +
    `<i class="dot s-${t.status}"></i></button>`).join('')).join('');

  $('#progBody').innerHTML =
    `<div class="p-hero"><div><div class="p-big">${done}<span>из ${N} ${plural(N, 'дня', 'дней', 'дней')}</span></div><div class="muted small">${sub}</div></div>` +
    `<div class="p-fire${streak ? '' : ' off'}" title="Дней подряд всё сделано"><svg viewBox="0 0 24 24" aria-hidden="true"><path class="f1" d="M12 2c1 4 5 5.5 5 11a5 5 0 0 1-10 0c0-2.5 1.2-4 2.5-5 .2 1.8 1 3 2.5 3.5C11 9 10.5 5.5 12 2z"/><path class="f2" d="M12 22a3 3 0 0 1-3-3c0-1.8 1.3-2.8 3-4.5 1.7 1.7 3 2.7 3 4.5a3 3 0 0 1-3 3z"/></svg>` +
    `<div><b>${streak}</b><em>${plural(streak, 'день', 'дня', 'дней')} подряд</em></div></div></div>` +
    `<div class="p-bar"><i class="s-done-bar" style="width:${done / N * 100}%"></i><i class="s-fail-bar" style="width:${fail / N * 100}%"></i></div>` +
    `<div class="legend"><span><i class="dot s-done"></i>сделал ${done}</span><span><i class="dot s-fail"></i>не получилось ${fail}</span><span><i class="dot p-rest"></i>остальное ${N - done - fail}</span></div>` +
    `<div class="p-cards"><div class="p-card ${behind ? 'warn' : 'ok'}"><span>Темп</span><b>${behind ? `Отстаёшь на ${behind} ${plural(behind, 'задачу', 'задачи', 'задач')}` : 'Всё по плану'}</b></div>` +
    `<div class="p-card"><span>Прогноз</span><b>${forecast}</b></div></div>` +
    `<div class="p-weeks">${weeks.map(w => `<div class="p-wk"><span>${wLabel(w)}</span><span class="p-mini">${w.map(k => `<i class="m-${st(k)}${k === today ? ' m-today' : ''}"></i>`).join('')}</span><b>${w.filter(k => st(k) === 'done').length}/${w.length}</b></div>`).join('')}</div>` +
    weeks.map((w, i) => w.some(k => days[k])
      ? `<details class="p-week"${i === openW || (openW < 0 && i === 0) ? ' open' : ''}><summary><span>Неделя ${weekNo[i] + 1} · ${wLabel(w)}</span><small>${w.filter(k => st(k) === 'done').length} из ${w.length}</small></summary><div class="p-list">${rowsOf(w)}</div></details>`
      : '').join('');
}

/* ---------- toasts ---------- */
function toast(text, actions = [], ms = 5000) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span>${esc(text)}</span>`;
  const close = () => { el.remove(); };
  actions.forEach(a => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = a.label;
    b.onclick = () => { a.run(); close(); };
    el.appendChild(b);
  });
  $('#toasts').appendChild(el);
  if (ms) setTimeout(close, ms);
  return el;
}

/* задача со временем закончилась: спросить сразу */
let endedToast = null;
function checkEnded() {
  if ((endedToast && endedToast.isConnected) || anyDialogOpen()) return;
  const n = now();
  const t = sortTasks(db.tasks[n.key] || []).find(x => x.end && x.status === 'plan' && !x.asked && toMin(x.end) <= n.min);
  if (!t) return;
  const answer = s => () => { setStatus(n.key, t.id, s, false); renderMonth(); renderDay(); };
  endedToast = toast(`«${t.name}» закончилось в ${t.end}. Получилось?`, [
    { label: 'Да', run: answer('done') },
    { label: 'Нет', run: answer('fail') },
    { label: 'Позже', run: () => { t.asked = true; patchTask(t.id, { asked: true }); } },
  ], 0);
}

/* ---------- auto-open windows ---------- */
function anyDialogOpen() { return $('#eveningDlg').open || $('#blocksDlg').open || $('#progressDlg').open; }
function updateButtons() {
  $('#summaryBtn').hidden = !isLastDay(now());
  // «Прогресс» видят только те, у кого есть задачи с галочкой
  $('#progressBtn').hidden = !hasTrack || !allTracks().length;
}
function checkAuto() {
  if (!user || anyDialogOpen()) return;
  const n = now();
  if (n.min >= EVENING_FROM && !db.eveningDone[n.key] && !session.evening[n.key]) {
    session.evening[n.key] = true;
    openEvening();
    return;
  }
  const mk = mkey(n.y, n.m);
  if (isLastDay(n) && !db.summaryDone[mk] && !session.summary[mk]) {
    session.summary[mk] = true;
    openBlocks(mk, true);
  }
}
function tick() {
  if (!user) return;
  const n = now();
  if (n.key !== lastTodayKey) { lastTodayKey = n.key; renderAll(); }
  updateButtons();
  checkAuto();
  checkEnded();
}

/* ---------- theme ---------- */
function currentTheme() {
  return document.documentElement.dataset.theme ||
    (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}
/* цвет полосы статуса телефона подстраиваем под выбранную тему */
function syncThemeColor() {
  const bg = getComputedStyle(document.body).backgroundColor;
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.setAttribute('content', bg));
}
function toggleTheme() {
  const t = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem(THEME, t); } catch (e) { /* без запоминания */ }
  syncThemeColor();
}

/* ---------- новогодний снег ----------
   Идёт с ноября по январь, немного и медленно. Кнопка-снежинка выключает его (запоминается).
   Если в системе включено «уменьшить движение», снега нет. */
const SNOW_KEY = 'calendar-snow';
const snowSeason = () => [10, 11, 0].includes(now().m);
let snowOn = true, snowRaf = 0, flakes = [];
try { snowOn = localStorage.getItem(SNOW_KEY) !== 'off'; } catch (e) { /* по умолчанию включён */ }

function startSnow() {
  const cv = $('#snow'), ctx = cv.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const resize = () => { cv.width = innerWidth * dpr; cv.height = innerHeight * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
  resize();
  window.addEventListener('resize', resize);
  const count = innerWidth < 700 ? 18 : 36;
  const make = top => ({
    x: Math.random() * innerWidth, y: top ? -10 : Math.random() * innerHeight,
    r: 1 + Math.random() * 2.2, v: 0.25 + Math.random() * 0.55,
    a: 0.35 + Math.random() * 0.45, s: Math.random() * Math.PI * 2, w: 0.004 + Math.random() * 0.01,
  });
  flakes = Array.from({ length: count }, () => make(false));
  const frame = () => {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    const color = currentTheme() === 'dark' ? '255,255,255' : '140,170,210';
    for (const f of flakes) {
      f.y += f.v; f.s += f.w; f.x += Math.sin(f.s) * 0.3;
      if (f.y > innerHeight + 10) Object.assign(f, make(true));
      ctx.beginPath();
      ctx.fillStyle = `rgba(${color},${f.a})`;
      ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
      ctx.fill();
    }
    snowRaf = requestAnimationFrame(frame);
  };
  snowRaf = requestAnimationFrame(frame);
}
function stopSnow() {
  cancelAnimationFrame(snowRaf);
  snowRaf = 0;
  const cv = $('#snow');
  cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
}
function setupSnow() {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const btn = $('#snowBtn');
  btn.hidden = !snowSeason() || reduce;
  btn.setAttribute('aria-pressed', snowOn);
  if (snowSeason() && !reduce && snowOn && !snowRaf) startSnow();
}
function toggleSnow() {
  snowOn = !snowOn;
  try { localStorage.setItem(SNOW_KEY, snowOn ? 'on' : 'off'); } catch (e) { /* не запомним */ }
  $('#snowBtn').setAttribute('aria-pressed', snowOn);
  if (snowOn) startSnow(); else stopSnow();
}

/* ---------- погода в Екатеринбурге (Open-Meteo, бесплатно, без ключа) ---------- */
const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast?latitude=56.84&longitude=60.61&current=temperature_2m,weather_code,snowfall&timezone=Asia%2FYekaterinburg';
const SNOW_CODES = [71, 73, 75, 77, 85, 86];
const SNOWFLAKE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18M4.2 7.5l15.6 9M19.8 7.5l-15.6 9"/></svg>';
async function loadWeather() {
  try {
    const res = await fetch(WEATHER_URL);
    if (!res.ok) throw new Error(res.status);
    const { current: c } = await res.json();
    const t = Math.round(c.temperature_2m);
    const snowing = SNOW_CODES.includes(c.weather_code) || c.snowfall > 0;
    const el = $('#weather');
    el.innerHTML = `${t > 0 ? '+' : t < 0 ? '−' : ''}${Math.abs(t)}°${snowing ? SNOWFLAKE_SVG : ''}`;
    el.title = `Екатеринбург: ${t > 0 ? '+' : ''}${t}°${snowing ? ', идёт снег' : ''}`;
    el.hidden = false;
  } catch (e) {
    /* нет связи: просто не показываем погоду */
  }
}

/* ---------- backup ---------- */
function exportData() {
  const blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `calendar-backup-${now().key}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------- перенос записей, сделанных до входа ---------- */
function readLegacy() {
  try {
    const old = JSON.parse(localStorage.getItem(LEGACY_STORE));
    return old && old.tasks && Object.keys(old.tasks).length ? old : null;
  } catch (e) { return null; }
}
function dropLegacy() { try { localStorage.removeItem(LEGACY_STORE); } catch (e) { /* ничего */ } }
function offerMigration() {
  const old = readLegacy();
  if (!old) return;
  toast('В этом браузере есть записи, сделанные до входа. Перенести их в аккаунт?', [
    { label: 'Перенести', run: () => migrate(old) },
    { label: 'Не надо', run: dropLegacy },
  ], 0);
}
async function migrate(old) {
  const idMap = {}, blockRows = [], taskRows = [], markRows = [];
  for (const mk in old.blocks || {}) {
    if (db.blocks[mk]) { old.blocks[mk].forEach((b, i) => { if (db.blocks[mk][i]) idMap[b.id] = db.blocks[mk][i].id; }); continue; }
    old.blocks[mk].forEach((b, i) => {
      const id = newId();
      idMap[b.id] = id;
      blockRows.push({ id, month: mk, name: (b.name || '').slice(0, 100), note: ((old.notes && old.notes[mk] && old.notes[mk][b.id]) || '').slice(0, 5000), position: i });
    });
  }
  for (const day in old.tasks) {
    for (const t of old.tasks[day]) {
      taskRows.push({ id: newId(), day, name: String(t.name).slice(0, 300), start_time: t.start || null, end_time: t.end || null,
        status: ['plan', 'done', 'fail'].includes(t.status) ? t.status : 'plan',
        block_id: (t.block && idMap[t.block]) || null, asked: !!(old.asked && old.asked[t.id]) });
    }
  }
  for (const k in old.eveningDone || {}) markRows.push({ user_id: user.id, kind: 'evening', key: k });
  for (const k in old.summaryDone || {}) markRows.push({ user_id: user.id, kind: 'summary', key: k });

  const ok = (!blockRows.length || await remote(sb.from('blocks').insert(blockRows))) &&
    (!taskRows.length || await remote(sb.from('tasks').insert(taskRows))) &&
    (!markRows.length || await remote(sb.from('marks').upsert(markRows, { onConflict: 'user_id,kind,key', ignoreDuplicates: true })));
  if (!ok) return;
  dropLegacy();
  await loadAll();
  renderAll();
  toast(`Перенесено задач: ${taskRows.length}`);
}

/* ---------- вход ---------- */
/* режимы экрана: in — вход, up — регистрация, reset — прислать ссылку, newpass — задать новый пароль */
let authMode = 'in';
const AUTH_TEXT = {
  in:      { lead: 'Войди, чтобы видеть свои задачи на любом устройстве.', submit: 'Войти', sw: 'Нет аккаунта? Создать', pass: 'Пароль' },
  up:      { lead: 'Создай аккаунт: почта и пароль не короче 6 символов.', submit: 'Создать аккаунт', sw: 'Уже есть аккаунт? Войти', pass: 'Пароль' },
  reset:   { lead: 'Введи почту, с которой регистрировался. Пришлём ссылку, чтобы задать новый пароль.', submit: 'Прислать ссылку', sw: 'Вспомнил пароль? Войти', pass: 'Пароль' },
  newpass: { lead: 'Придумай новый пароль для своего аккаунта.', submit: 'Сохранить пароль', sw: '', pass: 'Новый пароль' },
};
function setAuthMode(m) {
  authMode = m;
  const t = AUTH_TEXT[m];
  $('#authLead').textContent = t.lead;
  $('#authSubmit').textContent = t.submit;
  $('#authSwitch').textContent = t.sw;
  $('#authSwitch').hidden = !t.sw;
  $('#authForgot').hidden = m !== 'in';
  $('#emailField').hidden = m === 'newpass';
  $('#passwordField').hidden = m === 'reset';
  $('#passwordLabel').textContent = t.pass;
  $('#authPassword').autocomplete = m === 'in' ? 'current-password' : 'new-password';
  authMessage('');
}
function authMessage(text, info = false) {
  const el = $('#authMsg');
  el.textContent = text;
  el.className = info ? 'info' : 'error';
  el.hidden = !text;
}
function authErrorText(e) {
  const map = {
    invalid_credentials: 'Неверная почта или пароль',
    user_already_exists: 'Такая почта уже зарегистрирована. Нажми «Войти».',
    email_exists: 'Такая почта уже зарегистрирована. Нажми «Войти».',
    weak_password: 'Пароль слишком простой. Нужно не меньше 6 символов.',
    email_address_invalid: 'Проверь адрес почты',
    email_not_confirmed: 'Почта не подтверждена. Открой письмо от Supabase и нажми ссылку.',
    over_email_send_rate_limit: 'Слишком много писем за час. Попробуй позже.',
    over_request_rate_limit: 'Слишком много попыток. Подожди минуту.',
    same_password: 'Новый пароль совпадает со старым. Придумай другой.',
    email_address_not_authorized: 'Письмо не отправилось: в Supabase не настроена почта для писем. Напиши владельцу календаря.',
  };
  return map[e.code] || (/fetch|network/i.test(e.message) ? 'Нет связи с сервером. Проверь интернет.' : e.message);
}
async function submitAuth(e) {
  e.preventDefault();
  const email = $('#authEmail').value.trim(), password = $('#authPassword').value;
  if (authMode !== 'newpass' && !/^\S+@\S+\.\S+$/.test(email)) return authMessage('Введи почту, например name@mail.com');
  if (authMode !== 'reset' && password.length < 6) return authMessage('Пароль должен быть не короче 6 символов');
  const btn = $('#authSubmit'), mode = authMode;
  btn.disabled = true;
  btn.textContent = 'Подожди…';
  let res;
  if (mode === 'in') res = await sb.auth.signInWithPassword({ email, password });
  else if (mode === 'up') res = await sb.auth.signUp({ email, password });
  else if (mode === 'reset') res = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
  else res = await sb.auth.updateUser({ password });
  btn.disabled = false;
  btn.textContent = AUTH_TEXT[mode].submit;
  const { data, error } = res;
  if (error) return authMessage(authErrorText(error));
  if (mode === 'reset') return authMessage('Если с этой почтой есть аккаунт, письмо со ссылкой уже в пути. Проверь и папку «Спам».', true);
  $('#authPassword').value = '';
  if (mode === 'newpass') {
    const { data: s } = await sb.auth.getSession();
    toast('Пароль изменён');
    return startApp(s.session.user);
  }
  if (!data.session) return authMessage('Аккаунт создан. Подтверди почту по ссылке из письма и войди.', true);
  startApp(data.session.user);
}

function showNewPassword() {
  user = null;
  $('#loading').hidden = true;
  $('#app').hidden = true;
  $('#authScreen').hidden = false;
  setAuthMode('newpass');
  $('#authPassword').focus();
}

function showAuth() {
  user = null;
  db = emptyDb();
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  $('#toasts').innerHTML = '';
  $('#loading').hidden = true;
  $('#app').hidden = true;
  $('#authScreen').hidden = false;
  if (authMode === 'newpass') setAuthMode('in');
  $('#authEmail').focus();
}

let started = false;
async function startApp(u) {
  user = u;
  $('#authScreen').hidden = true;
  $('#loading').hidden = false;
  $('#loading').textContent = 'Загружаю…';
  try {
    await loadAll();
  } catch (e) {
    console.error(e);
    $('#loading').textContent = /does not exist|relation|schema cache/i.test(e.message)
      ? 'В Supabase ещё нет таблиц. Выполни файл schema.sql в SQL Editor и обнови страницу.'
      : 'Не получилось загрузить данные. Проверь интернет и обнови страницу.';
    return;
  }
  $('#loading').hidden = true;
  $('#app').hidden = false;
  $('#userEmail').textContent = u.email;
  renderAll();
  if (!started) { started = true; setInterval(tick, 30000); }
  tick();
  offerMigration();
}

/* ---------- events ---------- */
$('#authForm').onsubmit = submitAuth;
$('#authSwitch').onclick = () => setAuthMode(authMode === 'in' ? 'up' : 'in');
$('#authForgot').onclick = () => setAuthMode('reset');
$('#authEmail').oninput = $('#authPassword').oninput = () => authMessage('');
$('#logoutBtn').onclick = async () => { flushBlockEdits(); await sb.auth.signOut(); showAuth(); };

$('#prev').onclick = () => goMonth(-1);
$('#next').onclick = () => goMonth(1);
$('#todayBtn').onclick = () => selectDay(now().key);
$('#themeBtn').onclick = toggleTheme;
$('#snowBtn').onclick = toggleSnow;
$('#eveningBtn').onclick = openEvening;
$('#summaryBtn').onclick = () => { const n = now(); openBlocks(mkey(n.y, n.m), true); };
$('#editBlocks').onclick = () => { const p = parse(sel); openBlocks(mkey(p.y, p.m), false); };

$('#grid').onclick = e => { const c = e.target.closest('.cell'); if (c) selectDay(c.dataset.k); };
document.querySelectorAll('.seg button').forEach(b => b.onclick = () => setMode(b.dataset.mode));
$('#startTime').oninput = () => { hideError(); updateDuration(); };
$('#endTime').oninput = () => { hideError(); updateDuration(); };
$('#taskName').oninput = hideError;
$('#addForm').onsubmit = addTask;

$('#taskList').onclick = e => {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  const id = b.closest('.task').dataset.id, act = b.dataset.act;
  if (act === 'del') return deleteTask(sel, id);
  if (act === 'prev' || act === 'next') return moveWithUndo(sel, [id], act === 'prev' ? -1 : 1);
  setStatus(sel, id, act);
  renderMonth(); renderDay();
};

$('#moveDayBtn').onclick = () => {
  const open = $('#movePop').hidden;
  $('#movePop').hidden = !open;
  $('#moveDayBtn').setAttribute('aria-expanded', open);
};
$('#movePrev').onclick = () => moveWithUndo(sel, (db.tasks[sel] || []).map(t => t.id), -1);
$('#moveNext').onclick = () => moveWithUndo(sel, (db.tasks[sel] || []).map(t => t.id), 1);

$('#trackOn').onchange = e => { trackOn = e.target.checked; hideError(); renderTrackPicker(); if (trackOn && newTrack) $('#trackNew').focus(); };
$('#trackRow').onclick = e => {
  const b = e.target.closest('.tchip'); if (!b) return;
  if (b.dataset.track) { selTrack = b.dataset.track; newTrack = false; }
  else newTrack = true;
  hideError();
  renderTrackPicker();
  if (newTrack) $('#trackNew').focus();
};
$('#trackNew').oninput = hideError;

$('#progressBtn').onclick = openProgress;
$('#trackSel').onchange = e => { progTrack = e.target.value; progMonth = null; renderProgress(); };
$('#progMonths').onclick = e => { const b = e.target.closest('button[data-mk]'); if (!b) return; progMonth = b.dataset.mk; renderProgress(); };
$('#progBody').onclick = e => {
  const r = e.target.closest('.prow'); if (!r) return;
  $('#progressDlg').close();
  selectDay(r.dataset.k);
};

$('#eveningList').onclick = e => {
  const b = e.target.closest('button[data-s]'); if (!b) return;
  setStatus(evDay(), b.closest('.check-row').dataset.id, b.dataset.s, false);
  renderEvening(); renderMonth(); renderDay();
};
$('#tomorrowForm').onsubmit = e => {
  e.preventDefault();
  const name = $('#tomorrowName').value.trim();
  if (!name) { $('#tomorrowName').focus(); return; }
  const k = shift(evDay(), 1), task = { id: newId(), name, status: 'plan', block: null, asked: false, track: null };
  (db.tasks[k] = db.tasks[k] || []).push(task);
  saveTask(k, task);
  $('#tomorrowName').value = '';
  renderEvening(); renderMonth(); renderDay();
};
$('#saveDay').onclick = () => {
  const k = evDay();
  db.eveningDone[k] = true;
  saveMark('evening', k);
  $('#eveningDlg').close();
  toast('День сохранён');
};

$('#blocksList').addEventListener('input', async e => {
  const item = e.target.closest('.block-item'); if (!item) return;
  const { mk } = blocksCtx, id = item.dataset.id;
  const b = blocks(mk).find(x => x.id === id); if (!b) return;
  const field = e.target.classList.contains('bname') ? 'name' : e.target.classList.contains('bnote') ? 'note' : null;
  if (!field) return;
  b[field] = e.target.value;
  if (!db.blocks[mk]) { await ensureBlocks(mk); return; }   // первая правка: весь месяц уходит в базу уже с ней
  patchBlockLater(id, { [field]: e.target.value });
});
$('#blocksList').onclick = async e => {
  const btn = e.target.closest('.del-block'); if (!btn) return;
  const { mk } = blocksCtx, id = btn.closest('.block-item').dataset.id;
  const wasSaved = !!db.blocks[mk];
  const list = blocks(mk).filter(x => x.id !== id);
  if (wasSaved) db.blocks[mk] = list; else draftBlocks[mk] = list;
  for (const k in db.tasks) if (k.startsWith(mk + '-')) db.tasks[k].forEach(t => { if (t.block === id) t.block = null; });
  renderBlocks();
  if (wasSaved) { clearTimeout(blockTimers[id]?.t); delete blockTimers[id]; remote(sb.from('blocks').delete().eq('id', id)); }
  else ensureBlocks(mk);
};
$('#addBlock').onclick = async () => {
  const { mk } = blocksCtx, b = { id: newId(), name: '', note: '' };
  const wasSaved = !!db.blocks[mk];
  blocks(mk).push(b);
  renderBlocks();
  const inputs = document.querySelectorAll('#blocksList .bname');
  inputs[inputs.length - 1].focus();
  if (wasSaved) remote(sb.from('blocks').insert({ id: b.id, month: mk, name: '', note: '', position: db.blocks[mk].length - 1 }));
  else ensureBlocks(mk);
};
$('#blocksDone').onclick = () => {
  flushBlockEdits();
  if (blocksCtx.summary) {
    db.summaryDone[blocksCtx.mk] = true;
    saveMark('summary', blocksCtx.mk);
    toast('Итоги месяца сохранены');
  }
  $('#blocksDlg').close();
};

document.querySelectorAll('.dlg .close').forEach(b => b.onclick = () => b.closest('dialog').close());
document.querySelectorAll('.dlg').forEach(d => {
  d.addEventListener('close', () => { flushBlockEdits(); renderDay(); setTimeout(checkAuto, 400); });
});

$('#exportBtn').onclick = exportData;

document.addEventListener('keydown', e => {
  if (!user || anyDialogOpen() || e.target.closest('input, textarea, select')) return;
  if (e.key === 'ArrowLeft') goMonth(-1);
  if (e.key === 'ArrowRight') goMonth(1);
});

/* вернулся на вкладку: подтянуть то, что поменял с другого устройства */
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !user || anyDialogOpen() || pendingWrites || Object.keys(blockTimers).length) return;
  try { await loadAll(); renderAll(); } catch (e) { /* покажем старое */ }
});

/* ---------- start ---------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(e => console.warn('SW:', e)));
}
setMode('none');
setAuthMode('in');
setupSnow();
loadWeather();
setInterval(loadWeather, 15 * 60 * 1000);
if (document.documentElement.dataset.theme) syncThemeColor();
sb.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT' && user) showAuth();
  if (event === 'PASSWORD_RECOVERY') showNewPassword();
});
sb.auth.getSession().then(({ data }) => {
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  if (cameForRecovery && data.session) return showNewPassword();
  if (data.session) return startApp(data.session.user);
  showAuth();
  if (recoveryLinkError) {
    setAuthMode('reset');
    authMessage('Ссылка из письма устарела или уже использована. Запроси новую.');
  }
});
