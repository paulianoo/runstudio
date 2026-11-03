/* RunStudio — pilotage de tapis de course Bluetooth FTMS (Domyos Run 500 & compatibles) */
'use strict';

/* =========================================================================
   Utilitaires
   ========================================================================= */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const r1 = v => Math.round(v * 10) / 10;
const pad = n => String(n).padStart(2, '0');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function fmtTime(s) {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
  return h ? `${h}:${pad(m)}:${pad(x)}` : `${pad(m)}:${pad(x)}`;
}
function fmtPace(kmh) {
  if (!kmh || kmh < 0.5) return '--:--';
  const t = Math.round(3600 / kmh);
  return `${Math.floor(t / 60)}:${pad(t % 60)}`;
}
function fmtDur(s) { // durée lisible pour la voix / cartes
  s = Math.round(s);
  const m = Math.floor(s / 60), x = s % 60;
  if (m && x) return `${m} min ${x} s`;
  if (m) return `${m} min`;
  return `${x} s`;
}
function parseDur(str) { // "mm:ss", "h:mm:ss" ou minutes
  str = String(str).trim().replace(',', '.');
  if (str.includes(':')) return str.split(':').map(Number).reduce((a, b) => a * 60 + (b || 0), 0);
  const n = parseFloat(str);
  return isNaN(n) ? 60 : Math.round(n * 60);
}
function toList(str) { return String(str).split(/[;, ]+/).map(x => parseFloat(x.replace(',', '.'))).filter(x => !isNaN(x)); }

/* =========================================================================
   Profils : chaque profil a ses propres réglages, programmes, historique et plan
   ========================================================================= */
const raw = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { toast('⚠️ Stockage local plein — exportez une sauvegarde'); } },
};
const SEED_PROFILES = [
  { id: 'paul', name: 'Paul', emoji: '🎾', kind: 'sport',
    settings: { weight: 65, age: 22, height: 175, hrMax: 193, hrRest: 60 } },
  { id: 'maman', name: 'Maman', emoji: '🌸', kind: 'douceur', plan: 'reprise6m',
    settings: { weight: 60, age: 62, height: 160, hrMax: 165, hrRest: 70, accent: '#ec4899', startSpeed: 4.5, walkSpeed: 4,
      speedPresets: [4, 4.5, 5, 5.5, 6, 6.5, 7], inclinePresets: [0, 1, 2, 3, 4, 5],
      heroTile: 'time', tiles: ['remaining', 'speed', 'distance', 'hr', 'incline', 'kcal'] } },
];
let PROFILES = raw.get('rs.profiles', null);
if (!PROFILES) {
  PROFILES = SEED_PROFILES.map(({ settings, plan, ...p }) => p);
  const first = PROFILES[0].id; // les données d'avant les profils reviennent au premier profil
  for (const k of ['settings', 'programs', 'history', 'presetsV', 'progFilter']) {
    const v = localStorage.getItem('rs.' + k);
    if (v != null) { localStorage.setItem(`rs.p_${first}.${k}`, v); localStorage.removeItem('rs.' + k); }
  }
  for (const sp of SEED_PROFILES) {
    raw.set(`rs.p_${sp.id}.settings`, { ...raw.get(`rs.p_${sp.id}.settings`, {}), ...sp.settings });
    if (sp.plan) raw.set(`rs.p_${sp.id}.plan`, { key: sp.plan, cursor: 0, log: [] });
  }
  raw.set('rs.profiles', PROFILES);
  raw.set('rs.activeProfile', first);
}
let PID = raw.get('rs.activeProfile', PROFILES[0].id);
if (!PROFILES.some(p => p.id === PID)) PID = PROFILES[0].id;
const PROFILE = PROFILES.find(p => p.id === PID);
const store = {
  get: (k, d) => raw.get(`rs.p_${PID}.${k}`, d),
  set: (k, v) => raw.set(`rs.p_${PID}.${k}`, v),
};

let toastT;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms);
}

function download(name, content, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* =========================================================================
   Réglages
   ========================================================================= */
const DEFAULTS = {
  weight: 75, age: 35, height: 175, hrMax: 185, hrRest: 60,
  minSpeed: 1, maxSpeed: 16, speedStep: 0.1, startSpeed: 5,
  minIncline: 0, maxIncline: 10, inclineStep: 0.5,
  speedPresets: [6, 8, 10, 12, 14], inclinePresets: [0, 2, 4, 6, 8, 10],
  endAction: 'walk', walkSpeed: 4.5,
  theme: 'dark', accent: '#00d1b2',
  heroTile: 'time', tiles: ['distance', 'speed', 'pace', 'incline', 'hr', 'kcal', 'elev', 'avgPace'],
  chartWindow: 10,
  voice: true, voiceRate: 1.05, beep: true, countdownBeeps: true, splits: true, splitDistance: 1,
  calories: 'calc', wakeLock: true, minSaveSec: 60, startCountdown: 3, intensity: 100,
};
let S = Object.assign({}, DEFAULTS, store.get('settings', {}));
const saveSettings = () => store.set('settings', S);

const SCHEMA = [
  { sec: '👤 Profil', items: [
    { k: 'weight', l: 'Poids', t: 'num', u: 'kg', min: 30, max: 250, step: 0.5, h: 'Utilisé pour le calcul des calories' },
    { k: 'height', l: 'Taille', t: 'num', u: 'cm', min: 100, max: 230, step: 1 },
    { k: 'age', l: 'Âge', t: 'num', u: 'ans', min: 10, max: 99, step: 1 },
    { k: 'hrMax', l: 'FC max', t: 'num', u: 'bpm', min: 120, max: 230, step: 1, h: () => `Zones cardio · estimation pour ${S.age} ans : ${Math.round(208 - 0.7 * S.age)} bpm` },
    { k: '_plan', l: 'Plan d’entraînement', t: 'plan', h: 'Programme suivi séance après séance' },
    { k: 'hrRest', l: 'FC repos', t: 'num', u: 'bpm', min: 30, max: 110, step: 1 },
  ] },
  { sec: '🏃 Tapis', items: [
    { k: 'minSpeed', l: 'Vitesse mini', t: 'num', u: 'km/h', min: 0.5, max: 5, step: 0.1 },
    { k: 'maxSpeed', l: 'Vitesse maxi', t: 'num', u: 'km/h', min: 5, max: 25, step: 0.5, h: 'Run 500 : 16 km/h' },
    { k: 'speedStep', l: 'Pas des boutons ±', t: 'sel', u: 'km/h', o: [[0.1, '0.1'], [0.2, '0.2'], [0.5, '0.5'], [1, '1']] },
    { k: 'startSpeed', l: 'Vitesse au démarrage', t: 'num', u: 'km/h', min: 1, max: 16, step: 0.1, h: 'Séance libre' },
    { k: 'speedPresets', l: 'Vitesses rapides', t: 'list', u: 'km/h', h: 'Boutons raccourcis, séparés par des virgules' },
    { k: 'minIncline', l: 'Inclinaison mini', t: 'num', u: '%', min: -5, max: 0, step: 0.5 },
    { k: 'maxIncline', l: 'Inclinaison maxi', t: 'num', u: '%', min: 0, max: 20, step: 0.5, h: 'Run 500 : 10 %' },
    { k: 'inclineStep', l: 'Pas inclinaison ±', t: 'sel', u: '%', o: [[0.5, '0.5'], [1, '1'], [2, '2']] },
    { k: 'inclinePresets', l: 'Inclinaisons rapides', t: 'list', u: '%' },
  ] },
  { sec: '🎨 Affichage', items: [
    { k: 'theme', l: 'Thème', t: 'sel', o: [['dark', 'Sombre'], ['light', 'Clair'], ['auto', 'Système']] },
    { k: 'accent', l: 'Couleur principale', t: 'color' },
    { k: 'heroTile', l: 'Grande tuile', t: 'sel', o: () => Object.entries(TILES).map(([k, v]) => [k, v.l]) },
    { k: 'tiles', l: 'Tuiles affichées', t: 'tiles', h: 'Cochez et ordonnez vos indicateurs' },
    { k: 'chartWindow', l: 'Fenêtre du graphique', t: 'sel', u: 'min', o: [[5, '5'], [10, '10'], [20, '20'], [30, '30'], [60, '60'], [0, 'Toute la séance']] },
  ] },
  { sec: '🔊 Sons & voix', items: [
    { k: 'voice', l: 'Annonces vocales', t: 'bool', h: 'Changements d’étape, kilomètres…' },
    { k: 'voiceRate', l: 'Débit de la voix', t: 'range', min: 0.7, max: 1.5, step: 0.05 },
    { k: 'beep', l: 'Bips', t: 'bool' },
    { k: 'countdownBeeps', l: 'Bips 3-2-1 avant changement', t: 'bool' },
    { k: 'splits', l: 'Annoncer les temps intermédiaires', t: 'bool' },
    { k: 'splitDistance', l: 'Tous les', t: 'sel', u: 'km', o: [[0.5, '0.5'], [1, '1'], [2, '2'], [5, '5']] },
    { k: '_testVoice', l: 'Tester la voix', t: 'action', a: () => speak('Bonne séance ! Prochaine étape : 2 minutes à 12 kilomètres heure.', true) },
  ] },
  { sec: '⏱️ Séance', items: [
    { k: 'startCountdown', l: 'Compte à rebours', t: 'num', u: 's', min: 0, max: 10, step: 1 },
    { k: 'intensity', l: 'Intensité par défaut des programmes', t: 'num', u: '%', min: 50, max: 150, step: 5, h: 'Multiplie toutes les vitesses d’un programme' },
    { k: 'endAction', l: 'Fin de programme', t: 'sel', o: [['walk', 'Passer en marche'], ['stop', 'Arrêter le tapis'], ['keep', 'Garder la vitesse']] },
    { k: 'walkSpeed', l: 'Vitesse de marche', t: 'num', u: 'km/h', min: 1, max: 8, step: 0.5 },
    { k: 'calories', l: 'Source des calories', t: 'sel', o: [['calc', 'Calcul (ACSM, poids + pente)'], ['machine', 'Valeur du tapis']] },
    { k: 'minSaveSec', l: 'Durée mini pour enregistrer', t: 'num', u: 's', min: 0, max: 600, step: 10 },
    { k: 'wakeLock', l: 'Garder l’écran allumé', t: 'bool' },
  ] },
];

function applyTheme() {
  const root = document.documentElement;
  const theme = S.theme === 'auto' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : S.theme;
  root.dataset.theme = theme;
  root.style.setProperty('--accent', S.accent);
  const c = S.accent.replace('#', '');
  const [r, g, b] = [0, 2, 4].map(i => parseInt(c.substr(i, 2), 16) / 255);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  root.style.setProperty('--accent-ink', lum > 0.5 ? '#0b1410' : '#ffffff');
  $('meta[name=theme-color]').content = theme === 'light' ? '#eef1f5' : '#0b0f14';
}

/* =========================================================================
   Sons & voix
   ========================================================================= */
let actx;
function beep(freq = 880, dur = 0.12, vol = 0.25) {
  if (!S.beep) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const o = actx.createOscillator(), g = actx.createGain();
    o.frequency.value = freq; o.type = 'sine';
    g.gain.setValueAtTime(vol, actx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + dur);
    o.connect(g).connect(actx.destination); o.start(); o.stop(actx.currentTime + dur);
  } catch { /* audio indisponible */ }
}
function speak(text, force) {
  if ((!S.voice && !force) || !('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'fr-FR'; u.rate = S.voiceRate;
  const v = speechSynthesis.getVoices().find(v => v.lang.startsWith('fr'));
  if (v) u.voice = v;
  speechSynthesis.speak(u);
}
const sayKmh = v => `${String(r1(v)).replace('.', ' virgule ')} kilomètres heure`;

/* =========================================================================
   Bluetooth : tapis FTMS, simulateur, ceinture cardio
   ========================================================================= */
class FTMSTreadmill {
  constructor(app) { this.app = app; this.q = Promise.resolve(); this.name = 'Tapis'; this.last = {}; this.kind = 'ftms'; }
  async connect() {
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [0x1826] }], optionalServices: [0x180a, 0x180d],
    });
    this.name = this.device.name || 'Tapis FTMS';
    this.device.addEventListener('gattserverdisconnected', () => this.app.onDeviceLost(this));
    const server = await this.device.gatt.connect();
    const svc = await server.getPrimaryService(0x1826);
    const data = await svc.getCharacteristic(0x2acd); // Treadmill Data
    data.addEventListener('characteristicvaluechanged', e => this.parse(e.target.value));
    await data.startNotifications();
    try {
      this.cp = await svc.getCharacteristic(0x2ad9); // Control Point
      this.cp.addEventListener('characteristicvaluechanged', e => this.onCP(e.target.value));
      await this.cp.startNotifications();
    } catch (e) { console.warn('Pas de point de contrôle FTMS', e); this.cp = null; }
    try {
      const st = await svc.getCharacteristic(0x2ada); // Machine Status
      st.addEventListener('characteristicvaluechanged', e => this.onStatus(e.target.value));
      await st.startNotifications();
    } catch { /* optionnel */ }
    try {
      const r = await (await svc.getCharacteristic(0x2ad4)).readValue();
      this.speedRange = { min: r.getUint16(0, true) / 100, max: r.getUint16(2, true) / 100 };
    } catch { /* optionnel */ }
    try {
      const r = await (await svc.getCharacteristic(0x2ad5)).readValue();
      this.inclineRange = { min: r.getInt16(0, true) / 10, max: r.getInt16(2, true) / 10 };
    } catch { /* optionnel */ }
    await this.write([0x00]); // Request Control
  }
  write(bytes, retry = true) {
    if (!this.cp) return Promise.resolve();
    if (bytes[0] !== 0x00) this.last[bytes[0]] = { bytes, retry };
    this.q = this.q
      .then(() => {
        const v = new Uint8Array(bytes);
        return this.cp.writeValueWithResponse ? this.cp.writeValueWithResponse(v) : this.cp.writeValue(v);
      })
      .then(() => new Promise(r => setTimeout(r, 80)))
      .catch(e => console.warn('Écriture FTMS', bytes, e));
    return this.q;
  }
  onCP(dv) {
    if (dv.getUint8(0) !== 0x80) return;
    const op = dv.getUint8(1), res = dv.getUint8(2);
    if (res === 0x05 && op !== 0x00 && this.last[op]?.retry) { // contrôle perdu → on le redemande
      const { bytes } = this.last[op];
      this.write([0x00]).then(() => this.write(bytes, false));
    }
  }
  onStatus(dv) {
    const op = dv.getUint8(0);
    if (op === 0x02) this.app.onMachineStopped();
    if (op === 0x04) this.app.onMachineStarted();
  }
  parse(dv) {
    const r = {};
    try {
      let o = 0; const f = dv.getUint16(o, true); o += 2;
      if (!(f & 0x0001)) { r.speed = dv.getUint16(o, true) / 100; o += 2; }
      if (f & 0x0002) o += 2;
      if (f & 0x0004) { r.distance = dv.getUint16(o, true) + (dv.getUint8(o + 2) << 16); o += 3; }
      if (f & 0x0008) { r.incline = dv.getInt16(o, true) / 10; o += 4; }
      if (f & 0x0010) o += 4;
      if (f & 0x0020) o += 1;
      if (f & 0x0040) o += 1;
      if (f & 0x0080) { r.kcal = dv.getUint16(o, true); o += 5; }
      if (f & 0x0100) { const h = dv.getUint8(o); if (h) r.hr = h; o += 1; }
      if (f & 0x0200) o += 1;
      if (f & 0x0400) { r.elapsed = dv.getUint16(o, true); o += 2; }
    } catch { /* trame tronquée : on garde ce qui a été lu */ }
    this.app.onLive(r, 'machine');
  }
  start() { return this.write([0x07]); }
  pause() { return this.write([0x08, 0x02]); }
  stop() { return this.write([0x08, 0x01]); }
  setSpeed(kmh) { const v = Math.round(kmh * 100); return this.write([0x02, v & 255, (v >> 8) & 255]); }
  setIncline(p) { const v = Math.round(p * 10) & 0xffff; return this.write([0x03, v & 255, v >> 8]); }
  disconnect() { try { this.device.gatt.disconnect(); } catch { /* déjà fermé */ } }
}

class SimTreadmill {
  constructor(app) { this.app = app; this.name = 'Simulateur'; this.kind = 'sim'; this.spd = 0; this.inc = 0; this.tS = 0; this.tI = 0; this.on = false; this.hr = 70; this.kcal = 0; }
  async connect() { this.iv = setInterval(() => this.tick(), 250); }
  tick() {
    const tgt = this.on ? this.tS : 0;
    this.spd = clamp(this.spd + clamp(tgt - this.spd, -0.3, 0.3), 0, 30);
    this.inc += clamp(this.tI - this.inc, -0.12, 0.12);
    const goal = 65 + this.spd * 8.5 + Math.max(0, this.inc) * 3.5;
    this.hr += (goal - this.hr) * 0.02 + (Math.random() - 0.5) * 0.6;
    this.kcal += this.spd * 0.004;
    this.app.onLive({ speed: r1(this.spd * 100) / 100, incline: r1(this.inc), hr: Math.round(this.hr), kcal: Math.round(this.kcal) }, 'sim');
  }
  start() { this.on = true; }
  pause() { this.on = false; }
  stop() { this.on = false; this.tI = 0; }
  setSpeed(v) { this.tS = v; }
  setIncline(v) { this.tI = v; }
  disconnect() { clearInterval(this.iv); }
}

class HRMonitor {
  constructor(app) { this.app = app; }
  async connect() {
    this.device = await navigator.bluetooth.requestDevice({ filters: [{ services: ['heart_rate'] }] });
    this.name = this.device.name || 'Ceinture cardio';
    this.device.addEventListener('gattserverdisconnected', () => this.app.onHrLost());
    const server = await this.device.gatt.connect();
    const ch = await (await server.getPrimaryService('heart_rate')).getCharacteristic('heart_rate_measurement');
    ch.addEventListener('characteristicvaluechanged', e => {
      const dv = e.target.value, f = dv.getUint8(0);
      const hr = f & 1 ? dv.getUint16(1, true) : dv.getUint8(1);
      if (hr) this.app.onLive({ hr }, 'belt');
    });
    await ch.startNotifications();
  }
  disconnect() { try { this.device.gatt.disconnect(); } catch { /* déjà fermé */ } }
}

/* =========================================================================
   Programmes
   ========================================================================= */
const st = (name, mode, value, speed, incline = 0) => ({ type: 'step', name, mode, value, speed, incline });
const rep = (times, steps) => ({ type: 'repeat', times, steps });
const CATS = {
  tennis:    { l: '🎾 Tennis', d: 'Effort intermittent comme sur le court : explosivité, sprints répétés, récupération rapide entre les points. Placez les séances intenses à 48 h des matchs, l’activation la veille et la récupération le lendemain.' },
  endurance: { l: '🫁 Endurance fondamentale', d: 'Allure facile, on peut parler en courant. Construit le moteur aérobie et aide à mieux récupérer, au tennis comme au quotidien.' },
  seuil:     { l: '🔥 Seuil & tempo', d: 'Effort soutenu mais contrôlé. Repousse le moment où l’on « sature » et permet de tenir plus longtemps à haute intensité.' },
  vma:       { l: '⚡ VMA & vitesse', d: 'Efforts courts et très intenses. Développe la vitesse maximale aérobie et la capacité à répéter les efforts.' },
  force:     { l: '⛰️ Force & côtes', d: 'La pente renforce jambes et appuis sans courir vite, avec moins de chocs pour les articulations.' },
  recup:     { l: '🌿 Récupération & marche', d: 'Faible intensité pour récupérer, reprendre en douceur ou bouger les jours de repos.' },
  perso:     { l: '⭐ Mes programmes', d: 'Vos créations et copies.' },
};
const PRESETS = [
  // --- Tennis ---
  { cat: 'tennis', name: 'Tennis · Intermittent 15/15', tag: 'Cardio match', desc: 'Reproduit le rythme des échanges : 2 séries de 8 × 15 s vite / 15 s lent.',
    blocks: [st('Échauffement', 'time', 480, 8), rep(8, [st('Point', 'time', 15, 14.5), st('Entre les points', 'time', 15, 7)]), st('Récup entre séries', 'time', 180, 6),
      rep(8, [st('Point', 'time', 15, 14.5), st('Entre les points', 'time', 15, 7)]), st('Retour au calme', 'time', 300, 6.5)] },
  { cat: 'tennis', name: 'Tennis · Sprints répétés 20/40', tag: 'Explosivité', desc: '3 séries de 6 accélérations courtes : la capacité à enchaîner les rushs au filet et les courses latérales.',
    blocks: [st('Échauffement', 'time', 600, 8), rep(6, [st('Sprint', 'time', 20, 15), st('Récup', 'time', 40, 6.5)]), st('Marche', 'time', 150, 5),
      rep(6, [st('Sprint', 'time', 20, 15), st('Récup', 'time', 40, 6.5)]), st('Marche', 'time', 150, 5),
      rep(6, [st('Sprint', 'time', 20, 15), st('Récup', 'time', 40, 6.5)]), st('Retour au calme', 'time', 300, 6)] },
  { cat: 'tennis', name: 'Tennis · Puissance en côte', tag: 'Appuis', desc: '10 poussées courtes à 6 % de pente : puissance des jambes et des démarrages, sans impact.',
    blocks: [st('Échauffement', 'time', 480, 7.5, 2), rep(10, [st('Poussée', 'time', 20, 11, 6), st('Marche', 'time', 40, 5, 6)]), st('Retour au calme', 'time', 300, 6, 0)] },
  { cat: 'tennis', name: 'Tennis · Simulation de match', tag: '3 sets', desc: '3 « sets » de 6 jeux d’efforts variés, avec 90 s de marche à chaque changement de côté.',
    blocks: [st('Échauffement', 'time', 480, 8),
      rep(6, [st('Long échange', 'time', 25, 13), st('Pause', 'time', 20, 7), st('Point court', 'time', 15, 14), st('Pause', 'time', 25, 6.5)]), st('Changement de côté', 'time', 90, 5),
      rep(6, [st('Long échange', 'time', 25, 13), st('Pause', 'time', 20, 7), st('Point court', 'time', 15, 14), st('Pause', 'time', 25, 6.5)]), st('Changement de côté', 'time', 90, 5),
      rep(6, [st('Long échange', 'time', 25, 13), st('Pause', 'time', 20, 7), st('Point court', 'time', 15, 14), st('Pause', 'time', 25, 6.5)]), st('Retour au calme', 'time', 300, 6)] },
  { cat: 'tennis', name: 'Tennis · Foncier hors saison', tag: 'Aérobie', desc: 'Base aérobie pour tenir les longs matchs : 3 × 6 min soutenues.',
    blocks: [st('Échauffement', 'time', 600, 8), rep(3, [st('Soutenu', 'time', 360, 11), st('Récup', 'time', 120, 8)]), st('Retour au calme', 'time', 300, 7)] },
  { cat: 'tennis', name: 'Tennis · Activation veille de match', tag: 'Veille', desc: '20 minutes légères avec quelques accélérations pour arriver vif, sans fatigue.',
    blocks: [st('Footing', 'time', 600, 8), rep(4, [st('Accélération', 'time', 20, 13), st('Récup', 'time', 60, 7)]), st('Retour au calme', 'time', 280, 6.5)] },
  { cat: 'tennis', name: 'Tennis · Récup lendemain de match', tag: 'Récup', desc: 'Footing très facile pour relancer la circulation et soulager les jambes.',
    blocks: [st('Marche', 'time', 300, 5), st('Footing très facile', 'time', 900, 7.5, 1), st('Marche', 'time', 300, 5)] },
  // --- Endurance ---
  { cat: 'endurance', name: 'Endurance fondamentale 45′', desc: 'Footing aisé pour construire le foncier.', tag: 'Endurance',
    blocks: [st('Échauffement', 'time', 300, 7), st('Endurance', 'time', 2100, 9.5, 1), st('Retour au calme', 'time', 300, 7)] },
  { cat: 'endurance', name: 'Endurance 30′', desc: 'Version courte, facile à caser entre deux matchs.', tag: 'Zone 2',
    blocks: [st('Échauffement', 'time', 300, 7), st('Endurance', 'time', 1200, 9, 1), st('Retour au calme', 'time', 300, 7)] },
  { cat: 'endurance', name: 'Sortie longue 60′', desc: 'Une heure à allure confortable pour l’endurance de fond.', tag: 'Long',
    blocks: [st('Échauffement', 'time', 420, 7.5), st('Endurance', 'time', 2880, 9.5, 1), st('Retour au calme', 'time', 300, 7)] },
  { cat: 'endurance', for: ['sport', 'douceur'], name: 'Découverte 20′', desc: 'Alternance marche / course pour débuter.', tag: 'Débutant',
    blocks: [st('Marche', 'time', 180, 5), rep(5, [st('Course', 'time', 120, 8), st('Marche', 'time', 60, 5.5)]), st('Marche', 'time', 120, 4.5)] },
  // --- Seuil ---
  { cat: 'seuil', name: 'Tempo 3 × 8′', desc: 'Trois blocs à allure soutenue, 2 min de récup.', tag: 'Seuil',
    blocks: [st('Échauffement', 'time', 600, 8), rep(3, [st('Tempo', 'time', 480, 12), st('Récup', 'time', 120, 8)]), st('Retour au calme', 'time', 300, 7)] },
  { cat: 'seuil', name: 'Pyramide 1-2-3-2-1', desc: 'Efforts croissants puis décroissants, récupération égale.', tag: 'Seuil',
    blocks: [st('Échauffement', 'time', 600, 8), st('Effort 1′', 'time', 60, 13), st('Récup', 'time', 60, 8), st('Effort 2′', 'time', 120, 12.5), st('Récup', 'time', 120, 8),
      st('Effort 3′', 'time', 180, 12), st('Récup', 'time', 180, 8), st('Effort 2′', 'time', 120, 12.5), st('Récup', 'time', 120, 8), st('Effort 1′', 'time', 60, 13), st('Retour au calme', 'time', 300, 7)] },
  { cat: 'seuil', name: '5 km progressif', desc: 'Chaque kilomètre un peu plus vite que le précédent.', tag: 'Distance',
    blocks: [st('Km 1', 'dist', 1000, 9), st('Km 2', 'dist', 1000, 9.8), st('Km 3', 'dist', 1000, 10.5), st('Km 4', 'dist', 1000, 11.2), st('Km 5', 'dist', 1000, 12)] },
  // --- VMA ---
  { cat: 'vma', name: 'Fractionné 30/30', desc: '10 × 30 s rapide / 30 s récup. Idéal pour la VMA.', tag: 'VMA',
    blocks: [st('Échauffement', 'time', 600, 8), rep(10, [st('Rapide', 'time', 30, 14), st('Récup', 'time', 30, 8)]), st('Retour au calme', 'time', 300, 7)] },
  { cat: 'vma', name: 'VMA 6 × 800 m', desc: '800 m vite, 2 minutes de récupération.', tag: 'VMA',
    blocks: [st('Échauffement', 'time', 720, 8), rep(6, [st('800 m', 'dist', 800, 14.5), st('Récup', 'time', 120, 7)]), st('Retour au calme', 'time', 300, 7)] },
  // --- Force ---
  { cat: 'force', name: 'Côtes', desc: '6 montées à 8 % avec descente en marche rapide.', tag: 'Force',
    blocks: [st('Échauffement', 'time', 480, 8, 1), rep(6, [st('Montée', 'time', 120, 9, 8), st('Descente', 'time', 120, 6.5, 1)]), st('Retour au calme', 'time', 300, 6, 0)] },
  // --- Récupération ---
  { cat: 'recup', for: ['sport', 'douceur'], name: 'Marche active inclinée', desc: '30 minutes de marche avec variations de pente.', tag: 'Marche',
    blocks: [st('Mise en route', 'time', 300, 5, 0), rep(3, [st('Pente', 'time', 180, 5.5, 6), st('Forte pente', 'time', 120, 5.2, 10), st('Plat', 'time', 120, 6, 2)]), st('Retour au calme', 'time', 240, 4.5, 0)] },
  { cat: 'recup', for: ['sport', 'douceur'], name: 'Marche active 30′', desc: 'Marche soutenue sur terrain plat, idéale les jours sans séance.', tag: 'Marche',
    blocks: [st('Mise en route', 'time', 300, 4.8), st('Marche active', 'time', 1200, 5.6, 1), st('Retour au calme', 'time', 300, 4.5)] },
  { cat: 'recup', for: ['douceur'], name: 'Balade 20′', desc: 'Marche tranquille pour bouger un jour de repos.', tag: 'Doux',
    blocks: [st('Marche', 'time', 1200, 4.8)] },
];
const PRESETS_VERSION = 3;
const presetsFor = kind => PRESETS.filter(p => (p.for || ['sport']).includes(kind || 'sport'));
const makePresetPrograms = () => presetsFor(PROFILE.kind).map(({ for: _, ...p }) => ({ id: uid(), builtin: true, ...structuredClone(p) }));
const savePrograms = () => store.set('programs', PROGRAMS);
let PROGRAMS = store.get('programs', null);
if (!PROGRAMS) { PROGRAMS = makePresetPrograms(); store.set('presetsV', PRESETS_VERSION); savePrograms(); }
else if (store.get('presetsV', 1) < PRESETS_VERSION) { // mise à jour : catégories + nouveaux programmes fournis
  const byName = new Map(presetsFor(PROFILE.kind).map(p => [p.name, p]));
  PROGRAMS.forEach(p => { if (!p.cat) p.cat = byName.get(p.name)?.cat || 'perso'; });
  const names = new Set(PROGRAMS.map(p => p.name));
  PROGRAMS.push(...makePresetPrograms().filter(p => !names.has(p.name)));
  store.set('presetsV', PRESETS_VERSION); savePrograms();
}

/* =========================================================================
   Plans au long cours (une séance après l'autre, progression mémorisée)
   ========================================================================= */
const PLANS = {
  reprise6m: {
    name: 'De la marche au trot en 6 mois', weeks: 26, perWeek: 5,
    desc: 'Pour une marcheuse régulière qui veut trottiner 30 minutes sans s’arrêter. 5 séances de 30 minutes environ (35 au maximum) par semaine : 3 de course-marche et 2 de marche.',
    tips: ['Allure de trot : vous devez pouvoir parler. Si vous êtes essoufflée, ralentissez (bouton − de l’intensité) ou marchez.',
      'Gardez 2 jours de repos par semaine et évitez 3 séances d’affilée.',
      'Une semaine trop difficile ? Refaites-la : le plan attend, il n’y a pas de date limite.',
      'Douleur articulaire ou malaise : arrêtez la séance. À 62 ans, un avis médical avant de commencer est recommandé.'],
    phases: [[1, 2, 'Marche rapide : habituer le corps'], [3, 8, 'Premiers trottinements'], [9, 16, 'On allonge le trot'],
      [17, 20, 'Vers le trot continu'], [21, 26, 'Trot continu jusqu’à 30 minutes']],
    build: buildReprise6m,
  },
};
function buildReprise6m() {
  // Chaque séance dure 30 minutes environ, 35 au grand maximum, échauffement et retour au calme compris.
  const MAX = 35 * 60;
  // [trot (s), marche (s), nombre de trots, vitesse trot, semaine allégée] — marche = 0 : trot continu
  const W = [
    [120, 180, 5, 6.0], [180, 120, 5, 6.0],
    [30, 150, 8, 6.5], [60, 150, 7, 6.5], [60, 120, 8, 6.5], [90, 120, 7, 6.5], [120, 120, 6, 6.5], [90, 120, 5, 6.5, 1],
    [180, 120, 5, 6.8], [240, 120, 4, 6.8], [300, 90, 4, 6.8], [240, 120, 3, 6.8, 1], [360, 90, 3, 6.8], [420, 90, 3, 6.8], [600, 90, 2, 7], [480, 90, 2, 7, 1],
    [660, 90, 2, 7], [780, 60, 2, 7], [1080, 0, 1, 7], [900, 0, 1, 7, 1],
    [1200, 0, 1, 7], [1320, 0, 1, 7], [1440, 0, 1, 7], [1200, 0, 1, 7, 1], [1560, 0, 1, 7.2], [1680, 0, 1, 7.2],
  ];
  const out = [];
  W.forEach(([run, walk, reps, spd, light], w) => {
    const week = w + 1, marche = week <= 2;
    const effort = marche ? 'Marche rapide' : 'Trot';
    const pre = light ? 'Semaine plus légère pour assimiler les progrès. ' : '';
    // échauffement + retour au calme : 4 + 3 min, raccourcis à 3 + 2 min pour les longs trots continus
    const wrap = len => len + 420 <= MAX ? [240, 180] : [180, 120];
    const len = (r, n) => n * r + (n - 1) * walk; // la dernière marche est remplacée par le retour au calme
    const runWalk = longer => {
      let r = run, n = reps;
      if (longer) { // séance longue : un trot de plus, sinon des trots plus longs, sans dépasser 35 minutes
        if (!walk) r = Math.min(1800, run + 120);
        else if (len(r, n + 1) + 420 <= MAX) n++;
        else if (len(r + 60, n) + 420 <= MAX) r += 60;
      }
      const [wu, cd] = wrap(len(r, n));
      const main = n > 1 ? [rep(n - 1, [st(effort, 'time', r, spd), st('Marche', 'time', walk, 5)]), st(effort, 'time', r, spd)] : [st(walk ? effort : 'Trot continu', 'time', r, spd)];
      return {
        name: walk ? `${effort} ${fmtDur(r)} / marche ${fmtDur(walk)} × ${n}` : `Trot continu ${Math.round(r / 60)} minutes`,
        blocks: [st('Échauffement : marche', 'time', wu, 4.8), ...main, st('Retour au calme', 'time', cd, 4.5)],
        desc: pre + (marche ? 'Alternez marche rapide et marche normale : un peu essoufflée, mais capable de parler.'
          : walk ? 'Trottinez tout doucement, en petites foulées. Marchez dès que c’est prévu, sans culpabiliser.'
          : 'Trottinez sans vous arrêter, à une allure où vous pouvez parler.'),
      };
    };
    // marche active : 30 → 35 min, la vitesse et la pente progressent
    const walkMin = light ? 30 : Math.min(35, 30 + Math.floor(w / 5));
    const wSpeed = week > 20 ? 6 : week > 12 ? 5.8 : 5.5, wSlope = week > 16 ? 2 : 1;
    // marche en côte : toujours 5 × (3 min côte + 2 min plat) = 32 min, la pente progresse de 3 à 6 %
    const slope = week > 18 ? 6 : week > 12 ? 5 : week > 6 ? 4 : 3, hills = light ? 4 : 5;
    const sessions = [
      runWalk(false),
      { name: `Marche active ${walkMin} minutes`, desc: pre + 'Marche soutenue et régulière, bras actifs.',
        blocks: [st('Mise en route', 'time', 240, 4.8), st('Marche active', 'time', (walkMin - 7) * 60, wSpeed, wSlope), st('Retour au calme', 'time', 180, 4.5)] },
      runWalk(false),
      { name: `Marche en côte ${hills} × 3 minutes à ${slope} %`, desc: pre + 'La pente renforce les jambes sans chocs. Ne vous tenez pas aux poignées si possible.',
        blocks: [st('Mise en route', 'time', 240, 4.8), rep(hills, [st('Côte', 'time', 180, 5, slope), st('Plat', 'time', 120, 5.2, 1)]), st('Retour au calme', 'time', 180, 4.5, 0)] },
      runWalk(true),
    ];
    sessions.forEach((s, d) => out.push({ ...s, cat: 'plan', week, day: d + 1, light: !!light }));
  });
  const last = out[out.length - 1];
  last.name = 'Objectif : 30 minutes de trot ! 🎉';
  last.desc = 'Dernière séance du plan : 30 minutes de trot sans vous arrêter. Vous l’avez fait !';
  return out;
}
const PLAN_CACHE = {};
const planState = () => store.get('plan', null);
function planSessions() {
  const ps = planState();
  if (!ps || !PLANS[ps.key]) return null;
  return PLAN_CACHE[ps.key] ||= PLANS[ps.key].build().map((s, i) => ({ ...s, planIndex: i }));
}
function todaySession() {
  const ps = planState(), ss = planSessions();
  return ss && ps.cursor < ss.length ? ss[ps.cursor] : null;
}
const phaseOf = (key, week) => PLANS[key].phases.find(([a, b]) => week >= a && week <= b)?.[2] || '';
function setPlanCursor(c, logIndex) {
  const ps = planState(); if (!ps) return;
  if (logIndex != null) ps.log.push({ i: logIndex, date: Date.now() });
  ps.cursor = clamp(c, 0, planSessions().length);
  store.set('plan', ps);
}
function planGo() {
  const s = todaySession(); if (!s) return;
  loadProgram({ ...s, name: `S${s.week}·${s.day} — ${s.name}` });
}

function flatten(def) {
  const out = [];
  for (const b of def.blocks) {
    if (b.type === 'repeat') {
      for (let i = 0; i < b.times; i++) b.steps.forEach(s => out.push({ ...s, rep: `${i + 1}/${b.times}` }));
    } else out.push({ ...b });
  }
  return out;
}
const stepSec = (s, k = 1) => s.mode === 'time' ? s.value : s.value / Math.max(0.5, s.speed * k / 3.6);
const stepM = (s, k = 1) => s.mode === 'dist' ? s.value : s.value * s.speed * k / 3.6;
function progTotals(def, k = 1) {
  const steps = flatten(def);
  return { steps, sec: steps.reduce((a, s) => a + stepSec(s, k), 0), m: steps.reduce((a, s) => a + stepM(s, k), 0) };
}
const stepLabel = s => `${s.mode === 'time' ? fmtDur(s.value) : (s.value >= 1000 ? r1(s.value / 1000) + ' km' : s.value + ' m')} · ${r1(s.speed)} km/h${s.incline ? ' · ' + s.incline + ' %' : ''}`;

/* =========================================================================
   État de l'application
   ========================================================================= */
let dev = null, hrDev = null;
const live = { speed: 0, incline: 0, hr: 0, kcal: null, hrSrc: null, at: 0 };
const target = { speed: S.startSpeed, incline: 0 };
let sess = newSession();
let prog = null;  // programme actif
let wakeLock = null;

function newSession() {
  return { state: 'idle', startedAt: null, elapsed: 0, dist: 0, elev: 0, kcal: 0, kcal0: null,
    samples: [], hrSum: 0, hrN: 0, maxHr: 0, maxSpeed: 0, nextSplit: S.splitDistance * 1000, splitT: 0, splits: [], lastSampleT: -1 };
}

/* ---------- données reçues ---------- */
const app = {
  onLive(d, src) {
    if (d.speed != null) live.speed = d.speed;
    if (d.incline != null) live.incline = d.incline;
    if (d.kcal != null) live.kcal = d.kcal;
    if (d.hr) {
      if (src === 'belt' || live.hrSrc !== 'belt' || Date.now() - live.hrAt > 5000) { live.hr = d.hr; live.hrSrc = src; live.hrAt = Date.now(); }
    }
    live.at = Date.now();
    scheduleRender();
  },
  onDeviceLost(d) {
    if (dev !== d) return;
    toast('⚠️ Tapis déconnecté');
    dev = null; live.speed = 0;
    if (sess.state === 'running') setState('paused');
    renderConn();
  },
  onHrLost() { toast('Ceinture cardio déconnectée'); hrDev = null; renderConn(); },
  onMachineStopped() { if (sess.state === 'running') { setState('paused'); toast('Tapis mis en pause depuis la console'); } },
  onMachineStarted() { if (sess.state === 'paused') setState('running'); },
};

/* ---------- profils ---------- */
function renderProfileChip() {
  $('#btnProfile .av').textContent = PROFILE.emoji;
  $('#btnProfile .pn').textContent = PROFILE.name;
  document.title = `RunStudio · ${PROFILE.name}`;
}
const saveProfiles = () => raw.set('rs.profiles', PROFILES);
function switchProfile(id) {
  if (id === PID) return closeDialog();
  if (sess.state !== 'idle') return toast('Terminez la séance avant de changer de profil');
  raw.set('rs.activeProfile', id);
  location.reload();
}
function openProfiles() {
  const planName = id => { const p = raw.get(`rs.p_${id}.plan`, null); return p && PLANS[p.key] ? ` · plan ${Math.round(p.cursor / PLANS[p.key].weeks / PLANS[p.key].perWeek * 100)} %` : ''; };
  showDialog(`<div class="dlg-head"><h2>Profils</h2><button class="btn icon" data-close>✕</button></div>
    <div class="dlg-body"><div class="choice">${PROFILES.map(p => `<button data-pid="${p.id}" class="${p.id === PID ? 'cur' : ''}">
      <span class="ic">${p.emoji}</span><span><b>${esc(p.name)}</b><small>${p.id === PID ? 'Profil actif' : 'Passer sur ce profil'} · ${p.kind === 'douceur' ? 'programmes en douceur' : 'programmes sportifs'}${planName(p.id)}</small></span></button>`).join('')}</div>
      <div id="newProfile" class="hidden" style="margin-top:14px"><div class="ed-top">
        <input id="npName" placeholder="Prénom" class="title"><input id="npEmoji" placeholder="Emoji (ex. 🏃)" maxlength="4">
        <select id="npKind"><option value="sport">Programmes sportifs</option><option value="douceur">Programmes en douceur</option></select>
        <button class="btn primary" id="npOk">Créer le profil</button></div></div>
    </div>
    <div class="dlg-foot"><div class="left">${PROFILES.length > 1 ? '<button class="btn sm danger" id="pDel">🗑 Supprimer ce profil</button>' : ''}<button class="btn sm" id="pRen">✏️ Renommer</button></div>
      <button class="btn" id="pNew">＋ Nouveau profil</button></div>`);
  $('#dlg .choice').onclick = e => { const b = e.target.closest('[data-pid]'); if (b) switchProfile(b.dataset.pid); };
  $('#pNew').onclick = () => { $('#newProfile').classList.remove('hidden'); $('#npName').focus(); };
  $('#npOk').onclick = () => {
    const name = $('#npName').value.trim(); if (!name) return $('#npName').focus();
    const id = 'p' + uid();
    PROFILES.push({ id, name, emoji: $('#npEmoji').value.trim() || '🏃', kind: $('#npKind').value });
    saveProfiles(); switchProfile(id);
  };
  $('#pRen').onclick = () => {
    const name = prompt('Nom du profil', PROFILE.name); if (!name) return;
    const emoji = prompt('Emoji du profil', PROFILE.emoji) || PROFILE.emoji;
    Object.assign(PROFILE, { name: name.trim(), emoji: emoji.trim() }); saveProfiles(); renderProfileChip(); openProfiles();
  };
  if ($('#pDel')) $('#pDel').onclick = () => {
    if (!confirm(`Supprimer le profil « ${PROFILE.name} », son historique et ses programmes ? C’est définitif.`)) return;
    Object.keys(localStorage).filter(k => k.startsWith(`rs.p_${PID}.`)).forEach(k => localStorage.removeItem(k));
    PROFILES = PROFILES.filter(p => p.id !== PID); saveProfiles();
    raw.set('rs.activeProfile', PROFILES[0].id); location.reload();
  };
}

/* ---------- connexion ---------- */
function openDeviceDialog() {
  if (dev) {
    showDialog(`<div class="dlg-head"><h2>${esc(dev.name)}</h2><button class="btn icon" data-close>✕</button></div>
      <div class="dlg-body"><p class="help">Connecté${dev.kind === 'sim' ? ' en <b>mode simulation</b>' : ' via <b>Bluetooth FTMS</b>'}.
      ${dev.speedRange ? `<br>Plage vitesse annoncée : ${dev.speedRange.min}–${dev.speedRange.max} km/h` : ''}
      ${dev.inclineRange ? `<br>Plage inclinaison annoncée : ${dev.inclineRange.min}–${dev.inclineRange.max} %` : ''}</p></div>
      <div class="dlg-foot"><button class="btn danger" id="dDisc">Déconnecter</button><button class="btn primary" data-close>OK</button></div>`);
    $('#dDisc').onclick = () => { if (sess.state === 'running') dev.pause(); dev.disconnect(); dev = null; live.speed = 0; renderConn(); closeDialog(); };
    return;
  }
  const bt = !!navigator.bluetooth;
  showDialog(`<div class="dlg-head"><h2>Connecter un tapis</h2><button class="btn icon" data-close>✕</button></div>
    <div class="dlg-body"><div class="choice">
      <button id="cFtms" ${bt ? '' : 'disabled style="opacity:.5"'}><span class="ic">📡</span><span><b>Tapis Bluetooth (FTMS)</b>
        <small>${bt ? 'Domyos Run 500, Kinomap/Zwift-compatibles…' : 'Web Bluetooth indisponible : utilisez Chrome ou Edge (PC, Android).'}</small></span></button>
      <button id="cSim"><span class="ic">🧪</span><span><b>Mode simulateur</b><small>Pour essayer l’application et ses programmes sans tapis.</small></span></button>
    </div>
    <p class="help" style="margin-top:14px">💡 <b>Run 500 :</b> le mode FTMS s’active une fois depuis l’application Domyos E-Connected
    (réglages du tapis → compatibilité Zwift/Kinomap), puis éteignez/rallumez le tapis. Fermez ensuite E-Connected : le tapis n’accepte qu’une connexion à la fois.</p></div>`);
  $('#cSim').onclick = () => connect(new SimTreadmill(app));
  if (bt) $('#cFtms').onclick = () => connect(new FTMSTreadmill(app));
}
async function connect(d) {
  closeDialog();
  $('#btnDevice').classList.add('busy');
  try {
    await d.connect();
    dev = d;
    if (d.speedRange?.max) { S.maxSpeed = Math.min(S.maxSpeed, d.speedRange.max); }
    if (d.inclineRange?.max != null) { S.maxIncline = Math.min(S.maxIncline, d.inclineRange.max); S.minIncline = Math.max(S.minIncline, d.inclineRange.min); }
    toast(`✅ ${d.name} connecté`);
  } catch (e) {
    if (e.name !== 'NotFoundError') toast('Connexion impossible : ' + e.message, 4000);
  }
  renderConn();
}
async function connectHr() {
  if (hrDev) { hrDev.disconnect(); hrDev = null; renderConn(); return; }
  if (!navigator.bluetooth) return toast('Web Bluetooth indisponible dans ce navigateur', 3500);
  $('#btnHr').classList.add('busy');
  try { const h = new HRMonitor(app); await h.connect(); hrDev = h; toast('❤️ ' + h.name + ' connectée'); }
  catch (e) { if (e.name !== 'NotFoundError') toast('Cardio : ' + e.message, 4000); }
  renderConn();
}
function renderConn() {
  const b = $('#btnDevice'), h = $('#btnHr');
  b.classList.remove('busy'); h.classList.remove('busy');
  b.classList.toggle('on', !!dev); $('span', b).textContent = dev ? dev.name : 'Connecter le tapis';
  h.classList.toggle('on', !!hrDev); $('span', h).textContent = hrDev ? '♥ ' + hrDev.name : '♥ Cardio';
}

/* ---------- commandes ---------- */
let spdT, incT;
function setTargetSpeed(v, silent) {
  target.speed = r1(clamp(v, S.minSpeed, S.maxSpeed));
  clearTimeout(spdT);
  spdT = setTimeout(() => { if (dev && sess.state === 'running') dev.setSpeed(target.speed); }, silent ? 0 : 220);
  renderTargets();
}
function setTargetIncline(v, silent) {
  target.incline = r1(clamp(v, S.minIncline, S.maxIncline));
  clearTimeout(incT);
  incT = setTimeout(() => { if (dev && sess.state !== 'idle') dev.setIncline(target.incline); }, silent ? 0 : 220);
  renderTargets();
}

async function startPause() {
  if (sess.state === 'countdown') return;
  if (!dev) { openDeviceDialog(); return; }
  if (sess.state === 'running') { dev.pause(); setState('paused'); speak('Pause'); return; }
  if (sess.state === 'idle') {
    sess = newSession();
    if (prog) applyStep(true); else target.speed = clamp(S.startSpeed, S.minSpeed, S.maxSpeed);
    await countdown(S.startCountdown);
    sess.startedAt = Date.now();
    if (prog) prog.starts[0] = 0;
    if (prog) speak(`C'est parti pour ${prog.def.name}. ${stepSpeech(prog.steps[0])}`);
  } else {
    await countdown(Math.min(3, S.startCountdown));
    speak('Reprise');
  }
  setState('running');
  await dev.start();
  setTimeout(() => { dev?.setSpeed(target.speed); dev?.setIncline(target.incline); }, 400);
}

function countdown(n) {
  return new Promise(res => {
    if (!n) return res();
    sess.state = 'countdown'; renderStartBtn();
    const el = $('#countdown'); el.classList.remove('hidden');
    let i = n;
    const step = () => {
      if (i === 0) { el.classList.add('hidden'); beep(1320, 0.35); return res(); }
      el.textContent = i; beep(880, 0.12); i--; setTimeout(step, 1000);
    };
    step();
  });
}

function setState(s) {
  sess.state = s;
  if (s === 'running') requestWake(); else if (s === 'idle') releaseWake();
  renderStartBtn();
}

function stopSession() {
  if (sess.state === 'idle') { if (prog) unloadProgram(); return; }
  dev?.stop();
  setState('idle');
  window.speechSynthesis?.cancel();
  const done = sess;
  const p = prog;
  if (prog) prog = { ...prog, idx: 0, stepT: 0, stepD: 0, starts: [], finished: false };
  renderBanner();
  if (done.elapsed < S.minSaveSec) { toast('Séance trop courte : non enregistrée'); sess = newSession(); renderAll(); return; }
  const rec = buildRecord(done, p);
  showSummary(rec, true);
}

function buildRecord(s, p) {
  const step = 5; // échantillonnage stocké : toutes les 5 s
  const samples = s.samples.filter((x, i) => i % step === 0 || i === s.samples.length - 1).map(x => [Math.round(x.t), r1(x.s * 10) / 10, x.i, x.h || 0, Math.round(x.d)]);
  return {
    id: uid(), date: s.startedAt || Date.now(), sec: Math.round(s.elapsed), dist: Math.round(s.dist), elev: Math.round(s.elev), kcal: Math.round(s.kcal),
    avgHr: s.hrN ? Math.round(s.hrSum / s.hrN) : 0, maxHr: s.maxHr, maxSpeed: r1(s.maxSpeed),
    program: p ? p.def.name : null, splits: s.splits, samples,
    planIndex: p?.def.planIndex ?? null,
    planOk: !!p && (p.finished || s.elapsed >= 0.8 * progTotals(p.def, p.k).sec),
  };
}

/* ---------- boucle principale (1 s) ---------- */
let lastTick = performance.now();
function tick() {
  const now = performance.now();
  const dt = Math.min(2, (now - lastTick) / 1000);
  lastTick = now;
  if (dev && Date.now() - live.at > 6000 && dev.kind === 'ftms') live.speed = 0; // plus de trames
  if (sess.state === 'running') {
    const moving = live.speed > 0.2;
    if (moving) {
      const dd = live.speed / 3.6 * dt;
      sess.elapsed += dt; sess.dist += dd;
      if (live.incline > 0) sess.elev += dd * live.incline / 100;
      // calories
      if (S.calories === 'machine' && live.kcal != null) {
        if (sess.kcal0 == null) sess.kcal0 = live.kcal - sess.kcal;
        sess.kcal = Math.max(sess.kcal, live.kcal - sess.kcal0);
      } else {
        const m = live.speed * 1000 / 60, g = Math.max(0, live.incline) / 100;
        const vo2 = live.speed < 8 ? 0.1 * m + 1.8 * m * g + 3.5 : 0.2 * m + 0.9 * m * g + 3.5;
        sess.kcal += vo2 * S.weight / 1000 * 5 / 60 * dt;
      }
      sess.maxSpeed = Math.max(sess.maxSpeed, live.speed);
      if (live.hr) { sess.hrSum += live.hr; sess.hrN++; sess.maxHr = Math.max(sess.maxHr, live.hr); }
      if (prog && !prog.finished) progTick(dt, dd);
      checkSplit();
    }
    if (Math.floor(sess.elapsed) !== sess.lastSampleT) {
      sess.lastSampleT = Math.floor(sess.elapsed);
      sess.samples.push({ t: sess.elapsed, s: live.speed, i: live.incline, h: live.hr, d: sess.dist });
    }
  }
  renderLive();
}

function checkSplit() {
  if (!S.splits || sess.dist < sess.nextSplit) return;
  const t = sess.elapsed - sess.splitT;
  sess.splits.push({ d: sess.nextSplit, t: Math.round(t) });
  const km = sess.nextSplit / 1000;
  const per = t / S.splitDistance;
  speak(`${String(km).replace('.', ' virgule ')} kilomètre${km > 1 ? 's' : ''}. Temps total ${fmtSpeech(sess.elapsed)}. Allure ${Math.floor(per / 60)} minutes ${Math.round(per % 60)} au kilomètre.`);
  sess.splitT = sess.elapsed;
  sess.nextSplit += S.splitDistance * 1000;
}
function fmtSpeech(s) {
  s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
  return [h && `${h} heure${h > 1 ? 's' : ''}`, m && `${m} minute${m > 1 ? 's' : ''}`, x && `${x} seconde${x > 1 ? 's' : ''}`].filter(Boolean).join(' ') || '0 seconde';
}

/* ---------- exécution d'un programme ---------- */
function loadProgram(def) {
  const steps = flatten(def);
  if (!steps.length) return toast('Ce programme est vide');
  prog = { def, steps, idx: 0, stepT: 0, stepD: 0, starts: [], k: S.intensity / 100, finished: false };
  if (sess.state !== 'idle') { prog.starts[0] = sess.elapsed; applyStep(); speak(`Programme ${def.name}. ${stepSpeech(steps[0])}`); }
  else toast(`Programme « ${def.name} » prêt — appuyez sur Démarrer`);
  switchView('run');
  renderBanner(); renderChart();
}
function unloadProgram() { prog = null; renderBanner(); renderChart(); }
const curStep = () => prog?.steps[prog.idx];
function applyStep(silent) {
  const s = curStep(); if (!s) return;
  if (sess.state !== 'idle' && prog.starts[prog.idx] == null) prog.starts[prog.idx] = sess.elapsed;
  setTargetSpeed(s.speed * prog.k, true);
  setTargetIncline(s.incline, true);
  if (!silent) beep(1320, 0.3);
  renderBanner();
}
function stepSpeech(s) {
  const len = s.mode === 'time' ? fmtSpeech(s.value) : (s.value >= 1000 ? `${String(r1(s.value / 1000)).replace('.', ' virgule ')} kilomètres` : `${s.value} mètres`);
  return `${s.name}${s.rep ? ', ' + s.rep.replace('/', ' sur ') : ''} : ${len} à ${sayKmh(s.speed * prog.k)}${s.incline ? `, pente ${s.incline} pourcent` : ''}.`;
}
function stepLeft() {
  const s = curStep(); if (!s) return 0;
  return s.mode === 'time' ? s.value - prog.stepT : s.value - prog.stepD;
}
function progTick(dt, dd) {
  const s = curStep();
  const before = stepLeft();
  prog.stepT += dt; prog.stepD += dd;
  const left = stepLeft();
  if (S.countdownBeeps && s.mode === 'time' && left > 0) {
    if (Math.ceil(left) !== Math.ceil(before) && Math.ceil(left) <= 3) beep(660, 0.1);
  }
  if (s.mode === 'time' && Math.ceil(before) > 10 && Math.ceil(left) <= 10 && prog.steps[prog.idx + 1]) {
    const n = prog.steps[prog.idx + 1];
    speak(`Dans 10 secondes : ${n.name}, ${sayKmh(n.speed * prog.k)}`);
  }
  if (left <= 0) gotoStep(prog.idx + 1);
}
function gotoStep(i) {
  if (!prog) return;
  if (i < 0) i = 0;
  if (i >= prog.steps.length) return finishProgram();
  prog.idx = i; prog.stepT = 0; prog.stepD = 0; prog.finished = false;
  prog.starts.length = i; prog.starts[i] = sess.elapsed;
  applyStep();
  speak(stepSpeech(curStep()));
}
function finishProgram() {
  prog.finished = true; prog.idx = prog.steps.length;
  beep(1046, 0.2); setTimeout(() => beep(1318, 0.4), 220);
  if (S.endAction === 'stop') { speak('Programme terminé. Bravo !'); stopSession(); return; }
  if (S.endAction === 'walk') { setTargetSpeed(S.walkSpeed, true); setTargetIncline(0, true); speak('Programme terminé, bravo ! Passage en marche pour récupérer.'); }
  else speak('Programme terminé, bravo !');
  renderBanner();
}
function changeIntensity(d) {
  if (!prog) return;
  prog.k = clamp(r1(prog.k * 100 + d) / 100, 0.5, 1.5);
  const s = curStep(); if (s && !prog.finished) setTargetSpeed(s.speed * prog.k);
  renderBanner();
}

/* =========================================================================
   Rendu — tuiles
   ========================================================================= */
const avgSpeed = () => sess.elapsed > 1 ? sess.dist / sess.elapsed * 3.6 : 0;
function hrZone(hr) {
  if (!hr) return 0;
  const p = hr / S.hrMax;
  return p < 0.6 ? 1 : p < 0.7 ? 2 : p < 0.8 ? 3 : p < 0.9 ? 4 : 5;
}
function progRemaining() {
  if (!prog || prog.finished) return 0;
  let s = Math.max(0, prog.steps[prog.idx] ? (curStep().mode === 'time' ? stepLeft() : stepLeft() / Math.max(0.5, live.speed || curStep().speed * prog.k) * 3.6) : 0);
  for (let i = prog.idx + 1; i < prog.steps.length; i++) s += stepSec(prog.steps[i], prog.k);
  return s;
}
const TILES = {
  time:      { l: 'Durée', v: () => fmtTime(sess.elapsed) },
  distance:  { l: 'Distance', u: 'km', v: () => (sess.dist / 1000).toFixed(2) },
  speed:     { l: 'Vitesse', u: 'km/h', v: () => live.speed.toFixed(1), sub: () => `consigne ${target.speed.toFixed(1)}` },
  pace:      { l: 'Allure', u: '/km', v: () => fmtPace(live.speed) },
  avgSpeed:  { l: 'Vitesse moy.', u: 'km/h', v: () => avgSpeed().toFixed(1) },
  avgPace:   { l: 'Allure moy.', u: '/km', v: () => fmtPace(avgSpeed()) },
  incline:   { l: 'Inclinaison', u: '%', v: () => live.incline.toFixed(1) },
  hr:        { l: 'Cardio', u: 'bpm', v: () => live.hr || '--', sub: () => live.hr ? `zone ${hrZone(live.hr)} · ${Math.round(live.hr / S.hrMax * 100)} % FCmax` : 'non connecté', zone: true },
  kcal:      { l: 'Calories', u: 'kcal', v: () => Math.round(sess.kcal) },
  elev:      { l: 'Dénivelé +', u: 'm', v: () => Math.round(sess.elev) },
  split:     { l: 'Tour en cours', v: () => fmtTime(sess.elapsed - sess.splitT), sub: () => `${Math.round(sess.dist - (sess.nextSplit - S.splitDistance * 1000))} m / ${S.splitDistance * 1000} m` },
  remaining: { l: 'Fin du programme', v: () => prog ? fmtTime(progRemaining()) : '--:--' },
  maxSpeed:  { l: 'Vitesse max', u: 'km/h', v: () => sess.maxSpeed.toFixed(1) },
  clock:     { l: 'Heure', v: () => new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) },
};
function buildTiles() {
  const keys = [S.heroTile, ...S.tiles.filter(k => k !== S.heroTile && TILES[k])];
  $('#tiles').innerHTML = keys.map((k, i) => `<div class="tile${i === 0 ? ' hero' : ''}" data-k="${k}"><div class="lbl">${TILES[k].l}</div>
    <div class="val"><span class="v"></span>${TILES[k].u ? `<span class="unit">${TILES[k].u}</span>` : ''}</div>${TILES[k].sub ? '<div class="sub"></div>' : ''}</div>`).join('');
}
function renderTiles() {
  for (const el of $$('#tiles .tile')) {
    const t = TILES[el.dataset.k];
    $('.v', el).textContent = t.v();
    if (t.sub) $('.sub', el).textContent = t.sub();
    if (t.zone) { const z = hrZone(live.hr); el.dataset.zone = z; el.style.setProperty('--zc', z ? css('--z' + z) : 'transparent'); }
  }
}

/* ---------- consignes & boutons ---------- */
function buildPresets() {
  $('#speedPresets').innerHTML = S.speedPresets.map(v => `<button data-spd="${v}">${v}</button>`).join('');
  $('#inclinePresets').innerHTML = S.inclinePresets.map(v => `<button data-inc="${v}">${v}</button>`).join('');
}
function renderTargets() {
  $('#tgtSpeed').textContent = target.speed.toFixed(1);
  $('#tgtIncline').textContent = target.incline.toFixed(1);
  $$('#speedPresets button').forEach(b => b.classList.toggle('sel', +b.dataset.spd === target.speed));
  $$('#inclinePresets button').forEach(b => b.classList.toggle('sel', +b.dataset.inc === target.incline));
}
function renderStartBtn() {
  const b = $('#btnStart');
  const s = sess.state;
  b.classList.toggle('pause', s === 'running');
  b.textContent = s === 'running' ? '❚❚ Pause' : s === 'paused' ? '▶ Reprendre' : s === 'countdown' ? '…' : (prog ? '▶ Lancer le programme' : '▶ Démarrer');
}

/* ---------- bandeau programme ---------- */
function renderBanner() {
  const el = $('#programBanner');
  if (!prog) {
    const t = sess.state === 'idle' && todaySession();
    el.classList.toggle('hidden', !t);
    if (t) el.innerHTML = `<div class="b-top"><span class="b-name">📅 Séance du jour · semaine ${t.week} · séance ${t.day}</span>
      <div class="b-tools"><button class="btn primary" data-plan="go">▶ Charger la séance</button></div></div>
      <div class="b-step">${esc(t.name)}<small>${fmtTime(progTotals(t).sec)}</small></div><div class="b-next">${esc(t.desc)}</div>`;
    return;
  }
  el.classList.remove('hidden');
  const s = curStep(), n = prog.steps[prog.idx + 1];
  const total = prog.steps.reduce((a, x) => a + stepSec(x, prog.k), 0);
  const segs = prog.steps.map((x, i) => `<i style="--w:${stepSec(x, prog.k) / total * 1000}" class="${i < prog.idx ? 'done' : i === prog.idx ? 'cur' : ''}"></i>`).join('');
  el.innerHTML = `<div class="b-top"><span class="b-name">📋 ${esc(prog.def.name)}</span>
      <span class="b-idx">${prog.finished ? 'Terminé ✔' : `Étape ${prog.idx + 1} / ${prog.steps.length}`}</span>
      <div class="b-tools">
        <span class="b-int" title="Intensité : multiplie les vitesses du programme"><button class="btn sm icon" data-int="-5">−</button>${Math.round(prog.k * 100)} %<button class="btn sm icon" data-int="5">+</button></span>
        <button class="btn sm icon" data-pstep="-1" title="Étape précédente">⏮</button>
        <button class="btn sm icon" data-pstep="1" title="Étape suivante">⏭</button>
        <button class="btn sm icon" id="bUnload" title="Retirer le programme">✕</button>
      </div></div>
    ${prog.finished ? `<div class="b-step">Programme terminé — bravo ! 🎉</div>` : `
    <div class="b-top"><div class="b-step">${esc(s.name)}${s.rep ? ` <small>${s.rep}</small>` : ''}<small>${r1(s.speed * prog.k)} km/h${s.incline ? ' · ' + s.incline + ' %' : ''}</small></div>
      <div class="b-left" id="bLeft"></div></div>
    <div class="bar"><i id="bBar"></i></div>
    <div class="b-next">${n ? `Ensuite : <b>${esc(n.name)}</b> — ${stepLabel({ ...n, speed: n.speed * prog.k })}` : 'Dernière étape 💪'}</div>`}
    <div class="seg">${segs}</div>`;
  renderBannerLive();
}
function renderBannerLive() {
  if (!prog || prog.finished) return;
  const s = curStep(), left = Math.max(0, stepLeft());
  const bl = $('#bLeft'), bb = $('#bBar'); if (!bl) return;
  bl.textContent = s.mode === 'time' ? fmtTime(left) : `${Math.round(left)} m`;
  bb.style.width = `${clamp(100 - left / s.value * 100, 0, 100)}%`;
}

/* =========================================================================
   Graphiques (canvas)
   ========================================================================= */
function setupCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight || +cv.getAttribute('height');
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}
/* samples: [{t,s,i,h}], plan: [{t0,t1,s,i}] */
function drawSession(cv, { samples = [], plan = null, x0 = 0, x1 = null, cursor = null, axes = true }) {
  const { ctx, w, h } = setupCanvas(cv);
  if (!w) return;
  const padL = axes ? 34 : 4, padR = axes ? 34 : 4, padT = 8, padB = axes ? 20 : 4;
  const W = w - padL - padR, H = h - padT - padB;
  const last = samples.length ? samples[samples.length - 1].t : 0;
  x1 = x1 ?? Math.max(60, last, plan ? plan[plan.length - 1].t1 : 0);
  if (x1 <= x0) x1 = x0 + 60;
  let sMax = Math.max(8, ...samples.map(p => p.s), ...(plan || []).map(p => p.s)) + 1;
  sMax = Math.ceil(sMax / 2) * 2;
  const iMax = Math.max(S.maxIncline, 1);
  const X = t => padL + (t - x0) / (x1 - x0) * W;
  const Ys = v => padT + H - v / sMax * H;
  const Yi = v => padT + H - Math.max(0, v) / iMax * H * 0.45;
  const Yh = v => padT + H - (v - 50) / (Math.max(S.hrMax, 150) - 50 + 10) * H;
  const line = css('--line'), mut = css('--mut'), acc = css('--accent'), inc = css('--incl'), hrc = css('--hr');
  ctx.font = '11px Segoe UI, system-ui, sans-serif';
  // grille
  if (axes) {
    ctx.strokeStyle = line; ctx.fillStyle = mut; ctx.lineWidth = 1;
    for (let v = 0; v <= sMax; v += sMax > 12 ? 4 : 2) {
      const y = Math.round(Ys(v)) + 0.5;
      ctx.globalAlpha = 0.6; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke(); ctx.globalAlpha = 1;
      ctx.textAlign = 'right'; ctx.fillText(v, padL - 6, y + 4);
    }
    const span = x1 - x0, stepT = [60, 120, 300, 600, 900, 1800, 3600].find(s => span / s <= 8) || 3600;
    ctx.textAlign = 'center';
    for (let t = Math.ceil(x0 / stepT) * stepT; t <= x1; t += stepT) ctx.fillText(fmtTime(t).replace(/^00:/, '0:'), X(t), h - 5);
    ctx.textAlign = 'left'; ctx.fillStyle = hrc; ctx.globalAlpha = 0.8;
    [100, 140, 180].forEach(v => { if (v < S.hrMax + 10) ctx.fillText(v, w - padR + 6, Yh(v) + 4); });
    ctx.globalAlpha = 1;
  }
  ctx.save(); ctx.beginPath(); ctx.rect(padL, 0, W, h); ctx.clip();
  // plan (programme)
  if (plan) {
    ctx.fillStyle = css('--plan');
    for (const p of plan) ctx.fillRect(X(p.t0), Ys(p.s), Math.max(1, X(p.t1) - X(p.t0) - 1), Ys(0) - Ys(p.s));
    ctx.strokeStyle = inc; ctx.globalAlpha = 0.5; ctx.setLineDash([4, 3]); ctx.beginPath();
    plan.forEach((p, k) => { k ? ctx.lineTo(X(p.t0), Yi(p.i)) : ctx.moveTo(X(p.t0), Yi(p.i)); ctx.lineTo(X(p.t1), Yi(p.i)); });
    ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
  }
  const vis = samples.filter(p => p.t >= x0 - 2);
  if (vis.length > 1) {
    // inclinaison (aire)
    ctx.fillStyle = inc; ctx.globalAlpha = 0.25; ctx.beginPath(); ctx.moveTo(X(vis[0].t), Yi(0));
    vis.forEach(p => ctx.lineTo(X(p.t), Yi(p.i))); ctx.lineTo(X(vis[vis.length - 1].t), Yi(0)); ctx.fill(); ctx.globalAlpha = 1;
    // cardio
    if (vis.some(p => p.h)) {
      ctx.strokeStyle = hrc; ctx.lineWidth = 1.5; ctx.beginPath(); let on = false;
      vis.forEach(p => { if (!p.h) { on = false; return; } on ? ctx.lineTo(X(p.t), Yh(p.h)) : ctx.moveTo(X(p.t), Yh(p.h)); on = true; });
      ctx.stroke();
    }
    // vitesse
    const g = ctx.createLinearGradient(0, padT, 0, padT + H);
    g.addColorStop(0, acc + '55'); g.addColorStop(1, acc + '00');
    ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(X(vis[0].t), Ys(0));
    vis.forEach(p => ctx.lineTo(X(p.t), Ys(p.s))); ctx.lineTo(X(vis[vis.length - 1].t), Ys(0)); ctx.fill();
    ctx.strokeStyle = acc; ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.beginPath();
    vis.forEach((p, k) => k ? ctx.lineTo(X(p.t), Ys(p.s)) : ctx.moveTo(X(p.t), Ys(p.s))); ctx.stroke();
  }
  if (cursor != null) {
    ctx.strokeStyle = css('--txt'); ctx.globalAlpha = 0.6; ctx.lineWidth = 1; ctx.beginPath();
    ctx.moveTo(X(cursor) + 0.5, padT); ctx.lineTo(X(cursor) + 0.5, padT + H); ctx.stroke(); ctx.globalAlpha = 1;
  }
  ctx.restore();
}
function livePlan() {
  if (!prog) return null;
  const out = []; let t = 0;
  prog.steps.forEach((s, i) => {
    const t0 = i < prog.idx || (i === prog.idx && prog.starts[i] != null) ? (prog.starts[i] ?? t) : t;
    let t1;
    if (i < prog.idx) t1 = prog.starts[i + 1] ?? t0 + stepSec(s, prog.k);
    else if (i === prog.idx && !prog.finished && sess.state !== 'idle') t1 = sess.elapsed + Math.max(0, s.mode === 'time' ? stepLeft() : stepLeft() / Math.max(0.5, s.speed * prog.k) * 3.6);
    else t1 = t0 + stepSec(s, prog.k);
    out.push({ t0, t1, s: s.speed * prog.k, i: s.incline }); t = t1;
  });
  return out;
}
function renderChart() {
  const cv = $('#liveChart');
  if (prog) {
    $('#chartTitle').textContent = 'Profil du programme';
    const plan = livePlan();
    drawSession(cv, { samples: sess.samples, plan, x0: 0, x1: Math.max(plan[plan.length - 1].t1, sess.elapsed), cursor: sess.state !== 'idle' ? sess.elapsed : null });
  } else {
    $('#chartTitle').textContent = 'Séance en direct';
    const win = S.chartWindow * 60;
    const x1 = win ? Math.max(win, sess.elapsed) : Math.max(60, sess.elapsed);
    drawSession(cv, { samples: sess.samples, x0: win ? x1 - win : 0, x1 });
  }
}
function drawProfile(cv, def, k = 1) {
  const { ctx, w, h } = setupCanvas(cv);
  const steps = flatten(def); if (!steps.length || !w) return;
  const total = steps.reduce((a, s) => a + stepSec(s, k), 0);
  const sMax = Math.max(...steps.map(s => s.speed * k), 8) * 1.08;
  const acc = css('--accent'), inc = css('--incl');
  let x = 0;
  for (const s of steps) {
    const ww = stepSec(s, k) / total * w, hh = s.speed * k / sMax * (h - 6);
    ctx.globalAlpha = 0.35 + 0.65 * (s.speed * k / sMax);
    ctx.fillStyle = acc; ctx.fillRect(x, h - hh, Math.max(1, ww - 1), hh);
    if (s.incline > 0) { ctx.globalAlpha = 0.9; ctx.fillStyle = inc; ctx.fillRect(x, h - hh - 3, Math.max(1, ww - 1), 3); }
    x += ww;
  }
  ctx.globalAlpha = 1;
}
function drawWeeks(cv) {
  const { ctx, w, h } = setupCanvas(cv);
  const weeks = []; const now = new Date();
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  for (let i = 11; i >= 0; i--) { const d = new Date(monday); d.setDate(d.getDate() - i * 7); weeks.push({ start: +d, km: 0, label: `${d.getDate()}/${d.getMonth() + 1}` }); }
  for (const r of HISTORY) { const wk = weeks.findLast(x => r.date >= x.start); if (wk) wk.km += r.dist / 1000; }
  const max = Math.max(5, ...weeks.map(x => x.km));
  const padB = 20, padT = 16, bw = w / weeks.length;
  ctx.font = '11px Segoe UI, system-ui, sans-serif'; ctx.textAlign = 'center';
  weeks.forEach((x, i) => {
    const hh = x.km / max * (h - padB - padT);
    ctx.fillStyle = css('--accent'); ctx.globalAlpha = i === 11 ? 1 : 0.55;
    const bx = i * bw + bw * 0.18, bwid = bw * 0.64;
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(bx, h - padB - hh, bwid, hh, 4) : ctx.rect(bx, h - padB - hh, bwid, hh); ctx.fill();
    ctx.globalAlpha = 1; ctx.fillStyle = css('--mut'); ctx.fillText(x.label, i * bw + bw / 2, h - 5);
    if (x.km) { ctx.fillStyle = css('--txt'); ctx.fillText(x.km.toFixed(1), i * bw + bw / 2, h - padB - hh - 4); }
  });
}

/* ---------- rendu global ---------- */
let rafPending = false;
function scheduleRender() { if (!rafPending) { rafPending = true; requestAnimationFrame(() => { rafPending = false; renderTiles(); }); } }
function renderLive() { renderTiles(); renderBannerLive(); if ($('#view-run').classList.contains('active')) renderChart(); }
function renderAll() { renderProfileChip(); buildTiles(); buildPresets(); renderTargets(); renderStartBtn(); renderBanner(); renderLive(); renderConn(); }

/* =========================================================================
   Vue Programmes
   ========================================================================= */
let progFilter = store.get('progFilter', 'all');
function renderPlan() {
  const el = $('#programPlan'), ps = planState(), ss = planSessions();
  if (!ss) { el.innerHTML = ''; return; }
  const P = PLANS[ps.key], s = todaySession(), pct = ps.cursor / ss.length * 100;
  const t = s && progTotals(s);
  el.innerHTML = `<div class="card plan">
    <div class="plan-head"><div><span class="tag">📅 Mon plan · ${P.weeks} semaines</span><h2>${esc(P.name)}</h2><p>${esc(P.desc)}</p></div>
      <div class="plan-pct"><b>${Math.round(pct)} %</b><small>${ps.cursor} / ${ss.length} séances</small></div></div>
    <div class="bar"><i style="width:${pct}%"></i></div>
    ${s ? `<div class="plan-today">
      <div><small>Séance du jour · semaine ${s.week}/${P.weeks} · séance ${s.day}/${P.perWeek} · ${esc(phaseOf(ps.key, s.week))}</small>
        <h3>${esc(s.name)}</h3><p>${esc(s.desc)}</p>
        <div class="meta"><span>⏱ <b>${fmtTime(t.sec)}</b></span><span>📏 <b>${(t.m / 1000).toFixed(1)} km</b></span></div></div>
      <canvas id="planChart"></canvas></div>
    <div class="row">
      <button class="btn sm" data-plan="back" title="Revenir au début de la semaine précédente">⏮ Semaine précédente</button>
      <button class="btn sm" data-plan="redo" title="Recommencer la semaine en cours">↺ Refaire la semaine</button>
      <button class="btn sm" data-plan="skip">✔ Marquer comme faite</button>
      <button class="btn sm" data-plan="list">📋 Tout le plan</button>
      <button class="btn primary" data-plan="go">▶ Lancer la séance du jour</button></div>`
    : `<div class="plan-today"><div><h3>🎉 Plan terminé, bravo !</h3><p>Continuez avec les programmes Endurance ou refaites les dernières semaines.</p></div></div>
      <div class="row"><button class="btn sm" data-plan="list">📋 Tout le plan</button><button class="btn sm" data-plan="back">⏮ Semaine précédente</button></div>`}
    <details class="tips"><summary>💡 Conseils</summary><ul>${P.tips.map(x => `<li>${esc(x)}</li>`).join('')}</ul></details>
  </div>`;
  if (s) drawProfile($('#planChart'), s);
}
function planAction(a) {
  const ps = planState(), s = todaySession();
  const weekStart = w => (w - 1) * PLANS[ps.key].perWeek;
  const curWeek = s ? s.week : PLANS[ps.key].weeks + 1;
  if (a === 'go') return planGo();
  if (a === 'skip' && s) setPlanCursor(ps.cursor + 1, s.planIndex);
  if (a === 'redo' && s) setPlanCursor(weekStart(curWeek));
  if (a === 'back') setPlanCursor(weekStart(Math.max(1, curWeek - 1)));
  if (a === 'list') return showPlanList();
  renderPlan(); renderBanner();
}
function showPlanList() {
  const ps = planState(), ss = planSessions(), P = PLANS[ps.key];
  const doneSet = new Set(ps.log.map(l => l.i));
  let html = '';
  for (const [a, b, label] of P.phases) {
    html += `<h3 class="phase">${label} <small>semaines ${a} à ${b}</small></h3>`;
    for (let w = a; w <= b; w++) {
      const list = ss.filter(s => s.week === w);
      html += `<div class="pweek${list.some(s => s.planIndex === ps.cursor) ? ' cur' : ''}"><b>S${w}${list[0].light ? ' <span class="tag">légère</span>' : ''}</b><div>${list.map(s =>
        `<button data-goto="${s.planIndex}" class="${s.planIndex === ps.cursor ? 'now' : s.planIndex < ps.cursor || doneSet.has(s.planIndex) ? 'ok' : ''}" title="Choisir comme séance du jour">${s.planIndex < ps.cursor ? '✔' : s.planIndex === ps.cursor ? '▶' : s.day} ${esc(s.name)}</button>`).join('')}</div></div>`;
    }
  }
  showDialog(`<div class="dlg-head"><h2>📋 ${esc(P.name)}</h2><button class="btn icon" data-close>✕</button></div>
    <div class="dlg-body plan-list">${html}</div>
    <div class="dlg-foot"><span class="help" style="margin-right:auto">Cliquez sur une séance pour en faire la séance du jour.</span><button class="btn primary" data-close>Fermer</button></div>`);
  $('.plan-list').onclick = e => {
    const b = e.target.closest('[data-goto]'); if (!b) return;
    setPlanCursor(+b.dataset.goto); closeDialog(); renderPlan(); renderBanner();
  };
}

function renderPrograms() {
  renderPlan();
  const used = Object.keys(CATS).filter(c => PROGRAMS.some(p => (p.cat || 'perso') === c));
  if (progFilter !== 'all' && !used.includes(progFilter)) progFilter = 'all';
  $('#programFilters').innerHTML = [['all', 'Tous'], ...used.map(c => [c, CATS[c].l])]
    .map(([k, l]) => `<button data-cat="${k}" class="${k === progFilter ? 'sel' : ''}">${l}</button>`).join('');
  const card = p => {
    const t = progTotals(p);
    return `<div class="card pcard" data-id="${p.id}">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:start"><h3>${esc(p.name)}</h3>${p.tag ? `<span class="tag">${esc(p.tag)}</span>` : ''}</div>
      <p>${esc(p.desc || '')}</p>
      <canvas></canvas>
      <div class="meta"><span>⏱ <b>${fmtTime(t.sec)}</b></span><span>📏 <b>${(t.m / 1000).toFixed(2)} km</b></span><span>🔢 <b>${t.steps.length}</b> étapes</span></div>
      <div class="row"><button class="btn sm" data-edit>✏️ Modifier</button><button class="btn sm" data-dup>⧉</button><button class="btn sm primary" data-go>▶ Lancer</button></div>
    </div>`;
  };
  $('#programList').innerHTML = used.filter(c => progFilter === 'all' || c === progFilter).map(c => `<section class="pcat">
      <div class="pcat-head"><h2>${CATS[c].l}</h2><p>${CATS[c].d}</p></div>
      ${c === 'tennis' ? TENNIS_WEEK : ''}
      <div class="grid">${PROGRAMS.filter(p => (p.cat || 'perso') === c).map(card).join('')}</div></section>`).join('')
    || '<div class="card empty">Aucun programme. Créez-en un !</div>';
  $$('#programList .pcard').forEach(c => drawProfile($('canvas', c), PROGRAMS.find(p => p.id === c.dataset.id)));
}
const TENNIS_WEEK = `<div class="card week"><b>📅 Semaine type avec 1 à 2 tennis</b>
  <div class="week-grid">
    <div><small>Lendemain de match</small>Récup lendemain de match <em>ou repos</em></div>
    <div><small>Milieu de semaine (≥ 48 h du match)</small>Intermittent 15/15, Sprints répétés <em>ou</em> Simulation de match</div>
    <div><small>Autre jour libre</small>Endurance 30′/45′ <em>ou</em> Puissance en côte</div>
    <div><small>Veille de match</small>Activation veille de match <em>ou repos</em></div>
  </div>
  <small class="help">Hors saison : ajoutez le Foncier hors saison. Ne faites pas deux séances intenses de suite, le tennis en est déjà une.</small></div>`;

function quickGoal() {
  showDialog(`<div class="dlg-head"><h2>🎯 Objectif rapide</h2><button class="btn icon" data-close>✕</button></div>
    <div class="dlg-body"><div class="settings" style="grid-template-columns:1fr">
      <div class="field"><label>Type d’objectif</label><div class="in"><select id="qType"><option value="time">Durée</option><option value="dist">Distance</option></select></div></div>
      <div class="field"><label>Valeur<small id="qHint">mm:ss ou minutes</small></label><div class="in"><input id="qVal" type="text" value="30:00"></div></div>
      <div class="field"><label>Vitesse</label><div class="in"><input id="qSpd" type="number" step="0.1" value="${S.startSpeed + 4}"><span class="u">km/h</span></div></div>
      <div class="field"><label>Inclinaison</label><div class="in"><input id="qInc" type="number" step="0.5" value="1"><span class="u">%</span></div></div>
      <div class="field"><label>Échauffement 5 min<small>à 7 km/h</small></label><label class="switch"><input id="qWu" type="checkbox" checked><span></span></label></div>
    </div></div>
    <div class="dlg-foot"><button class="btn" data-close>Annuler</button><button class="btn primary" id="qGo">▶ Charger</button></div>`);
  $('#qType').onchange = e => { const d = e.target.value === 'dist'; $('#qVal').value = d ? '5' : '30:00'; $('#qHint').textContent = d ? 'kilomètres' : 'mm:ss ou minutes'; };
  $('#qGo').onclick = () => {
    const type = $('#qType').value, raw = $('#qVal').value;
    const value = type === 'dist' ? Math.round(parseFloat(raw.replace(',', '.')) * 1000) : parseDur(raw);
    const blocks = [];
    if ($('#qWu').checked) blocks.push(st('Échauffement', 'time', 300, 7));
    blocks.push(st('Objectif', type, value, +$('#qSpd').value || 9, +$('#qInc').value || 0));
    closeDialog();
    loadProgram({ name: `Objectif ${type === 'dist' ? r1(value / 1000) + ' km' : fmtDur(value)}`, blocks });
  };
}

/* ---------- éditeur ---------- */
let ed = null;
function openEditor(def) {
  ed = def ? structuredClone(def) : { id: null, cat: 'perso', name: 'Mon programme', desc: '', tag: '', blocks: [st('Échauffement', 'time', 300, 7), st('Course', 'time', 1200, 10)] };
  showDialog(`<div class="dlg-head"><h2>${def ? 'Modifier' : 'Nouveau'} programme</h2><button class="btn icon" data-close>✕</button></div>
    <div class="dlg-body">
      <div class="ed-top"><input class="title" id="eName" placeholder="Nom" value="${esc(ed.name)}"><input id="eTag" placeholder="Étiquette (ex. VMA)" value="${esc(ed.tag || '')}">
        <input id="eDesc" placeholder="Description" value="${esc(ed.desc || '')}">
        <select id="eCat">${Object.entries(CATS).map(([k, c]) => `<option value="${k}"${k === (ed.cat || 'perso') ? ' selected' : ''}>${c.l}</option>`).join('')}</select></div>
      <div class="srow shead" style="padding:0 11px"><span>Étape</span><span>Type</span><span>Durée / m</span><span>km/h</span><span>Pente %</span><span></span></div>
      <div id="eBlocks" class="ed-blocks"></div>
      <div class="ed-add"><button class="btn sm" id="eAddStep">＋ Étape</button><button class="btn sm" id="eAddRep">＋ Bloc répété</button></div>
      <div class="ed-preview"><canvas id="ePrev"></canvas><div class="meta" id="eMeta"></div></div>
    </div>
    <div class="dlg-foot">${def?.id ? '<div class="left"><button class="btn danger" id="eDel">🗑 Supprimer</button></div>' : ''}
      <button class="btn" data-close>Annuler</button><button class="btn" id="eTry">▶ Enregistrer & lancer</button><button class="btn primary" id="eSave">Enregistrer</button></div>`);
  $('#eName').oninput = e => ed.name = e.target.value;
  $('#eTag').oninput = e => ed.tag = e.target.value;
  $('#eDesc').oninput = e => ed.desc = e.target.value;
  $('#eCat').onchange = e => ed.cat = e.target.value;
  $('#eAddStep').onclick = () => { ed.blocks.push(st('Étape', 'time', 120, 9)); renderEditor(); };
  $('#eAddRep').onclick = () => { ed.blocks.push(rep(4, [st('Rapide', 'time', 60, 12), st('Récup', 'time', 60, 7)])); renderEditor(); };
  $('#eSave').onclick = () => { saveEditor(); closeDialog(); };
  $('#eTry').onclick = () => { const p = saveEditor(); closeDialog(); loadProgram(p); };
  if ($('#eDel')) $('#eDel').onclick = () => {
    if (!confirm(`Supprimer « ${ed.name} » ?`)) return;
    PROGRAMS = PROGRAMS.filter(p => p.id !== ed.id); savePrograms(); renderPrograms(); closeDialog();
  };
  const box = $('#eBlocks');
  box.addEventListener('input', onEditorInput);
  box.addEventListener('change', onEditorInput);
  box.addEventListener('click', onEditorClick);
  renderEditor();
}
function stepRow(s, b, k) {
  const val = s.mode === 'time' ? fmtTime(s.value) : s.value;
  return `<div class="srow" data-b="${b}" data-s="${k}">
    <input class="nm" data-f="name" value="${esc(s.name)}" placeholder="Nom">
    <label class="fl"><span>Type</span><select data-f="mode"><option value="time"${s.mode === 'time' ? ' selected' : ''}>Durée</option><option value="dist"${s.mode === 'dist' ? ' selected' : ''}>Distance (m)</option></select></label>
    <label class="fl"><span>${s.mode === 'time' ? 'mm:ss' : 'mètres'}</span><input data-f="value" value="${val}" inputmode="${s.mode === 'time' ? 'text' : 'numeric'}" title="${s.mode === 'time' ? 'mm:ss' : 'mètres'}"></label>
    <label class="fl"><span>km/h</span><input data-f="speed" type="number" inputmode="decimal" step="0.1" min="0.5" max="25" value="${s.speed}"></label>
    <label class="fl"><span>Pente %</span><input data-f="incline" type="number" inputmode="decimal" step="0.5" min="-5" max="20" value="${s.incline}"></label>
    <div class="tools"><button data-op="up" title="Monter">↑</button><button data-op="down" title="Descendre">↓</button><button data-op="dup" title="Dupliquer">⧉</button><button data-op="del" title="Supprimer">✕</button></div>
  </div>`;
}
function renderEditor() {
  $('#eBlocks').innerHTML = ed.blocks.map((b, i) => b.type === 'repeat'
    ? `<div class="eblock rep"><div class="rep-head" data-b="${i}" data-s="-1">🔁 Répéter <input data-f="times" type="number" min="1" max="99" value="${b.times}"> fois
        <div class="srow" style="display:flex;margin-left:auto"><div class="tools"><button data-op="up">↑</button><button data-op="down">↓</button><button data-op="addin" title="Ajouter une étape dans le bloc">＋</button><button data-op="del">✕</button></div></div></div>
        <div class="rep-steps">${b.steps.map((s, k) => stepRow(s, i, k)).join('')}</div></div>`
    : `<div class="eblock">${stepRow(b, i, -1)}</div>`).join('');
  renderEditorPreview();
}
function renderEditorPreview() {
  drawProfile($('#ePrev'), ed);
  const t = progTotals(ed);
  $('#eMeta').innerHTML = `<span>⏱ <b>${fmtTime(t.sec)}</b></span><span>📏 <b>${(t.m / 1000).toFixed(2)} km</b></span><span>🔢 <b>${t.steps.length}</b> étapes</span>`;
}
function edTarget(el) {
  const row = el.closest('[data-b]'); if (!row) return {};
  const b = +row.dataset.b, s = +row.dataset.s;
  return { b, s, list: s < 0 ? ed.blocks : ed.blocks[b].steps, idx: s < 0 ? b : s, obj: s < 0 ? ed.blocks[b] : ed.blocks[b].steps[s] };
}
function onEditorInput(e) {
  const f = e.target.dataset.f; if (!f) return;
  const { obj } = edTarget(e.target); if (!obj) return;
  const v = e.target.value;
  if (f === 'name') obj.name = v;
  else if (f === 'times') obj.times = clamp(parseInt(v) || 1, 1, 99);
  else if (f === 'speed') obj.speed = clamp(parseFloat(v) || 0, 0.5, 25);
  else if (f === 'incline') obj.incline = clamp(parseFloat(v) || 0, -5, 20);
  else if (f === 'value') { if (e.type !== 'change') return; obj.value = obj.mode === 'time' ? Math.max(5, parseDur(v)) : Math.max(10, Math.round(parseFloat(v) || 0)); e.target.value = obj.mode === 'time' ? fmtTime(obj.value) : obj.value; }
  else if (f === 'mode') { if (e.type !== 'change') return; obj.mode = v; obj.value = v === 'time' ? 120 : 400; renderEditor(); return; }
  renderEditorPreview();
}
function onEditorClick(e) {
  const op = e.target.dataset.op; if (!op) return;
  const { list, idx, obj } = edTarget(e.target);
  if (op === 'del') list.splice(idx, 1);
  if (op === 'dup') list.splice(idx + 1, 0, structuredClone(obj));
  if (op === 'up' && idx > 0) [list[idx - 1], list[idx]] = [list[idx], list[idx - 1]];
  if (op === 'down' && idx < list.length - 1) [list[idx + 1], list[idx]] = [list[idx], list[idx + 1]];
  if (op === 'addin') obj.steps.push(st('Étape', 'time', 60, 9));
  ed.blocks = ed.blocks.filter(b => b.type !== 'repeat' || b.steps.length);
  renderEditor();
}
function saveEditor() {
  ed.name = ed.name.trim() || 'Sans titre';
  if (ed.id) PROGRAMS = PROGRAMS.map(p => p.id === ed.id ? ed : p);
  else { ed.id = uid(); PROGRAMS.unshift(ed); }
  savePrograms(); renderPrograms(); toast('Programme enregistré');
  return ed;
}

/* =========================================================================
   Vue Historique
   ========================================================================= */
let HISTORY = store.get('history', []);
const saveHistory = () => store.set('history', HISTORY);
const unpack = r => r.samples.map(([t, s, i, h, d]) => ({ t, s, i, h, d }));

function renderHistory() {
  const H = HISTORY;
  const totKm = H.reduce((a, r) => a + r.dist, 0) / 1000, totSec = H.reduce((a, r) => a + r.sec, 0);
  const week = H.filter(r => r.date > Date.now() - 7 * 864e5).reduce((a, r) => a + r.dist, 0) / 1000;
  const longest = Math.max(0, ...H.map(r => r.dist)) / 1000;
  const best = H.filter(r => r.dist >= 1000).reduce((b, r) => Math.max(b, r.dist / r.sec * 3.6), 0);
  const stat = (l, v, u = '') => `<div class="card stat"><div class="lbl">${l}</div><div class="val">${v}<small>${u}</small></div></div>`;
  $('#histStats').innerHTML = stat('Séances', H.length) + stat('Distance totale', totKm.toFixed(1), 'km') + stat('Temps total', fmtTime(totSec))
    + stat('7 derniers jours', week.toFixed(1), 'km') + stat('Plus longue', longest.toFixed(2), 'km') + stat('Meilleure allure moy.', fmtPace(best), '/km');
  drawWeeks($('#weekChart'));
  $('#histList').innerHTML = H.length ? H.map(r => {
    const d = new Date(r.date);
    return `<button class="card hitem" data-id="${r.id}">
      <div class="d">${d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' })} · ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}<small>${esc(r.program || 'Séance libre')}</small></div>
      <div class="m"><small>Distance</small>${(r.dist / 1000).toFixed(2)} km</div>
      <div class="m"><small>Durée</small>${fmtTime(r.sec)}</div>
      <div class="m"><small>Allure</small>${fmtPace(r.dist / Math.max(1, r.sec) * 3.6)}</div>
      <div class="m opt"><small>D+</small>${r.elev} m</div>
      <div class="m opt"><small>Cardio</small>${r.avgHr || '--'} bpm</div>
    </button>`;
  }).join('') : '<div class="card empty">Pas encore de séance enregistrée. À vous de courir ! 🏃</div>';
}

function showSummary(r, fresh) {
  const d = new Date(r.date);
  const stat = (l, v, u = '') => `<div class="stat"><div class="lbl">${l}</div><div class="val">${v}<small>${u}</small></div></div>`;
  showDialog(`<div class="dlg-head"><h2>${fresh ? '🎉 Séance terminée' : esc(r.program || 'Séance libre')}</h2><button class="btn icon" data-close>✕</button></div>
    <div class="dlg-body">
      <p class="help" style="margin:0 0 12px">${d.toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'short' })}${r.program ? ' · ' + esc(r.program) : ''}</p>
      <div class="sum">${stat('Distance', (r.dist / 1000).toFixed(2), 'km') + stat('Durée', fmtTime(r.sec)) + stat('Allure moy.', fmtPace(r.dist / Math.max(1, r.sec) * 3.6), '/km')
        + stat('Vitesse max', r.maxSpeed, 'km/h') + stat('Dénivelé +', r.elev, 'm') + stat('Calories', r.kcal, 'kcal') + stat('FC moy.', r.avgHr || '--', 'bpm') + stat('FC max', r.maxHr || '--', 'bpm')}</div>
      ${fresh && r.planIndex != null ? `<label class="plan-check"><input type="checkbox" id="xPlan"${r.planOk ? ' checked' : ''}>
        Valider cette séance dans mon plan${r.planOk ? '' : ' <small>(séance incomplète : elle restera la séance du jour si vous décochez)</small>'}</label>` : ''}
      <canvas id="sumChart" height="200"></canvas>
      ${r.splits?.length ? `<p class="help"><b>Temps intermédiaires :</b> ${r.splits.map(s => `${r1(s.d / 1000)} km : ${fmtTime(s.t)}`).join(' · ')}</p>` : ''}
    </div>
    <div class="dlg-foot"><div class="left"><button class="btn sm" id="xTcx">⤓ TCX (Strava, Garmin)</button><button class="btn sm" id="xCsv">⤓ CSV</button></div>
      ${fresh ? '<button class="btn danger" id="xDiscard">Ne pas enregistrer</button><button class="btn primary" id="xSave">Enregistrer</button>'
        : '<button class="btn danger" id="xDel">🗑 Supprimer</button><button class="btn primary" data-close>Fermer</button>'}</div>`, () => { if (fresh && !r._saved && !r._discarded) saveRecord(r); });
  requestAnimationFrame(() => drawSession($('#sumChart'), { samples: unpack(r) }));
  $('#xTcx').onclick = () => download(`run-${d.toISOString().slice(0, 16).replace(/[:T]/g, '-')}.tcx`, toTCX(r), 'application/vnd.garmin.tcx+xml');
  $('#xCsv').onclick = () => download(`run-${d.toISOString().slice(0, 10)}.csv`, toCSV(r), 'text/csv');
  if ($('#xPlan')) $('#xPlan').onchange = e => r.planOk = e.target.checked;
  if (fresh) {
    $('#xSave').onclick = () => { saveRecord(r); closeDialog(); };
    $('#xDiscard').onclick = () => { r._discarded = true; sess = newSession(); renderAll(); closeDialog(); toast('Séance supprimée'); };
  } else {
    $('#xDel').onclick = () => { if (!confirm('Supprimer cette séance ?')) return; HISTORY = HISTORY.filter(x => x.id !== r.id); saveHistory(); renderHistory(); closeDialog(); };
  }
}
function saveRecord(r) {
  r._saved = true;
  const { _saved, ...clean } = r;
  HISTORY.unshift(clean); HISTORY.sort((a, b) => b.date - a.date); saveHistory();
  const ps = planState();
  if (r.planIndex != null && r.planOk && ps) { setPlanCursor(Math.max(ps.cursor, r.planIndex + 1), r.planIndex); prog = null; }
  sess = newSession(); renderAll(); renderHistory();
  toast(r.planIndex != null && r.planOk ? '✅ Séance enregistrée et validée dans le plan' : '✅ Séance enregistrée');
}
function toTCX(r) {
  const iso = t => new Date(r.date + t * 1000).toISOString();
  const pts = unpack(r).map(p => `<Trackpoint><Time>${iso(p.t)}</Time><DistanceMeters>${p.d}</DistanceMeters>${p.h ? `<HeartRateBpm><Value>${p.h}</Value></HeartRateBpm>` : ''}<Extensions><ns3:TPX><ns3:Speed>${(p.s / 3.6).toFixed(3)}</ns3:Speed></ns3:TPX></Extensions></Trackpoint>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2">
<Activities><Activity Sport="Running"><Id>${iso(0)}</Id>
<Lap StartTime="${iso(0)}"><TotalTimeSeconds>${r.sec}</TotalTimeSeconds><DistanceMeters>${r.dist}</DistanceMeters><MaximumSpeed>${(r.maxSpeed / 3.6).toFixed(3)}</MaximumSpeed><Calories>${r.kcal}</Calories>${r.avgHr ? `<AverageHeartRateBpm><Value>${r.avgHr}</Value></AverageHeartRateBpm><MaximumHeartRateBpm><Value>${r.maxHr}</Value></MaximumHeartRateBpm>` : ''}<Intensity>Active</Intensity><TriggerMethod>Manual</TriggerMethod>
<Track>
${pts}
</Track></Lap><Notes>${esc(r.program || 'Séance libre')} — tapis de course (RunStudio)</Notes></Activity></Activities></TrainingCenterDatabase>`;
}
function toCSV(r) {
  return 'temps_s;vitesse_kmh;inclinaison_pct;fc_bpm;distance_m\n' + r.samples.map(x => x.join(';')).join('\n');
}

/* =========================================================================
   Vue Réglages
   ========================================================================= */
const ACCENTS = ['#00d1b2', '#0082c3', '#3b82f6', '#8b5cf6', '#ec4899', '#f43f5e', '#f59e0b', '#22c55e'];
function renderSettings() {
  const field = it => {
    const v = S[it.k];
    const hint = typeof it.h === 'function' ? it.h() : it.h;
    const lbl = `<label>${it.l}${hint ? `<small>${hint}</small>` : ''}</label>`;
    const u = it.u ? `<span class="u">${it.u}</span>` : '';
    switch (it.t) {
      case 'num': return `<div class="field">${lbl}<div class="in"><input type="number" data-k="${it.k}" value="${v}" min="${it.min}" max="${it.max}" step="${it.step}">${u}</div></div>`;
      case 'list': return `<div class="field">${lbl}<div class="in"><input type="text" data-k="${it.k}" data-t="list" value="${v.join(', ')}">${u}</div></div>`;
      case 'range': return `<div class="field">${lbl}<div class="in"><input type="range" data-k="${it.k}" value="${v}" min="${it.min}" max="${it.max}" step="${it.step}"><span class="u">${v}</span></div></div>`;
      case 'bool': return `<div class="field">${lbl}<label class="switch"><input type="checkbox" data-k="${it.k}"${v ? ' checked' : ''}><span></span></label></div>`;
      case 'sel': { const o = typeof it.o === 'function' ? it.o() : it.o; return `<div class="field">${lbl}<div class="in"><select data-k="${it.k}">${o.map(([a, b]) => `<option value="${a}"${String(a) === String(v) ? ' selected' : ''}>${b}</option>`).join('')}</select>${u}</div></div>`; }
      case 'color': return `<div class="field">${lbl}<div class="swatches">${ACCENTS.map(c => `<button data-color="${c}" style="background:${c}" class="${c === S.accent ? 'sel' : ''}" title="${c}"></button>`).join('')}<input type="color" data-k="accent" value="${S.accent}"></div></div>`;
      case 'plan': { const cur = store.get('plan', null)?.key || ''; return `<div class="field">${lbl}<div class="in"><select data-plansel>
        <option value="">Aucun</option>${Object.entries(PLANS).map(([k, p]) => `<option value="${k}"${k === cur ? ' selected' : ''}>${p.name}</option>`).join('')}</select></div></div>`; }
      case 'action': return `<div class="field">${lbl}<button class="btn sm" data-action="${it.k}">▶ Essayer</button></div>`;
      case 'tiles': {
        const order = [...S.tiles, ...Object.keys(TILES).filter(k => !S.tiles.includes(k))];
        return `<div class="field" style="flex-direction:column;align-items:stretch">${lbl}<div class="tilelist">${order.map(k => `<div class="ti${S.tiles.includes(k) ? '' : ' off'}" data-tile="${k}">
          <label class="switch" style="transform:scale(.8)"><input type="checkbox" data-tilechk="${k}"${S.tiles.includes(k) ? ' checked' : ''}><span></span></label><span>${TILES[k].l}</span>
          <button class="btn sm icon" data-tmove="-1">↑</button><button class="btn sm icon" data-tmove="1">↓</button></div>`).join('')}</div></div>`;
      }
    }
  };
  $('#settingsForm').innerHTML = SCHEMA.map(s => `<div class="card sec"><h2>${s.sec}</h2>${s.items.map(field).join('')}</div>`).join('') + `
    <div class="card sec"><h2>💾 Données</h2>
      <div class="field"><label>Sauvegarde complète<small>Réglages, programmes et historique (JSON)</small></label><button class="btn sm" data-action="_export">⤓ Exporter</button></div>
      <div class="field"><label>Restaurer les programmes d’origine<small>Ajoute les programmes fournis manquants</small></label><button class="btn sm" data-action="_presets">↺ Restaurer</button></div>
      <div class="field"><label>Réinitialiser les réglages</label><button class="btn sm danger" data-action="_reset">Réinitialiser</button></div>
    </div>
    <div class="card sec"><h2>❓ Aide</h2><div class="help">
      <p><b>Connexion du Run 500</b> : activez une fois le mode FTMS via l’app Domyos E-Connected, redémarrez le tapis, puis fermez E-Connected avant de vous connecter ici. Navigateurs compatibles : <b>Chrome</b> ou <b>Edge</b> sur PC/Android (sur iPhone : app <b>Bluefy</b>).</p>
      <p><b>Raccourcis clavier</b> : <kbd>Espace</kbd> démarrer/pause · <kbd>↑</kbd><kbd>↓</kbd> vitesse · <kbd>→</kbd><kbd>←</kbd> inclinaison · <kbd>N</kbd> étape suivante · <kbd>1</kbd>…<kbd>9</kbd> vitesses rapides</p>
      <p><b>Sécurité</b> : gardez toujours la clé de sécurité du tapis attachée. Le bouton Stop de l’app envoie un arrêt, mais la clé reste l’arrêt d’urgence.</p>
      <p><b>Export</b> : les fichiers TCX s’importent dans Strava (« Téléverser une activité »), Garmin Connect, Runalyze…</p>
    </div></div>`;
}
function onSettingChange(e) {
  const el = e.target;
  if (el.dataset.plansel != null) {
    if (e.type !== 'change') return;
    const cur = store.get('plan', null);
    if (cur?.cursor && !confirm('Changer de plan efface la progression actuelle. Continuer ?')) { renderSettings(); return; }
    store.set('plan', el.value ? { key: el.value, cursor: 0, log: [] } : null);
    toast(el.value ? 'Plan activé : voir l’onglet Programmes' : 'Plan retiré');
    return;
  }
  if (el.dataset.tilechk) {
    const k = el.dataset.tilechk;
    S.tiles = el.checked ? [...S.tiles, k] : S.tiles.filter(x => x !== k);
  } else if (el.dataset.k) {
    const k = el.dataset.k;
    if (el.type === 'checkbox') S[k] = el.checked;
    else if (el.dataset.t === 'list') { if (e.type !== 'change') return; S[k] = toList(el.value); }
    else if (el.type === 'number' || el.type === 'range') { const n = parseFloat(el.value); if (isNaN(n)) return; S[k] = n; if (el.type === 'range') el.nextElementSibling.textContent = n; }
    else if (el.tagName === 'SELECT') S[k] = isNaN(+el.value) || el.value === '' ? el.value : +el.value;
    else S[k] = el.value;
  } else return;
  saveSettings(); applyTheme(); buildTiles(); buildPresets(); renderTargets(); renderLive();
  if (el.dataset.tilechk || ['accent', 'theme', 'age'].includes(el.dataset.k)) renderSettings();
}
function onSettingClick(e) {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.color) { S.accent = b.dataset.color; saveSettings(); applyTheme(); renderSettings(); renderLive(); return; }
  if (b.dataset.tmove) {
    const k = b.closest('[data-tile]').dataset.tile, i = S.tiles.indexOf(k), j = i + +b.dataset.tmove;
    if (i < 0 || j < 0 || j >= S.tiles.length) return;
    [S.tiles[i], S.tiles[j]] = [S.tiles[j], S.tiles[i]];
    saveSettings(); buildTiles(); renderTiles(); renderSettings(); return;
  }
  const a = b.dataset.action;
  if (a === '_export') exportAll();
  if (a === '_presets') {
    const names = new Set(PROGRAMS.map(p => p.name));
    const add = makePresetPrograms().filter(p => !names.has(p.name));
    PROGRAMS.push(...add); savePrograms(); renderPrograms(); toast(`${add.length} programme(s) restauré(s)`);
  }
  if (a === '_reset' && confirm('Réinitialiser tous les réglages ?')) { S = { ...DEFAULTS }; saveSettings(); applyTheme(); renderAll(); renderSettings(); }
  const it = SCHEMA.flatMap(s => s.items).find(i => i.k === a);
  if (it?.a) it.a();
}
function exportAll() {
  download(`runstudio-${PROFILE.name.toLowerCase().replace(/\W+/g, '-')}-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ app: 'RunStudio', v: 2, profile: PROFILE, settings: S, programs: PROGRAMS, history: HISTORY, plan: planState() }), 'application/json');
}
function importAll(file) {
  const fr = new FileReader();
  fr.onload = () => {
    try {
      const d = JSON.parse(fr.result);
      if (d.settings) { S = { ...DEFAULTS, ...d.settings }; saveSettings(); }
      if (d.plan) store.set('plan', d.plan);
      if (Array.isArray(d.programs)) { const ids = new Set(PROGRAMS.map(p => p.id)); PROGRAMS.push(...d.programs.filter(p => !ids.has(p.id))); savePrograms(); }
      if (Array.isArray(d.history)) { const ids = new Set(HISTORY.map(r => r.id)); HISTORY.push(...d.history.filter(r => !ids.has(r.id))); HISTORY.sort((a, b) => b.date - a.date); saveHistory(); }
      applyTheme(); renderAll(); renderPrograms(); renderHistory(); renderSettings();
      toast('✅ Sauvegarde restaurée');
    } catch { toast('Fichier invalide'); }
  };
  fr.readAsText(file);
}

/* =========================================================================
   Dialogues, navigation, écran, clavier
   ========================================================================= */
let dlgOnClose = null;
function showDialog(html, onClose) {
  const d = $('#dlg');
  if (d.open) { d.close(); }
  d.innerHTML = html; dlgOnClose = onClose || null;
  d.showModal();
}
function closeDialog() { const d = $('#dlg'); if (d.open) d.close(); }
$('#dlg').addEventListener('close', () => { const f = dlgOnClose; dlgOnClose = null; f?.(); });
$('#dlg').addEventListener('click', e => { if (e.target.closest('[data-close]') || e.target === $('#dlg')) closeDialog(); });

function switchView(v) {
  $$('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  $$('.view').forEach(s => s.classList.toggle('active', s.id === 'view-' + v));
  if (v === 'programs') renderPrograms();
  if (v === 'history') renderHistory();
  if (v === 'settings') renderSettings();
  if (v === 'run') renderChart();
}

async function requestWake() {
  if (!S.wakeLock || wakeLock || !navigator.wakeLock) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => wakeLock = null); } catch { /* refusé */ }
}
function releaseWake() { wakeLock?.release(); wakeLock = null; }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && sess.state === 'running') requestWake(); });

/* ---------- événements ---------- */
$$('.tabs button').forEach(b => b.onclick = () => switchView(b.dataset.view));
$('#btnDevice').onclick = openDeviceDialog;
$('#btnProfile').onclick = openProfiles;
$('#btnHr').onclick = connectHr;
$('#btnStart').onclick = startPause;
$('#btnStop').onclick = stopSession;
$('#view-run').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const a = b.dataset.act;
  if (a === 'spd+') setTargetSpeed(target.speed + S.speedStep);
  if (a === 'spd-') setTargetSpeed(target.speed - S.speedStep);
  if (a === 'inc+') setTargetIncline(target.incline + S.inclineStep);
  if (a === 'inc-') setTargetIncline(target.incline - S.inclineStep);
  if (b.dataset.spd) setTargetSpeed(+b.dataset.spd);
  if (b.dataset.inc) setTargetIncline(+b.dataset.inc);
  if (b.dataset.int) changeIntensity(+b.dataset.int);
  if (b.dataset.pstep) gotoStep(prog.idx + +b.dataset.pstep);
  if (b.id === 'bUnload') unloadProgram();
  if (b.dataset.plan) planAction(b.dataset.plan);
});
$('#programPlan').addEventListener('click', e => { const b = e.target.closest('[data-plan]'); if (b) planAction(b.dataset.plan); });
$('#programList').addEventListener('click', e => {
  const c = e.target.closest('.pcard'); if (!c) return;
  const p = PROGRAMS.find(x => x.id === c.dataset.id);
  if (e.target.closest('[data-go]')) loadProgram(p);
  else if (e.target.closest('[data-edit]')) openEditor(p);
  else if (e.target.closest('[data-dup]')) { const cp = { ...structuredClone(p), id: uid(), name: p.name + ' (copie)', builtin: false }; PROGRAMS.splice(PROGRAMS.indexOf(p) + 1, 0, cp); savePrograms(); renderPrograms(); }
});
$('#programFilters').addEventListener('click', e => {
  const b = e.target.closest('[data-cat]'); if (!b) return;
  progFilter = b.dataset.cat; store.set('progFilter', progFilter); renderPrograms();
});
$('#btnNewProgram').onclick = () => openEditor(null);
$('#btnQuickGoal').onclick = quickGoal;
$('#histList').addEventListener('click', e => { const b = e.target.closest('[data-id]'); if (b) showSummary(HISTORY.find(r => r.id === b.dataset.id), false); });
$('#btnExportAll').onclick = exportAll;
$('#fileImport').onchange = e => { if (e.target.files[0]) importAll(e.target.files[0]); e.target.value = ''; };
$('#settingsForm').addEventListener('input', onSettingChange);
$('#settingsForm').addEventListener('change', onSettingChange);
$('#settingsForm').addEventListener('click', onSettingClick);

document.addEventListener('keydown', e => {
  if (e.target.closest('input,select,textarea') || $('#dlg').open) return;
  if (e.code === 'Space') { e.preventDefault(); startPause(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); setTargetSpeed(target.speed + S.speedStep); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); setTargetSpeed(target.speed - S.speedStep); }
  else if (e.key === 'ArrowRight') setTargetIncline(target.incline + S.inclineStep);
  else if (e.key === 'ArrowLeft') setTargetIncline(target.incline - S.inclineStep);
  else if (e.key.toLowerCase() === 'n' && prog && sess.state !== 'idle') gotoStep(prog.idx + 1);
  else if (/^[1-9]$/.test(e.key) && S.speedPresets[+e.key - 1] != null) setTargetSpeed(S.speedPresets[+e.key - 1]);
});
window.addEventListener('resize', () => { renderChart(); if ($('#view-programs').classList.contains('active')) renderPrograms(); if ($('#view-history').classList.contains('active')) drawWeeks($('#weekChart')); });
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (S.theme === 'auto') { applyTheme(); renderLive(); } });
window.addEventListener('beforeunload', e => { if (sess.state === 'running' || sess.state === 'paused') { e.preventDefault(); e.returnValue = ''; } });
if ('speechSynthesis' in window) speechSynthesis.getVoices();

/* ---------- démarrage ---------- */
applyTheme();
renderAll();
setInterval(tick, 1000);
if (location.hostname === 'localhost') setInterval(() => fetch('/ping').catch(() => {}), 30e3); // garde le serveur local en vie
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
