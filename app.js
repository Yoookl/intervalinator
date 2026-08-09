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
  screen: 'main', // 'main' | 'profile'
  expandedDayIds: new Set(),
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

function applyTheme(theme){
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
  state.expandedDayIds = new Set();
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
  state.expandedDayIds = new Set();
  render();
}

/* ---------- Audio ---------- */
let audioCtx = null;
function ensureAudio(){
  if(!audioCtx){
    try{ audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }catch(e){ audioCtx = null; }
  }
}
function beep(freq, durationMs, gain){
  if(!state.plan.soundOn) return;
  try{
    ensureAudio();
    if(!audioCtx) return;
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
      s.push({ mode:'exercise', seconds: secs, name: ex.name || '(ohne Namen)', muscle: ex.muscle, exNum: exIdx+1, totalEx: exercises.length, setNum: set, totalSets: sets });
      const isLastOverall = (exIdx === exercises.length-1) && (set === sets);
      if(!isLastOverall){
        const movingToNextExercise = (set === sets);
        const pauseLen = Math.max(0, movingToNextExercise ? effectivePauseAfter(ex) : effectiveSetPause(ex));
        s.push({ mode:'pause', seconds: pauseLen });
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

/* ---------- Modal ---------- */
// Erstes Overlay/Modal im Code. Wird an document.body gehaengt (nicht #app),
// da render() bei jedem Aufruf #app.innerHTML leert und ein offenes Modal sonst mitreissen wuerde.
function openModal(buildContentFn){
  const overlay = el('div', {class:'modal-overlay'});
  const box = el('div', {class:'modal-box'});

  function close(){
    document.removeEventListener('keydown', onKeydown);
    overlay.remove();
  }
  function onKeydown(e){
    if(e.key === 'Escape') close();
  }
  overlay.addEventListener('click', (e) => { if(e.target === overlay) close(); });
  document.addEventListener('keydown', onKeydown);

  box.appendChild(buildContentFn(close));
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  return close;
}

// Baut ein Zahlenfeld + "an globale Einstellung gekoppelt"-Checkbox fuer das Pause-Modal.
// initialValue ist immer der aktuell wirksame Wert (ob global oder eigen), damit beim Umschalten
// des Kopplungs-Status die Zahl nicht "springt".
function buildPauseFieldGroup(labelText, initialValue, initialLinked, onChange){
  const wrap = el('div', {class:'modal-field'});
  wrap.appendChild(el('div', {class:'modal-field-label'}, [labelText]));

  const row = el('div', {class:'modal-field-row'});
  const input = el('input', {type:'number', min:'0', step:'5'});
  input.value = initialValue;
  row.appendChild(input);
  wrap.appendChild(row);

  const toggleWrap = el('label', {class:'modal-toggle'});
  const checkbox = el('input', {type:'checkbox'});
  checkbox.checked = initialLinked;
  toggleWrap.appendChild(checkbox);
  toggleWrap.appendChild(el('span', {}, [t('pauseModal.linked')]));
  wrap.appendChild(toggleWrap);

  function emit(){
    onChange(checkbox.checked, Math.max(0, parseInt(input.value || '0', 10)));
  }
  input.addEventListener('input', emit);
  checkbox.addEventListener('change', emit);

  return wrap;
}

function effectiveSetPause(ex){
  return (ex.setPauseOverride != null) ? ex.setPauseOverride : state.plan.setPauseSeconds;
}
function effectivePauseAfter(ex){
  return (ex.pauseAfterOverride != null) ? ex.pauseAfterOverride : state.plan.pauseSeconds;
}

function openPauseSettingsModal(day, ex){
  openModal((close) => {
    const wrap = el('div', {});
    wrap.appendChild(el('div', {class:'modal-title'}, [t('pauseModal.title', {name: ex.name || t('exercise.namePlaceholder')})]));

    let setPauseLinked = ex.setPauseOverride == null;
    let setPauseValue = effectiveSetPause(ex);
    wrap.appendChild(buildPauseFieldGroup(t('pauseModal.setPauseLabel'), setPauseValue, setPauseLinked, (linked, value) => {
      setPauseLinked = linked; setPauseValue = value;
    }));

    let afterLinked = ex.pauseAfterOverride == null;
    let afterValue = effectivePauseAfter(ex);
    wrap.appendChild(buildPauseFieldGroup(t('pauseModal.afterLabel'), afterValue, afterLinked, (linked, value) => {
      afterLinked = linked; afterValue = value;
    }));

    const actions = el('div', {class:'modal-actions'});
    const cancelBtn = el('button', {class:'btn'}, [t('common.cancel')]);
    cancelBtn.addEventListener('click', close);
    const saveBtn = el('button', {class:'btn btn-primary'}, [t('common.save')]);
    saveBtn.addEventListener('click', () => {
      if(setPauseLinked){ state.plan.setPauseSeconds = setPauseValue; ex.setPauseOverride = null; }
      else { ex.setPauseOverride = setPauseValue; }
      if(afterLinked){ state.plan.pauseSeconds = afterValue; ex.pauseAfterOverride = null; }
      else { ex.pauseAfterOverride = afterValue; }
      schedulePersist();
      close();
      render();
    });
    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);
    wrap.appendChild(actions);

    return wrap;
  });
}

/* ---------- Render ---------- */
function render(){
  const app = document.getElementById('app');
  app.innerHTML = '';
  if(!authReady){
    app.appendChild(renderLoadingScreen());
    return;
  }
  if(!authUser){
    app.appendChild(renderAuthScreen());
    return;
  }
  if(state.running){
    app.appendChild(renderTimerScreen());
    return;
  }
  if(state.screen === 'profile'){
    app.appendChild(renderProfileScreen());
    return;
  }
  if(state.screen === 'onboarding'){
    app.appendChild(renderOnboardingScreen());
    return;
  }
  if(state.screen === 'history'){
    app.appendChild(renderHistoryScreen());
    return;
  }
  app.appendChild(renderMainView());
}

function renderLoadingScreen(){
  const wrap = el('div', {class:'auth-wrap'});
  wrap.appendChild(el('div', {class:'auth-sub'}, [t('common.loading')]));
  return wrap;
}

function renderAuthScreen(){
  const wrap = el('div', {class:'auth-wrap'});
  const card = el('div', {class:'auth-card'});
  const isLogin = authMode === 'login';
  card.appendChild(el('div', {class:'auth-title'}, [t('auth.title')]));
  card.appendChild(el('div', {class:'auth-sub'}, [isLogin ? t('auth.loginSubtitle') : t('auth.registerSubtitle')]));

  if(authError) card.appendChild(el('div', {class:'auth-error'}, [authError]));
  if(authInfo) card.appendChild(el('div', {class:'auth-info'}, [authInfo]));

  const emailField = el('div', {class:'auth-field'});
  emailField.appendChild(el('label', {}, [t('auth.email')]));
  const emailInput = el('input', {type:'email', autocomplete:'email'});
  emailField.appendChild(emailInput);

  const pwField = el('div', {class:'auth-field'});
  pwField.appendChild(el('label', {}, [t('auth.password')]));
  const pwInput = el('input', {type:'password', autocomplete: isLogin ? 'current-password' : 'new-password'});
  pwField.appendChild(pwInput);
  if(!isLogin) pwField.appendChild(el('div', {class:'auth-hint'}, [t('auth.passwordHint')]));

  card.appendChild(emailField);
  card.appendChild(pwField);

  const submitBtn = el('button', {class:'btn btn-primary btn-block'}, [authBusy ? t('auth.submitting') : (isLogin ? t('auth.loginButton') : t('auth.registerButton'))]);
  submitBtn.disabled = authBusy;
  submitBtn.addEventListener('click', () => {
    const email = emailInput.value.trim();
    const pw = pwInput.value;
    if(!email || !pw){ authError = t('auth.fillBoth'); render(); return; }
    if(!EMAIL_RE.test(email)){ authError = t('auth.invalidEmail'); render(); return; }
    if(!isLogin && pw.length < 8){ authError = t('auth.passwordTooShort'); render(); return; }
    if(isLogin) handleLogin(email, pw); else handleRegister(email, pw);
  });
  const onEnter = (e) => { if(e.key === 'Enter') submitBtn.click(); };
  emailInput.addEventListener('keydown', onEnter);
  pwInput.addEventListener('keydown', onEnter);

  card.appendChild(submitBtn);

  if(isLogin){
    const forgot = el('div', {class:'auth-forgot'});
    const forgotLink = el('a', {}, [t('auth.forgotPassword')]);
    forgotLink.addEventListener('click', () => handlePasswordReset(emailInput.value.trim()));
    forgot.appendChild(forgotLink);
    card.appendChild(forgot);
  }

  const switchRow = el('div', {class:'auth-switch'});
  const switchLink = el('a', {}, [isLogin ? t('auth.switchToRegister') : t('auth.switchToLogin')]);
  switchLink.addEventListener('click', () => {
    authMode = isLogin ? 'register' : 'login';
    authError = ''; authInfo = '';
    render();
  });
  switchRow.appendChild(switchLink);
  card.appendChild(switchRow);

  wrap.appendChild(card);
  return wrap;
}

const LANGUAGE_NAMES = { de: 'Deutsch', en: 'English', fr: 'Français', es: 'Español' };

function openDeleteAccountModal(){
  openModal((close) => {
    const wrap = el('div', {});
    wrap.appendChild(el('div', {class:'modal-title'}, [t('profile.deleteModalTitle')]));
    wrap.appendChild(el('div', {class:'sub'}, [t('profile.deleteAccountWarning')]));

    const pwField = el('div', {class:'auth-field'});
    pwField.appendChild(el('label', {}, [t('profile.deleteModalPasswordLabel')]));
    const pwInput = el('input', {type:'password'});
    pwField.appendChild(pwInput);
    wrap.appendChild(pwField);

    const actions = el('div', {class:'modal-actions'});
    const cancelBtn = el('button', {class:'btn'}, [t('common.cancel')]);
    cancelBtn.addEventListener('click', close);
    const confirmBtn = el('button', {class:'btn btn-danger'}, [t('profile.deleteModalConfirmButton')]);
    confirmBtn.addEventListener('click', () => {
      const pw = pwInput.value;
      close();
      handleDeleteAccount(pw);
    });
    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    wrap.appendChild(actions);

    return wrap;
  });
}

function renderProfileScreen(){
  const wrap = el('div', {});

  const head = el('div', {class:'user-bar'});
  const backBtn = el('button', {class:'btn logout-btn'}, ['← ' + t('profile.back')]);
  backBtn.addEventListener('click', () => { state.screen = 'main'; render(); });
  head.appendChild(backBtn);
  wrap.appendChild(head);

  wrap.appendChild(el('h1', {}, [t('profile.title')]));
  wrap.appendChild(el('div', {class:'sub'}, [authUser.email || '']));

  if(profileError) wrap.appendChild(el('div', {class:'auth-error'}, [profileError]));
  if(profileInfo) wrap.appendChild(el('div', {class:'auth-info'}, [profileInfo]));

  // Darstellung: Theme + Sprache
  const appearanceCard = el('div', {class:'card'});
  appearanceCard.appendChild(el('div', {class:'card-title'}, [t('profile.appearance')]));

  const themeField = el('div', {class:'field'});
  themeField.appendChild(el('label', {}, [t('profile.appearance')]));
  const themeSelect = el('select', {});
  const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
  ['dark','light'].forEach(th => {
    const opt = el('option', {value:th}, [t(th === 'dark' ? 'profile.themeDark' : 'profile.themeLight')]);
    if(th === currentTheme) opt.setAttribute('selected','selected');
    themeSelect.appendChild(opt);
  });
  themeSelect.addEventListener('change', e => {
    applyTheme(e.target.value);
    settings.theme = e.target.value;
    scheduleSettingsPersist();
  });
  themeField.appendChild(themeSelect);
  appearanceCard.appendChild(themeField);

  const langField = el('div', {class:'field'});
  langField.appendChild(el('label', {}, [t('profile.language')]));
  const langSelect = el('select', {});
  SUPPORTED_LANGUAGES.forEach(lang => {
    const opt = el('option', {value:lang}, [LANGUAGE_NAMES[lang]]);
    if(lang === currentLanguage) opt.setAttribute('selected','selected');
    langSelect.appendChild(opt);
  });
  langSelect.addEventListener('change', e => { setLanguage(e.target.value); });
  langField.appendChild(langSelect);
  appearanceCard.appendChild(langField);

  wrap.appendChild(appearanceCard);

  const onboardingLinkRow = el('div', {class:'profile-link-row'});
  const onboardingLink = el('a', {}, [t('onboarding.editLink')]);
  onboardingLink.addEventListener('click', () => { state.screen = 'onboarding'; render(); });
  onboardingLinkRow.appendChild(onboardingLink);
  wrap.appendChild(onboardingLinkRow);

  // Passwort aendern
  const pwCard = el('div', {class:'card'});
  pwCard.appendChild(el('div', {class:'card-title'}, [t('profile.changePasswordTitle')]));

  const curPwField = el('div', {class:'auth-field'});
  curPwField.appendChild(el('label', {}, [t('profile.currentPassword')]));
  const curPwInput = el('input', {type:'password', autocomplete:'current-password'});
  curPwField.appendChild(curPwInput);
  pwCard.appendChild(curPwField);

  const newPwField = el('div', {class:'auth-field'});
  newPwField.appendChild(el('label', {}, [t('profile.newPassword')]));
  const newPwInput = el('input', {type:'password', autocomplete:'new-password'});
  newPwField.appendChild(newPwInput);
  newPwField.appendChild(el('div', {class:'auth-hint'}, [t('auth.passwordHint')]));
  pwCard.appendChild(newPwField);

  const changePwBtn = el('button', {class:'btn btn-block'}, [t('profile.changePasswordButton')]);
  changePwBtn.addEventListener('click', () => {
    handleChangePassword(curPwInput.value, newPwInput.value);
  });
  pwCard.appendChild(changePwBtn);

  wrap.appendChild(pwCard);

  // Gefahrenzone: Account loeschen
  const dangerCard = el('div', {class:'card'});
  dangerCard.appendChild(el('div', {class:'card-title'}, [t('profile.dangerZone')]));
  dangerCard.appendChild(el('div', {class:'sub'}, [t('profile.deleteAccountWarning')]));
  const deleteBtn = el('button', {class:'btn btn-danger btn-block'}, [t('profile.deleteAccountButton')]);
  deleteBtn.addEventListener('click', () => openDeleteAccountModal());
  dangerCard.appendChild(deleteBtn);
  wrap.appendChild(dangerCard);

  return wrap;
}

function buildCheckboxList(idList, translationPrefix, selectedArray, onChange){
  const wrap = el('div', {class:'checkbox-list'});
  idList.forEach(id => {
    const row = el('label', {class:'checkbox-list-item'});
    const checkbox = el('input', {type:'checkbox'});
    checkbox.checked = selectedArray.includes(id);
    checkbox.addEventListener('change', () => {
      const idx = selectedArray.indexOf(id);
      if(checkbox.checked && idx === -1) selectedArray.push(id);
      else if(!checkbox.checked && idx !== -1) selectedArray.splice(idx, 1);
      onChange();
    });
    row.appendChild(checkbox);
    row.appendChild(el('span', {}, [t(translationPrefix + id)]));
    wrap.appendChild(row);
  });
  return wrap;
}

function renderOnboardingScreen(){
  const wrap = el('div', {});

  const head = el('div', {class:'user-bar'});
  const backBtn = el('button', {class:'btn logout-btn'}, ['← ' + t('onboarding.back')]);
  backBtn.addEventListener('click', () => { state.screen = 'main'; render(); });
  head.appendChild(backBtn);
  wrap.appendChild(head);

  wrap.appendChild(el('h1', {}, [t('onboarding.title')]));
  wrap.appendChild(el('div', {class:'sub'}, [t('onboarding.intro')]));

  const card = el('div', {class:'card'});

  card.appendChild(el('div', {class:'card-title'}, [t('onboarding.equipment')]));
  card.appendChild(buildCheckboxList(EQUIPMENT_IDS, 'equipment.', onboarding.equipment, () => scheduleOnboardingPersist()));

  card.appendChild(el('div', {class:'card-title', style:{marginTop:'16px'}}, [t('onboarding.focus')]));
  card.appendChild(buildCheckboxList(FOCUS_IDS, 'focus.', onboarding.focus, () => scheduleOnboardingPersist()));

  const daysField = el('div', {class:'field', style:{marginTop:'16px'}});
  daysField.appendChild(el('label', {}, [t('onboarding.daysPerWeek')]));
  const daysInput = el('input', {type:'number', min:'1', max:'7', step:'1'});
  daysInput.value = onboarding.daysPerWeek != null ? onboarding.daysPerWeek : '';
  daysInput.addEventListener('input', e => {
    const v = parseInt(e.target.value, 10);
    onboarding.daysPerWeek = isNaN(v) ? null : v;
    scheduleOnboardingPersist();
  });
  daysField.appendChild(daysInput);
  card.appendChild(daysField);

  const minutesField = el('div', {class:'field', style:{marginTop:'8px'}});
  minutesField.appendChild(el('label', {}, [t('onboarding.sessionMinutes')]));
  const minutesInput = el('input', {type:'number', min:'10', step:'5'});
  minutesInput.value = onboarding.sessionMinutes != null ? onboarding.sessionMinutes : '';
  minutesInput.addEventListener('input', e => {
    const v = parseInt(e.target.value, 10);
    onboarding.sessionMinutes = isNaN(v) ? null : v;
    scheduleOnboardingPersist();
  });
  minutesField.appendChild(minutesInput);
  card.appendChild(minutesField);

  const constraintsField = el('div', {class:'auth-field', style:{marginTop:'12px'}});
  constraintsField.appendChild(el('label', {}, [t('onboarding.constraints')]));
  const constraintsInput = el('input', {type:'text', placeholder: t('onboarding.constraintsPlaceholder')});
  constraintsInput.value = onboarding.constraints || '';
  constraintsInput.addEventListener('input', e => {
    onboarding.constraints = e.target.value;
    scheduleOnboardingPersist();
  });
  constraintsField.appendChild(constraintsInput);
  card.appendChild(constraintsField);

  wrap.appendChild(card);

  if(onboardingGenerateError) wrap.appendChild(el('div', {class:'auth-error'}, [onboardingGenerateError]));

  const actionsRow = el('div', {class:'onboarding-card-actions'});

  const wasCompleted = onboarding.completed;
  const generateBtn = el('button', {class:'btn btn-primary btn-block'}, [
    onboardingGenerating ? t('onboarding.generating') : t(wasCompleted ? 'onboarding.regenerateButton' : 'onboarding.generateButton')
  ]);
  generateBtn.disabled = onboardingGenerating;
  generateBtn.addEventListener('click', () => {
    if(wasCompleted) openRegeneratePlanModal(runGeneration);
    else runGeneration();
  });
  actionsRow.appendChild(generateBtn);

  const saveOnlyBtn = el('button', {class:'btn btn-block'}, [t('onboarding.saveOnlyButton')]);
  saveOnlyBtn.disabled = onboardingGenerating;
  saveOnlyBtn.addEventListener('click', () => {
    onboarding.completed = true;
    persistOnboarding();
    state.screen = 'main';
    render();
  });
  actionsRow.appendChild(saveOnlyBtn);

  wrap.appendChild(actionsRow);

  return wrap;
}

/* ---------- Historie ---------- */
let historyLoading = false;
let historySessions = null; // null = noch nicht geladen
let historyError = '';
let expandedExerciseKeys = new Set();

async function loadHistory(){
  if(!authUser) return;
  historyLoading = true; historyError = ''; render();
  try{
    const cutoff = new Date(Date.now() - 30*24*60*60*1000);
    const snap = await db.collection('users').doc(authUser.uid).collection('sessions')
      .where('finishedAt', '>=', cutoff)
      .orderBy('finishedAt', 'desc')
      .get();
    historySessions = snap.docs.map(d => d.data());
  }catch(e){
    historyError = e.message || t('error.unknown');
    historySessions = [];
  }
  historyLoading = false;
  render();
}

function aggregateByExercise(sessions){
  const map = new Map();
  sessions.forEach(s => {
    (s.exercises || []).forEach(ex => {
      const key = ex.name + '|' + (ex.muscle || '');
      if(!map.has(key)) map.set(key, { name: ex.name, muscle: ex.muscle, count: 0, sessions: [] });
      const entry = map.get(key);
      entry.count += 1;
      entry.sessions.push(s);
    });
  });
  return Array.from(map.values()).sort((a,b) => b.count - a.count);
}

function renderHistoryExerciseCard(entry){
  const card = el('div', {class:'card'});
  const key = entry.name + '|' + (entry.muscle || '');
  const isExpanded = expandedExerciseKeys.has(key);

  const head = el('div', {class:'collapsible-head'});
  head.appendChild(el('span', {class:`chevron ${isExpanded?'open':''}`}, ['▸']));
  const titleWrap = el('div', {style:{flex:'1'}});
  titleWrap.appendChild(el('div', {}, [entry.name || t('exercise.namePlaceholder')]));
  if(entry.muscle) titleWrap.appendChild(el('div', {class:'collapsible-title'}, [t('muscle.'+entry.muscle)]));
  head.appendChild(titleWrap);
  head.appendChild(el('div', {class:'pause-value'}, [t('history.countBadge', {count: entry.count})]));
  head.addEventListener('click', () => {
    if(isExpanded) expandedExerciseKeys.delete(key); else expandedExerciseKeys.add(key);
    render();
  });
  card.appendChild(head);

  if(isExpanded){
    const body = el('div', {class:'collapsible-body'});
    entry.sessions.slice(0, 10).forEach(s => {
      const dateStr = (s.finishedAt && s.finishedAt.toDate) ? s.finishedAt.toDate().toLocaleDateString() : '';
      body.appendChild(el('div', {class:'collapsible-summary'}, [`${dateStr} · ${s.dayName || ''}`]));
    });
    card.appendChild(body);
  }

  return card;
}

function renderHistoryScreen(){
  const wrap = el('div', {});

  const head = el('div', {class:'user-bar'});
  const backBtn = el('button', {class:'btn logout-btn'}, ['← ' + t('history.back')]);
  backBtn.addEventListener('click', () => { state.screen = 'main'; render(); });
  head.appendChild(backBtn);
  wrap.appendChild(head);

  wrap.appendChild(el('h1', {}, [t('history.title')]));
  wrap.appendChild(el('div', {class:'sub'}, [t('history.subtitle')]));

  if(historyLoading || historySessions === null){
    wrap.appendChild(el('div', {class:'empty-note'}, [t('common.loading')]));
    return wrap;
  }
  if(historyError){
    wrap.appendChild(el('div', {class:'auth-error'}, [historyError]));
  }

  const completedSessions = historySessions.filter(s => s.completed);
  if(completedSessions.length === 0){
    wrap.appendChild(el('div', {class:'empty-note'}, [t('history.empty')]));
    return wrap;
  }

  aggregateByExercise(completedSessions).forEach(entry => {
    wrap.appendChild(renderHistoryExerciseCard(entry));
  });

  return wrap;
}

function renderMainView(){
  const wrap = el('div', {});
  const userBar = el('div', {class:'user-bar'});
  userBar.appendChild(el('span', {class:'user-email'}, [authUser.email || '']));
  const userBarBtns = el('div', {class:'user-bar-btns'});
  const historyBtn = el('button', {class:'btn logout-btn'}, ['📊']);
  historyBtn.addEventListener('click', () => { state.screen = 'history'; historySessions = null; render(); loadHistory(); });
  userBarBtns.appendChild(historyBtn);
  const settingsBtn = el('button', {class:'btn logout-btn'}, ['⚙']);
  settingsBtn.addEventListener('click', () => { state.screen = 'profile'; render(); });
  userBarBtns.appendChild(settingsBtn);
  const logoutBtn = el('button', {class:'btn logout-btn'}, [t('main.logout')]);
  logoutBtn.addEventListener('click', handleLogout);
  userBarBtns.appendChild(logoutBtn);
  userBar.appendChild(userBarBtns);
  wrap.appendChild(userBar);
  wrap.appendChild(el('h1', {}, [t('main.title')]));
  wrap.appendChild(el('div', {class:'sub'}, [t('main.subtitle')]));

  if(!onboarding.completed && !onboardingCardDismissed){
    const obCard = el('div', {class:'card onboarding-card'});
    obCard.appendChild(el('div', {class:'card-title'}, [t('onboarding.introTitle')]));
    obCard.appendChild(el('div', {class:'sub', style:{margin:'0 0 4px'}}, [t('onboarding.introText')]));
    const obActions = el('div', {class:'onboarding-card-actions'});
    const skipBtn = el('button', {class:'btn'}, [t('onboarding.introSkip')]);
    skipBtn.addEventListener('click', () => { onboardingCardDismissed = true; render(); });
    const fillBtn = el('button', {class:'btn btn-primary'}, [t('onboarding.introStart')]);
    fillBtn.addEventListener('click', () => { state.screen = 'onboarding'; render(); });
    obActions.appendChild(skipBtn);
    obActions.appendChild(fillBtn);
    obCard.appendChild(obActions);
    wrap.appendChild(obCard);
  }

  const soundRow = el('div', {class:'sound-toggle', style:{marginBottom:'16px'}});
  const soundCheckbox = el('input', {type:'checkbox', id:'soundToggle'});
  soundCheckbox.checked = state.plan.soundOn;
  soundCheckbox.addEventListener('change', e => { state.plan.soundOn = e.target.checked; schedulePersist(); });
  soundRow.appendChild(soundCheckbox);
  soundRow.appendChild(el('label', {for:'soundToggle'}, [t('main.soundLabel')]));
  wrap.appendChild(soundRow);

  // Tage
  if(state.plan.days.length === 0){
    wrap.appendChild(el('div', {class:'empty-note'}, [t('main.noDaysYet')]));
  }
  state.plan.days.forEach((day, dayIdx) => {
    wrap.appendChild(renderDayCard(day, dayIdx));
  });

  const addDayBtn = el('button', {class:'btn btn-block'}, [t('main.addDay')]);
  addDayBtn.addEventListener('click', () => {
    const newDay = { id: uid(), name: t('main.newDayName'), exercises: [] };
    state.plan.days.push(newDay);
    state.expandedDayIds.add(newDay.id);
    schedulePersist();
    render();
  });
  wrap.appendChild(addDayBtn);

  return wrap;
}

function renderDayCard(day, dayIdx){
  const card = el('div', {class:'day-card'});
  const isExpanded = state.expandedDayIds.has(day.id);

  const head = el('div', {class:'day-head'});
  const chevron = el('span', {class:`chevron ${isExpanded?'open':''}`, style:{cursor:'pointer'}}, ['▸']);
  chevron.addEventListener('click', () => {
    if(isExpanded) state.expandedDayIds.delete(day.id);
    else state.expandedDayIds.add(day.id);
    render();
  });
  const nameInput = el('input', {class:'day-name-input', type:'text'});
  nameInput.value = day.name;
  nameInput.addEventListener('input', e => { day.name = e.target.value; schedulePersist(); });
  const delBtn = el('button', {class:'icon-btn'}, ['✕']);
  delBtn.addEventListener('click', () => {
    if(confirm(t('day.deleteConfirm', {name: day.name}))){
      state.expandedDayIds.delete(day.id);
      state.plan.days.splice(dayIdx,1);
      schedulePersist();
      render();
    }
  });
  head.appendChild(chevron);
  head.appendChild(nameInput);
  head.appendChild(delBtn);
  card.appendChild(head);

  const metaRow = el('div', {class:'day-meta-row'});
  metaRow.appendChild(el('div', {class:'day-total', 'data-day-id': day.id}, [t('day.totalDuration', {duration: formatMinSec(dayTotalSeconds(day))})]));
  const startBtn = el('button', {class:'btn btn-primary day-start-btn'}, [t('day.start')]);
  startBtn.addEventListener('click', () => {
    if(day.exercises.length > 0) startTimer(day);
    else alert(t('day.noExercisesAlert'));
  });
  metaRow.appendChild(startBtn);
  card.appendChild(metaRow);

  if(isExpanded){
    const body = el('div', {class:'collapsible-body'});

    if(day.exercises.length === 0){
      body.appendChild(el('div', {class:'empty-note'}, [t('day.noExercisesYet')]));
    }
    day.exercises.forEach((ex, exIdx) => {
      body.appendChild(renderExerciseRow(day, ex, exIdx));
    });
    const addExBtn = el('button', {class:'btn add-ex-btn'}, [t('day.addExercise')]);
    addExBtn.addEventListener('click', () => {
      day.exercises.push(makeExercise('', MUSCLE_GROUP_IDS[0], 3, 30));
      schedulePersist();
      render();
    });
    body.appendChild(addExBtn);

    card.appendChild(body);
  }

  return card;
}

function updateDayTotalDisplay(day){
  const elm = document.querySelector(`.day-total[data-day-id="${day.id}"]`);
  if(elm) elm.textContent = t('day.totalDuration', {duration: formatMinSec(dayTotalSeconds(day))});
}

function renderExerciseRow(day, ex, exIdx){
  const row = el('div', {class:'exercise-row'});

  const reorderBox = el('div', {class:'reorder-box'});
  const upBtn = el('button', {class:'icon-btn reorder-btn'}, ['▲']);
  upBtn.disabled = (exIdx === 0);
  upBtn.addEventListener('click', () => {
    if(exIdx === 0) return;
    [day.exercises[exIdx-1], day.exercises[exIdx]] = [day.exercises[exIdx], day.exercises[exIdx-1]];
    schedulePersist();
    render();
  });
  const downBtn = el('button', {class:'icon-btn reorder-btn'}, ['▼']);
  downBtn.disabled = (exIdx === day.exercises.length - 1);
  downBtn.addEventListener('click', () => {
    if(exIdx === day.exercises.length - 1) return;
    [day.exercises[exIdx+1], day.exercises[exIdx]] = [day.exercises[exIdx], day.exercises[exIdx+1]];
    schedulePersist();
    render();
  });
  reorderBox.appendChild(upBtn);
  reorderBox.appendChild(downBtn);

  const content = el('div', {class:'ex-content'});
  const line1 = el('div', {class:'ex-line1'});

  const nameInput = el('input', {type:'text', class:'ex-name', placeholder: t('exercise.namePlaceholder')});
  nameInput.value = ex.name;
  nameInput.addEventListener('input', e => { ex.name = e.target.value; schedulePersist(); });

  const muscleSelect = el('select', {class:'ex-muscle'});
  MUSCLE_GROUP_IDS.forEach(id => {
    const opt = el('option', {value:id}, [t('muscle.'+id)]);
    if(ex.muscle === id) opt.setAttribute('selected','selected');
    muscleSelect.appendChild(opt);
  });
  muscleSelect.addEventListener('change', e => { ex.muscle = e.target.value; schedulePersist(); });

  const delBtn = el('button', {class:'icon-btn'}, ['✕']);
  delBtn.addEventListener('click', () => {
    const realIdx = day.exercises.indexOf(ex);
    if(realIdx >= 0) day.exercises.splice(realIdx, 1);
    schedulePersist();
    render();
  });

  line1.appendChild(nameInput);
  line1.appendChild(muscleSelect);
  line1.appendChild(delBtn);

  const line2 = el('div', {class:'ex-line2'});

  const setsField = el('div', {class:'field-mini'});
  setsField.appendChild(el('label', {}, [t('exercise.sets')]));
  const setsInput = el('input', {type:'number', min:'1'});
  setsInput.value = ex.sets;
  setsInput.addEventListener('input', e => {
    ex.sets = Math.max(1, parseInt(e.target.value||'1',10));
    schedulePersist();
    updateDayTotalDisplay(day);
  });
  setsField.appendChild(setsInput);

  const secField = el('div', {class:'field-mini'});
  secField.appendChild(el('label', {}, [t('exercise.secondsPerSet')]));
  const secInput = el('input', {type:'number', min:'5', step:'5'});
  secInput.value = ex.seconds;
  secInput.addEventListener('input', e => {
    ex.seconds = Math.max(5, parseInt(e.target.value||'30',10));
    schedulePersist();
    updateDayTotalDisplay(day);
  });
  secField.appendChild(secInput);

  const pauseField = el('div', {class:'field-mini pause-trigger'});
  pauseField.appendChild(el('label', {}, [t('exercise.pauseLabel')]));
  pauseField.appendChild(el('div', {class:'pause-value'}, [
    t('exercise.pauseSummary', {
      value: effectivePauseAfter(ex),
      tag: ex.pauseAfterOverride == null ? t('exercise.linkedTag') : t('exercise.customTag')
    })
  ]));
  pauseField.addEventListener('click', () => openPauseSettingsModal(day, ex));

  line2.appendChild(setsField);
  line2.appendChild(secField);
  line2.appendChild(pauseField);

  content.appendChild(line1);
  content.appendChild(line2);

  row.appendChild(reorderBox);
  row.appendChild(content);
  return row;
}



/* ---------- Timer-Ablauf ---------- */
let sessionStartStamp = null;

function startTimer(day){
  ensureAudio();
  steps = buildSteps(day);
  if(steps.length === 0) return;
  computeStepOffsets();
  state.running = true;
  state.stepIndex = 0;
  state.remaining = steps[0].seconds;
  state.paused = false;
  state.currentDayName = day.name;
  sessionStartStamp = new Date();

  beepForMode(steps[0].mode);

  clearInterval(state.intervalId);
  state.intervalId = setInterval(tick, 1000);
  render();
}

function tick(){
  if(state.paused || !state.running) return;
  state.remaining -= 1;
  if(state.remaining <= 0){
    advanceStep();
  } else {
    if(state.remaining === 10) tenSecondWarning();
    if(state.remaining <= 5) countdownBeep(state.remaining);
    updateTimerDOM();
  }
}

function advanceStep(){
  state.stepIndex += 1;
  if(state.stepIndex >= steps.length){
    finishTimer();
    return;
  }
  const s = steps[state.stepIndex];
  state.remaining = s.seconds;
  beepForMode(s.mode);
  if(navigator.vibrate) navigator.vibrate(150);
  render();
}

function skipStep(){ advanceStep(); }
function togglePause(){ state.paused = !state.paused; render(); }
function computeSessionSummary(fullyFinished){
  const completedUpToIndex = fullyFinished ? steps.length : state.stepIndex;
  const elapsed = fullyFinished ? stepsTotalSeconds : elapsedSeconds();
  const completionFraction = stepsTotalSeconds > 0 ? elapsed / stepsTotalSeconds : 0;

  const exerciseMap = new Map();
  for(let i = 0; i < completedUpToIndex; i++){
    const s = steps[i];
    if(s.mode !== 'exercise') continue;
    const key = s.name + '|' + (s.muscle || '');
    if(!exerciseMap.has(key)){
      exerciseMap.set(key, { name: s.name, muscle: s.muscle, reachedSets: 0, totalSets: s.totalSets });
    }
    exerciseMap.get(key).reachedSets += 1;
  }

  return {
    dayName: state.currentDayName,
    exercises: Array.from(exerciseMap.values()),
    totalPlannedSeconds: stepsTotalSeconds,
    elapsedSeconds: Math.round(elapsed),
    completionFraction: completionFraction,
    completed: completionFraction >= 0.75
  };
}

async function logSession(summary){
  if(!authUser || summary.elapsedSeconds <= 0) return;
  try{
    await db.collection('users').doc(authUser.uid).collection('sessions').add({
      dayName: summary.dayName,
      exercises: summary.exercises,
      startedAt: sessionStartStamp || firebase.firestore.FieldValue.serverTimestamp(),
      finishedAt: firebase.firestore.FieldValue.serverTimestamp(),
      totalPlannedSeconds: summary.totalPlannedSeconds,
      elapsedSeconds: summary.elapsedSeconds,
      completionFraction: summary.completionFraction,
      completed: summary.completed
    });
  }catch(e){ /* Historie ist unterstuetzend, kein User-Feedback noetig */ }
}

function stopTimer(){
  logSession(computeSessionSummary(false));
  clearInterval(state.intervalId);
  state.running = false;
  render();
}
function finishTimer(){
  logSession(computeSessionSummary(true));
  clearInterval(state.intervalId);
  state.running = false;
  finishFanfare();
  const app = document.getElementById('app');
  app.innerHTML = '';
  const wrap = el('div', {class:'finished'});
  wrap.appendChild(el('div', {class:'big'}, ['🏁']));
  wrap.appendChild(el('h1', {}, [t('finished.title')]));
  wrap.appendChild(el('div', {class:'sub'}, [t('finished.subtitle', {day: state.currentDayName})]));
  const backBtn = el('button', {class:'btn btn-primary btn-block'}, [t('finished.back')]);
  backBtn.addEventListener('click', () => { render(); });
  wrap.appendChild(backBtn);
  app.appendChild(wrap);
}

function peekNext(fromIndex){
  for(let i=fromIndex+1; i<steps.length; i++){
    const st = steps[i];
    if(st.mode === 'exercise') return { type:'exercise', name: st.name, setNum: st.setNum, totalSets: st.totalSets };
  }
  return null;
}

function renderTimerScreen(){
  const s = steps[state.stepIndex];
  const isRestColor = (s.mode === 'pause');
  const wrap = el('div', {class:'wrap timer-screen'});

  let primary = '';
  let secondary = '';
  let hint = '';

  if(s.mode === 'exercise'){
    primary = s.name;
    secondary = t('timer.exerciseSecondary', {muscle: t('muscle.'+s.muscle), set: s.setNum, total: s.totalSets});
    if(s.setNum === s.totalSets){
      const nxt = peekNext(state.stepIndex);
      if(nxt && nxt.type === 'exercise') hint = t('timer.nextExercise', {name: nxt.name});
    }
  } else if(s.mode === 'pause'){
    primary = t('timer.pause');
    const nextStep = steps[state.stepIndex+1];
    if(nextStep && nextStep.mode === 'exercise'){
      secondary = (nextStep.setNum === 1)
        ? t('timer.nextExercise', {name: nextStep.name})
        : t('timer.continueWith', {name: nextStep.name, set: nextStep.setNum, total: nextStep.totalSets});
    }
  }

  wrap.appendChild(el('div', {class:'timer-meta'}, [t('timer.stepMeta', {day: state.currentDayName, current: state.stepIndex+1, total: steps.length})]));
  wrap.appendChild(el('div', {class:`timer-primary ${isRestColor?'pause-mode':'exercise-mode'}`}, [primary]));
  if(secondary) wrap.appendChild(el('div', {class:'timer-secondary'}, [secondary]));
  if(hint) wrap.appendChild(el('div', {class:'timer-hint'}, [hint]));

  const ringWrap = el('div', {class:'ring-wrap'});
  const circumference = 2*Math.PI*108;
  ringWrap.innerHTML = `
    <svg width="240" height="240" viewBox="0 0 240 240">
      <circle class="ring-bg" cx="120" cy="120" r="108"></circle>
      <circle class="ring-fg ${isRestColor?'pause-mode':''}" id="ringFg" cx="120" cy="120" r="108"
        stroke-dasharray="${circumference}" stroke-dashoffset="0"></circle>
    </svg>
    <div class="ring-center">
      <div class="ring-time" id="ringTime">${state.remaining}</div>
    </div>
  `;
  wrap.appendChild(ringWrap);

  const overall = el('div', {class:'overall-progress'});
  const elapsed = elapsedSeconds();
  overall.innerHTML = `
    <div class="overall-progress-track">
      <div class="overall-progress-fill" id="overallFill" style="width:${(elapsed/Math.max(1,stepsTotalSeconds))*100}%"></div>
    </div>
    <div class="overall-progress-text">
      <span id="overallElapsed">${formatClock(elapsed)}</span>
      <span>${t('timer.overallTotal', {duration: formatClock(stepsTotalSeconds)})}</span>
    </div>
  `;
  wrap.appendChild(overall);

  const controls = el('div', {class:'timer-controls'});
  const pauseBtn = el('button', {class:'btn'}, [state.paused ? t('timer.resumeBtn') : t('timer.pauseBtn')]);
  pauseBtn.addEventListener('click', togglePause);
  const skipBtn = el('button', {class:'btn'}, [t('timer.skipBtn')]);
  skipBtn.addEventListener('click', skipStep);
  const cancelBtn = el('button', {class:'btn btn-danger'}, [t('timer.cancelBtn')]);
  cancelBtn.addEventListener('click', stopTimer);
  controls.appendChild(pauseBtn);
  controls.appendChild(skipBtn);
  controls.appendChild(cancelBtn);
  wrap.appendChild(controls);

  return wrap;
}

function updateTimerDOM(){
  const ring = document.getElementById('ringFg');
  const timeEl = document.getElementById('ringTime');
  if(ring && timeEl){
    const s = steps[state.stepIndex];
    const frac = Math.max(0, state.remaining) / s.seconds;
    const circumference = 2*Math.PI*108;
    ring.style.strokeDashoffset = String(circumference * (1 - frac));
    timeEl.textContent = Math.max(0, state.remaining);
  }
  const fill = document.getElementById('overallFill');
  const elapsedEl = document.getElementById('overallElapsed');
  if(fill && elapsedEl){
    const elapsed = elapsedSeconds();
    fill.style.width = `${(elapsed/Math.max(1,stepsTotalSeconds))*100}%`;
    elapsedEl.textContent = formatClock(elapsed);
  }
}

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
      loadPlanForCurrentUser();
      loadExerciseLibrary().catch(()=>{}); // Vorladen, damit sie beim Onboarding meist schon bereitsteht
    } else {
      authUser = null;
      state.plan = deepClone(DEFAULT_PLAN);
      state.screen = 'main';
      settings = { theme: null, language: null };
      onboarding = { equipment: [], focus: [], constraints: '', daysPerWeek: null, sessionMinutes: null, completed: false };
      onboardingCardDismissed = false;
      historySessions = null;
      ensureIds();
      render();
    }
  });
})();
