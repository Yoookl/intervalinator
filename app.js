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

const CURRENT_PLAN_SCHEMA_VERSION = 6;
const DEFAULT_GROUP_SWITCH_SECONDS = 10;
const DEFAULT_STRENGTH_REST_SECONDS = 120; // Studien sprechen fuer Kraft und Muskelaufbau eher fuer Pausen ab 2 Minuten
const DEFAULT_WARMUP_SECONDS = 60;
const DEFAULT_STRETCH_SECONDS = 120;

function makeExercise(name, muscle, sets, seconds){
  return { name, muscle, sets, seconds, pauseAfterOverride:null, setPauseOverride:null, groupId:null };
}
// Aufwaermen/Dehnen sind bewusst ganz normale Uebungen (kein Sonderfall) -
// vorbelegt mit 1 Satz und 60/120 Sek., aber genauso frei editier-/loesch-/verschiebbar wie jede andere.
function makeDay(name, exercises){
  return { name, type:'interval', exercises: [
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
  groupSwitchSeconds: DEFAULT_GROUP_SWITCH_SECONDS,
  strengthRestSeconds: DEFAULT_STRENGTH_REST_SECONDS,
  soundOn: true,
  days: [],
  myExercises: []
};

const state = {
  plan: deepClone(DEFAULT_PLAN),
  screen: 'main', // 'main' (Tabs) | 'onboarding' | 'strength' | 'finished'
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
  if(version < 6){
    // Neu: Trainingsart je Tag, Gruppen und eine eigene Uebungsliste. Bestehende Tage bleiben Intervall-Tage.
    if(plan.groupSwitchSeconds == null) plan.groupSwitchSeconds = DEFAULT_GROUP_SWITCH_SECONDS;
    if(plan.strengthRestSeconds == null) plan.strengthRestSeconds = DEFAULT_STRENGTH_REST_SECONDS;
    plan.myExercises = plan.myExercises || [];
    (plan.days || []).forEach(d => {
      d.type = d.type || 'interval';
      (d.exercises || []).forEach(ex => {
        if(ex.groupId === undefined) ex.groupId = null;
        upsertMyExercise(plan, ex);
      });
    });
    version = 6;
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
  // Ein gerade gezeigter Hinweis (showToast) soll nicht sofort von "Gespeichert" ersetzt werden.
  if(ok && Date.now() < (showToast.until || 0)) return;
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
  state.plan.days.forEach(d => d.exercises.forEach(ex => upsertMyExercise(state.plan, ex)));
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
  if((state.running || sr) && !wakeLockSentinel) requestWakeLock();
  if(sr) updateStrengthDOM();
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
  const blocks = blocksOf(day);
  blocks.forEach((block, bIdx) => {
    // Eine Gruppe laeuft reihum (a-b-a-b): pro Runde jede Uebung einmal.
    const rounds = Math.max(1, exercises[block[0]].sets || 1);
    for(let set = 1; set <= rounds; set++){
      block.forEach((exIdx, mIdx) => {
        const ex = exercises[exIdx];
        const secs = Math.max(1, ex.seconds || 1);
        s.push({ mode:'exercise', seconds: secs, name: ex.name || t('exercise.unnamed'), muscle: ex.muscle, exIdx, exNum: exIdx+1, totalEx: exercises.length, setNum: set, totalSets: rounds, inGroup: block.length > 1 });
        const lastMember = mIdx === block.length - 1, lastRound = set === rounds;
        if(bIdx === blocks.length - 1 && lastMember && lastRound) return;
        // kind/afterExIdx: damit die Anzeige weiss, was fuer eine Pause gerade laeuft.
        if(lastMember && lastRound) s.push({ mode:'pause', seconds: Math.max(0, effectivePauseAfter(ex, day)), kind:'exercise', afterExIdx: exIdx });
        else s.push({ mode:'pause', seconds: Math.max(0, effectiveSetPause(ex, day)), kind: block.length === 1 ? 'set' : (lastMember ? 'round' : 'switch'), afterExIdx: exIdx });
      });
    }
  });
  return s;
}

function dayTotalSeconds(day){
  if(dayType(day) === 'strength'){
    // Nur eine Schaetzung: rund 40 Sekunden pro Satz plus Pause.
    return strengthQueue(day).reduce((a, x) => a + 40 + effectiveSetPause(x.ex, day), 0);
  }
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

function dayType(day){ return day && day.type === 'strength' ? 'strength' : 'interval'; }

/* Gruppen: direkt aufeinanderfolgende Uebungen mit gleicher groupId bilden eine Gruppe.
   blocksOf liefert die Reihenfolge als Listen von Uebungs-Indizes (einzelne Uebung = Liste mit einem Eintrag). */
function blocksOf(day){
  const blocks = [];
  day.exercises.forEach((ex, i) => {
    const last = blocks[blocks.length - 1];
    if(ex.groupId && last && day.exercises[last[last.length - 1]].groupId === ex.groupId) last.push(i);
    else blocks.push([i]);
  });
  return blocks;
}
function groupInfo(day, i){
  let letterIdx = 0;
  for(const block of blocksOf(day)){
    const grouped = block.length > 1;
    if(block.includes(i)){
      return { inGroup: grouped, letter: grouped ? String.fromCharCode(65 + letterIdx) : '', pos: block.indexOf(i) + 1, size: block.length,
               first: block[0] === i, last: block[block.length - 1] === i, block };
    }
    if(grouped) letterIdx++;
  }
  return { inGroup: false, letter: '', pos: 1, size: 1, first: true, last: true, block: [i] };
}
// Haelt Gruppen gueltig: nur zusammenhaengend, mindestens zwei Uebungen, gleiche Rundenzahl.
function normalizeGroups(day){
  const list = day.exercises, seen = new Set();
  let i = 0;
  while(i < list.length){
    const g = list[i].groupId;
    if(!g){ i++; continue; }
    if(seen.has(g)){ list[i].groupId = null; i++; continue; }
    let j = i;
    while(j + 1 < list.length && list[j + 1].groupId === g) j++;
    seen.add(g);
    if(j === i) list[i].groupId = null;
    else for(let k = i + 1; k <= j; k++) list[k].sets = list[i].sets;
    i = j + 1;
  }
}

function defaultSetPause(ex, day){
  const strength = dayType(day) === 'strength';
  const i = day ? day.exercises.indexOf(ex) : -1;
  const g = i >= 0 ? groupInfo(day, i) : null;
  if(g && g.inGroup && !g.last) return strength ? 0 : state.plan.groupSwitchSeconds;
  return strength ? state.plan.strengthRestSeconds : state.plan.setPauseSeconds;
}
// In einer Gruppe ist das die Pause nach der Uebung innerhalb der Runde (bzw. nach der Runde bei der letzten Uebung).
function effectiveSetPause(ex, day){
  return (ex.setPauseOverride != null) ? ex.setPauseOverride : defaultSetPause(ex, day);
}
function effectivePauseAfter(ex, day){
  if(dayType(day) === 'strength') return effectiveSetPause(ex, day);
  return (ex.pauseAfterOverride != null) ? ex.pauseAfterOverride : state.plan.pauseSeconds;
}

/* Eigene Uebungen: alles, was man im Plan benutzt, landet in plan.myExercises und steht beim Hinzufuegen ganz oben.
   Eindeutig ueber den Namen (ohne Gross-/Kleinschreibung), Aufwaermen und Dehnen zaehlen nicht. */
function myKey(name){ return String(name || '').trim().toLowerCase(); }
function upsertMyExercise(plan, ex){
  const key = myKey(ex.name);
  if(!key || ex.muscle === 'warmup' || ex.muscle === 'stretch') return null;
  plan.myExercises = plan.myExercises || [];
  let my = plan.myExercises.find(m => myKey(m.name) === key);
  if(!my){ my = { id: uid(), name: ex.name.trim(), last: null }; plan.myExercises.push(my); }
  Object.assign(my, { muscle: ex.muscle, sets: ex.sets, seconds: ex.seconds, usedAt: Date.now() });
  if(ex.reps != null) Object.assign(my, { reps: ex.reps, weight: ex.weight || 0, unit: ex.unit || 'reps' });
  if(ex.setPlan) my.setPlan = ex.setPlan.map(p => ({ r: p.r, w: p.w || 0 }));
  else delete my.setPlan;
  return my;
}
function rememberExercise(ex){ return upsertMyExercise(state.plan, ex); }
function findMyExercise(name){
  const key = myKey(name);
  return (state.plan.myExercises || []).find(m => myKey(m.name) === key) || null;
}

/* Vorschlaege fuer die naechste Muskelgruppe. Grundlage: Gegenspieler-Paare halten in Gruppen das Trainingsvolumen,
   aehnliche Muskeln senken es; rund 48 Stunden Erholung je Muskel als Faustregel; Saetze pro Woche als Ausgleich. */
const ANTAGONISTS = { chest:['back'], back:['chest'], biceps:['triceps'], triceps:['biceps'], shoulders:['back'], legs:['abs'], abs:['legs'] };
const SYNERGISTS = { chest:['triceps','shoulders'], back:['biceps'], shoulders:['triceps'], legs:['abs'] };
const SUGGESTABLE_MUSCLES = ['chest','back','shoulders','biceps','triceps','legs','abs'];
function muscleHistory(){
  const sets = {}, lastAt = {};
  const weekAgo = Date.now() - 7 * 864e5;
  completedSessions().forEach(s => {
    const when = sessionDate(s);
    (s.exercises || []).forEach(e => {
      if(!e.muscle) return;
      if(when >= weekAgo) sets[e.muscle] = (sets[e.muscle] || 0) + (e.reachedSets || 0);
      if(!lastAt[e.muscle] || when > lastAt[e.muscle]) lastAt[e.muscle] = when;
    });
  });
  return { sets, lastAt };
}
function suggestMuscles(day, anchor, asGroup){
  const inDay = {};
  day.exercises.forEach(e => { inDay[e.muscle] = (inDay[e.muscle] || 0) + 1; });
  const hist = muscleHistory();
  return SUGGESTABLE_MUSCLES.map(m => {
    let score = 0, reason = '';
    const anchorName = anchor ? t('muscle.' + anchor.muscle) : '';
    if(anchor && (ANTAGONISTS[anchor.muscle] || []).includes(m)){ score += asGroup ? 6 : 3; reason = t('suggest.antagonist', {muscle: anchorName}); }
    else if(anchor && !asGroup && (SYNERGISTS[anchor.muscle] || []).includes(m)){ score += 3; reason = t('suggest.synergist', {muscle: anchorName}); }
    if(anchor && asGroup && anchor.muscle === m) score -= 4;
    if(!inDay[m]){ score += 2; if(!reason) reason = t('suggest.missing'); }
    if(inDay[m] >= 2) score -= 3;
    const last = hist.lastAt[m];
    const hoursAgo = last ? (Date.now() - last) / 36e5 : null;
    if(hoursAgo != null && hoursAgo < 48){ score -= 2; if(reason === t('suggest.missing')) reason = ''; }
    else if((hist.sets[m] || 0) < 6){ score += 1; if(!reason) reason = t('suggest.lowWeek', {n: hist.sets[m] || 0}); }
    return { muscle: m, score, reason };
  }).filter(x => x.score > 0 && x.reason).sort((a, b) => b.score - a.score).slice(0, 3);
}
function showToast(msg){
  const el = document.getElementById('saveToast');
  if(!el) return;
  showToast.until = Date.now() + 2200;
  el.textContent = msg;
  el.style.color = '';
  el.classList.add('show');
  clearTimeout(showSaveStatus._t);
  showSaveStatus._t = setTimeout(() => el.classList.remove('show'), 2200);
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
  sound:'<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/>', link:'<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>', logout:'<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/>', search:'<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4-4"/>', flag:'<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>'
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
  libGroupWith: null,  // Uebung, mit der eine neue Uebung gruppiert werden soll
  libMore: false,      // Bibliothek aufgeklappt
  exportDayId: null,   // null = ganzer Plan, sonst ein einzelner Trainingstag
  exportInfo: '',
  importResult: null,  // Ergebnis von parsePlanJson
  importEmptyDayId: null, // leerer Tag, aus dem heraus importiert wird
  importConfirmReplace: false,
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
function doseLabel(ex, day){
  if(dayType(day) === 'strength'){
    if(ex.setPlan && ex.setPlan.length){
      const rs = ex.setPlan.map(p => p.r), ws = ex.setPlan.map(p => p.w || 0);
      const range = a => Math.min(...a) === Math.max(...a) ? `${a[0]}` : `${Math.min(...a)}–${Math.max(...a)}`;
      return `${ex.sets} × ${range(rs)}${ex.unit === 'seconds' ? ' s' : ''}${Math.max(...ws) > 0 ? ' · ' + range(ws).replace(/\./g, currentLanguage === 'en' ? '.' : ',') + ' kg' : ''}`;
    }
    const amount = ex.unit === 'seconds' ? `${ex.reps} s` : `${ex.reps}`;
    return `${ex.sets} × ${amount}${ex.weight > 0 ? ' · ' + fmtKg(ex.weight) : ''}`;
  }
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

  // Laufendes Training: nur Teile aktualisieren, damit das Karten-Rad seine Scrollposition behaelt.
  if(authReady && authUser && state.running){ renderRun(app); return; }
  if(authReady && authUser && state.screen === 'strength' && sr){ renderStrength(app); return; }

  let html;
  if(!authReady) html = `<div class="center-screen"><div class="muted">${esc(t('common.loading'))}</div></div>`;
  else if(!authUser) html = vAuth();
  else if(state.screen === 'finished' && ui.finished) html = vFinished();
  else if(state.screen === 'onboarding') html = vSetup();
  else html = vTabs();
  app.innerHTML = html + vSheet();

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
        <button class="btn btn-ghost" data-act="openImport">${esc(t('import.title'))}</button>
      </div>
    </div>`;
  }
  const d = activeDay(), due = dueDay();
  const total = dayTotalSeconds(d);
  const resume = srSaved();
  return `
  <header class="head"><h1 class="display">${esc(t('train.title'))}</h1></header>
  <div class="days" role="tablist" aria-label="${esc(t('train.daysLabel'))}">
    ${days.map(x => `
      <button class="day-chip ${x.id === d.id ? 'on' : ''}" role="tab" aria-selected="${x.id === d.id}" data-act="pickDay" data-arg="${x.id}">
        ${due && x.id === due.id ? `<span class="due">${esc(t('train.due'))}</span>` : ''}
        <b>${esc(x.name || t('main.newDayName'))}</b><span>${dayType(x) === 'strength' ? esc(t('train.typeStrength')) + ' · ' : ''}${esc(minutesLabel(dayTotalSeconds(x)))}</span>
      </button>`).join('')}
    <button class="day-chip add" data-act="addDay" aria-label="${esc(t('train.addDay'))}">${icon('plus')}</button>
  </div>
  <div class="screen">
    ${resume ? `
      <div class="hint-card">
        <b>${esc(t('strength.resumeTitle', {name: resume.day.name}))}</b>
        <p>${esc(t('strength.resumeText', {time: formatClock((Date.now() - resume.saved.startedAt) / 1000)}))}</p>
        <div class="row-btns"><button class="btn btn-small btn-ghost" data-act="discardStrength">${esc(t('strength.discard'))}</button><button class="btn btn-small btn-primary" data-act="resumeStrength">${esc(t('strength.resume'))}</button></div>
      </div>` : ''}
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
    <button class="btn btn-primary btn-start" data-act="start" ${d.exercises.length ? '' : 'disabled'}>${icon('play', 22)} ${esc(t('train.start', {name: d.name}))} <small>· ${dayType(d) === 'strength' ? '~' : ''}${esc(minutesLabel(total))}</small></button>
  </div>`;
}

/* Kompakte Spur: eine Zeile pro Uebung, dazwischen die Pause. Gruppen stehen in einem gemeinsamen Rahmen.
   pos (nur im Abschluss-Bildschirm) = { exIdx, all } markiert, was erledigt ist. */
function vTrack(d, pos){
  const live = !!pos;
  const strength = dayType(d) === 'strength';
  const linkable = i => {
    const a = d.exercises[i], b = d.exercises[i + 1];
    return !live && b && ![a.muscle, b.muscle].some(m => m === 'warmup' || m === 'stretch');
  };
  return `<ol class="track ${live ? 'live' : ''}">${d.exercises.map((ex, i) => {
    const g = groupInfo(d, i);
    const st = pos && (pos.all || i < pos.exIdx) ? 'done' : '';
    const pause = effectiveSetPause(ex, d);
    let pauseTxt = '';
    if(!g.inGroup && ex.sets > 1 && !strength) pauseTxt = t('ex.setPauseShort', {s: pause}) + (ex.setPauseOverride != null ? ' · ' + t('ex.custom') : '');
    if(g.inGroup && g.last) pauseTxt = t('group.roundPause', {s: pause});
    const head = g.inGroup && g.first ? groupHead(d, g, ex, i, live) : '';
    const row = `<li class="ex ${st} ${g.inGroup ? 'in-group' : ''}">
      <button class="ex-btn" ${live ? 'tabindex="-1"' : `data-act="editEx" data-arg="${ex.id}"`}>
        <span class="node">${st === 'done' ? icon('check', 13) : g.inGroup ? g.letter + g.pos : i + 1}</span>
        <span class="ex-main">
          <span class="ex-name">${esc(ex.name || t('exercise.namePlaceholder'))}</span>
          <span class="ex-sub"><i style="background:${muscleColor(ex.muscle)}"></i>${esc(t('muscle.' + ex.muscle))}${pauseTxt ? ' · ' + esc(pauseTxt) : ''}</span>
        </span>
        <span class="ex-dose">${esc(g.inGroup && !strength ? ex.seconds + ' s' : doseLabel(ex, d))}</span>
      </button>
    </li>`;
    if(i === d.exercises.length - 1) return head + row;
    const sameGroup = g.inGroup && !g.last;
    const gapText = sameGroup
      ? (pause > 0 ? t('group.switch', {s: pause}) : t('group.direct'))
      : t('track.rest', {s: effectivePauseAfter(ex, d)}) + (!strength && ex.pauseAfterOverride != null ? ' · ' + t('ex.custom') : '');
    const gap = `<li class="gap ${sameGroup ? 'in-group' : ''} ${st}">
      <button class="gap-pause" ${live ? 'tabindex="-1"' : `data-act="editEx" data-arg="${ex.id}"`}>${icon('clock', 13)} ${esc(gapText)}</button>
      ${linkable(i) ? `<button class="gap-link ${sameGroup ? 'on' : ''}" data-act="toggleLink" data-arg="${i}" aria-pressed="${sameGroup}" aria-label="${esc(t(sameGroup ? 'group.unlink' : 'group.link'))}">${icon('link', 14)}<span>${esc(t(sameGroup ? 'group.unlinkShort' : 'group.linkShort'))}</span></button>` : ''}
    </li>`;
    return head + row + gap;
  }).join('')}</ol>`;
}
function groupHead(d, g, ex, i, live){
  const muscles = g.block.map(k => d.exercises[k].muscle);
  const similar = new Set(muscles).size < muscles.length;
  return `<li class="group-head"><span class="group-badge">${g.letter}</span>
    <span class="grow"><b>${esc(t('group.title', {n: ex.sets}))}</b>${!live && similar ? `<small>${esc(t('group.similarHint'))}</small>` : ''}</span>
    ${live ? '' : `<button class="chip small" data-act="openLibraryForGroup" data-arg="${ex.id}">${icon('plus', 14)} ${esc(t('group.add'))}</button>`}</li>`;
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
      return `<li class="list-row"><div class="grow"><b>${esc(s.dayName || '')}</b><small>${esc(d.toLocaleDateString(currentLanguage, {weekday:'long', day:'numeric', month:'numeric'}))}${s.type === 'strength' ? ' · ' + esc(t('train.typeStrength')) + (s.volumeKg ? ' · ' + Math.round(s.volumeKg).toLocaleString(currentLanguage) + ' kg' : '') : ''}</small></div>
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
      <li class="list-row"><div class="grow"><b>${esc(t('profile.groupSwitch'))}</b><small>${esc(t('profile.groupSwitchHint'))}</small></div>${vStepper('globalGroupSwitch', state.plan.groupSwitchSeconds, ' s')}</li>
      <li class="list-row"><div class="grow"><b>${esc(t('profile.strengthRest'))}</b><small>${esc(t('profile.strengthRestHint'))}</small></div>${vStepper('globalStrengthRest', state.plan.strengthRestSeconds, ' s')}</li>
      <li class="list-row"><div class="grow"><b>${esc(t('main.soundLabel'))}</b><small>${esc(t('profile.soundHint'))}</small></div>
        <button class="switch ${state.plan.soundOn ? 'on' : ''}" role="switch" aria-checked="${!!state.plan.soundOn}" data-act="toggleSound" aria-label="${esc(t('main.soundLabel'))}"></button></li>
      <li><button class="list-row" data-act="openExport"><div class="grow"><b>${esc(t('export.title'))}</b><small>${esc(t('export.hint'))}</small></div>${icon('next', 18)}</button></li>
      <li><button class="list-row" data-act="openImport"><div class="grow"><b>${esc(t('import.title'))}</b><small>${esc(t('import.hint'))}</small></div>${icon('next', 18)}</button></li>
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
    const next = steps[state.stepIndex + 1];
    // Pause innerhalb einer Gruppe: Die naechste Uebung kommt schon in die Mitte.
    if(s.kind === 'switch' || s.kind === 'round') return { exIdx: next.exIdx, set: next.setNum, soon: true };
    const prev = steps[state.stepIndex - 1];
    return { exIdx: s.afterExIdx, set: prev ? prev.setNum : 1, setDone: true };
  }
  return { exIdx: 0, set: 1 };
}
function nextExerciseStep(fromIndex){
  for(let i = fromIndex + 1; i < steps.length; i++) if(steps[i].mode === 'exercise') return steps[i];
  return null;
}
/* Trainingsansicht: oben die Stoppuhr im Ring (Schrittzeit) mit Gesamtzeit darunter,
   unten das Karten-Rad - alle Uebungen als Karten, die aktuelle steht immer in der Mitte,
   nach oben und unten werden die Karten kleiner und verschwinden im Nebel. */
const RING_R = 90;
const RING_C = 2 * Math.PI * RING_R;
const wheel = {
  follow: true,      // false, solange der Nutzer selbst gescrollt hat
  userAt: 0,         // Zeitpunkt der letzten echten Nutzer-Eingabe am Rad
  lastSet: -99,      // zuletzt von uns gesetzte Scrollposition
  programmatic: false,
  anim: null, progT: null, idle: null, resize: null
};

function runMode(){
  const s = steps[state.stepIndex];
  return s.mode === 'exercise' ? 'work' : s.mode === 'pause' ? 'rest' : 'prepare';
}
function vRunShell(){
  return `
  <div class="run" id="run">
    <header class="head" data-slot="head"></header>
    <section class="ring-card" data-slot="top" aria-live="polite"></section>
    <button class="sound-hint" id="soundHint" data-act="enableSound" hidden>${icon('sound', 18)} ${esc(t('timer.soundBlocked'))}</button>
    <div class="wheel-wrap"><div class="wheel" id="runWheel"></div></div>
    <button class="follow-pill" id="followPill" data-act="wheelBack" hidden>${icon('up', 16)} ${esc(t('wheel.back'))}</button>
    <div class="controls" data-slot="ctl"></div>
  </div>
  <div id="sheetSlot"></div>`;
}
function vRunTop(){
  const s = steps[state.stepIndex];
  const nxt = nextExerciseStep(state.stepIndex);
  const after = steps[state.stepIndex + 1];
  let phase, title, sub;
  if(s.mode === 'exercise'){
    phase = t(s.inGroup ? 'wheel.roundOf' : 'timer.setOf', {set: s.setNum, total: s.totalSets});
    title = s.name;
    sub = `${t('muscle.' + s.muscle)} · ${after ? t('timer.thenPause', {s: after.seconds}) : t('timer.thenDone')}`;
  } else if(s.mode === 'pause'){
    phase = s.kind === 'exercise' ? t('timer.exerciseChange') : s.kind === 'switch' ? t('timer.groupSwitch') : s.kind === 'round' ? t('timer.roundPause') : t('timer.setPause');
    title = nxt ? t('timer.upNext', {name: nxt.name}) : '';
    sub = nxt ? `${t(nxt.inGroup ? 'wheel.roundOf' : 'timer.setOf', {set: nxt.setNum, total: nxt.totalSets})} · ${nxt.seconds} s` : '';
  } else {
    phase = t('timer.prepare');
    title = nxt ? t('timer.upNext', {name: nxt.name}) : '';
    sub = nxt ? t(nxt.inGroup ? 'wheel.roundOf' : 'timer.setOf', {set: 1, total: nxt.totalSets}) : '';
  }
  return `
    <div class="ring-box">
      <svg viewBox="0 0 200 200" aria-hidden="true">
        <circle cx="100" cy="100" r="${RING_R}" fill="none" stroke="var(--sunk)" stroke-width="12"/>
        <circle id="runRing" cx="100" cy="100" r="${RING_R}" fill="none" stroke="var(--ph)" stroke-width="12" stroke-linecap="round" stroke-dasharray="${RING_C}" stroke-dashoffset="${RING_C}"/>
      </svg>
      <div class="ring-center">
        <span class="phase"><i></i>${esc(phase)}${state.paused ? ' · ' + esc(t('timer.paused')) : ''}</span>
        <span class="ring-clock" id="runClock">${formatClock(Math.ceil(remainingPrecise()))}</span>
      </div>
    </div>
    <div class="ring-title">${esc(title)}<small>${esc(sub)}</small></div>
    <div class="overall" aria-label="${esc(t('timer.overallLabel'))}">
      <span class="num" id="runElapsed"></span><div class="overall-bar"><i id="runTotalBar"></i></div><span class="num" id="runLeft"></span>
    </div>`;
}
function vWheelCards(){
  const pos = runPos();
  const list = runDay.exercises;
  // Erledigte Saetze je Uebung aus dem Ablauf zaehlen - in Gruppen wechseln sich die Uebungen ab.
  const doneCounts = list.map(() => 0);
  steps.slice(0, state.stepIndex).forEach(x => { if(x.mode === 'exercise') doneCounts[x.exIdx]++; });
  const upcoming = nextExerciseStep(state.stepIndex);
  return list.map((ex, i) => {
    const sets = Math.max(1, ex.sets || 1);
    const g = groupInfo(runDay, i);
    const isCur = i === pos.exIdx && pos.restAfter == null && !pos.soon;
    const soon = i === pos.exIdx && (pos.restAfter != null || pos.soon);
    const st = isCur ? 'cur' : doneCounts[i] >= sets ? 'done' : '';
    const label = st === 'done' ? t('wheel.done')
      : st === 'cur' ? t(g.inGroup ? 'wheel.nowRound' : 'wheel.now', {set: pos.set, total: sets})
      : soon ? t('wheel.soon') : upcoming && upcoming.exIdx === i ? t('wheel.next') : t('wheel.later');
    const pills = Array.from({length: sets}, (_, k) => {
      const isLive = st === 'cur' && k + 1 === pos.set && !pos.setDone && steps[state.stepIndex].mode === 'exercise';
      return `<i class="${k < doneCounts[i] ? 'done' : ''}">${isLive ? '<b id="livePill"></b>' : ''}</i>`;
    }).join('');
    const pause = effectiveSetPause(ex, runDay);
    const pauseTxt = g.inGroup ? (g.last ? ' · ' + t('group.roundPause', {s: pause}) : '') : sets > 1 ? ' · ' + t('ex.setPauseShort', {s: pause}) : '';
    const dose = g.inGroup ? ex.seconds + ' s' : doseLabel(ex, runDay);
    const card = `<article class="wcard ${st} ${soon ? 'soon' : ''} ${g.inGroup ? 'grp' : ''}" data-ex="${i}">
      <div class="wtop"><span class="wlabel">${g.inGroup ? g.letter + g.pos + ' · ' : ''}${esc(label)}</span><span class="wnum">${i + 1}/${list.length}</span></div>
      <div class="wname">${st === 'done' ? icon('check', 16) : ''}${esc(ex.name || t('exercise.namePlaceholder'))}</div>
      <div class="wsub"><i style="background:${muscleColor(ex.muscle)}"></i>${esc(t('muscle.' + ex.muscle))} · ${esc(dose)}${esc(pauseTxt)}</div>
      <div class="pills">${pills}</div>
    </article>`;
    if(i === list.length - 1) return card;
    const gapCur = pos.restAfter === i;
    const sameGroup = g.inGroup && !g.last;
    const gapText = sameGroup ? (pause > 0 ? t('group.switch', {s: pause}) : t('group.direct'))
      : gapCur ? t('track.restNow', {s: effectivePauseAfter(ex, runDay)}) : t('track.rest', {s: effectivePauseAfter(ex, runDay)});
    return card + `<div class="wgap ${gapCur ? 'cur' : ''}" data-gap="${i}">${icon('clock', 13)} ${esc(gapText)}</div>`;
  }).join('');
}
function renderRun(app){
  let run = document.getElementById('run');
  const fresh = !run;
  if(fresh){
    app.innerHTML = vRunShell();
    run = document.getElementById('run');
    mountWheel();
  }
  run.className = 'run ' + runMode();
  run.querySelector('[data-slot=head]').innerHTML = `
    <button class="icon-btn" data-act="askStop" aria-label="${esc(t('timer.cancelBtn'))}">${icon('close')}</button>
    <h1 class="display center small">${esc(state.currentDayName)}</h1>
    <span class="step-count">${state.stepIndex + 1}/${steps.length}</span>`;
  run.querySelector('[data-slot=top]').innerHTML = vRunTop();
  run.querySelector('[data-slot=ctl]').innerHTML = `
    <button data-act="prevStep" aria-label="${esc(t('timer.prevBtn'))}">${icon('prev')}</button>
    <button class="main" data-act="togglePause" aria-label="${esc(state.paused ? t('timer.resumeBtn') : t('timer.pauseBtn'))}">${icon(state.paused ? 'play' : 'pause', 28)}</button>
    <button data-act="skipStep" aria-label="${esc(t('timer.skipBtn'))}">${icon('skip')}</button>`;
  const w = document.getElementById('runWheel');
  const keep = w.scrollTop;
  w.innerHTML = vWheelCards();
  w.scrollTop = keep;
  if(fresh || wheel.follow){ wheel.lastSet = w.scrollTop; centerWheel(!fresh); }
  wheelDepth();
  updateFollowPill();
  document.getElementById('sheetSlot').innerHTML = vSheet();
  updateTimerDOM();
}

/* ---------- Karten-Rad ---------- */
function mountWheel(){
  const w = document.getElementById('runWheel');
  wheel.follow = true; wheel.userAt = 0; wheel.lastSet = -99;
  clearTimeout(wheel.idle);
  // Nur echtes Scrollen durch den Nutzer (Finger, Mausrad, Tastatur) zaehlt - nicht das Verschieben,
  // wenn sich die Hoehe der oberen Karte aendert.
  const mark = () => { wheel.userAt = performance.now(); };
  ['wheel', 'touchstart', 'touchmove', 'pointerdown', 'keydown'].forEach(ev => w.addEventListener(ev, mark, { passive: true }));
  w.addEventListener('scroll', () => {
    wheelDepth();
    if(wheel.programmatic || performance.now() - wheel.userAt > 1200 || Math.abs(w.scrollTop - wheel.lastSet) < 2) return;
    wheel.follow = false;
    updateFollowPill();
    clearTimeout(wheel.idle);
    wheel.idle = setTimeout(() => { wheel.follow = true; centerWheel(true); updateFollowPill(); }, 5000);
  }, { passive: true });
  if(wheel.resize) wheel.resize.disconnect();
  // Groessenaenderung (Drehen, Hoehe der oberen Karte): wieder mittig setzen.
  if(window.ResizeObserver){
    wheel.resize = new ResizeObserver(() => { if(wheel.follow) centerWheel(false); else wheelDepth(); });
    wheel.resize.observe(w);
  }
}
function wheelTarget(){
  const w = document.getElementById('runWheel');
  if(!w) return null; // Training schon beendet (z.B. spaeter Resize-Aufruf)
  if(sr){
    const cur = srCurrent();
    return w && (cur ? w.querySelector(`[data-ex="${cur.exIdx}"]`) : w.querySelector('.wcard:last-of-type'));
  }
  const pos = runPos();
  return w && w.querySelector(pos.restAfter != null ? `[data-gap="${pos.restAfter}"]` : `[data-ex="${pos.exIdx}"]`);
}
function centerWheel(smooth){
  const w = document.getElementById('runWheel'), target = wheelTarget();
  if(!w || !target) return;
  // Abstand ueber getBoundingClientRect - beide Werte haben so denselben Bezugspunkt.
  const wr = w.getBoundingClientRect(), tr = target.getBoundingClientRect();
  const to = Math.max(0, Math.min(w.scrollTop + (tr.top - wr.top) - (w.clientHeight - tr.height) / 2, w.scrollHeight - w.clientHeight));
  wheel.programmatic = true;
  clearTimeout(wheel.anim);
  const done = () => { clearTimeout(wheel.progT); wheel.progT = setTimeout(() => { wheel.programmatic = false; }, 60); };
  if(!smooth || matchMedia('(prefers-reduced-motion: reduce)').matches){
    w.scrollTop = to; wheel.lastSet = w.scrollTop; wheelDepth(); done();
    return;
  }
  // Eigene Animation per setTimeout: scrollTo({behavior:'smooth'}) wird von manchen Browsern abgebrochen,
  // und requestAnimationFrame steht, wenn der Browser Frames drosselt.
  const from = w.scrollTop, startAt = performance.now();
  const stepFn = () => {
    const k = Math.min(1, (performance.now() - startAt) / 450), e = 1 - Math.pow(1 - k, 3);
    w.scrollTop = from + (to - from) * e;
    wheel.lastSet = w.scrollTop;
    wheelDepth();
    if(k < 1) wheel.anim = setTimeout(stepFn, 16); else done();
  };
  wheel.anim = setTimeout(stepFn, 0);
}
// Tiefe: je weiter eine Karte von der Mitte weg ist, desto kleiner und blasser.
function wheelDepth(){
  const w = document.getElementById('runWheel');
  if(!w) return;
  const wr = w.getBoundingClientRect(), mid = wr.top + wr.height / 2, half = Math.max(1, wr.height / 2);
  w.querySelectorAll('.wcard, .wgap').forEach(c => {
    const r = c.getBoundingClientRect();
    const d = Math.min(1, Math.abs(r.top + r.height / 2 - mid) / half);
    c.style.transform = `scale(${1 - d * 0.12})`;
    c.style.opacity = String(1 - d * 0.6);
  });
}
function updateFollowPill(){
  const pill = document.getElementById('followPill');
  if(pill) pill.hidden = wheel.follow;
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
  const stepFrac = s.seconds > 0 ? Math.min(1, 1 - rem / s.seconds) : 1;
  clk.textContent = formatClock(Math.ceil(rem));
  document.getElementById('runRing').style.strokeDashoffset = String(RING_C * (1 - stepFrac));
  const elapsed = stepStartOffsets[state.stepIndex] + (s.seconds - rem);
  document.getElementById('runTotalBar').style.width = (elapsed / Math.max(1, stepsTotalSeconds) * 100) + '%';
  document.getElementById('runElapsed').textContent = formatClock(elapsed);
  document.getElementById('runLeft').textContent = formatClock(stepsTotalSeconds - elapsed);
  // Letzte 5 Sekunden: Zahl wird rot und pulsiert - auch aus der Entfernung erkennbar.
  document.getElementById('run').classList.toggle('final', !state.paused && rem > 0 && rem <= 5);
  const pill = document.getElementById('livePill');
  if(pill && s.mode === 'exercise') pill.style.width = (stepFrac * 100) + '%';
}

/* ---------- Nach dem Training ---------- */
function vFinished(){
  if(ui.finished.strength) return vFinishedStrength();
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
    const strength = dayType(d) === 'strength';
    const g = groupInfo(d, i);
    const setsCaption = g.inGroup ? t('group.rounds') : t('exercise.sets');
    const setPauseLabel = strength ? t('strength.restLabel') : !g.inGroup ? t('ex.setPauseLabel') : g.last ? t('group.roundPauseLabel') : t('group.switchLabel');
    const setPauseHint = ex.setPauseOverride != null ? t('ex.customHint') : t('ex.defaultHint', {s: defaultSetPause(ex, d)});
    const lastTime = strength ? lastTimeLabel(ex) : '';
    const suggestion = strength ? strengthSuggestion(ex) : null;
    if(strength) syncSetPlan(ex);
    const perSet = strength && !!ex.setPlan;
    return wrap(`
      <div class="cap">${esc(t('ex.position', {n: i + 1, total: d.exercises.length}))}${g.inGroup ? ' · ' + esc(t('group.member', {tag: g.letter + g.pos})) : ''}</div>
      <input class="name-input" type="text" id="exName" data-input="exName" placeholder="${esc(t('exercise.namePlaceholder'))}" value="${esc(ex.name)}">
      <div class="chips scroll-x">${MUSCLE_GROUP_IDS.map(m => `<button class="chip ${ex.muscle === m ? 'on' : ''}" data-act="exMuscle" data-arg="${m}"><i class="dot" style="background:${muscleColor(m)}"></i>${esc(t('muscle.' + m))}</button>`).join('')}</div>
      <div class="big-steppers ${strength && !perSet ? 'three' : ''} ${perSet ? 'one' : ''}">
        <div class="bs"><span class="cap">${esc(setsCaption)}</span><output>${ex.sets}</output>
          <div class="bs-btns"><button data-act="exSets" data-arg="-1" aria-label="${esc(t('common.less'))}">${icon('minus')}</button><button data-act="exSets" data-arg="1" aria-label="${esc(t('common.more'))}">${icon('plus')}</button></div></div>
        ${perSet ? '' : strength ? `
        <div class="bs"><span class="cap">${esc(strengthUnit(ex))}</span><output>${ex.reps}</output>
          <div class="bs-btns"><button data-act="exReps" data-arg="-1" aria-label="${esc(t('common.less'))}">${icon('minus')}</button><button data-act="exReps" data-arg="1" aria-label="${esc(t('common.more'))}">${icon('plus')}</button></div></div>
        <div class="bs"><span class="cap">${esc(t('strength.weight'))}</span><input class="bs-input" type="text" inputmode="decimal" id="exWeight" data-input="exWeight" value="${esc(String(ex.weight || 0).replace('.', currentLanguage === 'en' ? '.' : ','))}" aria-label="${esc(t('strength.weight'))}">
          <div class="bs-btns"><button data-act="exWeightStep" data-arg="-2.5" aria-label="${esc(t('common.less'))}">${icon('minus')}</button><button data-act="exWeightStep" data-arg="2.5" aria-label="${esc(t('common.more'))}">${icon('plus')}</button></div></div>`
        : `
        <div class="bs"><span class="cap">${esc(t('exercise.secondsPerSet'))}</span><output>${ex.seconds}</output>
          <div class="bs-btns"><button data-act="exSeconds" data-arg="-5" aria-label="${esc(t('common.less'))}">${icon('minus')}</button><button data-act="exSeconds" data-arg="5" aria-label="${esc(t('common.more'))}">${icon('plus')}</button></div></div>`}
      </div>
      ${g.inGroup ? `<div class="muted small">${esc(t('group.roundsHint'))}</div>` : ''}
      ${strength ? `<div class="seg-row">
        <div class="seg small"><button class="${perSet ? '' : 'on'}" data-act="exPerSet" data-arg="0">${esc(t('strength.modeSame'))}</button><button class="${perSet ? 'on' : ''}" data-act="exPerSet" data-arg="1">${esc(t('strength.modePerSet'))}</button></div>
        <div class="seg small"><button class="${ex.unit !== 'seconds' ? 'on' : ''}" data-act="exUnit" data-arg="reps">${esc(t('strength.unitReps'))}</button><button class="${ex.unit === 'seconds' ? 'on' : ''}" data-act="exUnit" data-arg="seconds">${esc(t('strength.unitSeconds'))}</button></div>
      </div>` : ''}
      ${perSet ? `<div class="per-set">${ex.setPlan.map((p, k) => `
        <div class="per-set-row"><span class="per-set-n">${k + 1}</span>
          <div class="stepper"><button data-act="exPlanReps" data-arg="${k}|-1" aria-label="${esc(t('common.less'))}">${icon('minus', 15)}</button><output>${p.r}</output><button data-act="exPlanReps" data-arg="${k}|1" aria-label="${esc(t('common.more'))}">${icon('plus', 15)}</button></div>
          <div class="stepper"><button data-act="exPlanWeight" data-arg="${k}|-2.5" aria-label="${esc(t('common.less'))}">${icon('minus', 15)}</button><output>${Number(p.w || 0).toLocaleString(currentLanguage)} kg</output><button data-act="exPlanWeight" data-arg="${k}|2.5" aria-label="${esc(t('common.more'))}">${icon('plus', 15)}</button></div>
        </div>`).join('')}</div>` : ''}
      ${lastTime ? `<div class="muted small">${esc(lastTime)}</div>` : ''}
      ${suggestion ? `<button class="chip small on raise-chip" data-act="exApplySuggestion" data-arg="${suggestion}">${esc(t('strength.raiseTo', {w: fmtKg(suggestion)}))}</button>` : ''}
      <div class="pauses">
        ${pauseRow(setPauseLabel, setPauseHint, effectiveSetPause(ex, d), ex.setPauseOverride != null, 'exSetPause', 'exSetPauseDefault')}
        ${!strength && g.last && i < d.exercises.length - 1 ? pauseRow(g.inGroup ? t('group.afterLabel') : t('ex.pauseAfterLabel'), ex.pauseAfterOverride != null ? t('ex.customHint') : t('ex.defaultHint', {s: state.plan.pauseSeconds}), effectivePauseAfter(ex, d), ex.pauseAfterOverride != null, 'exPauseAfter', 'exPauseAfterDefault') : ''}
      </div>
      ${ex.muscle !== 'warmup' && ex.muscle !== 'stretch' ? `<button class="btn btn-ghost" data-act="openLibraryForGroup" data-arg="${ex.id}">${icon('link', 18)} ${esc(g.inGroup ? t('group.add') : t('group.addPartner'))}</button>` : ''}
      <div class="tools">
        <button data-act="exMove" data-arg="-1" ${i === 0 ? 'disabled' : ''}>${icon('up', 18)} ${esc(t('ex.earlier'))}</button>
        <button data-act="exMove" data-arg="1" ${i === d.exercises.length - 1 ? 'disabled' : ''}>${icon('down', 18)} ${esc(t('ex.later'))}</button>
        <button class="danger" data-act="exRemove">${icon('trash', 18)} ${esc(t('ex.remove'))}</button>
      </div>
      <button class="btn btn-primary" data-act="closeSheet">${esc(t('common.done'))}</button>`);
  }

  if(ui.sheet === 'library' && d){
    const anchor = libraryAnchor(d);
    const partner = ui.libGroupWith ? d.exercises.find(e => e.id === ui.libGroupWith) : null;
    const suggestions = suggestMuscles(d, partner || anchor, !!partner);
    return wrap(`
      <h2 class="display sheet-title">${esc(partner ? t('library.titleGroup', {name: partner.name || t('exercise.namePlaceholder')}) : t('library.title'))}</h2>
      <label class="search">${icon('search', 18)}<input type="search" id="libSearch" data-input="libQuery" placeholder="${esc(t('library.searchOrCreate'))}" value="${esc(ui.libQuery)}"></label>
      ${!partner && anchor ? `<button class="chip small group-toggle" data-act="libToggleGroup" data-arg="${anchor.id}">${icon('link', 14)} ${esc(t('library.groupWith', {name: anchor.name || t('exercise.namePlaceholder')}))}</button>` : ''}
      ${partner ? `<button class="chip small on group-toggle" data-act="libToggleGroup" data-arg="">${icon('link', 14)} ${esc(t('library.groupingOn'))}</button>` : ''}
      ${suggestions.length ? `<div class="suggest"><div class="cap">${esc(t(partner ? 'suggest.titleGroup' : 'suggest.title'))}</div>
        <div class="suggest-row">${suggestions.map(x => `<button class="sug ${ui.libFilter === x.muscle ? 'on' : ''}" data-act="libFilter" data-arg="${ui.libFilter === x.muscle ? '' : x.muscle}"><b><i class="dot" style="background:${muscleColor(x.muscle)}"></i>${esc(t('muscle.' + x.muscle))}</b><small>${esc(x.reason)}</small></button>`).join('')}</div></div>` : ''}
      <div class="chips scroll-x">${['', ...MUSCLE_GROUP_IDS.filter(m => m !== 'other')].map(m => `<button class="chip small ${ui.libFilter === m ? 'on' : ''}" data-act="libFilter" data-arg="${m}">${esc(m ? t('muscle.' + m) : t('library.all'))}</button>`).join('')}</div>
      <div class="sheet-scroll" id="libList">${vLibraryList()}</div>`);
  }

  if(ui.sheet === 'day' && d){
    return wrap(`
      <h2 class="display sheet-title">${esc(t('daySheet.title'))}</h2>
      <label class="field"><span>${esc(t('daySheet.name'))}</span><input type="text" id="dayName" data-input="dayName" value="${esc(d.name)}"></label>
      <div class="field"><span>${esc(t('daySheet.type'))}</span>
        <div class="seg small unit-seg"><button class="${dayType(d) === 'interval' ? 'on' : ''}" data-act="setDayType" data-arg="interval">${esc(t('train.typeInterval'))}</button><button class="${dayType(d) === 'strength' ? 'on' : ''}" data-act="setDayType" data-arg="strength">${esc(t('train.typeStrength'))}</button></div>
        <small>${esc(t(dayType(d) === 'strength' ? 'daySheet.strengthHint' : 'daySheet.intervalHint'))}</small></div>
      ${d.exercises.length
        ? `<button class="btn btn-ghost" data-act="openExport" data-arg="${d.id}">${esc(t('export.dayButton'))}</button>`
        : `<button class="btn btn-ghost" data-act="openImport" data-arg="${d.id}">${esc(t('import.title'))}</button>`}
      ${ui.confirmDeleteDay
        ? `<div class="msg msg-error">${esc(t('day.deleteConfirm', {name: d.name}))}</div>
           <div class="row-btns"><button class="btn btn-ghost" data-act="cancelDeleteDay">${esc(t('common.cancel'))}</button><button class="btn btn-danger" data-act="deleteDay">${esc(t('daySheet.deleteConfirm'))}</button></div>`
        : `<button class="btn btn-ghost danger-text" data-act="askDeleteDay">${icon('trash', 18)} ${esc(t('daySheet.delete'))}</button>`}
      <button class="btn btn-primary" data-act="closeSheet">${esc(t('common.done'))}</button>`);
  }

  if(ui.sheet === 'stopStrength' && sr){
    const c = srCounts();
    return wrap(`
      <h2 class="display sheet-title">${esc(t('stop.title'))}</h2>
      <p class="muted">${esc(t('stop.text', {done: c.done, total: c.total}))}</p>
      <button class="btn btn-primary" data-act="closeSheet">${esc(t('stop.continue'))}</button>
      <button class="btn btn-ghost" data-act="stopStrength">${esc(t('stop.end'))}</button>
      <button class="btn btn-ghost danger-text" data-act="discardRunningStrength">${esc(t('strength.discardRunning'))}</button>`);
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

  if(ui.sheet === 'export'){
    const day = ui.exportDayId ? state.plan.days.find(x => x.id === ui.exportDayId) : null;
    return wrap(`
      <h2 class="display sheet-title">${esc(day ? t('export.titleDay', {name: day.name}) : t('export.title'))}</h2>
      <button class="btn btn-primary" data-act="exportClaude">${icon('spark', 20)} ${esc(t('export.claude'))}</button>
      ${ui.exportInfo ? `<div class="msg msg-info" role="status">${esc(ui.exportInfo)}</div>` : ''}
      <div class="row-btns">
        <button class="btn btn-ghost" data-act="exportCopy">${esc(t('export.copy'))}</button>
        ${navigator.share ? `<button class="btn btn-ghost" data-act="exportShare">${esc(t('export.share'))}</button>` : ''}
        <button class="btn btn-ghost" data-act="exportFile">${esc(t('export.file'))}</button>
      </div>
      <div class="cap">${esc(t('export.jsonCaption'))}</div>
      <div class="row-btns">
        <button class="btn btn-ghost" data-act="exportJsonFile">${esc(t('export.jsonFile'))}</button>
        <button class="btn btn-ghost" data-act="exportJsonCopy">${esc(t('export.jsonCopy'))}</button>
      </div>
      <label class="field"><span>${esc(t('export.preview'))}</span><textarea class="export-text" id="exportText" readonly rows="8">${esc(planExportText())}</textarea></label>
      <button class="btn btn-ghost" data-act="closeSheet">${esc(t('common.done'))}</button>`);
  }

  if(ui.sheet === 'import'){
    return wrap(`
      <h2 class="display sheet-title">${esc(t('import.title'))}</h2>
      <label class="btn btn-ghost file-btn">${esc(t('import.file'))}<input type="file" id="importFile" accept=".json,application/json" data-change="importFile"></label>
      <label class="field"><span>${esc(t('import.paste'))}</span><textarea class="export-text" id="importText" rows="6" data-input="importText" spellcheck="false"></textarea></label>
      <div class="import-result" id="importResult">${vImportResult()}</div>
      <button class="btn btn-ghost" data-act="closeSheet">${esc(t('common.cancel'))}</button>`);
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
// Letzte normale Uebung des Tages: Bezugspunkt fuer die Vorschlaege.
function libraryAnchor(d){
  for(let i = d.exercises.length - 1; i >= 0; i--){
    const m = d.exercises[i].muscle;
    if(m !== 'warmup' && m !== 'stretch') return d.exercises[i];
  }
  return null;
}
/* Reihenfolge bewusst: selbst anlegen, dann eigene Uebungen, die Bibliothek nur aufgeklappt oder bei einer Suche. */
function vLibraryList(){
  const raw = ui.libQuery.trim();
  const q = raw.toLowerCase();
  const matches = (name, muscle) => (!ui.libFilter || muscle === ui.libFilter) && (!q || name.toLowerCase().includes(q));
  const mine = (state.plan.myExercises || []).filter(m => matches(m.name, m.muscle)).sort((a, b) => (b.usedAt || 0) - (a.usedAt || 0));
  const exact = (state.plan.myExercises || []).some(m => myKey(m.name) === q);
  const create = exact ? '' : `<button class="list-row create-row" data-act="addCustomExercise"><span class="lib-plus">${icon('plus', 18)}</span><div class="grow"><b>${esc(raw ? t('library.customNamed', {name: raw}) : t('library.custom'))}</b><small>${esc(t('library.customHint'))}</small></div></button>`;
  const mineHtml = mine.length
    ? mine.map(m => `<div class="my-row"><button class="list-row" data-act="addMyExercise" data-arg="${esc(m.id)}"><i class="dot" style="background:${muscleColor(m.muscle)}"></i>
        <div class="grow"><b>${esc(m.name)}</b><small>${esc(t('muscle.' + m.muscle))}${m.last ? ' · ' + esc(relDay(new Date(m.last.date))) : ''}</small></div>${icon('plus', 18)}</button>
        <button class="my-remove" data-act="removeMyExercise" data-arg="${esc(m.id)}" aria-label="${esc(t('library.removeMine', {name: m.name}))}">${icon('close', 15)}</button></div>`).join('')
    : `<div class="muted pad side">${esc(q || ui.libFilter ? t('library.noMineMatch') : t('library.noMine'))}</div>`;
  const taken = new Set((state.plan.myExercises || []).map(m => myKey(m.name)));
  const lib = (exerciseLibrary || []).filter(e => !taken.has(myKey(e.name)) && matches(e.name, e.muscle));
  const showLib = ui.libMore || !!q;
  const libHtml = !exerciseLibrary ? '' : `
    <button class="lib-more" data-act="libToggleMore" aria-expanded="${showLib}">${icon(showLib ? 'up' : 'down', 16)} ${esc(t('library.more', {n: lib.length}))}</button>
    ${showLib ? lib.map(e => `<button class="list-row" data-act="addLibraryExercise" data-arg="${esc(e.id)}"><i class="dot" style="background:${muscleColor(e.muscle)}"></i>
      <div class="grow"><b>${esc(e.name)}</b><small>${esc(t('muscle.' + e.muscle))} · ${esc(e.equipment.map(x => t('equipment.' + x)).join(', '))}</small></div>${icon('plus', 18)}</button>`).join('') : ''}`;
  return `${create}<div class="cap side">${esc(t('library.mine'))}</div>${mineHtml}${libHtml}`;
}

/* ---------- Plan exportieren ---------- */
// Bewusst ohne E-Mail oder andere Kontodaten: nur Plan, Ziele und eine kurze Zusammenfassung des Trainings.
const CLAUDE_NEW_CHAT_URL = 'https://claude.ai/new?q=';
const CLAUDE_URL_LIMIT = 4000; // Eine feste Grenze ist nicht dokumentiert; laengere Plaene gehen ueber die Zwischenablage.
function exportDays(){
  const day = ui.exportDayId ? state.plan.days.find(d => d.id === ui.exportDayId) : null;
  return day ? [day] : state.plan.days;
}
function exportAmount(ex, r, w){
  if(ex.unit === 'seconds') return w > 0 ? t('export.secondsWeight', {s: r, w: fmtKg(w)}) : t('export.seconds', {s: r});
  return w > 0 ? t('export.repsWeight', {r, w: fmtKg(w)}) : t('export.reps', {r});
}
// Eine Zeile pro Uebung in ganzen Worten, damit der Text ohne Erklaerung verstaendlich ist.
function exportExerciseLine(day, ex, i){
  const g = groupInfo(day, i);
  const strength = dayType(day) === 'strength';
  const pause = effectiveSetPause(ex, day);
  const parts = [];
  if(strength){
    if(ex.setPlan && ex.setPlan.length) parts.push(ex.setPlan.map((p, k) => t('export.perSet', {n: k + 1, what: exportAmount(ex, p.r, p.w || 0)})).join('; '));
    else parts.push(g.inGroup ? exportAmount(ex, ex.reps, ex.weight || 0) : `${t(ex.sets === 1 ? 'export.set1' : 'export.setsN', {n: ex.sets})}: ${exportAmount(ex, ex.reps, ex.weight || 0)}`);
    parts.push(pause > 0 ? t('export.restReco', {time: formatClock(pause)}) : t('export.directThen'));
  } else if(g.inGroup){
    parts.push(t('export.seconds', {s: ex.seconds}));
    parts.push(g.last ? t('export.roundThen', {s: pause}) : pause > 0 ? t('export.switchThen', {s: pause}) : t('export.directThen'));
  } else {
    parts.push(`${t(ex.sets === 1 ? 'export.set1' : 'export.setsN', {n: ex.sets})}: ${t('export.seconds', {s: ex.seconds})}`);
    if(ex.sets > 1) parts.push(t('export.restBetween', {s: pause}));
  }
  if(!strength && g.last && i < day.exercises.length - 1) parts.push(t(g.inGroup ? 'export.groupThen' : 'export.then', {s: effectivePauseAfter(ex, day)}));
  const tag = g.inGroup ? g.letter + g.pos : String(i + 1);
  return `${g.inGroup ? '  ' : ''}${tag}. ${ex.name || t('exercise.namePlaceholder')} (${t('muscle.' + ex.muscle)}): ${parts.join(', ')}`;
}
function planExportText(){
  const lines = [t('export.fileTitle')];
  const goals = [];
  if(onboarding.focus.length) goals.push(`${t('onboarding.focus')}: ${onboarding.focus.map(x => t('focus.' + x)).join(', ')}`);
  if(onboarding.equipment.length) goals.push(`${t('onboarding.equipment')}: ${onboarding.equipment.map(x => t('equipment.' + x)).join(', ')}`);
  if(onboarding.daysPerWeek) goals.push(`${t('onboarding.daysPerWeek')}: ${onboarding.daysPerWeek}`);
  if(onboarding.sessionMinutes) goals.push(`${t('onboarding.sessionMinutes')}: ${onboarding.sessionMinutes}`);
  if(onboarding.constraints) goals.push(`${t('onboarding.constraints')}: ${onboarding.constraints}`);
  if(goals.length) lines.push('', `${t('onboarding.title')}:`, ...goals.map(x => '- ' + x));
  exportDays().forEach(day => {
    const type = t(dayType(day) === 'strength' ? 'train.typeStrength' : 'train.typeInterval');
    lines.push('', t('export.dayHeading', {name: day.name || t('main.newDayName'), type, time: minutesLabel(dayTotalSeconds(day))}));
    day.exercises.forEach((ex, i) => {
      const g = groupInfo(day, i);
      if(g.inGroup && g.first) lines.push(t('export.groupHeading', {letter: g.letter, n: ex.sets}));
      lines.push(exportExerciseLine(day, ex, i));
    });
  });
  const since30 = new Date(Date.now() - 30 * 864e5);
  const recent = completedSessions().filter(x => sessionDate(x) >= since30);
  if(recent.length){
    const hours = recent.reduce((a, x) => a + (x.elapsedSeconds || 0), 0) / 3600;
    const week = muscleHistory().sets;
    const perMuscle = Object.keys(week).filter(m => m !== 'warmup' && m !== 'stretch').map(m => `${t('muscle.' + m)} ${week[m]}`).join(', ');
    lines.push('', `${t('stats.title')}:`, `- ${t('stats.sessions30')}: ${recent.length} (${hours.toFixed(1).replace('.', currentLanguage === 'en' ? '.' : ',')} h)`);
    if(perMuscle) lines.push(`- ${t('export.weekSets')}: ${perMuscle}`);
  }
  return lines.join('\n');
}
function claudeMessage(){ return `${t(ui.exportDayId ? 'export.promptDay' : 'export.prompt')}\n\n${planExportText()}`; }
function exportBaseName(){
  const day = ui.exportDayId ? state.plan.days.find(d => d.id === ui.exportDayId) : null;
  const name = day && day.name ? '-' + day.name.toLowerCase().replace(/[^a-z0-9äöüß]+/g, '-').replace(/^-|-$/g, '') : '';
  return `${t('export.fileName')}${name}-${new Date().toISOString().slice(0, 10)}`;
}
function downloadFile(name, content, type){
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ---------- JSON-Format (Beschreibung: PLAN_FORMAT.md) ---------- */
const PLAN_FORMAT_ID = 'intervalinator-plan';
const PLAN_FORMAT_VERSION = 1;
function exportPlanJson(){
  const plan = state.plan;
  const days = exportDays().map(day => {
    const strength = dayType(day) === 'strength';
    let letterIdx = 0;
    const groupLetters = {};
    return { name: day.name || '', type: dayType(day), exercises: day.exercises.map(ex => {
      const out = { name: ex.name || '', muscle: ex.muscle };
      if(ex.groupId){
        if(!groupLetters[ex.groupId]) groupLetters[ex.groupId] = String.fromCharCode(65 + letterIdx++);
        out.group = groupLetters[ex.groupId];
      }
      out.sets = ex.sets;
      if(strength){
        out.unit = ex.unit === 'seconds' ? 'seconds' : 'reps';
        if(ex.setPlan && ex.setPlan.length) out.setPlan = ex.setPlan.map(p => ({ amount: p.r, weightKg: p.w || 0 }));
        else { out.amount = ex.reps; out.weightKg = ex.weight || 0; }
      } else out.seconds = ex.seconds;
      if(ex.setPauseOverride != null) out.setPauseSeconds = ex.setPauseOverride;
      if(!strength && ex.pauseAfterOverride != null) out.pauseAfterSeconds = ex.pauseAfterOverride;
      return out;
    }) };
  });
  return JSON.stringify({
    format: PLAN_FORMAT_ID, version: PLAN_FORMAT_VERSION, exportedAt: new Date().toISOString(),
    defaults: { setPauseSeconds: plan.setPauseSeconds, exercisePauseSeconds: plan.pauseSeconds, groupSwitchSeconds: plan.groupSwitchSeconds, strengthRestSeconds: plan.strengthRestSeconds },
    days
  }, null, 2);
}
function importNumber(v, min, max, fallback){
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
// Prueft eine Plandatei und baut daraus saubere Tage. Fremde Dateien werden nie ungeprueft uebernommen.
function parsePlanJson(text){
  let data;
  try{ data = JSON.parse(text); }catch(e){ return { error: t('import.errJson') }; }
  if(!data || data.format !== PLAN_FORMAT_ID) return { error: t('import.errFormat') };
  if(!(data.version >= 1) || data.version > PLAN_FORMAT_VERSION) return { error: t('import.errVersion') };
  const rawDays = Array.isArray(data.days) ? data.days.slice(0, 50) : [];
  const days = rawDays.filter(d => d && Array.isArray(d.exercises)).map(d => {
    const type = d.type === 'strength' ? 'strength' : 'interval';
    const ids = {};
    const day = { id: uid(), name: String(d.name || t('main.newDayName')).slice(0, 80), type, exercises: d.exercises.slice(0, 100).filter(Boolean).map(e => {
      const muscle = MUSCLE_GROUP_IDS.includes(e.muscle) ? e.muscle : 'other';
      const ex = makeExercise(String(e.name || '').slice(0, 120), muscle, importNumber(e.sets, 1, 20, 3), importNumber(e.seconds, 1, 3600, 30));
      ex.id = uid();
      if(e.group != null && String(e.group)){ const key = String(e.group); ids[key] = ids[key] || uid(); ex.groupId = ids[key]; }
      if(e.setPauseSeconds != null) ex.setPauseOverride = importNumber(e.setPauseSeconds, 0, 600, null);
      if(e.pauseAfterSeconds != null) ex.pauseAfterOverride = importNumber(e.pauseAfterSeconds, 0, 600, null);
      if(type === 'strength'){
        ex.unit = e.unit === 'seconds' ? 'seconds' : 'reps';
        ex.reps = importNumber(e.amount, 1, 600, 10);
        ex.weight = importNumber(e.weightKg, 0, 2000, 0);
        if(Array.isArray(e.setPlan) && e.setPlan.length){
          ex.setPlan = e.setPlan.slice(0, 20).map(p => ({ r: importNumber(p && p.amount, 1, 600, 10), w: importNumber(p && p.weightKg, 0, 2000, 0) }));
          ex.reps = ex.setPlan[0].r; ex.weight = ex.setPlan[0].w; ex.sets = ex.setPlan.length;
        }
      }
      return ex;
    }) };
    normalizeGroups(day);
    day.exercises.forEach(syncSetPlan);
    return day;
  });
  if(!days.length) return { error: t('import.errEmpty') };
  const dflt = data.defaults || {};
  return { days, defaults: {
    setPauseSeconds: importNumber(dflt.setPauseSeconds, 0, 600, state.plan.setPauseSeconds),
    pauseSeconds: importNumber(dflt.exercisePauseSeconds, 0, 600, state.plan.pauseSeconds),
    groupSwitchSeconds: importNumber(dflt.groupSwitchSeconds, 0, 600, state.plan.groupSwitchSeconds),
    strengthRestSeconds: importNumber(dflt.strengthRestSeconds, 0, 600, state.plan.strengthRestSeconds)
  } };
}
// Beim Hinzufuegen gelten die Standardpausen des eigenen Plans: Weichen die der Datei ab, als eigene Werte festhalten.
function keepImportedPauses(day, defaults){
  const strength = day.type === 'strength';
  day.exercises.forEach((ex, i) => {
    const g = groupInfo(day, i);
    const fromFile = g.inGroup && !g.last ? (strength ? 0 : defaults.groupSwitchSeconds) : (strength ? defaults.strengthRestSeconds : defaults.setPauseSeconds);
    if(ex.setPauseOverride == null && fromFile !== defaultSetPause(ex, day)) ex.setPauseOverride = fromFile;
    if(!strength && ex.pauseAfterOverride == null && defaults.pauseSeconds !== state.plan.pauseSeconds) ex.pauseAfterOverride = defaults.pauseSeconds;
  });
}
function vImportResult(){
  const res = ui.importResult;
  if(!res) return '';
  if(res.error) return `<div class="msg msg-error" role="alert">${esc(res.error)}</div>`;
  const exCount = res.days.reduce((a, d) => a + d.exercises.length, 0);
  return `<div class="msg msg-info" role="status">${esc(t('import.found', {days: res.days.length, ex: exCount}))}<br>${esc(res.days.map(d => d.name).join(', '))}</div>
    <button class="btn btn-primary" data-act="importAdd">${esc(t('import.add'))}</button>
    ${state.plan.days.length === 0 ? '' : ui.importConfirmReplace
      ? `<div class="msg msg-error">${esc(t('import.replaceWarn', {n: state.plan.days.length}))}</div>
         <div class="row-btns"><button class="btn btn-ghost" data-act="importCancelReplace">${esc(t('common.cancel'))}</button><button class="btn btn-danger" data-act="importReplace">${esc(t('import.replaceConfirm'))}</button></div>`
      : `<button class="btn btn-ghost" data-act="importAskReplace">${esc(t('import.replace'))}</button>`}`;
}
function refreshImportResult(){ const box = document.getElementById('importResult'); if(box) box.innerHTML = vImportResult(); }
function finishImport(days, message){
  days.forEach(d => d.exercises.forEach(ex => upsertMyExercise(state.plan, ex)));
  state.activeDayId = days[0].id;
  ui.sheet = null; ui.importResult = null; ui.importConfirmReplace = false; ui.tab = 'train';
  schedulePersist();
  render();
  showToast(message);
}
async function copyText(text){
  try{
    await navigator.clipboard.writeText(text);
    return true;
  }catch(e){
    const box = document.getElementById('exportText');
    if(!box) return false;
    const before = box.value;
    box.value = text;
    box.focus(); box.select();
    setTimeout(() => { box.value = before; }, 0);
    try{ return document.execCommand('copy'); }catch(e2){ return false; }
  }
}

/* ---------- Aktionen ---------- */
function currentExercise(){
  const d = activeDay();
  return d ? d.exercises.find(e => e.id === ui.editExId) : null;
}
function openSheet(name){ ui.sheet = name; rerender(); }
function closeSheet(){
  if(ui.sheet === 'editEx'){ const ex = currentExercise(); if(ex){ rememberExercise(ex); schedulePersist(); } }
  ui.sheet = null; ui.confirmDeleteDay = false; rerender();
}
// Neue Uebung vorbelegen: mit den eigenen letzten Werten, passend zur Trainingsart des Tages.
function prepareNewExercise(ex, day, my){
  if(my){ ex.sets = my.sets || ex.sets; ex.seconds = my.seconds || ex.seconds; }
  if(dayType(day) === 'strength') applyStrengthDefaults(ex, my);
  return ex;
}
function applyStrengthDefaults(ex, my){
  if(ex.reps == null) ex.reps = my && my.reps != null ? my.reps : (ex.muscle === 'warmup' || ex.muscle === 'stretch' ? ex.seconds : 10);
  if(ex.weight == null) ex.weight = my && my.weight != null ? my.weight : 0;
  if(ex.unit == null) ex.unit = my && my.unit ? my.unit : (ex.muscle === 'warmup' || ex.muscle === 'stretch' ? 'seconds' : 'reps');
  if(ex.setPlan == null && my && my.setPlan) ex.setPlan = my.setPlan.map(p => ({ r: p.r, w: p.w }));
}
function insertExercise(ex, my){
  const d = activeDay();
  ex.id = uid();
  prepareNewExercise(ex, d, my);
  const list = d.exercises;
  const partner = ui.libGroupWith ? list.find(e => e.id === ui.libGroupWith) : null;
  let at;
  if(partner){
    // Direkt hinter die Gruppe der Partner-Uebung setzen und die Rundenzahl uebernehmen.
    const g = groupInfo(d, list.indexOf(partner));
    at = g.block[g.block.length - 1] + 1;
    if(!partner.groupId) partner.groupId = uid();
    ex.groupId = partner.groupId;
    ex.sets = partner.sets;
  } else {
    // Neue Uebungen vor das abschliessende Dehnen setzen, falls es eines gibt.
    at = list.length && list[list.length - 1].muscle === 'stretch' ? list.length - 1 : list.length;
  }
  list.splice(at, 0, ex);
  normalizeGroups(d);
  ui.libGroupWith = null;
  rememberExercise(ex);
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
    const day = { id: uid(), name: t('main.newDayName'), type: 'interval', exercises: [] };
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

  setDayType(type){
    const d = activeDay();
    d.type = type;
    if(type === 'strength') d.exercises.forEach(ex => applyStrengthDefaults(ex, findMyExercise(ex.name)));
    schedulePersist(); rerender();
  },

  // Gruppen
  toggleLink(arg){
    const d = activeDay(), list = d.exercises, i = Number(arg), a = list[i], b = list[i + 1];
    if(!a || !b) return;
    if(a.groupId && a.groupId === b.groupId){
      // Trennen: alles ab b bildet eine eigene Gruppe.
      const g = a.groupId, fresh = uid();
      for(let k = i + 1; k < list.length && list[k].groupId === g; k++) list[k].groupId = fresh;
    } else {
      const bGroup = b.groupId;
      const rounds = a.groupId || !bGroup ? a.sets : b.sets;
      const g = a.groupId || bGroup || uid();
      a.groupId = g;
      list.forEach(e => { if(e === b || (bGroup && e.groupId === bGroup)) e.groupId = g; });
      const changed = list.some(e => e.groupId === g && e.sets !== rounds);
      list.forEach(e => { if(e.groupId === g) e.sets = rounds; });
      if(changed) showToast(t('group.synced', {n: rounds}));
    }
    normalizeGroups(d);
    schedulePersist(); rerender();
  },
  openLibraryForGroup(exId){
    ACTIONS.openLibrary();
    ui.libGroupWith = exId;
    rerender();
  },
  libToggleGroup(exId){ ui.libGroupWith = exId || null; rerender(); },
  libToggleMore(){ ui.libMore = !ui.libMore; refreshLibraryList(); },

  // Uebungen
  editEx(id){ ui.editExId = id; openSheet('editEx'); },
  exMuscle(m){ currentExercise().muscle = m; schedulePersist(); rerender(); },
  exSets(v){
    const d = activeDay(), ex = currentExercise();
    ex.sets = Math.max(1, Math.min(20, ex.sets + Number(v)));
    // In einer Gruppe gilt die Rundenzahl fuer alle Uebungen.
    if(ex.groupId) d.exercises.forEach(e => { if(e.groupId === ex.groupId) e.sets = ex.sets; });
    schedulePersist(); rerender();
  },
  exReps(v){ const ex = currentExercise(); ex.reps = Math.max(1, Math.min(600, (ex.reps || 0) + Number(v) * (ex.unit === 'seconds' ? 5 : 1))); schedulePersist(); rerender(); },
  exWeightStep(v){ const ex = currentExercise(); ex.weight = Math.max(0, (ex.weight || 0) + Number(v)); schedulePersist(); rerender(); },
  exUnit(u){ currentExercise().unit = u; schedulePersist(); rerender(); },
  exPerSet(on){
    const ex = currentExercise();
    if(on === '1' && !ex.setPlan) ex.setPlan = Array.from({length: ex.sets}, () => ({ r: ex.reps, w: ex.weight || 0 }));
    if(on === '0' && ex.setPlan){ ex.reps = ex.setPlan[0].r; ex.weight = ex.setPlan[0].w || 0; delete ex.setPlan; }
    schedulePersist(); rerender();
  },
  exPlanReps(arg){
    const [k, v] = arg.split('|'), ex = currentExercise(), p = ex.setPlan[Number(k)];
    p.r = Math.max(1, Math.min(600, p.r + Number(v) * (ex.unit === 'seconds' ? 5 : 1)));
    schedulePersist(); rerender();
  },
  exPlanWeight(arg){
    const [k, v] = arg.split('|'), p = currentExercise().setPlan[Number(k)];
    p.w = Math.max(0, (p.w || 0) + Number(v));
    schedulePersist(); rerender();
  },
  exApplySuggestion(w){ currentExercise().weight = Number(w); schedulePersist(); rerender(); },
  exSeconds(v){ const ex = currentExercise(); ex.seconds = Math.max(5, Math.min(3600, ex.seconds + Number(v))); schedulePersist(); rerender(); },
  exSetPause(v){ const ex = currentExercise(); ex.setPauseOverride = clampSeconds(effectiveSetPause(ex, activeDay()) + Number(v)); schedulePersist(); rerender(); },
  exSetPauseDefault(){ currentExercise().setPauseOverride = null; schedulePersist(); rerender(); },
  exPauseAfter(v){ const ex = currentExercise(); ex.pauseAfterOverride = clampSeconds(effectivePauseAfter(ex, activeDay()) + Number(v)); schedulePersist(); rerender(); },
  exPauseAfterDefault(){ currentExercise().pauseAfterOverride = null; schedulePersist(); rerender(); },
  exMove(dir){
    const d = activeDay(), list = d.exercises, i = list.findIndex(e => e.id === ui.editExId), step = Number(dir), j = i + step;
    if(j < 0 || j >= list.length) return;
    const ex = list[i], other = list[j];
    if(ex.groupId && other.groupId !== ex.groupId){
      // Am Rand der Gruppe: Die Uebung verlaesst die Gruppe und bleibt direkt daneben stehen.
      ex.groupId = null;
    } else if(!ex.groupId && other.groupId){
      // Einzelne Uebung springt ueber die ganze Gruppe.
      const block = groupInfo(d, j).block;
      list.splice(i, 1);
      list.splice(step > 0 ? block[block.length - 1] : block[0], 0, ex);
    } else {
      [list[i], list[j]] = [list[j], list[i]];
    }
    normalizeGroups(d);
    schedulePersist(); rerender();
  },
  exRemove(){
    const d = activeDay(), list = d.exercises;
    list.splice(list.findIndex(e => e.id === ui.editExId), 1);
    normalizeGroups(d);
    ui.sheet = null;
    schedulePersist(); closeSheet();
  },
  openLibrary(){
    ui.libQuery = ''; ui.libFilter = ''; ui.libGroupWith = null; ui.libMore = false;
    if(!exerciseLibrary) loadExerciseLibrary().then(() => { if(ui.sheet === 'library') refreshLibraryList(); }).catch(() => {});
    openSheet('library');
  },
  libFilter(m){ ui.libFilter = m; rerender(); const s = document.getElementById('libSearch'); if(s && ui.libQuery) s.focus(); },
  addLibraryExercise(id){
    const entry = (exerciseLibrary || []).find(e => e.id === id);
    if(entry) insertExercise(makeExercise(entry.name, entry.muscle, 3, 30));
  },
  addMyExercise(id){
    const my = (state.plan.myExercises || []).find(m => m.id === id);
    if(my) insertExercise(makeExercise(my.name, my.muscle, my.sets || 3, my.seconds || 30), my);
  },
  removeMyExercise(id){
    state.plan.myExercises = (state.plan.myExercises || []).filter(m => m.id !== id);
    schedulePersist();
    refreshLibraryList();
  },
  addCustomExercise(){
    insertExercise(makeExercise(ui.libQuery.trim(), ui.libFilter || 'other', 3, 30));
    const input = document.getElementById('exName');
    if(input && !input.value) input.focus();
  },

  // Training
  enableSound(){ setTimeout(() => { beep(880, 140, 0.5); updateSoundHint(); }, 150); },
  start(){
    const d = activeDay();
    if(!d || !d.exercises.length) return;
    if(dayType(d) === 'strength'){
      d.exercises.forEach(ex => applyStrengthDefaults(ex, findMyExercise(ex.name)));
      srClearSaved();
      startStrength(d);
    } else startTimer(d);
  },
  wheelBack(){ wheel.follow = true; clearTimeout(wheel.idle); centerWheel(true); updateFollowPill(); },
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
  globalGroupSwitch(v){ state.plan.groupSwitchSeconds = clampSeconds(state.plan.groupSwitchSeconds + Number(v)); schedulePersist(); rerender(); },
  globalStrengthRest(v){ state.plan.strengthRestSeconds = clampSeconds(state.plan.strengthRestSeconds + Number(v)); schedulePersist(); rerender(); },
  toggleSound(){ state.plan.soundOn = !state.plan.soundOn; schedulePersist(); rerender(); },
  setTheme(theme){ applyTheme(theme); settings.theme = theme === 'system' ? null : theme; scheduleSettingsPersist(); rerender(); },
  togglePw(){ ui.pwOpen = !ui.pwOpen; rerender(); },
  changePassword(){ handleChangePassword(drafts.curPw, drafts.newPw).then(() => { if(profileInfo){ drafts.curPw = ''; drafts.newPw = ''; ui.pwOpen = false; rerender(); } }); },
  openExport(dayId){ ui.exportDayId = dayId || null; ui.exportInfo = ''; openSheet('export'); },
  exportClaude(){
    const message = claudeMessage();
    // Passt der Plan in den Link, steht er direkt im Chat. Sonst bleibt er in der Zwischenablage zum Einfuegen.
    const full = CLAUDE_NEW_CHAT_URL + encodeURIComponent(message);
    const fits = full.length <= CLAUDE_URL_LIMIT;
    copyText(message);
    window.open(fits ? full : CLAUDE_NEW_CHAT_URL + encodeURIComponent(t('export.pasteIntro')), '_blank', 'noopener');
    ui.exportInfo = t(fits ? 'export.infoLink' : 'export.infoPaste');
    rerender();
  },
  exportCopy(){
    copyText(claudeMessage()).then(ok => { ui.exportInfo = t(ok ? 'export.copied' : 'export.copyFailed'); rerender(); });
  },
  exportShare(){
    navigator.share({ title: t('export.fileTitle'), text: claudeMessage() }).catch(() => {});
  },
  exportFile(){ downloadFile(exportBaseName() + '.txt', planExportText(), 'text/plain;charset=utf-8'); },
  exportJsonFile(){ downloadFile(exportBaseName() + '.json', exportPlanJson(), 'application/json'); },
  exportJsonCopy(){
    copyText(exportPlanJson()).then(ok => { ui.exportInfo = t(ok ? 'export.copied' : 'export.copyFailed'); rerender(); });
  },
  openImport(emptyDayId){ ui.importEmptyDayId = emptyDayId || null; ui.importResult = null; ui.importConfirmReplace = false; openSheet('import'); },
  importAskReplace(){ ui.importConfirmReplace = true; refreshImportResult(); },
  importCancelReplace(){ ui.importConfirmReplace = false; refreshImportResult(); },
  importAdd(){
    const res = ui.importResult;
    if(!res || !res.days) return;
    // Aus einem neuen, leeren Tag heraus importiert: Der Import ersetzt diesen Tag, statt ihn leer stehen zu lassen.
    state.plan.days = state.plan.days.filter(d => !(d.id === ui.importEmptyDayId && !d.exercises.length));
    const taken = new Set(state.plan.days.map(d => d.name));
    res.days.forEach(day => {
      // Gleiche Namen vermeiden: "Dran" und Statistik ordnen Trainings ueber den Tagesnamen zu.
      let name = day.name, n = 2;
      while(taken.has(name)) name = `${day.name} (${n++})`;
      day.name = name;
      taken.add(name);
      keepImportedPauses(day, res.defaults);
      state.plan.days.push(day);
    });
    finishImport(res.days, t('import.added', {n: res.days.length}));
  },
  importReplace(){
    const res = ui.importResult;
    if(!res || !res.days) return;
    Object.assign(state.plan, res.defaults);
    state.plan.days = res.days;
    finishImport(res.days, t('import.added', {n: res.days.length}));
  },
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
  exWeight(v){ const ex = currentExercise(); if(ex){ const n = parseFloat(String(v).replace(',', '.')); ex.weight = isNaN(n) || n < 0 ? 0 : n; schedulePersist(); } },
  importText(v){ ui.importConfirmReplace = false; ui.importResult = v.trim() ? parsePlanJson(v) : null; refreshImportResult(); },
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
  if(e.target.dataset && e.target.dataset.change === 'importFile' && e.target.files && e.target.files[0]){
    e.target.files[0].text().then(text => {
      const box = document.getElementById('importText');
      if(box) box.value = text;
      INPUTS.importText(text);
    }).catch(() => { ui.importResult = { error: t('import.errJson') }; refreshImportResult(); });
  }
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
  if(summary.type === 'strength'){ doc.type = 'strength'; doc.volumeKg = summary.volumeKg; }
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

/* ---------- Krafttraining ----------
   Nicht zeitgetrieben: Die Trainingszeit und die Pause seit dem letzten Satz laufen nur als Info mit.
   Man hakt jeden Satz ab und sieht dadurch, was als Naechstes kommt. Der Stand liegt zusaetzlich im
   localStorage, weil ein Krafttraining lange dauert und der Browser die Seite zwischendurch verwerfen kann. */
let sr = null; // laufendes Krafttraining: { dayId, startedAt, sets:{key:{r,w,done,skipped}}, lastCheckAt, restGoal, restBeeped, undo:[], focus }
let srTicker = null;
const SR_MAX_AGE_MS = 12 * 60 * 60 * 1000;

function srStorageKey(){ return authUser ? `intervalinator-strength-${authUser.uid}` : null; }
function srSave(){
  const key = srStorageKey();
  if(key && sr){ try{ localStorage.setItem(key, JSON.stringify(sr)); }catch(e){} }
}
function srClearSaved(){
  const key = srStorageKey();
  if(key){ try{ localStorage.removeItem(key); }catch(e){} }
}
// Ein unterbrochenes Training (Seite neu geladen, App beendet), das noch fortgesetzt werden kann.
function srSaved(){
  const key = srStorageKey();
  if(!key) return null;
  try{
    const saved = JSON.parse(localStorage.getItem(key));
    if(!saved || Date.now() - saved.startedAt > SR_MAX_AGE_MS) return null;
    const day = state.plan.days.find(d => d.id === saved.dayId);
    return day ? { saved, day } : null;
  }catch(e){ return null; }
}
const srKey = (ex, set) => `${ex.id}:${set}`;
function strengthQueue(day){
  const out = [];
  let letterIdx = 0;
  blocksOf(day).forEach(block => {
    const grouped = block.length > 1;
    const letter = grouped ? String.fromCharCode(65 + letterIdx++) : '';
    const rounds = Math.max(1, day.exercises[block[0]].sets || 1);
    for(let set = 1; set <= rounds; set++){
      block.forEach((exIdx, m) => out.push({ ex: day.exercises[exIdx], exIdx, set, rounds, grouped, tag: grouped ? letter + (m + 1) : '' }));
    }
  });
  return out;
}
function srEntry(item){ return sr.sets[srKey(item.ex, item.set)]; }
function srOpen(item){ const e = srEntry(item); return !e.done && !e.skipped; }
function srCurrent(){
  const q = strengthQueue(runDay);
  if(sr.focus){
    const f = q.find(x => x.ex.id === sr.focus && srOpen(x));
    if(f) return f;
    sr.focus = null;
  }
  return q.find(srOpen) || null;
}
function srNextAfter(cur){
  if(!cur) return null;
  return strengthQueue(runDay).find(x => srOpen(x) && !(x.ex.id === cur.ex.id && x.set === cur.set)) || null;
}
function srCounts(){
  const q = strengthQueue(runDay);
  return { done: q.filter(x => srEntry(x).done).length, closed: q.filter(x => !srOpen(x)).length, total: q.length };
}
// Zielwerte eines Satzes: entweder fuer alle Saetze gleich oder einzeln festgelegt (ex.setPlan).
function strengthTarget(ex, set){
  const plan = ex.setPlan;
  if(plan && plan.length){ const p = plan[set - 1] || plan[plan.length - 1]; return { r: p.r, w: p.w || 0 }; }
  return { r: ex.reps, w: ex.weight || 0 };
}
function syncSetPlan(ex){
  if(!ex.setPlan) return;
  while(ex.setPlan.length < ex.sets) ex.setPlan.push(Object.assign({}, ex.setPlan[ex.setPlan.length - 1]));
  ex.setPlan.length = ex.sets;
}
function strengthUnit(ex){ return ex.unit === 'seconds' ? t('strength.unitSeconds') : t('strength.unitReps'); }
function fmtKg(w){ return `${Number(w).toLocaleString(currentLanguage)} kg`; }
function setLabel(r, w, ex){
  const amount = ex.unit === 'seconds' ? `${r} s` : `${r}`;
  return w > 0 ? `${amount} × ${fmtKg(w)}` : amount + (ex.unit === 'seconds' ? '' : ` ${t('strength.unitReps')}`);
}
// Steigerung: Wurden zuletzt alle Saetze mit der Zielzahl geschafft, die Last leicht erhoehen (rund 2-10 %).
function strengthSuggestion(ex){
  if(ex.unit === 'seconds' || ex.setPlan) return null;
  const my = findMyExercise(ex.name);
  const last = my && my.last;
  if(!last || !last.sets || !last.sets.length) return null;
  const maxW = Math.max(...last.sets.map(s => s.w || 0));
  if(maxW <= 0 || last.sets.length < ex.sets || !last.sets.every(s => s.r >= ex.reps)) return null;
  const next = maxW + (maxW < 20 ? 1 : 2.5);
  return next > (ex.weight || 0) ? next : null;
}
function lastTimeLabel(ex){
  const my = findMyExercise(ex.name);
  const last = my && my.last;
  if(!last || !last.sets || !last.sets.length) return '';
  return t('strength.lastTime', {sets: last.sets.map(s => setLabel(s.r, s.w, ex)).join(' · '), when: relDay(new Date(last.date))});
}

function startStrength(day, saved){
  ensureAudio();
  tryResumeAudio();
  runDay = day;
  if(saved){
    sr = saved;
    // Falls der Plan inzwischen geaendert wurde: fehlende Saetze ergaenzen.
    strengthQueue(day).forEach(x => { const k = srKey(x.ex, x.set); if(!sr.sets[k]) sr.sets[k] = Object.assign(strengthTarget(x.ex, x.set), { done: false, skipped: false }); });
  } else {
    sr = { dayId: day.id, dayName: day.name, startedAt: Date.now(), sets: {}, lastCheckAt: null, restGoal: 0, restBeeped: true, undo: [], focus: null };
    strengthQueue(day).forEach(x => { sr.sets[srKey(x.ex, x.set)] = Object.assign(strengthTarget(x.ex, x.set), { done: false, skipped: false }); });
    srSave();
  }
  state.screen = 'strength';
  ui.sheet = null;
  requestWakeLock();
  clearInterval(srTicker);
  srTicker = setInterval(updateStrengthDOM, 500);
  render();
}
function vStrengthShell(){
  return `
  <div class="run strength-run" id="run">
    <header class="head" data-slot="head"></header>
    <section class="str-card" data-slot="top" aria-live="polite"></section>
    <div class="wheel-wrap"><div class="wheel" id="runWheel"></div></div>
    <button class="follow-pill" id="followPill" data-act="wheelBack" hidden>${icon('up', 16)} ${esc(t('wheel.back'))}</button>
    <div class="controls" data-slot="ctl"></div>
  </div>
  <div id="sheetSlot"></div>`;
}
function vStrengthTop(){
  const cur = srCurrent();
  const times = `
    <div class="str-times" id="srRestBox">
      <div class="str-since"><span class="lab">${esc(t('strength.sinceLast'))}</span><span class="str-clock" id="srRest"></span><span class="str-reco" id="srReco"></span></div>
      <div class="str-total"><span class="lab">${esc(t('strength.time'))}</span><span class="num" id="srElapsed"></span></div>
    </div>`;
  if(!cur) return times + `
    <div class="str-now"><div class="lab ok">${esc(t('strength.allDoneLabel'))}</div><div class="str-name">${esc(t('strength.allDone'))}</div></div>
    <button class="set-done" data-act="finishStrength">${icon('flag', 28)} ${esc(t('strength.finish'))}</button>`;
  const entry = srEntry(cur), ex = cur.ex;
  const next = srNextAfter(cur);
  const stepOf = cur.grouped ? t('wheel.roundOf', {set: cur.set, total: cur.rounds}) : t('timer.setOf', {set: cur.set, total: cur.rounds});
  const nextText = next ? `${next.ex.name || t('exercise.namePlaceholder')} · ${next.grouped ? t('wheel.roundOf', {set: next.set, total: next.rounds}) : t('timer.setOf', {set: next.set, total: next.rounds})}` : t('strength.lastSet');
  return times + `
    <div class="str-now">
      <div class="lab">${esc(stepOf)}${cur.tag ? ' · ' + cur.tag : ''}</div>
      <div class="str-line"><span class="str-name">${esc(ex.name || t('exercise.namePlaceholder'))}</span><span class="str-target">${esc(setLabel(entry.r, entry.w, ex))}</span></div>
    </div>
    <button class="set-done" data-act="srCheck">${icon('check', 32)} ${esc(t('strength.done'))}</button>
    <div class="str-next"><b>${esc(t('wheel.next'))}:</b> ${esc(nextText)}</div>`;
}
function vStrengthCards(){
  const cur = srCurrent(), next = srNextAfter(cur);
  const queue = strengthQueue(runDay);
  return runDay.exercises.map((ex, i) => {
    const items = queue.filter(x => x.exIdx === i);
    const isCur = cur && cur.exIdx === i;
    const allClosed = items.every(x => !srOpen(x));
    const st = isCur ? 'cur' : allClosed ? 'done' : '';
    const label = isCur ? t('strength.now') : allClosed ? t('wheel.done') : next && next.exIdx === i ? t('wheel.next') : t('wheel.later');
    const g = groupInfo(runDay, i);
    const tag = g.inGroup ? `${g.letter}${g.pos} · ` : '';
    const rows = items.map(x => {
      const e = srEntry(x);
      const active = isCur && x.set === cur.set;
      return `<button class="set-row ${e.done ? 'done' : ''} ${e.skipped ? 'skipped' : ''} ${active ? 'active' : ''}" data-act="srToggleSet" data-arg="${srKey(x.ex, x.set)}" aria-pressed="${e.done}">
        <span class="set-check">${e.done ? icon('check', 14) : x.set}</span><span class="grow">${esc(setLabel(e.r, e.w, ex))}</span>${e.skipped ? `<small>${esc(t('strength.skipped'))}</small>` : ''}</button>`;
    }).join('');
    const pause = effectiveSetPause(ex, runDay);
    return `<article class="wcard ${st} ${g.inGroup ? 'grp' : ''}" data-ex="${i}" ${isCur ? '' : `data-act="srFocus" data-arg="${ex.id}"`}>
      <div class="wtop"><span class="wlabel">${esc(tag + label)}</span><span class="wnum">${i + 1}/${runDay.exercises.length}</span></div>
      <div class="wname">${st === 'done' ? icon('check', 16) : ''}${esc(ex.name || t('exercise.namePlaceholder'))}</div>
      <div class="wsub"><i style="background:${muscleColor(ex.muscle)}"></i>${esc(t('muscle.' + ex.muscle))} · ${esc(pause > 0 ? t('strength.reco', {time: formatClock(pause)}) : t('group.direct'))}</div>
      <div class="set-rows">${rows}</div>
    </article>`;
  }).join('');
}
function renderStrength(app){
  let run = document.getElementById('run');
  const fresh = !run || !run.classList.contains('strength-run');
  if(fresh){
    app.innerHTML = vStrengthShell();
    run = document.getElementById('run');
    mountWheel();
  }
  const counts = srCounts();
  run.querySelector('[data-slot=head]').innerHTML = `
    <button class="icon-btn" data-act="askStopStrength" aria-label="${esc(t('timer.cancelBtn'))}">${icon('close')}</button>
    <h1 class="display center small">${esc(runDay.name)}</h1>
    <span class="step-count">${counts.closed}/${counts.total}</span>`;
  run.querySelector('[data-slot=top]').innerHTML = vStrengthTop();
  const cur = srCurrent();
  run.querySelector('[data-slot=ctl]').innerHTML = `
    <button data-act="srUndo" ${sr.undo.length ? '' : 'disabled'}>${icon('prev', 18)} ${esc(t('strength.undoShort'))}</button>
    <button data-act="srSkip" ${cur ? '' : 'disabled'}>${esc(t('strength.skipShort'))} ${icon('skip', 18)}</button>`;
  const w = document.getElementById('runWheel');
  const keep = w.scrollTop;
  w.innerHTML = vStrengthCards();
  w.scrollTop = keep;
  if(fresh || wheel.follow){ wheel.lastSet = w.scrollTop; centerWheel(!fresh); }
  wheelDepth();
  updateFollowPill();
  document.getElementById('sheetSlot').innerHTML = vSheet();
  updateStrengthDOM();
}
function updateStrengthDOM(){
  if(!sr || state.screen !== 'strength') return;
  const el = document.getElementById('srElapsed');
  if(!el) return;
  el.textContent = formatClock((Date.now() - sr.startedAt) / 1000);
  const box = document.getElementById('srRestBox');
  const val = document.getElementById('srRest');
  const reco = document.getElementById('srReco');
  if(!sr.lastCheckAt){
    box.classList.remove('ready');
    val.textContent = '–';
    reco.textContent = '';
    return;
  }
  const rest = (Date.now() - sr.lastCheckAt) / 1000;
  val.textContent = formatClock(rest);
  const reached = sr.restGoal > 0 && rest >= sr.restGoal;
  box.classList.toggle('ready', reached);
  // Die Pause ist nur eine Empfehlung: Es laeuft einfach weiter, beim Erreichen kommt ein leiser Hinweis.
  reco.textContent = sr.restGoal <= 0 ? t('strength.recoDirect')
    : t(reached ? 'strength.recoReached' : 'strength.reco', {time: formatClock(sr.restGoal)});
  if(reached && !sr.restBeeped){
    sr.restBeeped = true;
    beep(880, 180, 0.25);
    if(navigator.vibrate) navigator.vibrate(100);
  }
}
function srAfterChange(){ srSave(); wheel.follow = true; render(); }
function srCloseSet(item, field){
  const e = srEntry(item);
  e[field] = true;
  e.prev = { at: sr.lastCheckAt, goal: sr.restGoal }; // fuer Zurueck: die Zeit laeuft dann vom Satz davor weiter
  sr.undo.push(srKey(item.ex, item.set));
  sr.lastCheckAt = Date.now();
  sr.restGoal = field === 'done' ? effectiveSetPause(item.ex, runDay) : 0;
  sr.restBeeped = sr.restGoal <= 0;
  if(item.grouped) sr.focus = null;
}
function strengthSummary(){
  const queue = strengthQueue(runDay);
  const byEx = runDay.exercises.map((ex, i) => {
    const items = queue.filter(x => x.exIdx === i);
    const logs = items.filter(x => srEntry(x).done).map(x => ({ r: srEntry(x).r, w: srEntry(x).w || 0 }));
    const volume = ex.unit === 'seconds' ? 0 : logs.reduce((a, l) => a + l.r * l.w, 0);
    return { name: ex.name || t('exercise.unnamed'), muscle: ex.muscle, reachedSets: logs.length, totalSets: items.length, logs, volume };
  });
  const counts = srCounts();
  const fraction = counts.total ? counts.done / counts.total : 0;
  const elapsed = Math.round((Date.now() - sr.startedAt) / 1000);
  return {
    type: 'strength', dayName: runDay.name,
    exercises: byEx.filter(e => e.reachedSets > 0), allExercises: byEx,
    totalPlannedSeconds: elapsed, elapsedSeconds: elapsed, completionFraction: fraction, completed: fraction >= 0.75,
    volumeKg: byEx.reduce((a, e) => a + e.volume, 0)
  };
}
// Ergebnisse merken: "Letztes Mal" und die Last fuers naechste Training.
function rememberStrengthResults(summary){
  runDay.exercises.forEach((ex, i) => {
    const res = summary.allExercises[i];
    if(!res || !res.logs.length) return;
    const my = rememberExercise(ex);
    if(my) my.last = { date: Date.now(), sets: res.logs };
  });
  schedulePersist();
}
function endStrength(){
  const summary = strengthSummary();
  sessionStartStamp = new Date(sr.startedAt);
  clearInterval(srTicker);
  srClearSaved();
  releaseWakeLock();
  const anyDone = summary.exercises.length > 0;
  if(anyDone){
    // Vor dem Merken vergleichen, damit "mehr als letztes Mal" gegen den alten Stand rechnet.
    summary.allExercises.forEach((e, i) => {
      const my = findMyExercise(runDay.exercises[i].name);
      const prev = my && my.last ? Math.max(0, ...my.last.sets.map(s => s.w || 0)) : 0;
      const best = Math.max(0, ...e.logs.map(l => l.w));
      e.raised = prev > 0 && best > prev ? best - prev : 0;
    });
    rememberStrengthResults(summary);
    logSession(summary);
  }
  const day = runDay;
  sr = null;
  ui.sheet = null;
  if(anyDone){
    if(summary.completed) finishFanfare();
    ui.finished = { summary: Object.assign({}, summary, { exercises: summary.allExercises }), day, strength: true };
    state.screen = 'finished';
  } else {
    state.screen = 'main';
  }
  render();
}
function vFinishedStrength(){
  const { summary, day } = ui.finished;
  const next = dueDay();
  const done = summary.exercises.reduce((a, e) => a + e.reachedSets, 0);
  const total = summary.exercises.reduce((a, e) => a + e.totalSets, 0);
  return `
  <header class="head"><span class="icon-spacer"></span><span class="grow"></span><button class="icon-btn" data-act="closeFinished" aria-label="${esc(t('finished.back'))}">${icon('close')}</button></header>
  <div class="screen">
    <div class="done-hero">
      <div class="eyebrow ${summary.completed ? 'ok' : ''}">${esc(summary.completed ? t('finished.complete') : t('finished.partial'))}</div>
      <h1 class="display big">${esc(summary.completed ? t('finished.title2', {day: summary.dayName}) : t('finished.stopped'))}</h1>
      <p>${esc(t('finished.stats', {time: formatClock(summary.elapsedSeconds), done, total}))}${next ? ' · ' + esc(t('finished.next', {name: next.name})) : ''}</p>
    </div>
    <section class="kpis">
      <div class="kpi"><b>${Math.round(summary.volumeKg).toLocaleString(currentLanguage)} kg</b><span>${esc(t('strength.volume'))}</span></div>
      <div class="kpi"><b>${done}/${total}</b><span>${esc(t('train.sets'))}</span></div>
    </section>
    <ul class="list result-list">${summary.exercises.map((e, i) => ({ e, ex: day.exercises[i] })).filter(x => x.e.reachedSets > 0).map(({ e, ex }) => `
      <li class="list-row"><div class="grow"><b>${esc(e.name)}</b><small>${esc(e.logs.map(l => setLabel(l.r, l.w, ex)).join(' · '))}</small></div>
      ${e.raised ? `<span class="raise">${esc(t('strength.raised', {w: fmtKg(e.raised)}))}</span>` : ''}</li>`).join('')}</ul>
  </div>
  <div class="startbar"><button class="btn btn-ghost" data-act="closeFinished">${esc(t('finished.back'))}</button></div>`;
}

Object.assign(ACTIONS, {
  resumeStrength(){ const s = srSaved(); if(s) startStrength(s.day, s.saved); },
  discardStrength(){ srClearSaved(); render(); },
  srCheck(){ const cur = srCurrent(); if(!cur) return; srCloseSet(cur, 'done'); beep(660, 90, 0.3); srAfterChange(); },
  srSkip(){ const cur = srCurrent(); if(!cur) return; srCloseSet(cur, 'skipped'); srAfterChange(); },
  srUndo(){
    const key = sr.undo.pop();
    if(!key) return;
    sr.sets[key].done = false; sr.sets[key].skipped = false;
    const prev = sr.sets[key].prev || { at: null, goal: 0 };
    sr.lastCheckAt = prev.at; sr.restGoal = prev.goal; sr.restBeeped = true;
    srAfterChange();
  },
  // Satz in der Liste antippen: abhaken oder wieder oeffnen, auch ausserhalb der Reihenfolge.
  srToggleSet(key){
    const e = sr.sets[key];
    if(!e) return;
    if(e.done || e.skipped){
      e.done = false; e.skipped = false;
      sr.undo = sr.undo.filter(k => k !== key);
    } else {
      const item = strengthQueue(runDay).find(x => srKey(x.ex, x.set) === key);
      if(item) srCloseSet(item, 'done');
    }
    srAfterChange();
  },
  // Andere Uebung vorziehen, z.B. wenn das Geraet gerade belegt ist.
  srFocus(exId){ sr.focus = exId; srAfterChange(); },
  askStopStrength(){ ui.sheet = 'stopStrength'; render(); },
  finishStrength(){ endStrength(); },
  stopStrength(){ endStrength(); },
  discardRunningStrength(){
    clearInterval(srTicker); srClearSaved(); releaseWakeLock();
    sr = null; ui.sheet = null; state.screen = 'main';
    render();
  }
});

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
      clearInterval(srTicker); sr = null;
      settings = { theme: null, language: null };
      onboarding = { equipment: [], focus: [], constraints: '', daysPerWeek: null, sessionMinutes: null, completed: false };
      onboardingCardDismissed = false;
      historySessions = null;
      ensureIds();
      render();
    }
  });
})();
