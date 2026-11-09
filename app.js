'use strict';
/* Hockey Log — phone-first PWA. All data lives in localStorage on the device.
 * Schema (version 2):
 *   settings: { playerName, homeAddress, homeLat, homeLng, mapsKey, roundTrip }
 *   stadiums: [{ id, name, address, lat, lng, distanceKm, durationMin, distanceSource: 'google'|'manual'|null, distanceFrom }]
 *   teams:    [{ id, name, logo: dataURL|null }]
 *   days:     [{ id, date 'YYYY-MM-DD', type, competition, stadiumId,
 *                matches: [{ teamId, goals, assists }], notes, createdAt }]
 * A "day" is one game day at one rink (a league game or a whole tournament day with several opponents).
 * Version 1 (one entry per game, with team scores) is migrated on load/import.
 */

const STORAGE_KEY = 'hockeylog.v1';
const SCHEMA_VERSION = 2;
const GAME_TYPES = ['League', 'Tournament / Cup'];
const typeOf = (t) => (GAME_TYPES.includes(t) ? t : t === 'Friendly' ? 'Tournament / Cup' : 'League'); // 'Friendly' was removed: those were friendly cups
const LOGO_PX = 96;

// ---------- storage ----------
function emptyDb() {
  return {
    version: SCHEMA_VERSION,
    settings: { playerName: '', homeAddress: '', homeLat: null, homeLng: null, mapsKey: '', roundTrip: true, syncToken: '' },
    stadiums: [], teams: [], days: [],
    syncState: { seq: 0, hashes: {} },
  };
}
let needsMigrationSave = false;
function loadDb() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyDb();
    const parsed = JSON.parse(raw);
    needsMigrationSave = (parsed.version || 1) < SCHEMA_VERSION;
    return normalizeDb(parsed);
  } catch (e) {
    console.error('Could not load data', e);
    alert('Could not read saved data: ' + e.message);
    return emptyDb();
  }
}
function saveDb({ sync = true } = {}) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
    if (sync) scheduleSync();
    return true;
  } catch (e) {
    alert('Saving failed (' + e.message + '). Phone storage may be full: try smaller logos, and export a backup from Settings.');
    return false;
  }
}

const num = (v) => (v === '' || v === null || v === undefined || isNaN(+v) ? null : +v);
const count = (v) => Math.max(0, Math.floor(num(v) || 0));

/** Convert v1 data (one record per game, opponent as text) to v2 game days. */
function migrateV1(d) {
  const teams = new Map();
  const teamId = (name) => {
    const k = teamKey(name);
    if (!teams.has(k)) teams.set(k, { id: uid(), name: name.trim(), logo: null });
    return teams.get(k).id;
  };
  const days = new Map();
  for (const g of d.games || []) {
    if (!g || !/^\d{4}-\d{2}-\d{2}$/.test(g.date)) continue;
    const key = [g.date, g.stadiumId || '', g.type || '', g.competition || ''].join('|');
    if (!days.has(key)) {
      days.set(key, { id: uid(), date: g.date, type: g.type, competition: g.competition || '', stadiumId: g.stadiumId || null, matches: [], notes: '', createdAt: g.createdAt });
    }
    const day = days.get(key);
    day.matches.push({ teamId: g.opponent && g.opponent.trim() ? teamId(g.opponent) : null, goals: g.goals, assists: g.assists });
    if (g.notes) day.notes = day.notes ? day.notes + '\n' + g.notes : g.notes;
  }
  return { ...d, version: 2, teams: [...teams.values()], days: [...days.values()] };
}

/** Validate and fill defaults; throws on data that is not a Hockey Log export. */
function normalizeDb(d) {
  if (!d || typeof d !== 'object' || !Array.isArray(d.stadiums)) throw new Error('Not a Hockey Log data file');
  if (d.version > SCHEMA_VERSION) throw new Error('File was made by a newer app version');
  if (!d.version || d.version < 2) {
    if (!Array.isArray(d.games)) throw new Error('Not a Hockey Log data file');
    d = migrateV1(d);
  }
  if (!Array.isArray(d.days) || !Array.isArray(d.teams)) throw new Error('Not a Hockey Log data file');
  const base = emptyDb();
  const teams = d.teams.filter((t) => t && t.id && t.name).map((t) => ({
    id: String(t.id), name: String(t.name).trim(),
    logo: typeof t.logo === 'string' && t.logo.startsWith('data:image/') ? t.logo : null,
  }));
  const teamIds = new Set(teams.map((t) => t.id));
  return {
    version: SCHEMA_VERSION,
    settings: { ...base.settings, ...(d.settings || {}) },
    syncState: d.syncState && typeof d.syncState.hashes === 'object' ? { seq: +d.syncState.seq || 0, hashes: { ...d.syncState.hashes } } : base.syncState,
    stadiums: d.stadiums.filter((s) => s && s.id && s.name).map((s) => ({
      id: String(s.id), name: String(s.name), address: String(s.address || ''),
      lat: num(s.lat), lng: num(s.lng),
      distanceKm: num(s.distanceKm), durationMin: num(s.durationMin),
      distanceSource: s.distanceSource || null, distanceFrom: s.distanceFrom || null,
    })),
    teams,
    days: d.days.filter((x) => x && x.id && /^\d{4}-\d{2}-\d{2}$/.test(x.date)).map((x) => ({
      id: String(x.id), date: x.date, type: typeOf(x.type),
      competition: String(x.competition || ''), stadiumId: x.stadiumId ? String(x.stadiumId) : null,
      matches: (Array.isArray(x.matches) ? x.matches : []).map((m) => ({
        teamId: m && teamIds.has(String(m.teamId)) ? String(m.teamId) : null,
        goals: count(m && m.goals), assists: count(m && m.assists),
      })),
      notes: String(x.notes || ''), createdAt: x.createdAt || new Date().toISOString(),
    })),
  };
}

// ---------- helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
/** German date format: ISO 'YYYY-MM-DD' -> 'DD.MM.YYYY'. */
const deDate = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
/** Parse 'DD.MM.YYYY' (also with / or -, 2-digit year, or no separators like 08112026) -> ISO, or null if invalid. */
function parseDeDate(text) {
  const t = text.trim();
  const m = t.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})$/) || t.match(/^(\d{2})(\d{2})(\d{4})$/);
  if (!m) return null;
  const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
  const iso = `${y}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  const d = new Date(iso + 'T12:00:00');
  return !isNaN(d) && d.toISOString().slice(0, 10) === iso ? iso : null;
}
const fmtDate = (iso) => `${new Date(iso + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short' })}, ${deDate(iso)}`;
const fmtKm = (km) => (km == null ? '–' : km.toLocaleString(undefined, { maximumFractionDigits: km < 100 ? 1 : 0 }) + ' km');
const stadiumById = (id) => db.stadiums.find((s) => s.id === id);
const teamById = (id) => db.teams.find((t) => t.id === id);
const teamKey = (name) => name.trim().toLowerCase().replace(/\s+/g, ' ');
const dayTotals = (d) => d.matches.reduce((a, m) => ({ goals: a.goals + m.goals, assists: a.assists + m.assists }), { goals: 0, assists: 0 });

/** Hockey season runs Aug–Jul, labelled e.g. "2026/27". */
function seasonOf(iso) {
  const y = +iso.slice(0, 4), m = +iso.slice(5, 7);
  const start = m >= 8 ? y : y - 1;
  return `${start}/${String((start + 1) % 100).padStart(2, '0')}`;
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2400);
}
function findOrCreateTeam(name) {
  const k = teamKey(name);
  let t = db.teams.find((x) => teamKey(x.name) === k);
  if (!t) { t = { id: uid(), name: name.trim(), logo: null }; db.teams.push(t); }
  return t;
}
/** Team logo, or a coloured circle with initials when no logo was added. */
function teamBadge(team, size = 28) {
  if (!team) return `<span class="logo" style="width:${size}px;height:${size}px"></span>`;
  if (team.logo) return `<img class="logo" src="${esc(team.logo)}" alt="" width="${size}" height="${size}">`;
  let h = 0; for (const c of team.name) h = (h * 31 + c.charCodeAt(0)) % 360;
  const initials = team.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  return `<span class="logo initials" style="width:${size}px;height:${size}px;background:hsl(${h} 55% 42%);font-size:${Math.round(size * 0.38)}px">${esc(initials)}</span>`;
}
/** Read an image file, scale it to fit LOGO_PX square, return a PNG data URL. */
function imageFileToLogo(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = c.height = LOGO_PX;
      const s = Math.min(LOGO_PX / img.width, LOGO_PX / img.height);
      const w = img.width * s, h = img.height * s;
      c.getContext('2d').drawImage(img, (LOGO_PX - w) / 2, (LOGO_PX - h) / 2, w, h);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read this image')); };
    img.src = url;
  });
}

let db = loadDb();
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

// ---------- Google distance ----------
/** Driving distance + endpoint coordinates via Google Routes API (computeRoutes). */
async function fetchDrivingRoute(fromAddress, toAddress, apiKey) {
  const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.legs.startLocation,routes.legs.endLocation',
    },
    body: JSON.stringify({ origin: { address: fromAddress }, destination: { address: toAddress }, travelMode: 'DRIVE' }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error?.message || `HTTP ${res.status}`);
  const route = body.routes?.[0];
  if (!route || route.distanceMeters == null) throw new Error('No driving route found for this address');
  const leg = route.legs?.[0] || {};
  const ll = (loc) => (loc?.latLng ? { lat: loc.latLng.latitude, lng: loc.latLng.longitude } : null);
  return {
    km: route.distanceMeters / 1000,
    minutes: route.duration ? Math.round(parseInt(route.duration, 10) / 60) : null,
    from: ll(leg.startLocation), to: ll(leg.endLocation),
  };
}
async function updateStadiumDistance(stadium, { quiet = false } = {}) {
  const { homeAddress, mapsKey } = db.settings;
  const viaServer = sync.enabled && sync.routes;
  if (!homeAddress || (!mapsKey && !viaServer) || !stadium.address) {
    if (!quiet) toast(viaServer ? 'Set your home address in Settings first' : 'Set home address and Maps key in Settings first');
    return false;
  }
  try {
    const r = viaServer
      ? await api('api/route', { method: 'POST', body: { from: homeAddress, to: stadium.address } })
      : await fetchDrivingRoute(homeAddress, stadium.address, mapsKey);
    Object.assign(stadium, { distanceKm: Math.round(r.km * 10) / 10, durationMin: r.minutes, distanceSource: 'google', distanceFrom: homeAddress });
    if (r.to) Object.assign(stadium, r.to);
    if (r.from) { db.settings.homeLat = r.from.lat; db.settings.homeLng = r.from.lng; }
    saveDb();
    if (!quiet) toast(`${stadium.name}: ${fmtKm(stadium.distanceKm)}`);
    return true;
  } catch (e) {
    toast(`Distance lookup failed: ${e.message}`);
    return false;
  }
}

// ---------- stats ----------
function computeStats(days) {
  const dates = new Set(days.map((d) => d.date));
  let goals = 0, assists = 0;
  const opp = new Map(), rinks = new Map(), byType = new Map();
  const trips = new Set();
  for (const d of days) {
    const t = dayTotals(d);
    goals += t.goals; assists += t.assists;
    const b = byType.get(d.type) || { days: new Set(), goals: 0, assists: 0 };
    b.days.add(d.date); b.goals += t.goals; b.assists += t.assists; byType.set(d.type, b);
    for (const m of d.matches) {
      if (!m.teamId) continue;
      const o = opp.get(m.teamId) || { teamId: m.teamId, days: new Set(), goals: 0, assists: 0 };
      o.days.add(d.date); o.goals += m.goals; o.assists += m.assists; opp.set(m.teamId, o);
    }
    if (d.stadiumId) {
      trips.add(`${d.date}|${d.stadiumId}`);
      const r = rinks.get(d.stadiumId) || { id: d.stadiumId, days: new Set() };
      r.days.add(d.date); rinks.set(d.stadiumId, r);
    }
  }
  // One trip = one game day at one rink.
  const factor = db.settings.roundTrip ? 2 : 1;
  let km = 0, missing = 0;
  for (const key of trips) {
    const s = stadiumById(key.split('|')[1]);
    if (s && s.distanceKm != null) km += s.distanceKm * factor; else missing++;
  }
  return {
    days: dates.size, goals, assists, points: goals + assists,
    opponents: [...opp.values()].sort((a, b) => (b.goals + b.assists) - (a.goals + a.assists) || b.days.size - a.days.size),
    rinks: [...rinks.values()].sort((a, b) => b.days.size - a.days.size),
    trips: trips.size, km, missing, byType,
  };
}

// ---------- map ----------
let leafletMap = null;
/** Points of a quadratic Bézier curve from a to b, bowed sideways by `bend` of its length. */
function curvePoints(a, b, bend = 0.22, steps = 32) {
  const k = Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180); // keep the bow symmetric on screen
  const dx = (b.lng - a.lng) * k, dy = b.lat - a.lat;
  const c = { x: a.lng * k + dx / 2 - dy * bend, y: a.lat + dy / 2 + dx * bend };
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, u = 1 - t;
    const x = u * u * a.lng * k + 2 * u * t * c.x + t * t * b.lng * k;
    const y = u * u * a.lat + 2 * u * t * c.y + t * t * b.lat;
    pts.push([y, x / k]);
  }
  return pts;
}
function renderMap(el, rinkStats) {
  if (leafletMap) { leafletMap.remove(); leafletMap = null; }
  if (typeof L === 'undefined') { el.innerHTML = '<p class="hint">Map could not load.</p>'; return; }
  const st = db.settings;
  const home = st.homeLat != null ? { lat: st.homeLat, lng: st.homeLng } : null;
  const placed = rinkStats.map((r) => ({ r, s: stadiumById(r.id) })).filter((x) => x.s && x.s.lat != null);
  if (!placed.length) {
    el.outerHTML = '<p class="hint">Rinks appear on the map after their distance is looked up with Google Maps (Rinks tab).</p>';
    return;
  }
  leafletMap = L.map(el, { zoomControl: true, attributionControl: true, scrollWheelZoom: false });
  const layers = {
    Standard: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }),
    Light: L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      maxZoom: 19, subdomains: 'abcd', attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    }),
    Satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19, attribution: 'Imagery &copy; Esri',
    }),
  };
  let chosen = 'Standard';
  try { if (layers[localStorage.getItem('hockeylog.mapLayer')]) chosen = localStorage.getItem('hockeylog.mapLayer'); } catch { /* per-device preference only */ }
  layers[chosen].addTo(leafletMap);
  L.control.layers(layers, null, { position: 'topright' }).addTo(leafletMap);
  leafletMap.on('baselayerchange', (e) => { try { localStorage.setItem('hockeylog.mapLayer', e.name); } catch { /* ignore */ } });
  const bounds = [];
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#0b3d91';
  if (home) {
    L.marker([home.lat, home.lng], { icon: L.divIcon({ className: 'pin home-pin', html: '🏠', iconSize: [30, 30] }) }).addTo(leafletMap).bindPopup('Home');
    bounds.push([home.lat, home.lng]);
  }
  const maxDays = Math.max(...placed.map((x) => x.r.days.size));
  for (const { r, s } of placed) {
    const size = 26 + Math.round(14 * (r.days.size / maxDays));
    L.marker([s.lat, s.lng], { icon: L.divIcon({ className: 'pin rink-pin', html: `<span>${r.days.size}</span>`, iconSize: [size, size] }) })
      .addTo(leafletMap)
      .bindPopup(`<b>${esc(s.name)}</b><br>${r.days.size} game day${r.days.size > 1 ? 's' : ''} · ${fmtKm(s.distanceKm)}`);
    bounds.push([s.lat, s.lng]);
    if (!home) continue;
    const pts = curvePoints(home, s);
    L.polyline(pts, { color: accent, weight: 3, opacity: 0.85 }).addTo(leafletMap);
    // Arrowhead near the end, rotated along the curve's direction on screen.
    const i = Math.round(pts.length * 0.86), p = pts[i], q = pts[i - 1];
    const k = Math.cos(p[0] * Math.PI / 180);
    const angle = Math.atan2(-(p[0] - q[0]), (p[1] - q[1]) * k) * 180 / Math.PI;
    L.marker(p, { interactive: false, icon: L.divIcon({ className: 'arrowhead', html: `<span style="transform:rotate(${angle}deg);color:${accent}">➤</span>`, iconSize: [18, 18] }) }).addTo(leafletMap);
    if (s.distanceKm != null) {
      L.marker(pts[Math.floor(pts.length / 2)], { interactive: false, icon: L.divIcon({ className: 'km-label', html: `<span>${esc(fmtKm(s.distanceKm))}</span>`, iconSize: null }) }).addTo(leafletMap);
    }
  }
  if (bounds.length === 1) leafletMap.setView(bounds[0], 12);
  else leafletMap.fitBounds(bounds, { padding: [36, 36] });
}

// ---------- views ----------
const state = { tab: 'games', editing: null, filterSeason: 'all', filterType: 'all' };

function setTab(tab, editing = null) {
  state.tab = tab; state.editing = editing;
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab || (tab === 'day' && b.dataset.tab === 'games')));
  render();
  window.scrollTo(0, 0);
}

function render() {
  const titles = { games: 'Game days', day: state.editing === 'new' ? 'New game day' : 'Edit game day', stats: 'Stats', teams: 'Teams', stadiums: 'Rinks', settings: 'Settings' };
  $('#title').textContent = titles[state.tab];
  $('#addBtn').hidden = state.tab !== 'games';
  if (leafletMap && state.tab !== 'stats') { leafletMap.remove(); leafletMap = null; }
  ({ games: renderDays, day: renderDayForm, stats: renderStats, teams: renderTeams, stadiums: renderStadiums, settings: renderSettings })[state.tab]($('#view'));
}

function filterControls() {
  const seasons = [...new Set(db.days.map((d) => seasonOf(d.date)))].sort().reverse();
  return `<div class="filters">
    <select id="fSeason"><option value="all">All seasons</option>${seasons.map((s) => `<option ${s === state.filterSeason ? 'selected' : ''}>${s}</option>`).join('')}</select>
    <select id="fType"><option value="all">All types</option>${GAME_TYPES.map((t) => `<option ${t === state.filterType ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
  </div>`;
}
function bindFilters() {
  $('#fSeason').onchange = (e) => { state.filterSeason = e.target.value; render(); };
  $('#fType').onchange = (e) => { state.filterType = e.target.value; render(); };
}
function filteredDays() {
  return db.days.filter((d) => (state.filterSeason === 'all' || seasonOf(d.date) === state.filterSeason) && (state.filterType === 'all' || d.type === state.filterType));
}

function renderDays(view) {
  if (!db.days.length) {
    view.innerHTML = `<div class="empty">No game days yet.<br>Tap ＋ to add the first one.${db.settings.homeAddress ? '' : '<br><br>Tip: set your home address in Settings so driving distances can be calculated.'}</div>`;
    return;
  }
  const days = filteredDays().sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  let html = filterControls();
  for (const d of days) {
    const s = stadiumById(d.stadiumId), t = dayTotals(d);
    const teams = d.matches.map((m) => teamById(m.teamId)).filter(Boolean);
    html += `<div class="day-head">${esc(fmtDate(d.date))}</div>
    <div class="card game" data-id="${esc(d.id)}">
      <div class="main">
        <div class="meta"><span class="badge">${esc(d.type)}</span>${esc(d.competition)}${d.competition && s ? ' · ' : ''}${esc(s ? s.name : '')}</div>
        <div class="opps">${teams.map((tm) => `<span class="opp-chip">${teamBadge(tm, 20)}${esc(tm.name)}</span>`).join('') || '<span class="hint">no opponent</span>'}</div>
      </div>
      <div class="right"><div class="score">${t.goals} G</div><div class="pts">${t.assists} A</div></div>
    </div>`;
  }
  if (!days.length) html += '<div class="empty">No game days match these filters.</div>';
  view.innerHTML = html;
  bindFilters();
  view.querySelectorAll('.game').forEach((el) => (el.onclick = () => setTab('day', el.dataset.id)));
}

function stepper(cls, value) {
  return `<div class="stepper"><button type="button" data-d="-1">−</button><input class="${cls}" type="number" inputmode="numeric" min="0" value="${value}"><button type="button" data-d="1">＋</button></div>`;
}
function matchRow(m = { teamId: null, goals: 0, assists: 0 }) {
  const t = teamById(m.teamId);
  return `<div class="match-row card">
    <div class="inline"><input class="m-team" list="teamList" placeholder="Opponent team" value="${esc(t ? t.name : '')}"><button type="button" class="remove" aria-label="Remove opponent">✕</button></div>
    <div class="row">
      <div><label>Goals</label>${stepper('m-goals', m.goals)}</div>
      <div><label>Assists</label>${stepper('m-assists', m.assists)}</div>
    </div>
  </div>`;
}

function renderDayForm(view) {
  const isNew = state.editing === 'new';
  const last = [...db.days].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const d = isNew
    ? { date: today(), type: last?.type || 'League', competition: '', stadiumId: '', matches: [{ teamId: null, goals: 0, assists: 0 }], notes: '' }
    : db.days.find((x) => x.id === state.editing);
  if (!d) return setTab('games');
  const stadiums = [...db.stadiums].sort((a, b) => a.name.localeCompare(b.name));
  const comps = [...new Set(db.days.map((x) => x.competition).filter(Boolean))].sort();
  view.innerHTML = `<form id="dayForm" autocomplete="off">
    <div class="row">
      <div><label for="date">Date</label><div class="inline date-field"><input id="date" inputmode="numeric" required placeholder="DD.MM.YYYY" value="${esc(deDate(d.date))}"><button type="button" id="datePick" aria-label="Pick date">📅</button><input id="datePicker" type="date" tabindex="-1" aria-hidden="true" value="${esc(d.date)}"></div></div>
      <div><label for="type">Type</label><select id="type">${GAME_TYPES.map((t) => `<option ${t === d.type ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div>
    </div>
    <label for="competition">League / tournament name</label>
    <input id="competition" list="compList" value="${esc(d.competition)}" placeholder="e.g. U11 Regional League">
    <datalist id="compList">${comps.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
    <label for="stadium">Rink</label>
    <select id="stadium"><option value="">— choose —</option>${stadiums.map((s) => `<option value="${esc(s.id)}" ${s.id === d.stadiumId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}<option value="__new">＋ New rink…</option></select>
    <div id="newRink" hidden>
      <label for="rinkName">Rink name</label><input id="rinkName" placeholder="e.g. Eissporthalle Frankfurt">
      <label for="rinkAddr">Address (for Google Maps)</label><input id="rinkAddr" placeholder="Street, city">
    </div>
    <h2>Opponents</h2>
    <datalist id="teamList">${[...db.teams].sort((a, b) => a.name.localeCompare(b.name)).map((t) => `<option value="${esc(t.name)}">`).join('')}</datalist>
    <div id="matches">${(d.matches.length ? d.matches : [{ teamId: null, goals: 0, assists: 0 }]).map(matchRow).join('')}</div>
    <button class="btn secondary" type="button" id="addMatch">＋ Add opponent</button>
    <p class="hint" id="dayTotal"></p>
    <label for="notes">Notes</label><textarea id="notes">${esc(d.notes)}</textarea>
    <button class="btn" type="submit">Save</button>
    ${isNew ? '' : '<button class="btn danger" type="button" id="delBtn">Delete game day</button>'}
    <button class="btn secondary" type="button" id="cancelBtn">Cancel</button>
  </form>`;

  const form = $('#dayForm');
  const updateTotal = () => {
    let g = 0, a = 0;
    form.querySelectorAll('.match-row').forEach((r) => { g += count(r.querySelector('.m-goals').value); a += count(r.querySelector('.m-assists').value); });
    $('#dayTotal').textContent = `Day total: ${g} goals · ${a} assists`;
  };
  form.addEventListener('click', (e) => {
    const step = e.target.closest('[data-d]');
    if (step) { const inp = step.parentElement.querySelector('input'); inp.value = Math.max(0, count(inp.value) + +step.dataset.d); updateTotal(); }
    const rm = e.target.closest('.remove');
    if (rm) { rm.closest('.match-row').remove(); updateTotal(); }
  });
  form.addEventListener('input', updateTotal);
  $('#addMatch').onclick = () => {
    $('#matches').insertAdjacentHTML('beforeend', matchRow());
    $('#matches').lastElementChild.querySelector('.m-team').focus();
  };
  updateTotal();
  $('#stadium').onchange = (e) => { $('#newRink').hidden = e.target.value !== '__new'; };
  // Typed field shows DD.MM.YYYY; the hidden native picker offers a calendar.
  $('#datePick').onclick = () => {
    const iso = parseDeDate($('#date').value); if (iso) $('#datePicker').value = iso;
    try { $('#datePicker').showPicker(); } catch { $('#datePicker').focus(); $('#datePicker').click(); }
  };
  $('#datePicker').onchange = (e) => { if (e.target.value) $('#date').value = deDate(e.target.value); };
  $('#date').onblur = (e) => { const iso = parseDeDate(e.target.value); if (iso) e.target.value = deDate(iso); };
  $('#cancelBtn').onclick = () => setTab('games');
  if (!isNew) $('#delBtn').onclick = () => {
    if (!confirm('Delete this game day?')) return;
    db.days = db.days.filter((x) => x.id !== d.id); saveDb(); toast('Game day deleted'); setTab('games');
  };

  form.onsubmit = (e) => {
    e.preventDefault();
    const dateIso = parseDeDate($('#date').value);
    if (!dateIso) { toast('Enter the date as DD.MM.YYYY'); $('#date').focus(); return; }
    const rows = [...form.querySelectorAll('.match-row')].map((r) => ({
      name: r.querySelector('.m-team').value.trim(), goals: count(r.querySelector('.m-goals').value), assists: count(r.querySelector('.m-assists').value),
    }));
    if (rows.some((r) => !r.name && (r.goals || r.assists))) { toast('Enter the opponent for each row with points'); return; }
    let stadiumId = $('#stadium').value || null, newStadium = null;
    if (stadiumId === '__new') {
      const name = $('#rinkName').value.trim();
      if (!name) { toast('Enter a rink name'); return; }
      newStadium = { id: uid(), name, address: $('#rinkAddr').value.trim(), lat: null, lng: null, distanceKm: null, durationMin: null, distanceSource: null, distanceFrom: null };
      db.stadiums.push(newStadium); stadiumId = newStadium.id;
    }
    const data = {
      date: dateIso, type: $('#type').value, competition: $('#competition').value.trim(), stadiumId,
      matches: rows.filter((r) => r.name).map((r) => ({ teamId: findOrCreateTeam(r.name).id, goals: r.goals, assists: r.assists })),
      notes: $('#notes').value.trim(),
    };
    if (isNew) db.days.push({ id: uid(), createdAt: new Date().toISOString(), ...data });
    else Object.assign(d, data);
    saveDb();
    toast('Saved');
    if (newStadium && newStadium.address) updateStadiumDistance(newStadium, { quiet: true });
    setTab('games');
  };
}

function renderStats(view) {
  if (!db.days.length) { view.innerHTML = '<div class="empty">Stats appear once you have added game days.</div>'; return; }
  const s = computeStats(filteredDays());
  const kpi = (v, l) => `<div class="kpi"><b>${v}</b><small>${l}</small></div>`;
  let html = filterControls() + '<div style="height:10px"></div><div class="kpis four">' +
    kpi(s.days, 'game days') + kpi(s.goals, 'goals') + kpi(s.assists, 'assists') + kpi(s.points, 'points') + '</div>';

  html += `<h2>Driving</h2><div class="card">
    <div class="kpis" style="margin:0">${kpi(fmtKm(s.km), db.settings.roundTrip ? 'round trips' : 'one way')}${kpi(s.trips, 'trips')}${kpi(s.trips - s.missing ? fmtKm(s.km / (s.trips - s.missing)) : '–', 'per trip')}</div>
    ${s.missing ? `<p class="hint">${s.missing} trip(s) have no distance yet: check the Rinks tab.</p>` : ''}
    <div id="map"></div>
  </div>`;

  if (s.byType.size > 1) {
    html += '<h2>By type</h2><div class="card"><table><tr><th>Type</th><th>Days</th><th>G</th><th>A</th></tr>' +
      [...s.byType].map(([t, b]) => `<tr><td>${esc(t)}</td><td>${b.days.size}</td><td>${b.goals}</td><td>${b.assists}</td></tr>`).join('') + '</table></div>';
  }

  html += '<h2>Opponents</h2><div class="card"><table><tr><th>Team</th><th>Days</th><th>G</th><th>A</th></tr>' +
    s.opponents.map((o) => { const t = teamById(o.teamId); return `<tr><td><span class="team-cell">${teamBadge(t, 28)}${esc(t ? t.name : '?')}</span></td><td>${o.days.size}</td><td>${o.goals}</td><td>${o.assists}</td></tr>`; }).join('') + '</table>' +
    '<p class="hint">Add team logos in the Teams tab.</p></div>';

  html += '<h2>Rinks</h2><div class="card"><table><tr><th>Rink</th><th>Days</th><th>Distance</th></tr>' +
    s.rinks.map((r) => { const st = stadiumById(r.id); return `<tr><td>${esc(st ? st.name : '?')}</td><td>${r.days.size}</td><td>${fmtKm(st?.distanceKm)}</td></tr>`; }).join('') + '</table></div>';

  view.innerHTML = html;
  bindFilters();
  renderMap($('#map'), s.rinks);
}

function renderTeams(view) {
  const used = new Map();
  for (const d of db.days) for (const m of d.matches) if (m.teamId) { if (!used.has(m.teamId)) used.set(m.teamId, new Set()); used.get(m.teamId).add(d.date); }
  const list = [...db.teams].sort((a, b) => a.name.localeCompare(b.name));
  let html = '<p class="hint">Tap a team to add its logo (a screenshot or photo works) or fix its name. Renaming a team to an existing name merges the two.</p>';
  if (!list.length) html += '<div class="empty">Teams are added when you enter a game day.</div>';
  for (const t of list) {
    const open = state.editing === t.id;
    html += `<div class="card"><div class="game" data-id="${esc(t.id)}"><div class="main team-cell">${teamBadge(t, 40)}<b>${esc(t.name)}</b></div>
      <div class="right"><div class="pts">${used.get(t.id)?.size || 0} days</div></div></div>
      ${open ? `<form class="teamForm" data-id="${esc(t.id)}">
        <label>Name</label><input name="name" required value="${esc(t.name)}">
        <label>Logo</label><input name="logo" type="file" accept="image/*">
        <button class="btn" type="submit">Save</button>
        ${t.logo ? '<button class="btn secondary" type="button" data-nologo>Remove logo</button>' : ''}
        ${used.has(t.id) ? '' : '<button class="btn danger" type="button" data-del>Delete team</button>'}
      </form>` : ''}</div>`;
  }
  view.innerHTML = html;
  view.querySelectorAll('.game').forEach((el) => (el.onclick = () => { state.editing = state.editing === el.dataset.id ? null : el.dataset.id; render(); }));
  const form = view.querySelector('.teamForm');
  if (!form) return;
  const t = teamById(form.dataset.id);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const file = form.logo.files[0];
    if (file) {
      try { t.logo = await imageFileToLogo(file); } catch (err) { toast(err.message); return; }
    }
    const name = form.name.value.trim();
    const other = db.teams.find((x) => x.id !== t.id && teamKey(x.name) === teamKey(name));
    if (other) {
      if (!confirm(`Merge "${t.name}" into "${other.name}"?`)) return;
      for (const d of db.days) for (const m of d.matches) if (m.teamId === t.id) m.teamId = other.id;
      if (!other.logo) other.logo = t.logo;
      db.teams = db.teams.filter((x) => x.id !== t.id);
    } else t.name = name;
    if (saveDb()) toast('Saved');
    state.editing = null; render();
  };
  const nologo = form.querySelector('[data-nologo]');
  if (nologo) nologo.onclick = () => { t.logo = null; saveDb(); render(); };
  const del = form.querySelector('[data-del]');
  if (del) del.onclick = () => { if (confirm('Delete this team?')) { db.teams = db.teams.filter((x) => x.id !== t.id); saveDb(); state.editing = null; render(); } };
}

function renderStadiums(view) {
  const used = new Map();
  for (const d of db.days) if (d.stadiumId) used.set(d.stadiumId, (used.get(d.stadiumId) || 0) + 1);
  const list = [...db.stadiums].sort((a, b) => a.name.localeCompare(b.name));
  let html = '<p class="hint">Distances are one way from home. Tap a rink to edit, set the distance by hand, or look it up again (needed for the map).</p>';
  if (!list.length) html += '<div class="empty">Rinks are added when you enter a game day.</div>';
  for (const s of list) {
    const open = state.editing === s.id;
    html += `<div class="card"><div class="game" data-id="${esc(s.id)}"><div class="main"><div class="opp">${esc(s.name)}</div><div class="meta">${esc(s.address || 'no address')}${s.lat == null ? ' · not on map' : ''}</div></div>
      <div class="right"><div class="score">${fmtKm(s.distanceKm)}</div><div class="pts">${s.durationMin ? s.durationMin + ' min · ' : ''}${used.get(s.id) || 0} days</div></div></div>
      ${open ? `<form class="rinkForm" data-id="${esc(s.id)}">
        <label>Name</label><input name="name" required value="${esc(s.name)}">
        <label>Address</label><input name="address" value="${esc(s.address)}">
        <label>One-way distance (km)</label><input name="km" type="number" step="0.1" min="0" inputmode="decimal" value="${s.distanceKm ?? ''}">
        <button class="btn" type="submit">Save</button>
        <button class="btn secondary" type="button" data-lookup>Look up with Google Maps</button>
        ${used.get(s.id) ? '' : '<button class="btn danger" type="button" data-del>Delete rink</button>'}
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
    if (addr !== s.address) Object.assign(s, { lat: null, lng: null });
    Object.assign(s, { name: form.name.value.trim(), address: addr });
    if (km !== s.distanceKm) Object.assign(s, { distanceKm: km, durationMin: null, distanceSource: km == null ? null : 'manual', distanceFrom: db.settings.homeAddress });
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
    ${sync.enabled && sync.routes ? '<p class="hint">Distances are looked up by your home server; no Maps key needed on this device.</p><input id="key" type="hidden" value="' + esc(st.mapsKey) + '">' : `
    <label for="key">Google Maps API key</label><input id="key" value="${esc(st.mapsKey)}" placeholder="AIza…" autocapitalize="off" spellcheck="false">
    <p class="hint">Needs the Routes API enabled. Restrict the key to this site's address in Google Cloud. The key is stored only on this device.</p>`}
    <label class="inline"><input id="roundTrip" type="checkbox" ${st.roundTrip ? 'checked' : ''}> Count driving as round trips</label>
    <button class="btn" type="submit">Save settings</button>
    <button class="btn secondary" type="button" id="recalc">Recalculate all rink distances</button>
  </form>
  ${sync.enabled ? `<h2>Sync</h2><div class="card"><p class="hint" id="syncInfo">${esc(syncStatusText())}</p>
    ${sync.auth ? `<label for="token">Sync password</label><input id="token" type="text" value="" placeholder="${st.syncToken && !sync.lastError ? '✓ saved – paste a new one to replace' : 'paste the sync password'}" autocapitalize="off" autocorrect="off" spellcheck="false" class="mono">
    <p class="hint">The password stays hidden once saved. Forgot it? Send <b>hockey sync key</b> to your Telegram bot.</p>` : ''}
    <button class="btn secondary" type="button" id="syncNow">Sync now</button></div>` : ''}
  <h2>Backup</h2>
  <p class="hint">${sync.enabled ? 'Data is stored on this device and synced to your home server.' : 'Data is stored only in this browser. Export regularly (e.g. to iCloud Drive) to keep a backup.'}</p>
  <button class="btn secondary" id="exportBtn">Export data (JSON)</button>
  <button class="btn secondary" id="importBtn">Import data…</button>
  <input type="file" id="importFile" accept="application/json,.json" hidden>
  <p class="hint">${db.days.length} game days · ${db.teams.length} teams · ${db.stadiums.length} rinks</p>`;

  $('#setForm').onsubmit = (e) => {
    e.preventDefault();
    const home = $('#home').value.trim();
    const homeChanged = home !== st.homeAddress;
    Object.assign(st, { playerName: $('#playerName').value.trim(), homeAddress: home, mapsKey: $('#key').value.trim(), roundTrip: $('#roundTrip').checked });
    if ($('#token') && $('#token').value.trim()) st.syncToken = $('#token').value.trim();
    if (homeChanged) Object.assign(st, { homeLat: null, homeLng: null });
    saveDb();
    toast(homeChanged && db.stadiums.some((s) => s.distanceSource === 'google') ? 'Saved. Home changed: recalculate distances.' : 'Settings saved');
  };
  // An empty field means "keep the saved password"; only a pasted value replaces it.
  const saveToken = () => { const t = $('#token'); if (t && t.value.trim() && t.value.trim() !== st.syncToken) { st.syncToken = t.value.trim(); saveDb({ sync: false }); } };
  if ($('#token')) $('#token').onchange = saveToken;
  if ($('#syncNow')) $('#syncNow').onclick = async () => { saveToken(); await doSync(); toast(sync.lastError ? 'Sync failed: ' + sync.lastError : 'Synced'); render(); };
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
    const { syncState, ...rest } = db; // eslint-disable-line no-unused-vars
    const { syncToken, ...settings } = db.settings; // eslint-disable-line no-unused-vars
    const blob = new Blob([JSON.stringify({ ...rest, settings }, null, 2)], { type: 'application/json' });
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
      if (!confirm(`Replace current data with ${data.days.length} game days, ${data.teams.length} teams and ${data.stadiums.length} rinks from the file?`)) return;
      data.syncState = { seq: 0, hashes: {} }; // everything counts as new and is pushed to the server
      data.settings.syncToken = db.settings.syncToken; // the password belongs to this device, not to the file
      if (!data.settings.mapsKey) data.settings.mapsKey = db.settings.mapsKey;
      db = data; saveDb(); toast('Data imported'); render();
    } catch (err) { alert('Import failed: ' + err.message); }
    finally { e.target.value = ''; }
  };
}


// ---------- sync with home server ----------
/* Offline-first: the device copy is the source of truth for the UI. When the page is served by the
 * Hockey Log server (it answers api/health), changed records are pushed and other devices' changes
 * pulled. Change detection compares each record's hash with its hash at the last sync, so no edit
 * site has to remember to flag changes. Conflicts: last write wins per record (server side). */
const sync = { enabled: false, routes: false, auth: false, running: false, again: false, lastOk: null, lastError: null, timer: null };

function hashStr(str) { // cyrb53: fast 53-bit string hash, plenty for change detection
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
/** Settings shared across devices (the Maps key and sync password stay on each device). */
function sharedSettings() {
  const { mapsKey, syncToken, ...shared } = db.settings; // eslint-disable-line no-unused-vars
  return shared;
}
function localRecords() {
  const m = new Map();
  for (const x of db.days) m.set('day:' + x.id, { kind: 'day', id: x.id, data: x });
  for (const x of db.teams) m.set('team:' + x.id, { kind: 'team', id: x.id, data: x });
  for (const x of db.stadiums) m.set('stadium:' + x.id, { kind: 'stadium', id: x.id, data: x });
  m.set('settings:main', { kind: 'settings', id: 'main', data: sharedSettings() });
  return m;
}
const recHash = (r) => (r ? hashStr(JSON.stringify(r.data)) : null);

async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (db.settings.syncToken) headers.Authorization = 'Bearer ' + db.settings.syncToken;
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(res.status === 401 ? 'wrong or missing sync password (Settings)' : data.error || `HTTP ${res.status}`);
  return data;
}

function applyRemote(rec) {
  const lists = { day: 'days', team: 'teams', stadium: 'stadiums' };
  if (rec.kind === 'settings') {
    if (!rec.deleted && rec.data) Object.assign(db.settings, rec.data, { mapsKey: db.settings.mapsKey, syncToken: db.settings.syncToken });
    return;
  }
  const key = lists[rec.kind]; if (!key) return;
  const i = db[key].findIndex((x) => x.id === rec.id);
  if (rec.deleted) { if (i >= 0) db[key].splice(i, 1); }
  else if (i >= 0) db[key][i] = rec.data;
  else db[key].push(rec.data);
}

/** First sync of a device: take the server's shared settings, but keep local values where the server has none. */
function mergeSettings(remote) {
  for (const [key, value] of Object.entries(remote || {})) {
    if (value !== '' && value !== null && value !== undefined) db.settings[key] = value;
  }
}

async function doSync() {
  if (!sync.enabled) return;
  if (sync.running) { sync.again = true; return; }
  if (sync.auth && !db.settings.syncToken) { sync.lastError = 'enter the sync password in Settings'; updateSyncDot(); return; }
  sync.running = true;
  try {
    // 1. Pull first, so a device that has never synced cannot overwrite the server with its empty data.
    const res = await api('api/changes?since=' + db.syncState.seq);
    const applied = [];
    let settingsMergedFrom = null;
    for (const rec of res.records) {
      const k = rec.kind + ':' + rec.id;
      const synced = db.syncState.hashes[k];
      const localHash = recHash(localRecords().get(k));
      const remoteHash = rec.deleted ? null : hashStr(JSON.stringify(rec.data));
      if (localHash === remoteHash) { // already identical (e.g. the echo of our own push)
        if (remoteHash) db.syncState.hashes[k] = remoteHash; else delete db.syncState.hashes[k];
        continue;
      }
      if (synced !== undefined && localHash !== synced) continue; // edited here since last sync: our version is pushed below
      if (k === 'settings:main' && synced === undefined && !rec.deleted) { mergeSettings(rec.data); settingsMergedFrom = remoteHash; continue; }
      applyRemote(rec); applied.push(k);
    }
    if (applied.length || settingsMergedFrom) {
      db = normalizeDb(db);
      const after = localRecords();
      for (const k of applied) { const r = after.get(k); if (r) db.syncState.hashes[k] = recHash(r); else delete db.syncState.hashes[k]; }
      // Remember the server's version, so merged-in local values (if any) are pushed next.
      if (settingsMergedFrom) db.syncState.hashes['settings:main'] = settingsMergedFrom;
    }
    db.syncState.seq = res.seq;

    // 2. Push everything that differs from what the server last had.
    const now = new Date().toISOString();
    const local = localRecords(), snap = {}, push = [];
    for (const [k, r] of local) {
      snap[k] = recHash(r);
      if (db.syncState.hashes[k] !== snap[k]) push.push({ ...r, updatedAt: now, deleted: false });
    }
    for (const k of Object.keys(db.syncState.hashes)) {
      if (!local.has(k)) { const [kind, ...rest] = k.split(':'); push.push({ kind, id: rest.join(':'), data: null, updatedAt: now, deleted: true }); }
    }
    if (push.length) {
      await api('api/push', { method: 'POST', body: { records: push } });
      for (const r of push) { const k = r.kind + ':' + r.id; if (r.deleted) delete db.syncState.hashes[k]; else db.syncState.hashes[k] = snap[k]; }
    }
    saveDb({ sync: false });
    sync.lastOk = new Date(); sync.lastError = null;
    if ((applied.length || settingsMergedFrom) && state.tab !== 'day' && !document.querySelector('form:focus-within')) render();
  } catch (e) {
    sync.lastError = e.message;
    console.warn('Sync failed', e);
  } finally {
    sync.running = false;
    updateSyncDot();
    if (sync.again) { sync.again = false; scheduleSync(300); }
  }
}
function scheduleSync(ms = 1500) {
  if (!sync.enabled) return;
  clearTimeout(sync.timer); sync.timer = setTimeout(doSync, ms);
}
function syncStatusText() {
  if (sync.lastError) return 'Last sync failed: ' + sync.lastError;
  if (sync.lastOk) return 'Synced with home server at ' + sync.lastOk.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return 'Connecting to home server…';
}
function updateSyncDot() {
  const dot = $('#syncDot'); if (!dot) return;
  dot.hidden = !sync.enabled;
  dot.className = 'sync-dot ' + (sync.lastError ? (navigator.onLine ? 'err' : 'off') : sync.lastOk ? 'ok' : 'off');
  dot.title = syncStatusText();
  const info = $('#syncInfo'); if (info) info.textContent = syncStatusText();
}
async function initSync() {
  try {
    const res = await fetch('api/health', { cache: 'no-store' });
    const h = res.ok && (res.headers.get('content-type') || '').includes('json') ? await res.json() : null;
    if (!h || !h.ok) return; // static hosting (e.g. GitHub Pages): local-only mode
    Object.assign(sync, { enabled: true, routes: !!h.routes, auth: !!h.auth });
  } catch { return; } // offline at start: try again when the network returns
  updateSyncDot();
  if (state.tab === 'settings') render();
  await doSync();
  setInterval(() => { if (document.visibilityState === 'visible') doSync(); }, 60000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') doSync(); });
}
window.addEventListener('online', () => (sync.enabled ? doSync() : initSync()));

// ---------- boot ----------
// One-time setup link: https://…/#token=<password> stores the sync password, then removes it from the address bar.
function takeTokenFromHash() {
  if (!location.hash.startsWith('#token=')) return;
  db.settings.syncToken = decodeURIComponent(location.hash.slice(7)).trim();
  saveDb({ sync: false });
  history.replaceState(null, '', location.pathname + location.search);
  setTimeout(() => toast('Sync password saved'), 300);
  if (sync.enabled) doSync();
}
takeTokenFromHash();
window.addEventListener('hashchange', takeTokenFromHash);
if (needsMigrationSave) saveDb(); // persist a v1 → v2 migration right away (never overwrite unreadable data)
document.querySelectorAll('.tabbar button').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
$('#addBtn').onclick = () => setTab('day', 'new');
render();
initSync();
if ('serviceWorker' in navigator) {
  // Apply app updates right away: when a new service worker takes over, reload once (not on first install).
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !reloaded && state.tab !== 'day') { reloaded = true; location.reload(); }
  });
  navigator.serviceWorker.register('sw.js').then((reg) => {
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch((e) => console.warn('SW registration failed', e));
}
