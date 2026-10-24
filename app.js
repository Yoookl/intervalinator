/* ---------- Hilfsfunktionen ---------- */
function el(tag, props, children){
  const e = document.createElement(tag);
  if(props) Object.entries(props).forEach(([k,v]) => {
    if(k === 'style') Object.assign(e.style, v);
    else if(k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
    else e.setAttribute(k, v);
  });
  (children||[]).forEach(c => e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
  return e;
}
function uid(){ return Math.random().toString(36).slice(2,9); }
function deepClone(x){ return JSON.parse(JSON.stringify(x)); }

function showError(msg){
  try{
    const b = document.getElementById('errorBanner');
    if(b){ b.style.display = 'block'; b.textContent = t('error.prefix') + msg; }
  }catch(e){ /* nichts weiter möglich */ }
}
window.addEventListener('error', (e) => showError((e && e.message) || t('error.unknown')));
window.addEventListener('unhandledrejection', (e) => {
  const reason = e && e.reason;
  showError((reason && (reason.message || String(reason))) || t('error.unknownPromise'));
});

/* ---------- i18n ---------- */
const SUPPORTED_LANGUAGES = ['en','fr','es','de'];
const translationsCache = {};
let currentLanguage = 'en';

async function fetchTranslations(lang){
  const res = await fetch(`locales/${lang}.json`);
  if(!res.ok) throw new Error('Sprachdatei nicht gefunden: ' + lang);
  return res.json();
}

async function loadLanguage(lang){
  if(!SUPPORTED_LANGUAGES.includes(lang)) lang = 'en';
  if(!translationsCache.en){
    try{ translationsCache.en = await fetchTranslations('en'); }
    catch(e){ translationsCache.en = {}; }
  }
  if(!translationsCache[lang]){
    try{ translationsCache[lang] = await fetchTranslations(lang); }
    catch(e){ translationsCache[lang] = {}; }
  }
  currentLanguage = lang;
  document.documentElement.setAttribute('lang', lang);
}

function t(key, vars){
  const dict = translationsCache[currentLanguage] || {};
  const fallback = translationsCache.en || {};
  let str = (key in dict) ? dict[key] : (key in fallback ? fallback[key] : key);
  if(vars){
    Object.entries(vars).forEach(([k,v]) => {
      str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
    });
  }
  return str;
}

function detectInitialLanguage(){
  try{
    const stored = localStorage.getItem('intervalinator-lang');
    if(stored && SUPPORTED_LANGUAGES.includes(stored)) return stored;
  }catch(e){}
  const nav = ((navigator.language || 'en').split('-')[0] || 'en').toLowerCase();
  return SUPPORTED_LANGUAGES.includes(nav) ? nav : 'en';
}

async function setLanguage(lang){
  if(!SUPPORTED_LANGUAGES.includes(lang)) lang = 'en';
  await loadLanguage(lang);
  try{ localStorage.setItem('intervalinator-lang', lang); }catch(e){}
  settings.language = lang;
  scheduleSettingsPersist();
  render();
}

/* ---------- Firebase ---------- */
const firebaseConfig = {
  apiKey: "AIzaSyDx4AS5Z1d2WiiV8FFRrSfVdVTIuatKgKY",
  authDomain: "intervalinator.firebaseapp.com",
  projectId: "intervalinator",
  storageBucket: "intervalinator.firebasestorage.app",
  messagingSenderId: "209669642529",
  appId: "1:209669642529:web:1efa66e2d9b34582d2c660"
};
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();
auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);

let authReady = false;
let authUser = null;
let authMode = 'login'; // 'login' | 'register'
let authError = '';
let authInfo = '';
let authBusy = false;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function translateAuthError(e){
  const map = {
    'auth/invalid-email': 'authError.invalidEmail',
    'auth/user-disabled': 'authError.userDisabled',
    'auth/user-not-found': 'authError.userNotFound',
    'auth/wrong-password': 'authError.wrongPassword',
    'auth/invalid-credential': 'authError.invalidCredential',
    'auth/email-already-in-use': 'authError.emailInUse',
    'auth/weak-password': 'authError.weakPassword',
    'auth/too-many-requests': 'authError.tooManyRequests',
    'auth/network-request-failed': 'authError.networkFailed'
  };
  const key = map[e.code];
  return key ? t(key) : (e.message || t('authError.unknown'));
}

async function handleLogin(email, password){
  authError = ''; authInfo = ''; authBusy = true; render();
  try{
    await auth.signInWithEmailAndPassword(email, password);
  }catch(e){
    authError = translateAuthError(e);
  }
  authBusy = false;
  render();
}

async function handleRegister(email, password){
  authError = ''; authInfo = ''; authBusy = true; render();
  try{
    await auth.createUserWithEmailAndPassword(email, password);
  }catch(e){
    authError = translateAuthError(e);
  }
  authBusy = false;
  render();
}

async function handleLogout(){
  await auth.signOut();
}

async function handlePasswordReset(email){
  authError = ''; authInfo = '';
  if(!email){ authError = t('auth.resetEmailMissing'); render(); return; }
  try{
    await auth.sendPasswordResetEmail(email);
    authInfo = t('auth.resetEmailSent');
  }catch(e){
    authError = translateAuthError(e);
  }
  render();
}

/* ---------- Profil (Passwort aendern, Account loeschen) ---------- */
let profileError = '';
let profileInfo = '';

async function handleChangePassword(currentPw, newPw){
  profileError = ''; profileInfo = '';
  if(!currentPw || !newPw){ profileError = t('auth.fillBoth'); render(); return; }
  if(newPw.length < 8){ profileError = t('auth.passwordTooShort'); render(); return; }
  try{
    const cred = firebase.auth.EmailAuthProvider.credential(authUser.email, currentPw);
    await authUser.reauthenticateWithCredential(cred);
    await authUser.updatePassword(newPw);
    profileInfo = t('profile.passwordChanged');
  }catch(e){
    profileError = translateAuthError(e);
  }
  render();
}

async function handleDeleteAccount(password){
  profileError = '';
  try{
    const cred = firebase.auth.EmailAuthProvider.credential(authUser.email, password);
    await authUser.reauthenticateWithCredential(cred);
    const uid = authUser.uid;
    const batch = db.batch();
    const sessionsSnap = await db.collection('users').doc(uid).collection('sessions').get();
    sessionsSnap.forEach(doc => batch.delete(doc.ref));
    batch.delete(db.collection('users').doc(uid));
    await batch.commit();
    await authUser.delete();
    // auth.onAuthStateChanged uebernimmt danach das Zuruecksetzen von state/settings.
  }catch(e){
    profileError = translateAuthError(e);
    render();
  }
}

/* ---------- Daten ---------- */
const MUSCLE_GROUP_IDS = ["warmup","chest","back","shoulders","biceps","triceps","legs","abs","fullbody","cardio","stretch","other"];
// Migriert alte, direkt als deutscher Anzeigetext gespeicherte Muskelgruppen-Werte (Schema v1) auf stabile IDs.
const LEGACY_MUSCLE_MAP = {
  "Brust":"chest", "Rücken":"back", "Schultern":"shoulders", "Bizeps":"biceps", "Trizeps":"triceps",
  "Beine":"legs", "Bauch":"abs", "Ganzkörper":"fullbody", "Cardio":"cardio", "Sonstiges":"other"
};

const CURRENT_PLAN_SCHEMA_VERSION = 5;
const DEFAULT_WARMUP_SECONDS = 60;
const DEFAULT_STRETCH_SECONDS = 120;

function makeExercise(name, muscle, sets, seconds){
  return { name, muscle, sets, seconds, pauseAfterOverride:null, setPauseOverride:null };
}
// Aufwaermen/Dehnen sind bewusst ganz normale Uebungen (kein Sonderfall) -
// vorbelegt mit 1 Satz und 60/120 Sek., aber genauso frei editier-/loesch-/verschiebbar wie jede andere.
function makeDay(name, exercises){
  return { name, exercises: [
    makeExercise("Aufwärmen", "warmup", 1, DEFAULT_WARMUP_SECONDS),
    ...exercises,
    makeExercise("Dehnen", "stretch", 1, DEFAULT_STRETCH_SECONDS),
  ]};
}

// Neue Accounts starten komplett leer - kein Beispielplan mehr.
// Der Weg zum ersten Plan fuehrt bewusst ueber "Trainingsziele festlegen" (generiert oder manuell).
const DEFAULT_PLAN = {
  schemaVersion: CURRENT_PLAN_SCHEMA_VERSION,
  setPauseSeconds: 60,
  pauseSeconds: 15,
  soundOn: true,
  days: []
};

const state = {
  plan: deepClone(DEFAULT_PLAN),
  screen: 'main', // 'main' (Tabs) | 'onboarding' | 'finished'
  activeDayId: null, // im Training-Tab gewaehlter Tag (null = der faellige)
  running: false,
  stepIndex: 0,
  remaining: 0,
  paused: false,
  intervalId: null,
  currentDayName: ''
};
ensureIds();

function ensureIds(){
  state.plan.days.forEach(d => {
    if(!d.id) d.id = uid();
    d.exercises.forEach(ex => { if(!ex.id) ex.id = uid(); });
  });
}

// Bringt einen aus Firestore geladenen Plan (ggf. altes Schema) auf CURRENT_PLAN_SCHEMA_VERSION.
// Jede künftige Schema-Aenderung bekommt hier einen eigenen "if(version < X)"-Migrationsschritt.
function migratePlan(plan){
  let version = plan.schemaVersion || 1;
  if(version < 2){
    (plan.days || []).forEach(d => {
      (d.exercises || []).forEach(ex => {
        if(ex.muscle && LEGACY_MUSCLE_MAP[ex.muscle]) ex.muscle = LEGACY_MUSCLE_MAP[ex.muscle];
      });
    });
    version = 2;
  }
  if(version < 3){
    (plan.days || []).forEach(d => {
      (d.exercises || []).forEach(ex => {
        if(ex.pauseAfterOverride === undefined) ex.pauseAfterOverride = null;
        if(ex.setPauseOverride === undefined) ex.setPauseOverride = null;
      });
    });
    version = 3;
  }
  if(version < 4){
    // v3 bildete Aufwaermen/Dehnen kurzzeitig als eigene "Sätze" (type:'warmup'/'stretch') ab.
    // Seit v4 sind das wieder simple Tages-Felder (warmupSeconds/stretchSeconds).
    const legacyWarmup = plan.warmupSeconds; // nur bei sehr alten (v1/v2) Dokumenten vorhanden
    const legacyStretch = plan.stretchSeconds;
    (plan.days || []).forEach(d => {
      d.exercises = d.exercises || [];
      let warmupSeconds = null;
      let stretchSeconds = null;
      d.exercises = d.exercises.filter(ex => {
        if(ex.type === 'warmup'){ warmupSeconds = ex.seconds; return false; }
        if(ex.type === 'stretch'){ stretchSeconds = ex.seconds; return false; }
        delete ex.type;
        return true;
      });
      d.warmupSeconds = warmupSeconds != null ? warmupSeconds : (legacyWarmup > 0 ? legacyWarmup : DEFAULT_WARMUP_SECONDS);
      d.stretchSeconds = stretchSeconds != null ? stretchSeconds : (legacyStretch > 0 ? legacyStretch : DEFAULT_STRETCH_SECONDS);
    });
    delete plan.warmupSeconds;
    delete plan.stretchSeconds;
    version = 4;
  }
  if(version < 5){
    // Aufwaermen/Dehnen sind kein Sonderfall mehr, sondern ganz normale (vorbelegte) Uebungen.
    (plan.days || []).forEach(d => {
      d.exercises = d.exercises || [];
      const warmupSeconds = d.warmupSeconds != null ? d.warmupSeconds : DEFAULT_WARMUP_SECONDS;
      const stretchSeconds = d.stretchSeconds != null ? d.stretchSeconds : DEFAULT_STRETCH_SECONDS;
      d.exercises.unshift(makeExercise(t('timer.warmup'), 'warmup', 1, warmupSeconds));
      d.exercises.push(makeExercise(t('timer.stretch'), 'stretch', 1, stretchSeconds));
      delete d.warmupSeconds;
      delete d.stretchSeconds;
    });
    version = 5;
  }
  plan.schemaVersion = CURRENT_PLAN_SCHEMA_VERSION;
  return plan;
}

/* ---------- Speicher (Firestore pro Benutzer, mit lokalem Cache als Fallback) ---------- */
let saveTimeout = null;

function localCacheKey(){
  return authUser ? `training-timer-plan-v1-${authUser.uid}` : null;
}

function userDocRef(){
  return db.collection('users').doc(authUser.uid);
}

function schedulePersist(){
  if(!authUser) return;
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(persistPlan, 400);
}

async function persistPlan(){
  if(!authUser) return;
  try{
    await userDocRef().set({
      plan: state.plan,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    const key = localCacheKey();
    if(key){ try{ localStorage.setItem(key, JSON.stringify(state.plan)); }catch(e){} }
    showSaveStatus(true);
  }catch(e){
    showSaveStatus(false);
  }
}

function showSaveStatus(ok){
  const t_ = document.getElementById('saveToast');
  if(!t_) return;
  t_.textContent = ok ? t('common.save.ok') : t('common.save.fail');
  t_.style.color = ok ? '' : 'var(--danger)';
  t_.classList.add('show');
  clearTimeout(showSaveStatus._t);
  showSaveStatus._t = setTimeout(()=>t_.classList.remove('show'), 1400);
}

/* ---------- Einstellungen (Theme/Sprache, Konto-uebergreifend) ---------- */
let settings = { theme: null, language: null };
let settingsSaveTimeout = null;

// 'system' (bzw. kein gespeicherter Wert) folgt der Einstellung des Geraets.
function applyTheme(theme){
  if(theme === 'system'){
    document.documentElement.removeAttribute('data-theme');
    try{ localStorage.removeItem('intervalinator-theme'); }catch(e){}
    return;
  }
  if(theme !== 'light' && theme !== 'dark') return;
  document.documentElement.setAttribute('data-theme', theme);
  try{ localStorage.setItem('intervalinator-theme', theme); }catch(e){}
}

function scheduleSettingsPersist(){
  if(!authUser) return;
  clearTimeout(settingsSaveTimeout);
  settingsSaveTimeout = setTimeout(persistSettings, 400);
}

async function persistSettings(){
  if(!authUser) return;
  try{
    await userDocRef().set({ settings }, { merge: true });
  }catch(e){ /* Einstellungen sind sekundaer, kein User-Feedback noetig */ }
}

/* ---------- Onboarding (Trainingsziele) ---------- */
const EQUIPMENT_IDS = ["dumbbells","barbell","resistance_bands","pullup_bar","bench","kettlebell","machines","bodyweight_only","cardio_equipment"];
const FOCUS_IDS = ["strength","hypertrophy","endurance","weight_loss","mobility","general_fitness"];

let onboarding = { equipment: [], focus: [], constraints: '', daysPerWeek: null, sessionMinutes: null, completed: false };
let onboardingCardDismissed = false;
let onboardingSaveTimeout = null;

function scheduleOnboardingPersist(){
  if(!authUser) return;
  clearTimeout(onboardingSaveTimeout);
  onboardingSaveTimeout = setTimeout(persistOnboarding, 400);
}

async function persistOnboarding(){
  if(!authUser) return;
  try{
    await userDocRef().set({
      onboarding: { ...onboarding, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }
    }, { merge: true });
  }catch(e){ /* Onboarding-Daten sind sekundaer, kein User-Feedback noetig */ }
}

/* ---------- Trainingsplan-Generator (Uebungs-Bibliothek + Zusammenstell-Logik) ---------- */
let exerciseLibrary = null;
let exerciseLibraryPromise = null;

function loadExerciseLibrary(){
  if(!exerciseLibraryPromise){
    exerciseLibraryPromise = fetch('data/exercises.json').then(res => {
      if(!res.ok) throw new Error('exercise library not found');
      return res.json();
    }).then(data => { exerciseLibrary = data; return data; });
  }
  return exerciseLibraryPromise;
}

const FOCUS_PARAMS = {
  strength: { sets: 4, seconds: 40 },
  hypertrophy: { sets: 4, seconds: 35 },
  endurance: { sets: 3, seconds: 25 },
  weight_loss: { sets: 3, seconds: 30 },
  mobility: { sets: 2, seconds: 35 },
  general_fitness: { sets: 3, seconds: 30 }
};

function resolveSetsSeconds(focusArray){
  const rows = (focusArray && focusArray.length ? focusArray : ['general_fitness'])
    .map(f => FOCUS_PARAMS[f] || FOCUS_PARAMS.general_fitness);
  const avg = key => rows.reduce((sum, r) => sum + r[key], 0) / rows.length;
  return {
    sets: Math.max(2, Math.round(avg('sets'))),
    seconds: Math.max(15, Math.round(avg('seconds') / 5) * 5)
  };
}

function clampDaysPerWeek(daysPerWeek){
  if(!(daysPerWeek > 0)) return 3; // Standard, falls nichts angegeben
  return Math.max(1, Math.min(6, Math.round(daysPerWeek))); // Deckel bei 6, damindestens ein Ruhetag bleibt
}

// Slot-Anzahl je Tag an die gewuenschte Einheiten-Dauer anpassen (Basis: ~50 Min. fuer die Standard-Slotzahl).
function slotCountAdjustment(sessionMinutes){
  const m = sessionMinutes > 0 ? sessionMinutes : 50;
  if(m <= 30) return -2;
  if(m <= 40) return -1;
  if(m >= 90) return 2;
  if(m >= 70) return 1;
  return 0;
}
function applyDurationAdjustment(slots, sessionMinutes){
  const adj = slotCountAdjustment(sessionMinutes);
  let result = slots.slice();
  if(adj < 0){
    result = result.slice(0, Math.max(3, result.length + adj));
  } else if(adj > 0 && result.length > 0){
    for(let i = 0; i < adj; i++) result.push(result[0]);
  }
  return result;
}

const SPLIT_SLOTS = {
  full_body: ['legs','legs','chest','back','shoulders','abs'],
  upper: ['chest','chest','back','back','shoulders','biceps','triceps'],
  lower: ['legs','legs','legs','legs','abs','abs'],
  push: ['chest','chest','shoulders','shoulders','triceps','triceps'],
  pull: ['back','back','back','biceps','biceps'],
  legs: ['legs','legs','legs','legs','abs','abs']
};

function decideSplit({ equipment, focus, daysPerWeek, sessionMinutes }){
  const dayCount = clampDaysPerWeek(daysPerWeek);
  const wantsStrengthFocus = focus.includes('strength') || focus.includes('hypertrophy');
  const wantsCardioFinisher = focus.includes('weight_loss') || focus.includes('endurance');

  let pattern; // array of {key,nameKey,nameVars}
  if(dayCount <= 2){
    pattern = Array.from({length: dayCount}, (_, i) => ({ key:'full_body', nameKey:'splitDay.fullBody', nameVars:{n:i+1} }));
  } else if(dayCount === 3){
    pattern = wantsStrengthFocus
      ? [{key:'push', nameKey:'splitDay.push'}, {key:'pull', nameKey:'splitDay.pull'}, {key:'legs', nameKey:'splitDay.legs'}]
      : Array.from({length:3}, (_, i) => ({ key:'full_body', nameKey:'splitDay.fullBody', nameVars:{n:i+1} }));
  } else if(dayCount === 4){
    pattern = [
      {key:'upper', nameKey:'splitDay.upper'}, {key:'lower', nameKey:'splitDay.lower'},
      {key:'upper', nameKey:'splitDay.upper'}, {key:'lower', nameKey:'splitDay.lower'}
    ];
  } else {
    const cycle = [
      {key:'push', nameKey:'splitDay.push'}, {key:'pull', nameKey:'splitDay.pull'}, {key:'legs', nameKey:'splitDay.legs'}
    ];
    pattern = Array.from({length: dayCount}, (_, i) => cycle[i % 3]);
  }

  const days = pattern.map(p => {
    let slots = SPLIT_SLOTS[p.key].slice();
    if(wantsCardioFinisher) slots.push('cardio');
    slots = applyDurationAdjustment(slots, sessionMinutes);
    return { nameKey: p.nameKey, nameVars: p.nameVars, slots };
  });
  return { days };
}

// Eine Uebung passt nur, wenn ALLE ihre benoetigten Geraete auch ausgewaehlt wurden (nicht nur irgendeins) -
// z.B. Bankdruecken braucht wirklich Langhantel UND Bank, nicht nur eines von beiden.
function matchesEquipment(entry, equipment){
  return entry.equipment.every(id => equipment.includes(id));
}
function isPureBodyweight(entry){
  return entry.equipment.length === 1 && entry.equipment[0] === 'bodyweight_only';
}

function pickExercisesForSlots(slots, library, equipment, focus, usedIds){
  const picked = [];
  slots.forEach(muscle => {
    let candidates = library.filter(e => e.muscle === muscle && matchesEquipment(e, equipment));
    if(candidates.length === 0){
      // Fallback: reine Koerpergewichtsuebungen fuer diese Gruppe, damit ein Slot nie leer bleibt
      // (unabhaengig davon, ob "Nur Koerpergewicht" explizit angehakt wurde).
      candidates = library.filter(e => e.muscle === muscle && isPureBodyweight(e));
    }
    if(candidates.length === 0) return; // Bibliothek deckt diese Gruppe gar nicht ab - Slot auslassen statt abzustuerzen
    const preferred = candidates.filter(e => e.focus.some(f => focus.includes(f)));
    const pool = preferred.length ? preferred : candidates;
    const fresh = pool.filter(e => !usedIds.has(e.id));
    const finalPool = fresh.length ? fresh : pool;
    const chosen = finalPool[Math.floor(Math.random() * finalPool.length)];
    usedIds.add(chosen.id);
    picked.push(chosen);
  });
  return picked;
}

function generatePlanDays(onboardingData, library){
  const equipment = onboardingData.equipment || [];
  const focus = onboardingData.focus || [];
  const splitPlan = decideSplit({ equipment, focus, daysPerWeek: onboardingData.daysPerWeek, sessionMinutes: onboardingData.sessionMinutes });
  const { sets, seconds } = resolveSetsSeconds(focus);
  const usedIds = new Set();
  return splitPlan.days.map(d => {
    const picked = pickExercisesForSlots(d.slots, library, equipment, focus, usedIds);
    const exercises = picked.map(entry => makeExercise(entry.name, entry.muscle, sets, seconds));
    return makeDay(t(d.nameKey, d.nameVars), exercises);
  });
}

let onboardingGenerating = false;
let onboardingGenerateError = '';

async function runGeneration(){
  onboardingGenerateError = '';
  onboardingGenerating = true; render();
  let library;
  try{
    library = exerciseLibrary || await loadExerciseLibrary();
  }catch(e){
    onboardingGenerating = false;
    onboardingGenerateError = t('onboarding.libraryLoadError');
    render();
    return;
  }
  state.plan.days = generatePlanDays(onboarding, library);
  ensureIds();
  onboarding.completed = true;
  onboardingGenerating = false;
  persistOnboarding();
  await persistPlan();
  state.activeDayId = null;
  ui.tab = 'train';
  state.screen = 'main';
  render();
}

function openRegeneratePlanModal(onConfirm){
  openModal((close) => {
    const wrap = el('div', {});
    wrap.appendChild(el('div', {class:'modal-title'}, [t('onboarding.regenerateModalTitle')]));
    wrap.appendChild(el('div', {class:'sub'}, [t('onboarding.regenerateModalText')]));
    const actions = el('div', {class:'modal-actions'});
    const cancelBtn = el('button', {class:'btn'}, [t('common.cancel')]);
    cancelBtn.addEventListener('click', close);
    const confirmBtn = el('button', {class:'btn btn-primary'}, [t('onboarding.regenerateModalConfirm')]);
    confirmBtn.addEventListener('click', () => { close(); onConfirm(); });
    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    wrap.appendChild(actions);
    return wrap;
  });
}

async function loadPlanForCurrentUser(){
  const key = localCacheKey();
  try{
    const doc = await userDocRef().get();
    const data = doc.exists ? doc.data() : null;
    if(data && data.plan){
      state.plan = migratePlan(data.plan);
    } else {
      state.plan = deepClone(DEFAULT_PLAN);
      ensureIds();
      await persistPlan();
    }
    if(data && data.settings){
      settings = data.settings;
      if(settings.language && settings.language !== currentLanguage){
        await loadLanguage(settings.language);
      }
      if(settings.theme) applyTheme(settings.theme);
    }
    if(data && data.onboarding){
      onboarding = Object.assign({ equipment: [], focus: [], constraints: '', daysPerWeek: null, sessionMinutes: null, completed: false }, data.onboarding);
    } else {
      onboarding = { equipment: [], focus: [], constraints: '', daysPerWeek: null, sessionMinutes: null, completed: false };
    }
    onboardingCardDismissed = false;
  }catch(e){
    if(key){
      try{
        const raw = localStorage.getItem(key);
        state.plan = raw ? migratePlan(JSON.parse(raw)) : deepClone(DEFAULT_PLAN);
      }catch(e2){ state.plan = deepClone(DEFAULT_PLAN); }
    } else {
      state.plan = deepClone(DEFAULT_PLAN);
    }
  }
  ensureIds();
  state.activeDayId = null;
  render();
}

/* ---------- Audio ---------- */
// Warum so aufwendig: Wenn eine andere App (z.B. Musik) kurz die Audio-Ausgabe uebernimmt, setzt
// iOS/Safari den AudioContext auf 'interrupted' oder 'suspended'. Ein resume() ohne Nutzergeste
// wird dann oft ignoriert, und manchmal bleibt der Kontext sogar auf 'running' stehen, ohne dass
// seine Uhr weiterlaeuft (kein Ton). Zuverlaessig hilft nur: bei der naechsten Beruehrung den
// Kontext neu anlegen. Solange der Ton blockiert ist, zeigt der Timer einen Hinweis zum Antippen.
let audioCtx = null;
let audioClockCheck = null; // { ctxTime, wallTime } - erkennt einen "haengenden" Kontext
let audioCreatedAt = 0;
// Frisch angelegt (aus einer Geste) startet der Kontext auf iOS kurz als 'suspended' - so lange nicht als blockiert werten.
function audioFresh(){ return audioCtx && performance.now() - audioCreatedAt < 1500; }
function ensureAudio(){
  if(!audioCtx || audioCtx.state === 'closed'){
    try{
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      audioCreatedAt = performance.now();
      audioCtx.onstatechange = () => { audioClockCheck = null; if(state.running) updateSoundHint(); };
    }catch(e){ audioCtx = null; }
    audioClockCheck = null;
  }
}
// true, wenn ein Ton jetzt wirklich zu hoeren waere.
function audioWorking(){
  if(audioFresh()) return true;
  if(!audioCtx || audioCtx.state !== 'running') return false;
  const now = performance.now();
  if(!audioClockCheck){ audioClockCheck = { ctxTime: audioCtx.currentTime, wallTime: now }; return true; }
  const wall = (now - audioClockCheck.wallTime) / 1000;
  if(wall < 0.5) return audioClockCheck.ok !== false;
  const ok = audioCtx.currentTime - audioClockCheck.ctxTime > wall * 0.5;
  audioClockCheck = { ctxTime: audioCtx.currentTime, wallTime: now, ok };
  return ok;
}
// Ohne Nutzergeste (z.B. Seite kommt zurueck in den Vordergrund): nur fortsetzen versuchen.
function tryResumeAudio(){
  if(audioCtx && audioCtx.state !== 'running' && audioCtx.state !== 'closed') audioCtx.resume().catch(() => {});
}
// In einer Nutzergeste: blockierten Kontext durch einen frischen ersetzen und mit einem stillen Ton freischalten.
function unlockAudioFromGesture(){
  if(!state.plan.soundOn) return;
  if(audioCtx && audioWorking()) return;
  if(!audioCtx && !state.running) return; // Erster Kontext entsteht beim Trainingsstart (startTimer)
  if(audioCtx){ try{ audioCtx.close(); }catch(e){} audioCtx = null; }
  ensureAudio();
  if(!audioCtx) return;
  try{
    const buf = audioCtx.createBuffer(1, 1, 22050);
    const src = audioCtx.createBufferSource();
    src.buffer = buf; src.connect(audioCtx.destination); src.start(0);
  }catch(e){}
  audioCtx.resume().catch(() => {});
  if(state.running) setTimeout(updateSoundHint, 300);
}
function beep(freq, durationMs, gain){
  if(!state.plan.soundOn) return;
  try{
    ensureAudio();
    if(!audioCtx) return;
    if(audioCtx.state !== 'running' && !audioFresh()){
      // Nicht einplanen, solange der Kontext steht - sonst kommen alle Toene gesammelt, sobald er wieder laeuft.
      tryResumeAudio();
      return;
    }
    const vol = (gain != null) ? gain : 0.16;
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.type = 'square';
    osc.frequency.value = freq;
    g.gain.setValueAtTime(vol, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + durationMs/1000);
    osc.connect(g).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + durationMs/1000);
  }catch(e){ /* Ton nicht verfügbar, ignorieren */ }
}
function beepForMode(mode){
  if(mode === 'prepare'){
    beep(523, 200, 0.5);
    if(navigator.vibrate) navigator.vibrate(100);
    return;
  }
  const restLike = (mode === 'pause');
  if(restLike){
    beep(392, 260, 0.6);
    setTimeout(() => beep(294, 360, 0.6), 220);
  } else {
    beep(880, 200, 0.65);
    setTimeout(() => beep(1175, 320, 0.65), 180);
  }
  if(navigator.vibrate) navigator.vibrate(restLike ? [180] : [110,70,110]);
}
function tenSecondWarning(){
  beep(587, 200, 0.5);
  if(navigator.vibrate) navigator.vibrate(90);
}
function countdownBeep(remaining){
  const freq = 700 + (5 - remaining) * 160;
  beep(freq, 170, 0.65);
  if(navigator.vibrate) navigator.vibrate(90);
}
function finishFanfare(){
  beep(659, 200, 0.6);
  setTimeout(() => beep(784, 200, 0.6), 200);
  setTimeout(() => beep(1046, 550, 0.6), 400);
  if(navigator.vibrate) navigator.vibrate([120,80,120,80,200]);
}

/* ---------- Wake Lock (Bildschirm nicht sperren waehrend Training laeuft) ---------- */
let wakeLockSentinel = null;
async function requestWakeLock(){
  if(!('wakeLock' in navigator)) return;
  try{
    wakeLockSentinel = await navigator.wakeLock.request('screen');
    wakeLockSentinel.addEventListener('release', () => { wakeLockSentinel = null; });
  }catch(e){ /* z.B. Tab im Hintergrund oder nicht unterstuetzt, ignorieren */ }
}
function releaseWakeLock(){
  if(wakeLockSentinel){
    wakeLockSentinel.release().catch(() => {});
    wakeLockSentinel = null;
  }
}
function onPageVisible(){
  if(document.visibilityState !== 'visible') return;
  audioClockCheck = null;
  tryResumeAudio();
  if(state.running && !wakeLockSentinel) requestWakeLock();
  // Sofort aufholen statt auf den naechsten (evtl. verzoegerten) Intervall-Tick zu warten,
  // damit der Timer nach Hintergrund/Sperre nicht "eingefroren" wirkt.
  if(state.running && !state.paused) tick();
  if(state.running) setTimeout(updateSoundHint, 400);
}
document.addEventListener('visibilitychange', onPageVisible);
window.addEventListener('pageshow', onPageVisible);
window.addEventListener('focus', onPageVisible);
// iOS erlaubt Audio nur aus touchend/click heraus (nicht pointerdown/touchstart).
document.addEventListener('touchend', unlockAudioFromGesture, { passive: true, capture: true });
document.addEventListener('click', unlockAudioFromGesture, { capture: true });

/* ---------- Trainings-Sequenz ---------- */
let steps = [];
let stepStartOffsets = [];
let stepsTotalSeconds = 0;

function buildSteps(day){
  const s = [];
  const exercises = day.exercises;
  exercises.forEach((ex, exIdx) => {
    const sets = Math.max(1, ex.sets || 1);
    const secs = Math.max(1, ex.seconds || 1);
    for(let set=1; set<=sets; set++){
      s.push({ mode:'exercise', seconds: secs, name: ex.name || t('exercise.unnamed'), muscle: ex.muscle, exIdx, exNum: exIdx+1, totalEx: exercises.length, setNum: set, totalSets: sets });
      const isLastOverall = (exIdx === exercises.length-1) && (set === sets);
      if(!isLastOverall){
        const movingToNextExercise = (set === sets);
        const pauseLen = Math.max(0, movingToNextExercise ? effectivePauseAfter(ex) : effectiveSetPause(ex));
        // kind/afterExIdx: damit die Spur im Training weiss, ob Satzpause oder Uebungswechsel ist.
        s.push({ mode:'pause', seconds: pauseLen, kind: movingToNextExercise ? 'exercise' : 'set', afterExIdx: exIdx });
      }
    }
  });
  return s;
}

function dayTotalSeconds(day){
  return buildSteps(day).reduce((a,s) => a + s.seconds, 0);
}

function computeStepOffsets(){
  let acc = 0;
  stepStartOffsets = steps.map(s => { const o = acc; acc += s.seconds; return o; });
  stepsTotalSeconds = acc;
}
function elapsedSeconds(){
  const s = steps[state.stepIndex];
  return stepStartOffsets[state.stepIndex] + (s.seconds - Math.max(0, state.remaining));
}
function formatClock(totalSeconds){
  const t_ = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(t_/60), sec = t_%60;
  return `${m}:${String(sec).padStart(2,'0')}`;
}
function formatMinSec(totalSeconds){
  const m = Math.floor(totalSeconds/60), s = totalSeconds%60;
  return `${m}:${String(s).padStart(2,'0')} ${t('common.minutesSuffix')}`;
}


/* ---------- Oberflaeche (Konzept "Timeline") ----------
   Alle Bildschirme werden als HTML-Strings gebaut und in #app gesetzt.
   Klicks laufen zentral ueber data-act="<aktion>" (siehe ACTIONS), Texteingaben ueber
   data-input="<feld>" (siehe INPUTS) - so verliert render() keine halb getippten Eingaben.
   Alles, was vom Nutzer kommt (Namen, E-Mail), geht durch esc(). */

function esc(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function effectiveSetPause(ex){
  return (ex.setPauseOverride != null) ? ex.setPauseOverride : state.plan.setPauseSeconds;
}
function effectivePauseAfter(ex){
  return (ex.pauseAfterOverride != null) ? ex.pauseAfterOverride : state.plan.pauseSeconds;
}

const MUSCLE_HUES = { warmup:60, chest:20, back:250, shoulders:205, biceps:290, triceps:320, legs:120, abs:160, fullbody:180, cardio:5, stretch:340, other:260 };
function muscleColor(m){ return `oklch(var(--m-l) var(--m-c) ${MUSCLE_HUES[m] != null ? MUSCLE_HUES[m] : 260})`; }

const ICON_FILL = 'fill="currentColor" stroke="none"';
const ICONS = {
  back:'<path d="M15 18l-6-6 6-6"/>', close:'<path d="M6 6l12 12M18 6L6 18"/>', next:'<path d="M9 6l6 6-6 6"/>',
  chart:'<path d="M5 20V11M12 20V5M19 20v-6"/>', user:'<circle cx="12" cy="8" r="4"/><path d="M4 20c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
  list:'<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1" fill="currentColor"/><circle cx="4.5" cy="12" r="1" fill="currentColor"/><circle cx="4.5" cy="18" r="1" fill="currentColor"/>',
  play:`<path d="M8 5.5v13l10.5-6.5z" ${ICON_FILL}/>`, pause:`<rect x="6.5" y="5" width="4" height="14" rx="1" ${ICON_FILL}/><rect x="13.5" y="5" width="4" height="14" rx="1" ${ICON_FILL}/>`,
  skip:`<path d="M5.5 5.5v13l9-6.5z" ${ICON_FILL}/><path d="M18 5.5v13"/>`, prev:`<path d="M18.5 5.5v13l-9-6.5z" ${ICON_FILL}/><path d="M6 5.5v13"/>`,
  plus:'<path d="M12 5v14M5 12h14"/>', minus:'<path d="M5 12h14"/>', check:'<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  trash:'<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>', up:'<path d="M6 15l6-6 6 6"/>', down:'<path d="M6 9l6 6 6-6"/>',
  clock:'<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>', more:`<circle cx="5" cy="12" r="1.8" ${ICON_FILL}/><circle cx="12" cy="12" r="1.8" ${ICON_FILL}/><circle cx="19" cy="12" r="1.8" ${ICON_FILL}/>`,
  spark:'<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6"/>',
  sound:'<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/>', logout:'<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/>', search:'<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4-4"/>', flag:'<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>'
};
function icon(name, size){
  const s = size || 22;
  return `<svg class="ic" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

const ui = {
  tab: 'train',        // 'train' | 'history' | 'profile'
  sheet: null,         // 'editEx' | 'library' | 'day' | 'stop' | 'regen' | 'deleteAccount'
  editExId: null,
  libFilter: '',
  libQuery: '',
  confirmDeleteDay: false,
  setupOpen: 0,
  finished: null,      // { summary, day } nach einem Training
  pwOpen: false
};
const drafts = { email: '', password: '', curPw: '', newPw: '', deletePw: '' };

function activeDay(){
  const days = state.plan.days;
  return days.find(d => d.id === state.activeDayId) || dueDay() || days[0] || null;
}

/* ---------- Abgeleitete Werte aus der Historie ---------- */
function sessionDate(s){
  if(!s || !s.finishedAt) return null;
  if(s.finishedAt.toDate) return s.finishedAt.toDate();
  return s.finishedAt instanceof Date ? s.finishedAt : null;
}
function completedSessions(){
  return (historySessions || []).filter(s => s.completed && sessionDate(s)).sort((a, b) => sessionDate(b) - sessionDate(a));
}
// Rotation: dran ist der Tag nach dem zuletzt abgeschlossenen (Sessions speichern nur den Tagesnamen).
function dueDay(){
  const days = state.plan.days;
  if(!days.length) return null;
  const last = completedSessions()[0];
  if(!last) return days[0];
  const idx = days.findIndex(d => d.name === last.dayName);
  return days[(idx + 1) % days.length];
}
function lastDoneDate(day){
  const s = completedSessions().find(x => x.dayName === day.name);
  return s ? sessionDate(s) : null;
}
function relDay(date){
  if(!date) return t('rel.never');
  const a = new Date(); a.setHours(0,0,0,0);
  const b = new Date(date); b.setHours(0,0,0,0);
  const diff = Math.round((a - b) / 86400000);
  if(diff <= 0) return t('rel.today');
  if(diff === 1) return t('rel.yesterday');
  if(diff < 7) return t('rel.daysAgo', {n: diff});
  return b.toLocaleDateString(currentLanguage, {day:'numeric', month:'numeric'});
}
function minutesLabel(sec){ return t('common.minutes', {n: Math.max(1, Math.round(sec / 60))}); }
function daySets(day){ return day.exercises.reduce((a, e) => a + Math.max(1, e.sets || 1), 0); }
function doseLabel(ex){
  if(ex.sets > 1) return `${ex.sets} × ${ex.seconds} s`;
  return ex.seconds >= 60 ? formatClock(ex.seconds) + ' ' + t('common.minutesSuffix') : `${ex.seconds} s`;
}
function weekStart(d){
  const x = new Date(d || Date.now()); x.setHours(0,0,0,0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}
function isoWeek(d){
  const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const n = x.getUTCDay() || 7; x.setUTCDate(x.getUTCDate() + 4 - n);
  const y = new Date(Date.UTC(x.getUTCFullYear(), 0, 1));
  return Math.ceil(((x - y) / 864e5 + 1) / 7);
}
function weeklyTarget(){
  return onboarding.daysPerWeek || state.plan.days.length || 3;
}

/* ---------- Render ---------- */
function render(){
  const app = document.getElementById('app');
  const sc = app.querySelector('.screen');
  const keepScroll = render.keepScroll && sc ? sc.scrollTop : null;
  render.keepScroll = false;

  let html;
  if(!authReady) html = `<div class="center-screen"><div class="muted">${esc(t('common.loading'))}</div></div>`;
  else if(!authUser) html = vAuth();
  else if(state.running) html = vRun();
  else if(state.screen === 'finished' && ui.finished) html = vFinished();
  else if(state.screen === 'onboarding') html = vSetup();
  else html = vTabs();
  app.innerHTML = html + vSheet();

  if(state.running){ updateTimerDOM(); scrollRunTrack(); }
  if(keepScroll != null){ const n = app.querySelector('.screen'); if(n) n.scrollTop = keepScroll; }
}
// Neu zeichnen, ohne dass die Liste nach oben springt (z.B. nach + / - im Sheet).
function rerender(){ render.keepScroll = true; render(); }

/* ---------- Anmeldung ---------- */
function vAuth(){
  const isLogin = authMode === 'login';
  return `
  <div class="screen auth-screen">
    <div class="auth-brand"><span class="brand-mark">${icon('clock', 26)}</span><span>Intervalinator</span></div>
    <div class="auth-card">
      <h1 class="display">${esc(isLogin ? t('auth.loginSubtitle') : t('auth.registerSubtitle'))}</h1>
      ${authError ? `<div class="msg msg-error">${esc(authError)}</div>` : ''}
      ${authInfo ? `<div class="msg msg-info">${esc(authInfo)}</div>` : ''}
      <label class="field"><span>${esc(t('auth.email'))}</span>
        <input type="email" id="authEmail" autocomplete="email" data-input="email" data-enter="authSubmit" value="${esc(drafts.email)}"></label>
      <label class="field"><span>${esc(t('auth.password'))}</span>
        <input type="password" id="authPassword" autocomplete="${isLogin ? 'current-password' : 'new-password'}" data-input="password" data-enter="authSubmit" value="${esc(drafts.password)}">
        ${isLogin ? '' : `<small>${esc(t('auth.passwordHint'))}</small>`}</label>
      <button class="btn btn-primary" data-act="authSubmit" ${authBusy ? 'disabled' : ''}>${esc(authBusy ? t('auth.submitting') : (isLogin ? t('auth.loginButton') : t('auth.registerButton')))}</button>
      ${isLogin ? `<button class="link" data-act="resetPassword">${esc(t('auth.forgotPassword'))}</button>` : ''}
    </div>
    <button class="link" data-act="authSwitch">${esc(isLogin ? t('auth.switchToRegister') : t('auth.switchToLogin'))}</button>
  </div>`;
}

/* ---------- Tabs ---------- */
function vTabs(){
  const body = ui.tab === 'history' ? vHistory() : ui.tab === 'profile' ? vProfile() : vTrain();
  const tab = (id, ic, label) => `<button class="${ui.tab === id ? 'on' : ''}" data-act="tab" data-arg="${id}" ${ui.tab === id ? 'aria-current="page"' : ''}>${icon(ic)}<span>${esc(label)}</span></button>`;
  return body + `<nav class="tabbar">${tab('train', 'list', t('nav.train'))}${tab('history', 'chart', t('nav.progress'))}${tab('profile', 'user', t('nav.profile'))}</nav>`;
}

/* ---------- Training: Tage + kompakte Spur ---------- */
function vTrain(){
  const days = state.plan.days;
  if(!days.length){
    return `
    <header class="head"><h1 class="display">${esc(t('train.title'))}</h1></header>
    <div class="screen">
      <div class="empty">
        <span class="empty-icon">${icon('spark', 28)}</span>
        <h2>${esc(t('train.emptyTitle'))}</h2>
        <p>${esc(t('train.emptyText'))}</p>
        <button class="btn btn-primary" data-act="openSetup">${esc(t('train.emptyGenerate'))}</button>
        <button class="btn btn-ghost" data-act="addDay">${esc(t('train.emptyManual'))}</button>
      </div>
    </div>`;
  }
  const d = activeDay(), due = dueDay();
  const total = dayTotalSeconds(d);
  return `
  <header class="head"><h1 class="display">${esc(t('train.title'))}</h1></header>
  <div class="days" role="tablist" aria-label="${esc(t('train.daysLabel'))}">
    ${days.map(x => `
      <button class="day-chip ${x.id === d.id ? 'on' : ''}" role="tab" aria-selected="${x.id === d.id}" data-act="pickDay" data-arg="${x.id}">
        ${due && x.id === due.id ? `<span class="due">${esc(t('train.due'))}</span>` : ''}
        <b>${esc(x.name || t('main.newDayName'))}</b><span>${esc(minutesLabel(dayTotalSeconds(x)))}</span>
      </button>`).join('')}
    <button class="day-chip add" data-act="addDay" aria-label="${esc(t('train.addDay'))}">${icon('plus')}</button>
  </div>
  <div class="screen">
    ${!onboarding.completed && !onboardingCardDismissed ? `
      <div class="hint-card">
        <b>${esc(t('onboarding.introTitle'))}</b>
        <p>${esc(t('onboarding.introText'))}</p>
        <div class="row-btns"><button class="btn btn-small btn-ghost" data-act="dismissIntro">${esc(t('onboarding.introSkip'))}</button><button class="btn btn-small btn-primary" data-act="openSetup">${esc(t('onboarding.introStart'))}</button></div>
      </div>` : ''}
    <div class="summary">
      <span><b>${d.exercises.length}</b> ${esc(t('train.exercises'))}</span>
      <span><b>${daySets(d)}</b> ${esc(t('train.sets'))}</span>
      <span>${esc(t('train.lastDone'))} <b>${esc(relDay(lastDoneDate(d)))}</b></span>
      <button class="icon-btn small" data-act="openDaySheet" aria-label="${esc(t('train.dayOptions'))}">${icon('more', 20)}</button>
    </div>
    ${d.exercises.length ? `<div class="cap">${esc(t('train.flowHint'))}</div>${vTrack(d, null)}` : `<div class="muted pad">${esc(t('day.noExercisesYet'))}</div>`}
    <button class="add-btn" data-act="openLibrary">${icon('plus', 18)} ${esc(t('train.addExercise'))}</button>
  </div>
  <div class="startbar">
    <button class="btn btn-primary btn-start" data-act="start" ${d.exercises.length ? '' : 'disabled'}>${icon('play', 22)} ${esc(t('train.start', {name: d.name}))} <small>· ${esc(minutesLabel(total))}</small></button>
  </div>`;
}

/* Kompakte Spur: eine Zeile pro Uebung, dazwischen die Pause.
   pos (nur im Training) = { exIdx, set, setDone, restAfter, all } markiert, wo man gerade steht. */
function vTrack(d, pos){
  const live = !!pos;
  return `<ol class="track ${live ? 'live' : ''}">${d.exercises.map((ex, i) => {
    let st = '';
    if(pos){ if(pos.all || i < pos.exIdx) st = 'done'; else if(i === pos.exIdx && pos.restAfter == null) st = 'cur'; }
    const sets = Math.max(1, ex.sets || 1);
    const pills = st === 'cur' ? `<span class="pills">${Array.from({length: sets}, (_, k) => {
      const done = k + 1 < pos.set || (k + 1 === pos.set && pos.setDone);
      return `<i class="${done ? 'done' : ''}">${k + 1 === pos.set && !pos.setDone ? '<b id="livePill"></b>' : ''}</i>`;
    }).join('')}</span>` : '';
    const setPause = sets > 1 ? `${t('ex.setPauseShort', {s: effectiveSetPause(ex)})}${ex.setPauseOverride != null ? ' · ' + t('ex.custom') : ''}` : '';
    const row = `<li class="ex ${st}" ${st === 'cur' ? 'id="curEx"' : ''}>
      <button class="ex-btn" ${live ? 'tabindex="-1"' : `data-act="editEx" data-arg="${ex.id}"`}>
        <span class="node">${st === 'done' ? icon('check', 13) : i + 1}</span>
        <span class="ex-main">
          <span class="ex-name">${esc(ex.name || t('exercise.namePlaceholder'))}</span>
          <span class="ex-sub"><i style="background:${muscleColor(ex.muscle)}"></i>${esc(t('muscle.' + ex.muscle))}${setPause ? ' · ' + esc(setPause) : ''}</span>
          ${pills}
        </span>
        <span class="ex-dose">${esc(doseLabel(ex))}</span>
      </button>
    </li>`;
    if(i === d.exercises.length - 1) return row;
    const isRest = pos && pos.restAfter === i;
    const gap = `<li class="gap ${isRest ? 'cur' : ''} ${pos && (pos.all || i < (pos.restAfter != null ? pos.restAfter : pos.exIdx)) ? 'done' : ''}">
      <button ${live ? 'tabindex="-1"' : `data-act="editEx" data-arg="${ex.id}"`}>${icon('clock', 13)} ${esc(isRest ? t('track.restNow', {s: effectivePauseAfter(ex)}) : t('track.rest', {s: effectivePauseAfter(ex)}))}${ex.pauseAfterOverride != null ? ' · ' + esc(t('ex.custom')) : ''}</button>
    </li>`;
    return row + gap;
  }).join('')}</ol>`;
}

/* ---------- Verlauf (Statistik) ---------- */
function ringSvg(frac, size, stroke, color){
  const r = (size - stroke) / 2, C = 2 * Math.PI * r, c = size / 2;
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">
    <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="var(--sunk)" stroke-width="${stroke}"/>
    <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round"
      stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - Math.min(1, frac))}" transform="rotate(-90 ${c} ${c})"/></svg>`;
}
function vHistory(){
  const head = `<header class="head"><div><div class="eyebrow">${esc(t('stats.eyebrow'))}</div><h1 class="display">${esc(t('stats.title'))}</h1></div></header>`;
  if(historySessions === null || historyLoading) return head + `<div class="screen"><div class="muted pad">${esc(t('common.loading'))}</div></div>`;
  const done = completedSessions();
  const target = weeklyTarget();
  const ws = weekStart();
  const weeks = [3,2,1,0].map(k => {
    const from = new Date(ws); from.setDate(from.getDate() - 7 * k);
    const to = new Date(from); to.setDate(to.getDate() + 7);
    return { from, n: done.filter(s => sessionDate(s) >= from && sessionDate(s) < to).length, now: k === 0 };
  });
  const since30 = new Date(Date.now() - 30 * 864e5);
  const last30 = done.filter(s => sessionDate(s) >= since30);
  const minutes = last30.reduce((a, s) => a + (s.elapsedSeconds || 0), 0) / 60;
  const sets = last30.reduce((a, s) => a + (s.exercises || []).reduce((b, e) => b + (e.reachedSets || 0), 0), 0);
  return head + `
  <div class="screen">
    ${historyError ? `<div class="msg msg-error">${esc(historyError)}</div>` : ''}
    <section class="weeks" aria-label="${esc(t('stats.weeksLabel'))}">
      ${weeks.map(w => `<div class="wk ${w.now ? 'current' : ''}">${ringSvg(w.n / target, 64, 8, w.n >= target ? 'var(--ok)' : 'var(--accent)')}
        <b>${w.n}/${target}</b><span>${esc(w.now ? t('stats.thisWeek') : t('stats.week', {n: isoWeek(w.from)}))}</span></div>`).join('')}
    </section>
    <section class="kpis">
      <div class="kpi"><b>${last30.length}</b><span>${esc(t('stats.sessions30'))}</span></div>
      <div class="kpi"><b>${(minutes / 60).toFixed(1).replace('.', currentLanguage === 'en' ? '.' : ',')} h</b><span>${esc(t('stats.time30'))}</span></div>
      <div class="kpi"><b>${sets}</b><span>${esc(t('stats.sets30'))}</span></div>
      <div class="kpi"><b>${weeks.filter(w => w.n >= target).length}/4</b><span>${esc(t('stats.weeksOnTarget'))}</span></div>
    </section>
    <div class="cap">${esc(t('stats.recent'))}</div>
    ${done.length ? `<ul class="list">${done.slice(0, 12).map(s => {
      const d = sessionDate(s);
      return `<li class="list-row"><div class="grow"><b>${esc(s.dayName || '')}</b><small>${esc(d.toLocaleDateString(currentLanguage, {weekday:'long', day:'numeric', month:'numeric'}))}</small></div>
        <span class="num">${esc(minutesLabel(s.elapsedSeconds || 0))}</span></li>`; }).join('')}</ul>`
      : `<div class="muted pad">${esc(t('history.empty'))}</div>`}
  </div>`;
}

/* ---------- Profil ---------- */
const LANGUAGE_NAMES = { de: 'Deutsch', en: 'English', fr: 'Français', es: 'Español' };
function vStepper(act, value, unit){
  return `<div class="stepper"><button data-act="${act}" data-arg="-5" aria-label="${esc(t('common.less'))}">${icon('minus', 16)}</button><output>${value}${unit || ''}</output><button data-act="${act}" data-arg="5" aria-label="${esc(t('common.more'))}">${icon('plus', 16)}</button></div>`;
}
function vProfile(){
  const theme = settings.theme === 'light' || settings.theme === 'dark' ? settings.theme : 'system';
  return `
  <header class="head"><div><div class="eyebrow">${esc(authUser.email || '')}</div><h1 class="display">${esc(t('profile.title'))}</h1></div>
    <button class="icon-btn" data-act="logout" aria-label="${esc(t('main.logout'))}" title="${esc(t('main.logout'))}">${icon('logout', 20)}</button></header>
  <div class="screen">
    ${profileError ? `<div class="msg msg-error">${esc(profileError)}</div>` : ''}
    ${profileInfo ? `<div class="msg msg-info">${esc(profileInfo)}</div>` : ''}
    <div class="cap">${esc(t('profile.trainingDefaults'))}</div>
    <ul class="list">
      <li class="list-row"><div class="grow"><b>${esc(t('profile.setPause'))}</b><small>${esc(t('profile.setPauseHint'))}</small></div>${vStepper('globalSetPause', state.plan.setPauseSeconds, ' s')}</li>
      <li class="list-row"><div class="grow"><b>${esc(t('profile.exercisePause'))}</b><small>${esc(t('profile.exercisePauseHint'))}</small></div>${vStepper('globalPause', state.plan.pauseSeconds, ' s')}</li>
      <li class="list-row"><div class="grow"><b>${esc(t('main.soundLabel'))}</b><small>${esc(t('profile.soundHint'))}</small></div>
        <button class="switch ${state.plan.soundOn ? 'on' : ''}" role="switch" aria-checked="${!!state.plan.soundOn}" data-act="toggleSound" aria-label="${esc(t('main.soundLabel'))}"></button></li>
      <li><button class="list-row" data-act="openSetup"><div class="grow"><b>${esc(t('onboarding.editLink'))}</b><small>${esc(t('profile.setupHint'))}</small></div>${icon('next', 18)}</button></li>
    </ul>
    <div class="cap">${esc(t('profile.appearance'))}</div>
    <ul class="list">
      <li class="list-row"><div class="grow"><b>${esc(t('profile.theme'))}</b></div>
        <div class="seg small">${['system','light','dark'].map(x => `<button class="${theme === x ? 'on' : ''}" data-act="setTheme" data-arg="${x}">${esc(t('profile.theme_' + x))}</button>`).join('')}</div></li>
      <li class="list-row"><div class="grow"><b>${esc(t('profile.language'))}</b></div>
        <select id="langSelect" data-change="language">${SUPPORTED_LANGUAGES.map(l => `<option value="${l}" ${l === currentLanguage ? 'selected' : ''}>${LANGUAGE_NAMES[l]}</option>`).join('')}</select></li>
    </ul>
    <div class="cap">${esc(t('profile.account'))}</div>
    <ul class="list">
      <li><button class="list-row" data-act="togglePw" aria-expanded="${ui.pwOpen}"><div class="grow"><b>${esc(t('profile.changePasswordTitle'))}</b></div>${icon(ui.pwOpen ? 'up' : 'down', 18)}</button>
        ${ui.pwOpen ? `<div class="list-body">
          <label class="field"><span>${esc(t('profile.currentPassword'))}</span><input type="password" id="curPw" autocomplete="current-password" data-input="curPw" value="${esc(drafts.curPw)}"></label>
          <label class="field"><span>${esc(t('profile.newPassword'))}</span><input type="password" id="newPw" autocomplete="new-password" data-input="newPw" value="${esc(drafts.newPw)}"><small>${esc(t('auth.passwordHint'))}</small></label>
          <button class="btn btn-ghost" data-act="changePassword">${esc(t('profile.changePasswordButton'))}</button></div>` : ''}</li>
      <li><button class="list-row danger" data-act="openDeleteAccount"><div class="grow"><b>${esc(t('profile.deleteAccountButton'))}</b><small>${esc(t('profile.deleteAccountWarning'))}</small></div></button></li>
    </ul>
  </div>`;
}

/* ---------- Trainingsziele / Plan-Generator: Abschnitte nacheinander ---------- */
function vSetup(){
  const open = ui.setupOpen;
  const eqLabel = onboarding.equipment.length ? onboarding.equipment.map(id => t('equipment.' + id)).join(', ') : t('setup.nothingChosen');
  const focusLabel = onboarding.focus.length ? onboarding.focus.map(id => t('focus.' + id)).join(', ') : t('setup.nothingChosen');
  const timeLabel = t('setup.timeSummary', {days: onboarding.daysPerWeek || '–', minutes: onboarding.sessionMinutes || '–'});
  const sections = [
    { title: t('onboarding.equipment'), summary: eqLabel, body: () => `
      <div class="chips">${EQUIPMENT_IDS.map(id => `<button class="chip ${onboarding.equipment.includes(id) ? 'on' : ''}" data-act="toggleEquipment" data-arg="${id}" aria-pressed="${onboarding.equipment.includes(id)}">${esc(t('equipment.' + id))}</button>`).join('')}</div>` },
    { title: t('onboarding.focus'), summary: focusLabel, body: () => `
      <div class="chips">${FOCUS_IDS.map(id => `<button class="chip ${onboarding.focus.includes(id) ? 'on' : ''}" data-act="toggleFocus" data-arg="${id}" aria-pressed="${onboarding.focus.includes(id)}">${esc(t('focus.' + id))}</button>`).join('')}</div>` },
    { title: t('setup.time'), summary: timeLabel, body: () => `
      <div class="mini-label">${esc(t('onboarding.daysPerWeek'))}</div>
      <div class="seg">${[1,2,3,4,5,6,7].map(n => `<button class="${onboarding.daysPerWeek === n ? 'on' : ''}" data-act="setDays" data-arg="${n}">${n}</button>`).join('')}</div>
      <div class="mini-label">${esc(t('onboarding.sessionMinutes'))}</div>
      <div class="seg">${[20,30,45,60,75,90].map(n => `<button class="${onboarding.sessionMinutes === n ? 'on' : ''}" data-act="setMinutes" data-arg="${n}">${n}</button>`).join('')}</div>` },
    { title: t('onboarding.constraints'), summary: onboarding.constraints || t('setup.none'), body: () => `
      <input type="text" id="constraints" data-input="constraints" placeholder="${esc(t('onboarding.constraintsPlaceholder'))}" value="${esc(onboarding.constraints || '')}">` }
  ];
  return `
  <header class="head"><button class="icon-btn" data-act="closeSetup" aria-label="${esc(t('onboarding.back'))}">${icon('close')}</button>
    <h1 class="display center">${esc(t('onboarding.title'))}</h1><span class="icon-spacer"></span></header>
  <div class="screen">
    <p class="muted">${esc(t('onboarding.intro'))}</p>
    <div class="cap">${esc(t('setup.progress', {n: Math.min(open + 1, sections.length), total: sections.length}))}</div>
    <ol class="acc">${sections.map((s, i) => {
      const cls = i < open ? 'done' : i === open ? 'open' : '';
      return `<li class="sec ${cls}">
        <button class="sec-head" data-act="openSection" data-arg="${i}" aria-expanded="${i === open}">
          <span class="sec-num">${i < open ? icon('check', 14) : i + 1}</span>
          <span class="grow"><b>${esc(s.title)}</b>${i !== open ? `<small>${esc(s.summary)}</small>` : ''}</span>
          ${i < open ? `<span class="muted small">${esc(t('setup.change'))}</span>` : ''}
        </button>
        ${i === open ? `<div class="sec-body">${s.body()}
          ${i < sections.length - 1 ? `<button class="btn btn-small btn-primary" data-act="openSection" data-arg="${i + 1}">${esc(t('setup.continueTo', {name: sections[i + 1].title}))}</button>` : ''}</div>` : ''}
      </li>`; }).join('')}
    </ol>
    ${onboardingGenerateError ? `<div class="msg msg-error">${esc(onboardingGenerateError)}</div>` : ''}
  </div>
  <div class="startbar stack">
    <button class="btn btn-primary" data-act="generate" ${onboardingGenerating ? 'disabled' : ''}>${icon('spark', 20)} ${esc(onboardingGenerating ? t('onboarding.generating') : t(onboarding.completed && state.plan.days.length ? 'onboarding.regenerateButton' : 'onboarding.generateButton'))}</button>
    <button class="btn btn-ghost" data-act="saveOnboardingOnly" ${onboardingGenerating ? 'disabled' : ''}>${esc(t('onboarding.saveOnlyButton'))}</button>
  </div>`;
}

/* ---------- Training laeuft ---------- */
function remainingPrecise(){
  if(state.paused) return pausedRemainingMs / 1000;
  return Math.max(0, (stepDeadline - Date.now()) / 1000);
}
function runPos(){
  const s = steps[state.stepIndex];
  if(s.mode === 'exercise') return { exIdx: s.exIdx, set: s.setNum };
  if(s.mode === 'pause'){
    if(s.kind === 'exercise') return { exIdx: s.afterExIdx + 1, set: 1, restAfter: s.afterExIdx };
    const prev = steps[state.stepIndex - 1];
    return { exIdx: s.afterExIdx, set: prev ? prev.setNum : 1, setDone: true };
  }
  return { exIdx: 0, set: 1 };
}
function nextExerciseStep(fromIndex){
  for(let i = fromIndex + 1; i < steps.length; i++) if(steps[i].mode === 'exercise') return steps[i];
  return null;
}
function vRun(){
  const s = steps[state.stepIndex];
  const nxt = nextExerciseStep(state.stepIndex);
  const after = steps[state.stepIndex + 1];
  let phase, what, mode;
  if(s.mode === 'exercise'){
    mode = 'work';
    phase = t('timer.setOf', {set: s.setNum, total: s.totalSets});
    const afterTxt = after ? t('timer.thenPause', {s: after.seconds}) : t('timer.thenDone');
    what = `${esc(s.name)}<small>${esc(t('muscle.' + s.muscle))} · ${esc(afterTxt)}</small>`;
  } else if(s.mode === 'pause'){
    mode = 'rest';
    phase = s.kind === 'exercise' ? t('timer.exerciseChange') : t('timer.setPause');
    what = nxt ? `${esc(t('timer.upNext', {name: nxt.name}))}<small>${esc(t('timer.setOf', {set: nxt.setNum, total: nxt.totalSets}))} · ${nxt.seconds} s</small>` : '';
  } else {
    mode = 'prepare';
    phase = t('timer.prepare');
    what = nxt ? `${esc(t('timer.upNext', {name: nxt.name}))}<small>${esc(t('timer.setOf', {set: 1, total: nxt.totalSets}))}</small>` : '';
  }
  return `
  <div class="run ${mode}">
    <header class="head">
      <button class="icon-btn" data-act="askStop" aria-label="${esc(t('timer.cancelBtn'))}">${icon('close')}</button>
      <h1 class="display center small">${esc(state.currentDayName)}</h1>
      <span class="step-count">${state.stepIndex + 1}/${steps.length}</span>
    </header>
    <section class="now" aria-live="polite">
      <div class="phase"><i></i>${esc(phase)}${state.paused ? ' · ' + esc(t('timer.paused')) : ''}</div>
      <div class="clock" id="runClock">${formatClock(Math.ceil(remainingPrecise()))}</div>
      <div class="what">${what}</div>
      <div class="bar"><i id="runBar"></i></div>
      <div class="totals"><span id="runElapsed"></span><span id="runLeft"></span></div>
    </section>
    <button class="sound-hint" id="soundHint" data-act="enableSound" hidden>${icon('sound', 18)} ${esc(t('timer.soundBlocked'))}</button>
    <div class="screen run-track" id="runTrack">${vTrack(runDay, runPos())}</div>
    <div class="controls">
      <button data-act="prevStep" aria-label="${esc(t('timer.prevBtn'))}">${icon('prev')}</button>
      <button class="main" data-act="togglePause" aria-label="${esc(state.paused ? t('timer.resumeBtn') : t('timer.pauseBtn'))}">${icon(state.paused ? 'play' : 'pause', 28)}</button>
      <button data-act="skipStep" aria-label="${esc(t('timer.skipBtn'))}">${icon('skip')}</button>
    </div>
  </div>`;
}
function updateSoundHint(){
  const hint = document.getElementById('soundHint');
  if(hint) hint.hidden = !(state.running && state.plan.soundOn && !audioWorking());
}
function updateTimerDOM(){
  const clk = document.getElementById('runClock');
  if(!clk || !state.running) return;
  updateSoundHint();
  const s = steps[state.stepIndex];
  const rem = remainingPrecise();
  clk.textContent = formatClock(Math.ceil(rem));
  const elapsed = stepStartOffsets[state.stepIndex] + (s.seconds - rem);
  document.getElementById('runBar').style.width = (elapsed / Math.max(1, stepsTotalSeconds) * 100) + '%';
  document.getElementById('runElapsed').textContent = t('timer.elapsed', {time: formatClock(elapsed)});
  document.getElementById('runLeft').textContent = t('timer.left', {time: formatClock(stepsTotalSeconds - elapsed)});
  const pill = document.getElementById('livePill');
  if(pill && s.mode === 'exercise') pill.style.width = ((1 - rem / Math.max(1, s.seconds)) * 100) + '%';
}
function scrollRunTrack(){
  const track = document.getElementById('runTrack');
  const cur = document.getElementById('curEx') || (track && track.querySelector('.gap.cur'));
  if(track && cur) track.scrollTop = Math.max(0, cur.offsetTop - track.offsetTop - 12);
}

/* ---------- Nach dem Training ---------- */
function vFinished(){
  const { summary, day } = ui.finished;
  const full = summary.completionFraction >= 0.999;
  const reached = summary.exercises.reduce((a, e) => a + e.reachedSets, 0);
  const planned = daySets(day);
  const next = dueDay();
  const firstOpen = summary.exercises.findIndex(e => e.reachedSets < e.totalSets);
  const pos = full ? { all: true, exIdx: 0, set: 1 } : { exIdx: firstOpen < 0 ? summary.exercises.length : firstOpen, set: 1 };
  return `
  <header class="head"><span class="icon-spacer"></span><span class="grow"></span><button class="icon-btn" data-act="closeFinished" aria-label="${esc(t('finished.back'))}">${icon('close')}</button></header>
  <div class="screen">
    <div class="done-hero">
      <div class="eyebrow ${summary.completed ? 'ok' : ''}">${esc(summary.completed ? t('finished.complete') : t('finished.partial'))}</div>
      <h1 class="display big">${esc(summary.completed ? t('finished.title2', {day: summary.dayName}) : t('finished.stopped'))}</h1>
      <p>${esc(t('finished.stats', {time: formatClock(summary.elapsedSeconds), done: reached, total: planned}))}${next ? ' · ' + esc(t('finished.next', {name: next.name})) : ''}</p>
    </div>
    ${vTrack(day, pos)}
  </div>
  <div class="startbar"><button class="btn btn-ghost" data-act="closeFinished">${esc(t('finished.back'))}</button></div>`;
}

/* ---------- Bottom-Sheets ---------- */
function vSheet(){
  if(!ui.sheet) return '';
  const wrap = (inner, closeAct) => `<div class="sheet-backdrop" data-act="${closeAct || 'closeSheet'}"><div class="sheet" role="dialog" aria-modal="true" data-stop><div class="grab"></div>${inner}</div></div>`;
  const d = activeDay();

  if(ui.sheet === 'editEx'){
    const i = d ? d.exercises.findIndex(e => e.id === ui.editExId) : -1;
    const ex = i >= 0 ? d.exercises[i] : null;
    if(!ex) return '';
    const pauseRow = (label, hint, value, isCustom, act, resetAct) => `
      <div class="pause-row">
        <div class="grow"><b>${esc(label)}</b><small>${esc(hint)}</small></div>
        ${vStepper(act, value, ' s')}
        <button class="chip small ${isCustom ? '' : 'on'}" data-act="${resetAct}" aria-pressed="${!isCustom}">${esc(t('ex.default'))}</button>
      </div>`;
    return wrap(`
      <div class="cap">${esc(t('ex.position', {n: i + 1, total: d.exercises.length}))}</div>
      <input class="name-input" type="text" id="exName" data-input="exName" placeholder="${esc(t('exercise.namePlaceholder'))}" value="${esc(ex.name)}">
      <div class="chips scroll-x">${MUSCLE_GROUP_IDS.map(m => `<button class="chip ${ex.muscle === m ? 'on' : ''}" data-act="exMuscle" data-arg="${m}"><i class="dot" style="background:${muscleColor(m)}"></i>${esc(t('muscle.' + m))}</button>`).join('')}</div>
      <div class="big-steppers">
        <div class="bs"><span class="cap">${esc(t('exercise.sets'))}</span><output>${ex.sets}</output>
          <div class="bs-btns"><button data-act="exSets" data-arg="-1" aria-label="${esc(t('common.less'))}">${icon('minus')}</button><button data-act="exSets" data-arg="1" aria-label="${esc(t('common.more'))}">${icon('plus')}</button></div></div>
        <div class="bs"><span class="cap">${esc(t('exercise.secondsPerSet'))}</span><output>${ex.seconds}</output>
          <div class="bs-btns"><button data-act="exSeconds" data-arg="-5" aria-label="${esc(t('common.less'))}">${icon('minus')}</button><button data-act="exSeconds" data-arg="5" aria-label="${esc(t('common.more'))}">${icon('plus')}</button></div></div>
      </div>
      <div class="pauses">
        ${pauseRow(t('ex.setPauseLabel'), ex.setPauseOverride != null ? t('ex.customHint') : t('ex.defaultHint', {s: state.plan.setPauseSeconds}), effectiveSetPause(ex), ex.setPauseOverride != null, 'exSetPause', 'exSetPauseDefault')}
        ${i < d.exercises.length - 1 ? pauseRow(t('ex.pauseAfterLabel'), ex.pauseAfterOverride != null ? t('ex.customHint') : t('ex.defaultHint', {s: state.plan.pauseSeconds}), effectivePauseAfter(ex), ex.pauseAfterOverride != null, 'exPauseAfter', 'exPauseAfterDefault') : ''}
      </div>
      <div class="tools">
        <button data-act="exMove" data-arg="-1" ${i === 0 ? 'disabled' : ''}>${icon('up', 18)} ${esc(t('ex.earlier'))}</button>
        <button data-act="exMove" data-arg="1" ${i === d.exercises.length - 1 ? 'disabled' : ''}>${icon('down', 18)} ${esc(t('ex.later'))}</button>
        <button class="danger" data-act="exRemove">${icon('trash', 18)} ${esc(t('ex.remove'))}</button>
      </div>
      <button class="btn btn-primary" data-act="closeSheet">${esc(t('common.done'))}</button>`);
  }

  if(ui.sheet === 'library'){
    return wrap(`
      <h2 class="display sheet-title">${esc(t('library.title'))}</h2>
      <label class="search">${icon('search', 18)}<input type="search" id="libSearch" data-input="libQuery" placeholder="${esc(t('library.search'))}" value="${esc(ui.libQuery)}"></label>
      <div class="chips scroll-x">${['', ...MUSCLE_GROUP_IDS.filter(m => m !== 'other')].map(m => `<button class="chip small ${ui.libFilter === m ? 'on' : ''}" data-act="libFilter" data-arg="${m}">${esc(m ? t('muscle.' + m) : t('library.all'))}</button>`).join('')}</div>
      <div class="sheet-scroll" id="libList">${vLibraryList()}</div>`);
  }

  if(ui.sheet === 'day' && d){
    return wrap(`
      <h2 class="display sheet-title">${esc(t('daySheet.title'))}</h2>
      <label class="field"><span>${esc(t('daySheet.name'))}</span><input type="text" id="dayName" data-input="dayName" value="${esc(d.name)}"></label>
      ${ui.confirmDeleteDay
        ? `<div class="msg msg-error">${esc(t('day.deleteConfirm', {name: d.name}))}</div>
           <div class="row-btns"><button class="btn btn-ghost" data-act="cancelDeleteDay">${esc(t('common.cancel'))}</button><button class="btn btn-danger" data-act="deleteDay">${esc(t('daySheet.deleteConfirm'))}</button></div>`
        : `<button class="btn btn-ghost danger-text" data-act="askDeleteDay">${icon('trash', 18)} ${esc(t('daySheet.delete'))}</button>`}
      <button class="btn btn-primary" data-act="closeSheet">${esc(t('common.done'))}</button>`);
  }

  if(ui.sheet === 'stop' && state.running){
    const doneSets = steps.slice(0, state.stepIndex).filter(s => s.mode === 'exercise').length;
    const allSets = steps.filter(s => s.mode === 'exercise').length;
    return wrap(`
      <h2 class="display sheet-title">${esc(t('stop.title'))}</h2>
      <p class="muted">${esc(t('stop.text', {done: doneSets, total: allSets}))}</p>
      <button class="btn btn-primary" data-act="resumeFromStop">${esc(t('stop.continue'))}</button>
      <button class="btn btn-ghost" data-act="stopTraining">${esc(t('stop.end'))}</button>`, 'resumeFromStop');
  }

  if(ui.sheet === 'regen'){
    return wrap(`
      <h2 class="display sheet-title">${esc(t('onboarding.regenerateModalTitle'))}</h2>
      <p class="muted">${esc(t('onboarding.regenerateModalText'))}</p>
      <button class="btn btn-primary" data-act="confirmRegenerate">${esc(t('onboarding.regenerateModalConfirm'))}</button>
      <button class="btn btn-ghost" data-act="closeSheet">${esc(t('common.cancel'))}</button>`);
  }

  if(ui.sheet === 'deleteAccount'){
    return wrap(`
      <h2 class="display sheet-title">${esc(t('profile.deleteModalTitle'))}</h2>
      <p class="muted">${esc(t('profile.deleteAccountWarning'))}</p>
      <label class="field"><span>${esc(t('profile.deleteModalPasswordLabel'))}</span><input type="password" id="deletePw" autocomplete="current-password" data-input="deletePw" value=""></label>
      <button class="btn btn-danger" data-act="confirmDeleteAccount">${esc(t('profile.deleteModalConfirmButton'))}</button>
      <button class="btn btn-ghost" data-act="closeSheet">${esc(t('common.cancel'))}</button>`);
  }
  return '';
}
function vLibraryList(){
  const q = ui.libQuery.trim().toLowerCase();
  const items = (exerciseLibrary || []).filter(e => (!ui.libFilter || e.muscle === ui.libFilter) && (!q || e.name.toLowerCase().includes(q)));
  const custom = `<button class="list-row" data-act="addCustomExercise"><span class="lib-plus">${icon('plus', 18)}</span><div class="grow"><b>${esc(q ? t('library.customNamed', {name: ui.libQuery.trim()}) : t('library.custom'))}</b><small>${esc(t('library.customHint'))}</small></div></button>`;
  if(!exerciseLibrary) return custom + `<div class="muted pad">${esc(t('common.loading'))}</div>`;
  return custom + items.map(e => `<button class="list-row" data-act="addLibraryExercise" data-arg="${esc(e.id)}"><i class="dot" style="background:${muscleColor(e.muscle)}"></i>
    <div class="grow"><b>${esc(e.name)}</b><small>${esc(t('muscle.' + e.muscle))} · ${esc(e.equipment.map(x => t('equipment.' + x)).join(', '))}</small></div>${icon('plus', 18)}</button>`).join('')
    + (items.length ? '' : `<div class="muted pad">${esc(t('library.noMatch'))}</div>`);
}

/* ---------- Aktionen ---------- */
function currentExercise(){
  const d = activeDay();
  return d ? d.exercises.find(e => e.id === ui.editExId) : null;
}
function openSheet(name){ ui.sheet = name; rerender(); }
function closeSheet(){ ui.sheet = null; ui.confirmDeleteDay = false; rerender(); }
function insertExercise(ex){
  const d = activeDay();
  ex.id = uid();
  const list = d.exercises;
  // Neue Uebungen vor das abschliessende Dehnen setzen, falls es eines gibt.
  const at = list.length && list[list.length - 1].muscle === 'stretch' ? list.length - 1 : list.length;
  list.splice(at, 0, ex);
  schedulePersist();
  ui.editExId = ex.id;
  ui.sheet = 'editEx';
  rerender();
}
function clampSeconds(v){ return Math.max(0, Math.min(600, v)); }

const ACTIONS = {
  // Anmeldung
  authSubmit(){
    const email = drafts.email.trim(), pw = drafts.password, isLogin = authMode === 'login';
    if(!email || !pw){ authError = t('auth.fillBoth'); render(); return; }
    if(!EMAIL_RE.test(email)){ authError = t('auth.invalidEmail'); render(); return; }
    if(!isLogin && pw.length < 8){ authError = t('auth.passwordTooShort'); render(); return; }
    if(isLogin) handleLogin(email, pw); else handleRegister(email, pw);
  },
  authSwitch(){ authMode = authMode === 'login' ? 'register' : 'login'; authError = ''; authInfo = ''; render(); },
  resetPassword(){ handlePasswordReset(drafts.email.trim()); },
  logout(){ handleLogout(); },

  // Navigation
  tab(id){
    if(ui.tab === id) return;
    ui.tab = id; profileError = ''; profileInfo = '';
    if(id === 'history') loadHistory();
    render();
  },
  pickDay(id){ state.activeDayId = id; render(); },
  addDay(){
    const day = { id: uid(), name: t('main.newDayName'), exercises: [] };
    state.plan.days.push(day);
    state.activeDayId = day.id;
    schedulePersist();
    ui.sheet = 'day';
    render();
    const input = document.getElementById('dayName');
    if(input){ input.focus(); input.select(); }
  },
  dismissIntro(){ onboardingCardDismissed = true; render(); },
  openDaySheet(){ ui.confirmDeleteDay = false; openSheet('day'); },
  askDeleteDay(){ ui.confirmDeleteDay = true; rerender(); },
  cancelDeleteDay(){ ui.confirmDeleteDay = false; rerender(); },
  deleteDay(){
    const d = activeDay();
    state.plan.days = state.plan.days.filter(x => x.id !== d.id);
    state.activeDayId = null;
    schedulePersist();
    closeSheet();
  },
  closeSheet(){ closeSheet(); },

  // Uebungen
  editEx(id){ ui.editExId = id; openSheet('editEx'); },
  exMuscle(m){ currentExercise().muscle = m; schedulePersist(); rerender(); },
  exSets(v){ const ex = currentExercise(); ex.sets = Math.max(1, Math.min(20, ex.sets + Number(v))); schedulePersist(); rerender(); },
  exSeconds(v){ const ex = currentExercise(); ex.seconds = Math.max(5, Math.min(3600, ex.seconds + Number(v))); schedulePersist(); rerender(); },
  exSetPause(v){ const ex = currentExercise(); ex.setPauseOverride = clampSeconds(effectiveSetPause(ex) + Number(v)); schedulePersist(); rerender(); },
  exSetPauseDefault(){ currentExercise().setPauseOverride = null; schedulePersist(); rerender(); },
  exPauseAfter(v){ const ex = currentExercise(); ex.pauseAfterOverride = clampSeconds(effectivePauseAfter(ex) + Number(v)); schedulePersist(); rerender(); },
  exPauseAfterDefault(){ currentExercise().pauseAfterOverride = null; schedulePersist(); rerender(); },
  exMove(dir){
    const list = activeDay().exercises, i = list.findIndex(e => e.id === ui.editExId), j = i + Number(dir);
    if(j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    schedulePersist(); rerender();
  },
  exRemove(){
    const list = activeDay().exercises;
    list.splice(list.findIndex(e => e.id === ui.editExId), 1);
    schedulePersist(); closeSheet();
  },
  openLibrary(){
    ui.libQuery = ''; ui.libFilter = '';
    if(!exerciseLibrary) loadExerciseLibrary().then(() => { if(ui.sheet === 'library') refreshLibraryList(); }).catch(() => {});
    openSheet('library');
  },
  libFilter(m){ ui.libFilter = m; rerender(); const s = document.getElementById('libSearch'); if(s && ui.libQuery) s.focus(); },
  addLibraryExercise(id){
    const entry = (exerciseLibrary || []).find(e => e.id === id);
    if(entry) insertExercise(makeExercise(entry.name, entry.muscle, 3, 30));
  },
  addCustomExercise(){
    insertExercise(makeExercise(ui.libQuery.trim(), ui.libFilter || 'other', 3, 30));
    const input = document.getElementById('exName');
    if(input && !input.value) input.focus();
  },

  // Training
  enableSound(){ setTimeout(() => { beep(880, 140, 0.5); updateSoundHint(); }, 150); },
  start(){ const d = activeDay(); if(d && d.exercises.length) startTimer(d); },
  togglePause(){ togglePause(); },
  skipStep(){ skipStep(); },
  prevStep(){ prevStep(); },
  askStop(){ if(!state.paused) togglePause(); ui.sheet = 'stop'; render(); },
  resumeFromStop(){ ui.sheet = null; if(state.paused) togglePause(); else render(); },
  stopTraining(){ ui.sheet = null; stopTimer(); },
  closeFinished(){ state.screen = 'main'; ui.finished = null; ui.tab = 'train'; state.activeDayId = null; render(); },

  // Trainingsziele
  openSetup(){ state.screen = 'onboarding'; ui.setupOpen = 0; onboardingGenerateError = ''; render(); },
  closeSetup(){ state.screen = 'main'; render(); },
  openSection(i){ ui.setupOpen = Number(i); render(); },
  toggleEquipment(id){ toggleIn(onboarding.equipment, id); scheduleOnboardingPersist(); rerender(); },
  toggleFocus(id){ toggleIn(onboarding.focus, id); scheduleOnboardingPersist(); rerender(); },
  setDays(n){ onboarding.daysPerWeek = Number(n); scheduleOnboardingPersist(); rerender(); },
  setMinutes(n){ onboarding.sessionMinutes = Number(n); scheduleOnboardingPersist(); rerender(); },
  generate(){
    if(onboarding.completed && state.plan.days.length) openSheet('regen');
    else runGeneration();
  },
  confirmRegenerate(){ ui.sheet = null; runGeneration(); },
  saveOnboardingOnly(){ onboarding.completed = true; persistOnboarding(); state.screen = 'main'; render(); },

  // Profil
  globalSetPause(v){ state.plan.setPauseSeconds = clampSeconds(state.plan.setPauseSeconds + Number(v)); schedulePersist(); rerender(); },
  globalPause(v){ state.plan.pauseSeconds = clampSeconds(state.plan.pauseSeconds + Number(v)); schedulePersist(); rerender(); },
  toggleSound(){ state.plan.soundOn = !state.plan.soundOn; schedulePersist(); rerender(); },
  setTheme(theme){ applyTheme(theme); settings.theme = theme === 'system' ? null : theme; scheduleSettingsPersist(); rerender(); },
  togglePw(){ ui.pwOpen = !ui.pwOpen; rerender(); },
  changePassword(){ handleChangePassword(drafts.curPw, drafts.newPw).then(() => { if(profileInfo){ drafts.curPw = ''; drafts.newPw = ''; ui.pwOpen = false; rerender(); } }); },
  openDeleteAccount(){ drafts.deletePw = ''; openSheet('deleteAccount'); },
  confirmDeleteAccount(){ const pw = drafts.deletePw; drafts.deletePw = ''; ui.sheet = null; render(); handleDeleteAccount(pw); }
};
function toggleIn(list, id){ const i = list.indexOf(id); if(i < 0) list.push(id); else list.splice(i, 1); }
function refreshLibraryList(){ const box = document.getElementById('libList'); if(box) box.innerHTML = vLibraryList(); }

// Texteingaben: Daten direkt aktualisieren, ohne neu zu zeichnen (sonst ginge der Fokus verloren).
const INPUTS = {
  email(v){ drafts.email = v; }, password(v){ drafts.password = v; },
  curPw(v){ drafts.curPw = v; }, newPw(v){ drafts.newPw = v; }, deletePw(v){ drafts.deletePw = v; },
  exName(v){ const ex = currentExercise(); if(ex){ ex.name = v; schedulePersist(); } },
  dayName(v){ const d = activeDay(); if(d){ d.name = v; schedulePersist(); } },
  libQuery(v){ ui.libQuery = v; refreshLibraryList(); },
  constraints(v){ onboarding.constraints = v; scheduleOnboardingPersist(); }
};

document.addEventListener('click', (e) => {
  const target = e.target.closest('[data-act]');
  if(!target || !document.getElementById('app').contains(target)) return;
  // Klick innerhalb eines Sheets soll nicht den Hintergrund (= Schliessen) ausloesen.
  if(target.classList.contains('sheet-backdrop') && e.target.closest('[data-stop]')) return;
  const fn = ACTIONS[target.dataset.act];
  if(fn) fn(target.dataset.arg);
});
document.addEventListener('input', (e) => {
  const key = e.target.dataset && e.target.dataset.input;
  if(key && INPUTS[key]) INPUTS[key](e.target.value);
});
document.addEventListener('change', (e) => {
  if(e.target.dataset && e.target.dataset.change === 'language') setLanguage(e.target.value);
});
document.addEventListener('keydown', (e) => {
  if(e.key === 'Escape' && ui.sheet){ if(ui.sheet === 'stop') ACTIONS.resumeFromStop(); else closeSheet(); return; }
  if(e.key === 'Enter' && e.target.dataset && e.target.dataset.enter){ const fn = ACTIONS[e.target.dataset.enter]; if(fn) fn(); }
});

/* ---------- Historie laden ---------- */
let historyLoading = false;
let historySessions = null; // null = noch nicht geladen
let historyError = '';

async function loadHistory(){
  if(!authUser) return;
  historyLoading = true; historyError = '';
  try{
    // 35 Tage, damit die vier Wochen-Ringe (inkl. laufender Woche) vollstaendig sind.
    const cutoff = new Date(Date.now() - 35*24*60*60*1000);
    const snap = await db.collection('users').doc(authUser.uid).collection('sessions')
      .where('finishedAt', '>=', cutoff)
      .orderBy('finishedAt', 'desc')
      .get();
    historySessions = snap.docs.map(d => d.data());
  }catch(e){
    historyError = e.message || t('error.unknown');
    if(historySessions === null) historySessions = [];
  }
  historyLoading = false;
  if(!state.running) rerender();
}

/* ---------- Timer-Ablauf ---------- */
let sessionStartStamp = null;
const PREPARE_SECONDS = 10;
// Deadline (Date.now()-Zeitstempel) statt reinem Sekunden-Runterzaehlen: so kann der
// Timer beim Zurueckkehren aus dem Hintergrund/nach Bildschirmsperre sofort auf die
// tatsaechlich vergangene Realzeit aufholen, statt eingefroren zu bleiben.
let stepDeadline = null;
let pausedRemainingMs = 0;
let runDay = null;

function startTimer(day){
  ensureAudio();
  tryResumeAudio(); // Start ist ein Tipp - hier darf iOS den Kontext freigeben
  steps = buildSteps(day);
  if(steps.length === 0) return;
  steps.unshift({ mode:'prepare', seconds: PREPARE_SECONDS });
  computeStepOffsets();
  runDay = day;
  state.running = true;
  state.stepIndex = 0;
  state.remaining = steps[0].seconds;
  state.paused = false;
  state.currentDayName = day.name;
  sessionStartStamp = new Date();
  stepDeadline = Date.now() + state.remaining*1000;

  requestWakeLock();
  beepForMode(steps[0].mode);

  clearInterval(state.intervalId);
  // 4x pro Sekunde, damit Balken fluessig laufen; Toene nur beim Sekundenwechsel.
  state.intervalId = setInterval(tick, 250);
  ui.sheet = null;
  render();
}

function tick(){
  if(state.paused || !state.running) return;
  let stepChanged = false;
  while(state.running){
    const remaining = Math.ceil((stepDeadline - Date.now())/1000);
    if(remaining > 0){
      const secondChanged = remaining !== state.remaining;
      state.remaining = remaining;
      if(stepChanged){
        beepForMode(steps[state.stepIndex].mode);
        if(!ui.sheet) render();
      } else {
        if(secondChanged){
          if(remaining === 10) tenSecondWarning();
          if(remaining <= 5) countdownBeep(remaining);
        }
        updateTimerDOM();
      }
      return;
    }
    state.stepIndex += 1;
    if(state.stepIndex >= steps.length){
      finishTimer();
      return;
    }
    stepDeadline += steps[state.stepIndex].seconds*1000;
    stepChanged = true;
  }
}

function enterStep(index){
  state.stepIndex = index;
  const s = steps[index];
  state.remaining = s.seconds;
  stepDeadline = Date.now() + s.seconds*1000;
  pausedRemainingMs = s.seconds*1000;
  beepForMode(s.mode);
  render();
}
function skipStep(){
  if(state.stepIndex + 1 >= steps.length){ finishTimer(); return; }
  enterStep(state.stepIndex + 1);
}
// Zurueck: innerhalb der ersten 2 Sekunden zum vorherigen Schritt, sonst aktuellen Schritt neu starten.
function prevStep(){
  const s = steps[state.stepIndex];
  const elapsedInStep = s.seconds - remainingPrecise();
  enterStep(elapsedInStep < 2 && state.stepIndex > 0 ? state.stepIndex - 1 : state.stepIndex);
}

function togglePause(){
  if(state.paused){
    stepDeadline = Date.now() + pausedRemainingMs;
  } else {
    pausedRemainingMs = Math.max(0, stepDeadline - Date.now());
    state.remaining = Math.ceil(pausedRemainingMs/1000);
  }
  state.paused = !state.paused;
  render();
}
function computeSessionSummary(fullyFinished){
  const completedUpToIndex = fullyFinished ? steps.length : state.stepIndex;
  const elapsed = fullyFinished ? stepsTotalSeconds : stepStartOffsets[state.stepIndex] + (steps[state.stepIndex].seconds - remainingPrecise());
  const completionFraction = stepsTotalSeconds > 0 ? elapsed / stepsTotalSeconds : 0;

  const exerciseMap = new Map();
  for(let i = 0; i < steps.length; i++){
    const s = steps[i];
    if(s.mode !== 'exercise') continue;
    const key = s.name + '|' + (s.muscle || '');
    if(!exerciseMap.has(key)){
      exerciseMap.set(key, { name: s.name, muscle: s.muscle, reachedSets: 0, totalSets: s.totalSets });
    }
    if(i < completedUpToIndex) exerciseMap.get(key).reachedSets += 1;
  }

  return {
    dayName: state.currentDayName,
    // Wie bisher nur Uebungen speichern, die mindestens einen Satz erreicht haben.
    exercises: Array.from(exerciseMap.values()).filter(e => e.reachedSets > 0),
    allExercises: Array.from(exerciseMap.values()),
    totalPlannedSeconds: stepsTotalSeconds,
    elapsedSeconds: Math.round(elapsed),
    completionFraction: completionFraction,
    completed: completionFraction >= 0.75
  };
}

async function logSession(summary){
  if(!authUser || summary.elapsedSeconds <= 0) return;
  const doc = {
    dayName: summary.dayName,
    exercises: summary.exercises,
    startedAt: sessionStartStamp || firebase.firestore.FieldValue.serverTimestamp(),
    finishedAt: firebase.firestore.FieldValue.serverTimestamp(),
    totalPlannedSeconds: summary.totalPlannedSeconds,
    elapsedSeconds: summary.elapsedSeconds,
    completionFraction: summary.completionFraction,
    completed: summary.completed
  };
  // Sofort lokal eintragen, damit "Dran" und Statistik ohne Neuladen stimmen.
  if(historySessions) historySessions.unshift(Object.assign({}, doc, { finishedAt: new Date() }));
  try{
    await db.collection('users').doc(authUser.uid).collection('sessions').add(doc);
  }catch(e){ /* Historie ist unterstuetzend, kein User-Feedback noetig */ }
}

function endRun(summary){
  logSession(summary);
  clearInterval(state.intervalId);
  state.running = false;
  state.paused = false;
  releaseWakeLock();
  ui.sheet = null;
  ui.finished = { summary: Object.assign({}, summary, { exercises: summary.allExercises }), day: runDay };
  state.screen = 'finished';
  render();
}
function stopTimer(){ endRun(computeSessionSummary(false)); }
function finishTimer(){ finishFanfare(); endRun(computeSessionSummary(true)); }

/* ---------- Start ---------- */
(async function bootstrap(){
  await loadLanguage(detectInitialLanguage());
  render();
  auth.onAuthStateChanged(user => {
    authReady = true;
    authError = '';
    authInfo = '';
    if(user){
      authUser = user;
      drafts.password = '';
      historySessions = null;
      loadPlanForCurrentUser();
      loadHistory();
      loadExerciseLibrary().catch(()=>{}); // Vorladen fuer Bibliothek und Plan-Generator
    } else {
      authUser = null;
      state.plan = deepClone(DEFAULT_PLAN);
      state.screen = 'main';
      state.activeDayId = null;
      ui.tab = 'train'; ui.sheet = null; ui.finished = null;
      settings = { theme: null, language: null };
      onboarding = { equipment: [], focus: [], constraints: '', daysPerWeek: null, sessionMinutes: null, completed: false };
      onboardingCardDismissed = false;
      historySessions = null;
      ensureIds();
      render();
    }
  });
})();
