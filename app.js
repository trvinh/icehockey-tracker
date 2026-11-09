'use strict';
/* Hockey Log — phone-first PWA. All data lives in localStorage on the device.
 * Schema (version 1):
 *   settings: { playerName, homeAddress, mapsKey, roundTrip }
 *   stadiums: [{ id, name, address, distanceKm|null, durationMin|null, distanceSource: 'google'|'manual'|null, distanceFrom }]
 *   games:    [{ id, date 'YYYY-MM-DD', type, competition, stadiumId, opponent,
 *                scoreFor|null, scoreAgainst|null, goals, assists, notes, createdAt }]
 */

const STORAGE_KEY = 'hockeylog.v1';
const SCHEMA_VERSION = 1;
const GAME_TYPES = ['League', 'Tournament / Cup', 'Friendly'];

// ---------- storage ----------
function emptyDb() {
  return { version: SCHEMA_VERSION, settings: { playerName: '', homeAddress: '', mapsKey: '', roundTrip: true }, stadiums: [], games: [] };
}
function loadDb() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyDb();
    return normalizeDb(JSON.parse(raw));
  } catch (e) {
    console.error('Could not load data', e);
    alert('Could not read saved data: ' + e.message);
    return emptyDb();
  }
}
function saveDb() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  } catch (e) {
    alert('Saving failed (' + e.message + '). Export a backup from Settings.');
  }
}
/** Validate and fill defaults; throws on data that is not a Hockey Log export. */
function normalizeDb(d) {
  if (!d || typeof d !== 'object' || !Array.isArray(d.games) || !Array.isArray(d.stadiums)) {
    throw new Error('Not a Hockey Log data file');
  }
  if (d.version > SCHEMA_VERSION) throw new Error('File was made by a newer app version');
  const base = emptyDb();
  const num = (v) => (v === '' || v === null || v === undefined || isNaN(+v) ? null : +v);
  return {
    version: SCHEMA_VERSION,
    settings: { ...base.settings, ...(d.settings || {}) },
    stadiums: d.stadiums.filter((s) => s && s.id && s.name).map((s) => ({
      id: String(s.id), name: String(s.name), address: String(s.address || ''),
      distanceKm: num(s.distanceKm), durationMin: num(s.durationMin),
      distanceSource: s.distanceSource || null, distanceFrom: s.distanceFrom || null,
    })),
    games: d.games.filter((g) => g && g.id && /^\d{4}-\d{2}-\d{2}$/.test(g.date)).map((g) => ({
      id: String(g.id), date: g.date, type: GAME_TYPES.includes(g.type) ? g.type : 'League',
      competition: String(g.competition || ''), stadiumId: g.stadiumId ? String(g.stadiumId) : null,
      opponent: String(g.opponent || '').trim(),
      scoreFor: num(g.scoreFor), scoreAgainst: num(g.scoreAgainst),
      goals: Math.max(0, num(g.goals) || 0), assists: Math.max(0, num(g.assists) || 0),
      notes: String(g.notes || ''), createdAt: g.createdAt || new Date().toISOString(),
    })),
  };
}

let db = loadDb();
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

// ---------- helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const fmtDate = (iso) => new Date(iso + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const fmtKm = (km) => (km == null ? '–' : km.toLocaleString(undefined, { maximumFractionDigits: km < 100 ? 1 : 0 }) + ' km');
const stadiumById = (id) => db.stadiums.find((s) => s.id === id);
const teamKey = (name) => name.trim().toLowerCase().replace(/\s+/g, ' ');
/** Hockey season runs Aug–Jul, labelled e.g. "2026/27". */
function seasonOf(iso) {
  const y = +iso.slice(0, 4), m = +iso.slice(5, 7);
  const start = m >= 8 ? y : y - 1;
  return `${start}/${String((start + 1) % 100).padStart(2, '0')}`;
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2200);
}
function uniqueSorted(values) {
  const seen = new Map();
  for (const v of values) if (v && v.trim()) seen.set(teamKey(v), v.trim());
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

// ---------- Google distance ----------
/** Driving distance via Google Routes API (computeRoutes). Returns { km, minutes }. */
async function fetchDrivingDistance(fromAddress, toAddress, apiKey) {
  const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration',
    },
    body: JSON.stringify({ origin: { address: fromAddress }, destination: { address: toAddress }, travelMode: 'DRIVE' }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error?.message || `HTTP ${res.status}`);
  const route = body.routes?.[0];
  if (!route || route.distanceMeters == null) throw new Error('No driving route found for this address');
  return { km: route.distanceMeters / 1000, minutes: route.duration ? Math.round(parseInt(route.duration, 10) / 60) : null };
}
async function updateStadiumDistance(stadium, { quiet = false } = {}) {
  const { homeAddress, mapsKey } = db.settings;
  if (!homeAddress || !mapsKey || !stadium.address) {
    if (!quiet) toast('Set home address and Maps key in Settings first');
    return false;
  }
  try {
    const r = await fetchDrivingDistance(homeAddress, stadium.address, mapsKey);
    Object.assign(stadium, { distanceKm: Math.round(r.km * 10) / 10, durationMin: r.minutes, distanceSource: 'google', distanceFrom: homeAddress });
    saveDb();
    if (!quiet) toast(`${stadium.name}: ${fmtKm(stadium.distanceKm)}`);
    return true;
  } catch (e) {
    toast(`Distance lookup failed: ${e.message}`);
    return false;
  }
}

// ---------- stats ----------
function computeStats(games) {
  const days = new Set(games.map((g) => g.date));
  const totals = games.reduce((a, g) => ({ goals: a.goals + g.goals, assists: a.assists + g.assists }), { goals: 0, assists: 0 });
  let w = 0, l = 0, t = 0;
  for (const g of games) {
    if (g.scoreFor == null || g.scoreAgainst == null) continue;
    if (g.scoreFor > g.scoreAgainst) w++; else if (g.scoreFor < g.scoreAgainst) l++; else t++;
  }

  const opp = new Map();
  for (const g of games) {
    if (!g.opponent) continue;
    const k = teamKey(g.opponent);
    const o = opp.get(k) || { name: g.opponent, games: 0, goals: 0, assists: 0 };
    o.games++; o.goals += g.goals; o.assists += g.assists;
    opp.set(k, o);
  }

  // A "trip" is one game day at one rink: several games at the same rink on one day = one drive.
  const trips = new Map();
  for (const g of games) if (g.stadiumId) trips.set(`${g.date}|${g.stadiumId}`, g.stadiumId);
  const rinks = new Map();
  for (const g of games) {
    if (!g.stadiumId) continue;
    const r = rinks.get(g.stadiumId) || { id: g.stadiumId, days: 0, games: 0 };
    r.games++; rinks.set(g.stadiumId, r);
  }
  const factor = db.settings.roundTrip ? 2 : 1;
  let km = 0, missing = 0;
  for (const sid of trips.values()) {
    rinks.get(sid).days++;
    const s = stadiumById(sid);
    if (s && s.distanceKm != null) km += s.distanceKm * factor; else missing++;
  }

  const byType = new Map();
  for (const g of games) {
    const b = byType.get(g.type) || { games: 0, days: new Set(), goals: 0, assists: 0 };
    b.games++; b.days.add(g.date); b.goals += g.goals; b.assists += g.assists; byType.set(g.type, b);
  }

  return {
    games: games.length, days: days.size, ...totals, points: totals.goals + totals.assists, w, l, t,
    opponents: [...opp.values()].sort((a, b) => (b.goals + b.assists) - (a.goals + a.assists) || b.games - a.games || a.name.localeCompare(b.name)),
    rinks: [...rinks.values()].sort((a, b) => b.days - a.days || b.games - a.games),
    trips: trips.size, km, missing, byType,
  };
}

// ---------- views ----------
const state = { tab: 'games', editing: null, filterSeason: 'all', filterType: 'all' };

function setTab(tab, editing = null) {
  state.tab = tab; state.editing = editing;
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab || (tab === 'game' && b.dataset.tab === 'games')));
  render();
  window.scrollTo(0, 0);
}

function render() {
  const titles = { games: 'Games', game: state.editing === 'new' ? 'New game' : 'Edit game', stats: 'Stats', stadiums: 'Rinks', settings: 'Settings' };
  $('#title').textContent = titles[state.tab];
  $('#addBtn').hidden = state.tab !== 'games';
  const view = $('#view');
  ({ games: renderGames, game: renderGameForm, stats: renderStats, stadiums: renderStadiums, settings: renderSettings })[state.tab](view);
}

function filterControls(games) {
  const seasons = [...new Set(games.map((g) => seasonOf(g.date)))].sort().reverse();
  return `<div class="filters">
    <select id="fSeason"><option value="all">All seasons</option>${seasons.map((s) => `<option ${s === state.filterSeason ? 'selected' : ''}>${s}</option>`).join('')}</select>
    <select id="fType"><option value="all">All types</option>${GAME_TYPES.map((t) => `<option ${t === state.filterType ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
  </div>`;
}
function bindFilters() {
  $('#fSeason').onchange = (e) => { state.filterSeason = e.target.value; render(); };
  $('#fType').onchange = (e) => { state.filterType = e.target.value; render(); };
}
function filteredGames() {
  return db.games.filter((g) => (state.filterSeason === 'all' || seasonOf(g.date) === state.filterSeason) && (state.filterType === 'all' || g.type === state.filterType));
}

function renderGames(view) {
  if (!db.games.length) {
    view.innerHTML = `<div class="empty">No games yet.<br>Tap ＋ to add the first one.${db.settings.homeAddress ? '' : '<br><br>Tip: set your home address in Settings so driving distances can be calculated.'}</div>`;
    return;
  }
  const games = filteredGames().sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  let html = filterControls(db.games), lastDate = null;
  for (const g of games) {
    if (g.date !== lastDate) { html += `<div class="day-head">${esc(fmtDate(g.date))}</div>`; lastDate = g.date; }
    const s = stadiumById(g.stadiumId);
    const hasScore = g.scoreFor != null && g.scoreAgainst != null;
    const cls = hasScore ? (g.scoreFor > g.scoreAgainst ? 'w' : g.scoreFor < g.scoreAgainst ? 'l' : '') : '';
    html += `<div class="card game" data-id="${esc(g.id)}">
      <div class="main"><div class="opp">vs ${esc(g.opponent || '?')}</div>
        <div class="meta"><span class="badge">${esc(g.type)}</span>${esc(g.competition)}${g.competition && s ? ' · ' : ''}${esc(s ? s.name : '')}</div></div>
      <div class="right">${hasScore ? `<div class="score ${cls}">${g.scoreFor}:${g.scoreAgainst}</div>` : ''}<div class="pts">${g.goals} G · ${g.assists} A</div></div>
    </div>`;
  }
  if (!games.length) html += '<div class="empty">No games match these filters.</div>';
  view.innerHTML = html;
  bindFilters();
  view.querySelectorAll('.game').forEach((el) => (el.onclick = () => setTab('game', el.dataset.id)));
}

function stepper(id, value) {
  return `<div class="stepper"><button type="button" data-step="${id}" data-d="-1">−</button><input id="${id}" type="number" inputmode="numeric" min="0" value="${value}"><button type="button" data-step="${id}" data-d="1">＋</button></div>`;
}

function renderGameForm(view) {
  const isNew = state.editing === 'new';
  const last = [...db.games].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  // New games prefill date/type/competition/rink from the most recent entry: a cup day usually has several games.
  const g = isNew
    ? { date: last?.date === today() ? last.date : today(), type: last?.type || 'League', competition: last?.date === today() ? last.competition : '', stadiumId: last?.date === today() ? last.stadiumId : '', opponent: '', scoreFor: null, scoreAgainst: null, goals: 0, assists: 0, notes: '' }
    : db.games.find((x) => x.id === state.editing);
  if (!g) return setTab('games');
  const stadiums = [...db.stadiums].sort((a, b) => a.name.localeCompare(b.name));
  view.innerHTML = `<form id="gameForm" autocomplete="off">
    <div class="row">
      <div><label for="date">Date</label><input id="date" type="date" required value="${esc(g.date)}"></div>
      <div><label for="type">Type</label><select id="type">${GAME_TYPES.map((t) => `<option ${t === g.type ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div>
    </div>
    <label for="competition">League / tournament name</label>
    <input id="competition" list="compList" value="${esc(g.competition)}" placeholder="e.g. U11 Regional League">
    <datalist id="compList">${uniqueSorted(db.games.map((x) => x.competition)).map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
    <label for="stadium">Rink</label>
    <select id="stadium"><option value="">— choose —</option>${stadiums.map((s) => `<option value="${esc(s.id)}" ${s.id === g.stadiumId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}<option value="__new">＋ New rink…</option></select>
    <div id="newRink" hidden>
      <label for="rinkName">Rink name</label><input id="rinkName" placeholder="e.g. Eissporthalle Frankfurt">
      <label for="rinkAddr">Address (for Google Maps)</label><input id="rinkAddr" placeholder="Street, city">
    </div>
    <label for="opponent">Opponent</label>
    <input id="opponent" list="oppList" required value="${esc(g.opponent)}" placeholder="Team name">
    <datalist id="oppList">${uniqueSorted(db.games.map((x) => x.opponent)).map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
    <div class="row">
      <div><label for="scoreFor">Our score</label><input id="scoreFor" type="number" inputmode="numeric" min="0" value="${g.scoreFor ?? ''}"></div>
      <div><label for="scoreAgainst">Their score</label><input id="scoreAgainst" type="number" inputmode="numeric" min="0" value="${g.scoreAgainst ?? ''}"></div>
    </div>
    <div class="row">
      <div><label for="goals">Goals</label>${stepper('goals', g.goals)}</div>
      <div><label for="assists">Assists</label>${stepper('assists', g.assists)}</div>
    </div>
    <label for="notes">Notes</label><textarea id="notes">${esc(g.notes)}</textarea>
    <button class="btn" type="submit">Save</button>
    ${isNew ? '' : '<button class="btn danger" type="button" id="delBtn">Delete game</button>'}
    <button class="btn secondary" type="button" id="cancelBtn">Cancel</button>
  </form>`;

  view.querySelectorAll('[data-step]').forEach((b) => (b.onclick = () => {
    const inp = $('#' + b.dataset.step); inp.value = Math.max(0, (+inp.value || 0) + +b.dataset.d);
  }));
  $('#stadium').onchange = (e) => { $('#newRink').hidden = e.target.value !== '__new'; };
  $('#cancelBtn').onclick = () => setTab('games');
  if (!isNew) $('#delBtn').onclick = () => {
    if (!confirm('Delete this game?')) return;
    db.games = db.games.filter((x) => x.id !== g.id); saveDb(); toast('Game deleted'); setTab('games');
  };

  $('#gameForm').onsubmit = (e) => {
    e.preventDefault();
    let stadiumId = $('#stadium').value || null, newStadium = null;
    if (stadiumId === '__new') {
      const name = $('#rinkName').value.trim();
      if (!name) { toast('Enter a rink name'); return; }
      newStadium = { id: uid(), name, address: $('#rinkAddr').value.trim(), distanceKm: null, durationMin: null, distanceSource: null, distanceFrom: null };
      db.stadiums.push(newStadium); stadiumId = newStadium.id;
    }
    const n = (id) => ($('#' + id).value === '' ? null : Math.max(0, parseInt($('#' + id).value, 10)));
    const data = {
      date: $('#date').value, type: $('#type').value, competition: $('#competition').value.trim(), stadiumId,
      opponent: $('#opponent').value.trim(), scoreFor: n('scoreFor'), scoreAgainst: n('scoreAgainst'),
      goals: n('goals') || 0, assists: n('assists') || 0, notes: $('#notes').value.trim(),
    };
    if (isNew) db.games.push({ id: uid(), createdAt: new Date().toISOString(), ...data });
    else Object.assign(g, data);
    saveDb();
    toast('Saved');
    if (newStadium && newStadium.address) updateStadiumDistance(newStadium, { quiet: true });
    setTab('games');
  };
}

function renderStats(view) {
  if (!db.games.length) { view.innerHTML = '<div class="empty">Stats appear once you have added games.</div>'; return; }
  const s = computeStats(filteredGames());
  const kpi = (v, l) => `<div class="kpi"><b>${v}</b><small>${l}</small></div>`;
  let html = filterControls(db.games) + '<div style="height:10px"></div><div class="kpis">' +
    kpi(s.days, 'game days') + kpi(s.games, 'games') + kpi(s.points, 'points') +
    kpi(s.goals, 'goals') + kpi(s.assists, 'assists') + kpi(s.games ? (s.points / s.games).toFixed(2) : '–', 'points / game') +
    '</div>';
  if (s.w + s.l + s.t) html += `<p class="hint">Team record in games with a score: ${s.w} W · ${s.l} L · ${s.t} T</p>`;

  html += `<h2>Driving</h2><div class="card"><div class="kpis" style="margin:0">${kpi(fmtKm(s.km), db.settings.roundTrip ? 'round trips' : 'one way')}${kpi(s.trips, 'trips')}${kpi(s.trips - s.missing ? fmtKm(s.km / (s.trips - s.missing)) : '–', 'per trip')}</div>
    ${s.missing ? `<p class="hint">${s.missing} trip(s) have no distance yet: check the Rinks tab.</p>` : ''}
    <p class="hint">One trip = one game day at one rink.</p></div>`;

  if (s.byType.size > 1) {
    html += '<h2>By type</h2><div class="card"><table><tr><th>Type</th><th>Days</th><th>GP</th><th>G</th><th>A</th></tr>' +
      [...s.byType].map(([t, b]) => `<tr><td>${esc(t)}</td><td>${b.days.size}</td><td>${b.games}</td><td>${b.goals}</td><td>${b.assists}</td></tr>`).join('') + '</table></div>';
  }

  html += '<h2>Opponents</h2><div class="card"><table><tr><th>Team</th><th>GP</th><th>G</th><th>A</th><th>P</th></tr>' +
    s.opponents.map((o) => `<tr><td>${esc(o.name)}</td><td>${o.games}</td><td>${o.goals}</td><td>${o.assists}</td><td><b>${o.goals + o.assists}</b></td></tr>`).join('') + '</table></div>';

  html += '<h2>Rinks</h2><div class="card"><table><tr><th>Rink</th><th>Days</th><th>GP</th><th>Distance</th></tr>' +
    s.rinks.map((r) => { const st = stadiumById(r.id); return `<tr><td>${esc(st ? st.name : '?')}</td><td>${r.days}</td><td>${r.games}</td><td>${fmtKm(st?.distanceKm)}</td></tr>`; }).join('') + '</table></div>';

  view.innerHTML = html;
  bindFilters();
}

function renderStadiums(view) {
  const count = new Map();
  for (const g of db.games) if (g.stadiumId) count.set(g.stadiumId, (count.get(g.stadiumId) || 0) + 1);
  const list = [...db.stadiums].sort((a, b) => a.name.localeCompare(b.name));
  let html = '<p class="hint">Distances are one way from home; tap a rink to edit, set the distance by hand, or look it up again.</p>';
  if (!list.length) html += '<div class="empty">Rinks are added when you enter a game.</div>';
  for (const s of list) {
    const open = state.editing === s.id;
    html += `<div class="card"><div class="game" data-id="${esc(s.id)}"><div class="main"><div class="opp">${esc(s.name)}</div><div class="meta">${esc(s.address || 'no address')}</div></div>
      <div class="right"><div class="score">${fmtKm(s.distanceKm)}</div><div class="pts">${s.durationMin ? s.durationMin + ' min · ' : ''}${count.get(s.id) || 0} games</div></div></div>
      ${open ? `<form class="rinkForm" data-id="${esc(s.id)}">
        <label>Name</label><input name="name" required value="${esc(s.name)}">
        <label>Address</label><input name="address" value="${esc(s.address)}">
        <label>One-way distance (km)</label><input name="km" type="number" step="0.1" min="0" inputmode="decimal" value="${s.distanceKm ?? ''}">
        <button class="btn" type="submit">Save</button>
        <button class="btn secondary" type="button" data-lookup>Look up with Google Maps</button>
        ${count.get(s.id) ? '' : '<button class="btn danger" type="button" data-del>Delete rink</button>'}
      </form>` : ''}</div>`;
  }
  view.innerHTML = html;
  view.querySelectorAll('.game').forEach((el) => (el.onclick = () => { state.editing = state.editing === el.dataset.id ? null : el.dataset.id; render(); }));
  const form = view.querySelector('.rinkForm');
  if (!form) return;
  const s = stadiumById(form.dataset.id);
  form.onsubmit = (e) => {
    e.preventDefault();
    const addr = form.address.value.trim();
    const km = form.km.value === '' ? null : Math.max(0, +form.km.value);
    const kmChanged = km !== s.distanceKm;
    Object.assign(s, { name: form.name.value.trim(), address: addr });
    if (kmChanged) Object.assign(s, { distanceKm: km, durationMin: null, distanceSource: km == null ? null : 'manual', distanceFrom: db.settings.homeAddress });
    saveDb(); toast('Saved'); state.editing = null; render();
  };
  form.querySelector('[data-lookup]').onclick = async (e) => {
    s.address = form.address.value.trim();
    e.target.disabled = true; e.target.textContent = 'Looking up…';
    await updateStadiumDistance(s);
    render();
  };
  const del = form.querySelector('[data-del]');
  if (del) del.onclick = () => { if (confirm('Delete this rink?')) { db.stadiums = db.stadiums.filter((x) => x.id !== s.id); saveDb(); state.editing = null; render(); } };
}

function renderSettings(view) {
  const st = db.settings;
  view.innerHTML = `<form id="setForm" autocomplete="off">
    <label for="playerName">Player name</label><input id="playerName" value="${esc(st.playerName)}">
    <label for="home">Home address</label><input id="home" value="${esc(st.homeAddress)}" placeholder="Street, postcode, city">
    <label for="key">Google Maps API key</label><input id="key" value="${esc(st.mapsKey)}" placeholder="AIza…" autocapitalize="off" spellcheck="false">
    <p class="hint">Needs the Routes API enabled. Restrict the key to this site's address in Google Cloud. The key is stored only on this phone.</p>
    <label class="inline"><input id="roundTrip" type="checkbox" ${st.roundTrip ? 'checked' : ''}> Count driving as round trips</label>
    <button class="btn" type="submit">Save settings</button>
    <button class="btn secondary" type="button" id="recalc">Recalculate all rink distances</button>
  </form>
  <h2>Backup</h2>
  <p class="hint">Data is stored only in this browser. Export regularly (e.g. to iCloud Drive) to keep a backup.</p>
  <button class="btn secondary" id="exportBtn">Export data (JSON)</button>
  <button class="btn secondary" id="importBtn">Import data…</button>
  <input type="file" id="importFile" accept="application/json,.json" hidden>
  <p class="hint">${db.games.length} games · ${db.stadiums.length} rinks</p>`;

  $('#setForm').onsubmit = (e) => {
    e.preventDefault();
    const homeChanged = $('#home').value.trim() !== st.homeAddress;
    Object.assign(st, { playerName: $('#playerName').value.trim(), homeAddress: $('#home').value.trim(), mapsKey: $('#key').value.trim(), roundTrip: $('#roundTrip').checked });
    saveDb();
    toast(homeChanged && db.stadiums.some((s) => s.distanceSource === 'google') ? 'Saved. Home changed: recalculate distances.' : 'Settings saved');
  };
  $('#recalc').onclick = async (e) => {
    const targets = db.stadiums.filter((s) => s.address && s.distanceSource !== 'manual');
    if (!targets.length) { toast('No rinks with an address to look up'); return; }
    e.target.disabled = true;
    let ok = 0;
    for (const [i, s] of targets.entries()) {
      e.target.textContent = `Looking up ${i + 1}/${targets.length}…`;
      if (await updateStadiumDistance(s, { quiet: true })) ok++;
    }
    toast(`Updated ${ok} of ${targets.length} rinks`);
    render();
  };
  $('#exportBtn').onclick = () => {
    const blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `hockey-log-${today()}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $('#importBtn').onclick = () => $('#importFile').click();
  $('#importFile').onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const data = normalizeDb(JSON.parse(await file.text()));
      if (!confirm(`Replace current data with ${data.games.length} games and ${data.stadiums.length} rinks from the file?`)) return;
      db = data; saveDb(); toast('Data imported'); render();
    } catch (err) { alert('Import failed: ' + err.message); }
    finally { e.target.value = ''; }
  };
}

// ---------- boot ----------
document.querySelectorAll('.tabbar button').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
$('#addBtn').onclick = () => setTab('game', 'new');
render();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
