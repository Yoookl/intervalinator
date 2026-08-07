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
    if(b){ b.style.display = 'block'; b.textContent = 'Fehler: ' + msg; }
  }catch(e){ /* nichts weiter möglich */ }
}
window.addEventListener('error', (e) => showError((e && e.message) || 'Unbekannter Fehler'));
window.addEventListener('unhandledrejection', (e) => {
  const reason = e && e.reason;
  showError((reason && (reason.message || String(reason))) || 'Unbekannter Fehler (Promise)');
});

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
    'auth/invalid-email': 'Ungültige E-Mail-Adresse.',
    'auth/user-disabled': 'Dieser Account wurde deaktiviert.',
    'auth/user-not-found': 'Kein Account mit dieser E-Mail gefunden.',
    'auth/wrong-password': 'Falsches Passwort.',
    'auth/invalid-credential': 'E-Mail oder Passwort falsch.',
    'auth/email-already-in-use': 'Diese E-Mail wird bereits verwendet.',
    'auth/weak-password': 'Passwort ist zu schwach (mind. 6 Zeichen).',
    'auth/too-many-requests': 'Zu viele Versuche. Bitte später erneut versuchen.',
    'auth/network-request-failed': 'Netzwerkfehler. Bitte Verbindung prüfen.'
  };
  return map[e.code] || (e.message || 'Unbekannter Fehler.');
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
  if(!email){ authError = 'Bitte zuerst E-Mail-Adresse eingeben.'; render(); return; }
  try{
    await auth.sendPasswordResetEmail(email);
    authInfo = 'E-Mail zum Zurücksetzen des Passworts wurde gesendet.';
  }catch(e){
    authError = translateAuthError(e);
  }
  render();
}

/* ---------- Daten ---------- */
const MUSCLE_GROUPS = ["Brust","Rücken","Schultern","Bizeps","Trizeps","Beine","Bauch","Ganzkörper","Cardio","Sonstiges"];

const CURRENT_PLAN_SCHEMA_VERSION = 1;

const DEFAULT_PLAN = {
  schemaVersion: CURRENT_PLAN_SCHEMA_VERSION,
  warmupSeconds: 60,
  setPauseSeconds: 60,
  pauseSeconds: 15,
  stretchSeconds: 120,
  soundOn: true,
  days: [
    { name: "Push", exercises: [
      { name: "Liegestütz", muscle: "Brust", sets: 4, seconds: 30 },
      { name: "Langhantel Schulterdrücken", muscle: "Schultern", sets: 4, seconds: 30 },
      { name: "Hanteln Seitheben", muscle: "Schultern", sets: 3, seconds: 30 },
      { name: "Trizeps mit Band", muscle: "Trizeps", sets: 3, seconds: 30 },
    ]},
    { name: "Pull", exercises: [
      { name: "Langhantel vorgebeugtes Rudern", muscle: "Rücken", sets: 4, seconds: 30 },
      { name: "Band vorne auseinanderziehen", muscle: "Rücken", sets: 3, seconds: 30 },
      { name: "Band schräg oben-unten", muscle: "Rücken", sets: 3, seconds: 30 },
      { name: "Hanteln Bizeps Curls", muscle: "Bizeps", sets: 3, seconds: 30 },
      { name: "Langhantel Bizeps Curls", muscle: "Bizeps", sets: 3, seconds: 30 },
    ]},
    { name: "Beine", exercises: [
      { name: "Langhantel Kniebeugen", muscle: "Beine", sets: 4, seconds: 30 },
      { name: "Langhantel Ausfallschritte", muscle: "Beine", sets: 3, seconds: 30 },
      { name: "Wadenheben mit Hanteln", muscle: "Beine", sets: 3, seconds: 30 },
      { name: "Bauchrolle", muscle: "Bauch", sets: 3, seconds: 30 },
      { name: "Situps", muscle: "Bauch", sets: 3, seconds: 30 },
      { name: "Seitliches Bauchtraining", muscle: "Bauch", sets: 3, seconds: 30 },
    ]},
  ]
};

const state = {
  plan: deepClone(DEFAULT_PLAN),
  globalExpanded: false,
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
  // if(version < 2){ ... plan = ...; version = 2; }
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
  const t = document.getElementById('saveToast');
  if(!t) return;
  t.textContent = ok ? 'Gespeichert' : 'Speichern nicht möglich (nur lokal)';
  t.style.color = ok ? '' : 'var(--danger)';
  t.classList.add('show');
  clearTimeout(showSaveStatus._t);
  showSaveStatus._t = setTimeout(()=>t.classList.remove('show'), 1400);
}

async function loadPlanForCurrentUser(){
  const key = localCacheKey();
  try{
    const doc = await userDocRef().get();
    if(doc.exists && doc.data() && doc.data().plan){
      state.plan = migratePlan(doc.data().plan);
    } else {
      state.plan = deepClone(DEFAULT_PLAN);
      ensureIds();
      await persistPlan();
    }
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
  const restLike = (mode === 'pause' || mode === 'stretch');
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
  if(state.plan.warmupSeconds > 0){
    s.push({ mode:'warmup', seconds: state.plan.warmupSeconds });
  }
  day.exercises.forEach((ex, exIdx) => {
    const sets = Math.max(1, ex.sets || 1);
    const secs = Math.max(1, ex.seconds || 1);
    for(let set=1; set<=sets; set++){
      s.push({ mode:'exercise', seconds: secs, name: ex.name || '(ohne Namen)', muscle: ex.muscle, exNum: exIdx+1, totalEx: day.exercises.length, setNum: set, totalSets: sets });
      const isLastOverall = (exIdx === day.exercises.length-1) && (set === sets);
      if(!isLastOverall){
        const movingToNextExercise = (set === sets);
        const pauseLen = Math.max(0, movingToNextExercise ? state.plan.pauseSeconds : state.plan.setPauseSeconds);
        s.push({ mode:'pause', seconds: pauseLen });
      }
    }
  });
  if(state.plan.stretchSeconds > 0){
    s.push({ mode:'stretch', seconds: state.plan.stretchSeconds });
  }
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
  const t = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(t/60), sec = t%60;
  return `${m}:${String(sec).padStart(2,'0')}`;
}
function formatMinSec(totalSeconds){
  const m = Math.floor(totalSeconds/60), s = totalSeconds%60;
  return `${m}:${String(s).padStart(2,'0')} Min.`;
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
  app.appendChild(renderMainView());
}

function renderLoadingScreen(){
  const wrap = el('div', {class:'auth-wrap'});
  wrap.appendChild(el('div', {class:'auth-sub'}, ['Lade...']));
  return wrap;
}

function renderAuthScreen(){
  const wrap = el('div', {class:'auth-wrap'});
  const card = el('div', {class:'auth-card'});
  const isLogin = authMode === 'login';
  card.appendChild(el('div', {class:'auth-title'}, ['Trainingsplan']));
  card.appendChild(el('div', {class:'auth-sub'}, [isLogin ? 'Anmelden' : 'Neuen Account erstellen']));

  if(authError) card.appendChild(el('div', {class:'auth-error'}, [authError]));
  if(authInfo) card.appendChild(el('div', {class:'auth-info'}, [authInfo]));

  const emailField = el('div', {class:'auth-field'});
  emailField.appendChild(el('label', {}, ['E-Mail']));
  const emailInput = el('input', {type:'email', autocomplete:'email'});
  emailField.appendChild(emailInput);

  const pwField = el('div', {class:'auth-field'});
  pwField.appendChild(el('label', {}, ['Passwort']));
  const pwInput = el('input', {type:'password', autocomplete: isLogin ? 'current-password' : 'new-password'});
  pwField.appendChild(pwInput);
  if(!isLogin) pwField.appendChild(el('div', {class:'auth-hint'}, ['Mindestens 8 Zeichen']));

  card.appendChild(emailField);
  card.appendChild(pwField);

  const submitBtn = el('button', {class:'btn btn-primary btn-block'}, [authBusy ? '...' : (isLogin ? 'Anmelden' : 'Registrieren')]);
  submitBtn.disabled = authBusy;
  submitBtn.addEventListener('click', () => {
    const email = emailInput.value.trim();
    const pw = pwInput.value;
    if(!email || !pw){ authError = 'Bitte E-Mail und Passwort eingeben.'; render(); return; }
    if(!EMAIL_RE.test(email)){ authError = 'Bitte eine gültige E-Mail-Adresse eingeben.'; render(); return; }
    if(!isLogin && pw.length < 8){ authError = 'Das Passwort muss mindestens 8 Zeichen lang sein.'; render(); return; }
    if(isLogin) handleLogin(email, pw); else handleRegister(email, pw);
  });
  const onEnter = (e) => { if(e.key === 'Enter') submitBtn.click(); };
  emailInput.addEventListener('keydown', onEnter);
  pwInput.addEventListener('keydown', onEnter);

  card.appendChild(submitBtn);

  if(isLogin){
    const forgot = el('div', {class:'auth-forgot'});
    const forgotLink = el('a', {}, ['Passwort vergessen?']);
    forgotLink.addEventListener('click', () => handlePasswordReset(emailInput.value.trim()));
    forgot.appendChild(forgotLink);
    card.appendChild(forgot);
  }

  const switchRow = el('div', {class:'auth-switch'});
  const switchLink = el('a', {}, [isLogin ? 'Noch keinen Account? Registrieren' : 'Schon einen Account? Anmelden']);
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

function renderMainView(){
  const wrap = el('div', {});
  const userBar = el('div', {class:'user-bar'});
  userBar.appendChild(el('span', {class:'user-email'}, [authUser.email || '']));
  const logoutBtn = el('button', {class:'btn logout-btn'}, ['Abmelden']);
  logoutBtn.addEventListener('click', handleLogout);
  userBar.appendChild(logoutBtn);
  wrap.appendChild(userBar);
  wrap.appendChild(el('h1', {}, ['Trainingsplan']));
  wrap.appendChild(el('div', {class:'sub'}, ['Tag antippen zum Bearbeiten, Start direkt am Tag.']));

  // Globale Einstellungen (einklappbar)
  const globalCard = el('div', {class:'card'});
  const globalHead = el('div', {class:'collapsible-head'});
  globalHead.appendChild(el('span', {class:`chevron ${state.globalExpanded?'open':''}`}, ['▸']));
  globalHead.appendChild(el('span', {class:'collapsible-title'}, ['Globale Einstellungen']));
  globalHead.addEventListener('click', () => { state.globalExpanded = !state.globalExpanded; render(); });
  globalCard.appendChild(globalHead);

  if(!state.globalExpanded){
    const p = state.plan;
    globalCard.appendChild(el('div', {class:'collapsible-summary'}, [
      `Aufwärmen ${p.warmupSeconds}s · Satzpause ${p.setPauseSeconds}s · Übungspause ${p.pauseSeconds}s · Dehnen ${p.stretchSeconds}s · Sound ${p.soundOn ? 'an' : 'aus'}`
    ]));
  } else {
    const body = el('div', {class:'collapsible-body'});
    body.appendChild(makePlanNumberField('Aufwärmen (Sek.)', 'warmupSeconds', 0, 5));
    body.appendChild(makePlanNumberField('Pause zwischen den Sätzen (Sek.)', 'setPauseSeconds', 0, 5));
    body.appendChild(makePlanNumberField('Pause zwischen den Übungen (Sek.)', 'pauseSeconds', 0, 5));
    body.appendChild(makePlanNumberField('Dehnen (Sek.)', 'stretchSeconds', 0, 5));

    const soundRow = el('div', {class:'sound-toggle', style:{marginTop:'12px'}});
    const checkbox = el('input', {type:'checkbox', id:'soundToggle'});
    checkbox.checked = state.plan.soundOn;
    checkbox.addEventListener('change', e => { state.plan.soundOn = e.target.checked; schedulePersist(); });
    soundRow.appendChild(checkbox);
    soundRow.appendChild(el('label', {for:'soundToggle'}, ['Akustisches Feedback']));
    body.appendChild(soundRow);
    globalCard.appendChild(body);
  }
  wrap.appendChild(globalCard);

  // Tage
  state.plan.days.forEach((day, dayIdx) => {
    wrap.appendChild(renderDayCard(day, dayIdx));
  });

  const addDayBtn = el('button', {class:'btn btn-block'}, ['+ Tag hinzufügen']);
  addDayBtn.addEventListener('click', () => {
    const newDay = { id: uid(), name: 'Neuer Tag', exercises: [] };
    state.plan.days.push(newDay);
    state.expandedDayIds.add(newDay.id);
    schedulePersist();
    render();
  });
  wrap.appendChild(addDayBtn);

  return wrap;
}

function makePlanNumberField(labelText, key, min, step){
  const field = el('div', {class:'field'});
  field.appendChild(el('label', {}, [labelText]));
  const input = el('input', {type:'number'});
  input.value = state.plan[key];
  if(min !== null) input.min = String(min);
  if(step) input.step = String(step);
  input.addEventListener('input', e => {
    let v = parseInt(e.target.value || '0', 10);
    if(isNaN(v)) v = min !== null ? min : 0;
    if(min !== null) v = Math.max(min, v);
    state.plan[key] = v;
    schedulePersist();
    document.querySelectorAll('.day-total').forEach(elm => {
      const dayId = elm.getAttribute('data-day-id');
      const day = state.plan.days.find(d => d.id === dayId);
      if(day) elm.textContent = `Gesamtdauer: ${formatMinSec(dayTotalSeconds(day))}`;
    });
  });
  field.appendChild(input);
  return field;
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
    if(confirm(`Tag "${day.name}" wirklich löschen?`)){
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
  metaRow.appendChild(el('div', {class:'day-total', 'data-day-id': day.id}, [`Gesamtdauer: ${formatMinSec(dayTotalSeconds(day))}`]));
  const startBtn = el('button', {class:'btn btn-primary day-start-btn'}, ['▶ Start']);
  startBtn.addEventListener('click', () => {
    if(day.exercises.length > 0) startTimer(day);
    else alert('Dieser Tag hat noch keine Übungen. Bitte erst hinzufügen.');
  });
  metaRow.appendChild(startBtn);
  card.appendChild(metaRow);

  if(isExpanded){
    const body = el('div', {class:'collapsible-body'});
    if(day.exercises.length === 0){
      body.appendChild(el('div', {class:'empty-note'}, ['Noch keine Übungen — füge unten welche hinzu.']));
    }
    day.exercises.forEach((ex, exIdx) => {
      body.appendChild(renderExerciseRow(day, ex, exIdx));
    });
    const addExBtn = el('button', {class:'btn add-ex-btn'}, ['+ Übung']);
    addExBtn.addEventListener('click', () => {
      day.exercises.push({ id: uid(), name: '', muscle: MUSCLE_GROUPS[0], sets: 3, seconds: 30 });
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
  if(elm) elm.textContent = `Gesamtdauer: ${formatMinSec(dayTotalSeconds(day))}`;
}

function renderExerciseRow(day, ex, exIdx){
  const row = el('div', {class:'exercise-row'});

  const line1 = el('div', {class:'ex-line1'});

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

  const nameInput = el('input', {type:'text', class:'ex-name', placeholder:'Übung (Freitext)'});
  nameInput.value = ex.name;
  nameInput.addEventListener('input', e => { ex.name = e.target.value; schedulePersist(); });

  const muscleSelect = el('select', {class:'ex-muscle'});
  MUSCLE_GROUPS.forEach(m => {
    const opt = el('option', {value:m}, [m]);
    if(ex.muscle === m) opt.setAttribute('selected','selected');
    muscleSelect.appendChild(opt);
  });
  muscleSelect.addEventListener('change', e => { ex.muscle = e.target.value; schedulePersist(); });

  const delBtn = el('button', {class:'icon-btn'}, ['✕']);
  delBtn.addEventListener('click', () => {
    day.exercises.splice(exIdx,1);
    schedulePersist();
    render();
  });

  line1.appendChild(reorderBox);
  line1.appendChild(nameInput);
  line1.appendChild(muscleSelect);
  line1.appendChild(delBtn);

  const line2 = el('div', {class:'ex-line2'});

  const setsField = el('div', {class:'field-mini'});
  setsField.appendChild(el('label', {}, ['Sätze']));
  const setsInput = el('input', {type:'number', min:'1'});
  setsInput.value = ex.sets;
  setsInput.addEventListener('input', e => {
    ex.sets = Math.max(1, parseInt(e.target.value||'1',10));
    schedulePersist();
    updateDayTotalDisplay(day);
  });
  setsField.appendChild(setsInput);

  const secField = el('div', {class:'field-mini'});
  secField.appendChild(el('label', {}, ['Sek./Satz']));
  const secInput = el('input', {type:'number', min:'5', step:'5'});
  secInput.value = ex.seconds;
  secInput.addEventListener('input', e => {
    ex.seconds = Math.max(5, parseInt(e.target.value||'30',10));
    schedulePersist();
    updateDayTotalDisplay(day);
  });
  secField.appendChild(secInput);

  line2.appendChild(setsField);
  line2.appendChild(secField);

  row.appendChild(line1);
  row.appendChild(line2);
  return row;
}



/* ---------- Timer-Ablauf ---------- */
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
function stopTimer(){
  clearInterval(state.intervalId);
  state.running = false;
  render();
}
function finishTimer(){
  clearInterval(state.intervalId);
  state.running = false;
  finishFanfare();
  const app = document.getElementById('app');
  app.innerHTML = '';
  const wrap = el('div', {class:'finished'});
  wrap.appendChild(el('div', {class:'big'}, ['🏁']));
  wrap.appendChild(el('h1', {}, ['Fertig!']));
  wrap.appendChild(el('div', {class:'sub'}, [`${state.currentDayName} abgeschlossen.`]));
  const backBtn = el('button', {class:'btn btn-primary btn-block'}, ['Zurück']);
  backBtn.addEventListener('click', () => { render(); });
  wrap.appendChild(backBtn);
  app.appendChild(wrap);
}

function peekNext(fromIndex){
  for(let i=fromIndex+1; i<steps.length; i++){
    const st = steps[i];
    if(st.mode === 'exercise') return { type:'exercise', name: st.name, setNum: st.setNum, totalSets: st.totalSets };
    if(st.mode === 'stretch') return { type:'stretch' };
  }
  return null;
}

function renderTimerScreen(){
  const s = steps[state.stepIndex];
  const isRestColor = (s.mode === 'pause' || s.mode === 'stretch');
  const wrap = el('div', {class:'wrap timer-screen'});

  let primary = '';
  let secondary = '';
  let hint = '';

  if(s.mode === 'exercise'){
    primary = s.name;
    secondary = `${s.muscle} · Satz ${s.setNum}/${s.totalSets}`;
    if(s.setNum === s.totalSets){
      const nxt = peekNext(state.stepIndex);
      if(nxt && nxt.type === 'exercise') hint = `Nächste Übung: ${nxt.name}`;
      else if(nxt && nxt.type === 'stretch') hint = 'Danach: Dehnen';
    }
  } else if(s.mode === 'pause'){
    primary = 'Pause';
    const nextStep = steps[state.stepIndex+1];
    if(nextStep && nextStep.mode === 'exercise'){
      secondary = (nextStep.setNum === 1)
        ? `Nächste Übung: ${nextStep.name}`
        : `Weiter: ${nextStep.name} · Satz ${nextStep.setNum}/${nextStep.totalSets}`;
    } else if(nextStep && nextStep.mode === 'stretch'){
      secondary = 'Gleich: Dehnen';
    }
  } else if(s.mode === 'warmup'){
    primary = 'Aufwärmen';
    const nextStep = steps[state.stepIndex+1];
    if(nextStep && nextStep.mode === 'exercise') secondary = `Erste Übung: ${nextStep.name}`;
  } else if(s.mode === 'stretch'){
    primary = 'Dehnen';
    secondary = 'Fast geschafft';
  }

  wrap.appendChild(el('div', {class:'timer-meta'}, [`${state.currentDayName} · Schritt ${state.stepIndex+1} / ${steps.length}`]));
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
      <span>Gesamt ${formatClock(stepsTotalSeconds)}</span>
    </div>
  `;
  wrap.appendChild(overall);

  const controls = el('div', {class:'timer-controls'});
  const pauseBtn = el('button', {class:'btn'}, [state.paused ? '▶ Weiter' : '⏸ Pause']);
  pauseBtn.addEventListener('click', togglePause);
  const skipBtn = el('button', {class:'btn'}, ['⏭ Weiter']);
  skipBtn.addEventListener('click', skipStep);
  const cancelBtn = el('button', {class:'btn btn-danger'}, ['Abbrechen']);
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
render();
auth.onAuthStateChanged(user => {
  authReady = true;
  authError = '';
  authInfo = '';
  if(user){
    authUser = user;
    loadPlanForCurrentUser();
  } else {
    authUser = null;
    state.plan = deepClone(DEFAULT_PLAN);
    ensureIds();
    render();
  }
});
