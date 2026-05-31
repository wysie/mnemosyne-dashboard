const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const THEME_KEY = 'mnemosyne-dashboard-theme';
const VISUALISER_MODE_KEY = 'mnemosyne-dashboard-visualiser-mode';
let graphState = { nodes: [], edges: [], byId: {} };
let consolidationState = [];
let authState = { config: {}, auth_enabled: false, authenticated: true };
let realtimeState = { paused: false, source: null, events: [], status: null };
const LIVE_MEMORY_PAGE_SIZE = 25;
let liveMemoryItems = [];
let liveMemoryOffset = 0;
let liveMemoryHasMore = true;
let liveMemoryLoading = false;
let liveMemoryObserver = null;
let currentRoute = { tab: 'overview' };
let applyingHistory = false;
let lastBootError = null;
let bulkSelection = new Set();
let reviewSelection = new Set();
let selectedReviewQueue = 'contaminated';
let reviewOffset = 0;
let latestReviewData = null;
const REVIEW_PAGE_SIZE = 100;
let latestMemoryItems = [];
let latestReviewItems = [];
let graphView = { scale:1, x:0, y:0, dragging:false, sx:0, sy:0, ox:0, oy:0 };
const CONSTELLATION_MIN_ZOOM = .55;
const CONSTELLATION_MAX_ZOOM = 6;
const CONSTELLATION_DEFAULT_CAMERA = { rotation: 0.55, tilt: 0.78, zoom: 1, panX: 0, panY: 0 };
let constellationScene = { frame: 0, nodes: [], edges: [], byId: {}, stars: [], ...CONSTELLATION_DEFAULT_CAMERA, paused: false, mode: 'rotate', visualiserMode: localStorage.getItem(VISUALISER_MODE_KEY) || 'constellation', lastFrameTime: 0, lastInteraction: 0, hits: [], data: null, drag: null, pointers: new Map() };

function setTheme(theme){
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_KEY, theme);
  $$('.theme-icon').forEach(icon => { icon.textContent = theme === 'light' ? '☀' : '☾'; });
  $$('.theme-label').forEach(label => { label.textContent = theme === 'light' ? 'Light' : 'Dark'; });
}
function initTheme(){
  const saved = localStorage.getItem(THEME_KEY);
  const preferred = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  setTheme(saved || preferred);
}
async function api(path, options={}){
  const r = await fetch(path, options);
  const j = await r.json();
  if(r.status === 401){ showLogin(); throw new Error(j.error || 'auth required'); }
  if(!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
async function postJson(path, body){ return api(path, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body || {})}); }
function showLogin(){ $('#loginOverlay')?.classList.remove('hidden'); }
function hideLogin(){ $('#loginOverlay')?.classList.add('hidden'); }
function bootErrorPayload(){
  return lastBootError ? JSON.stringify(lastBootError, null, 2) : '';
}
function renderBootErrorStatus(){
  const status = $('#bootErrorStatus');
  const stack = $('#bootErrorStack');
  const copy = $('#copyBootError');
  if(!status || !stack) return;
  if(!lastBootError){
    status.textContent = 'No frontend boot errors recorded in this page session.';
    stack.textContent = '';
    stack.classList.add('hidden');
    if(copy) copy.disabled = true;
    return;
  }
  status.textContent = `${lastBootError.time} · ${lastBootError.message}`;
  stack.textContent = lastBootError.stack || lastBootError.message;
  stack.classList.remove('hidden');
  if(copy) copy.disabled = false;
}
function setBootError(title, body=''){
  const el = $('#bootError');
  if(!el) return;
  el.innerHTML = `<strong>${esc(title)}</strong>${body ? `<p>${esc(body)}</p>` : ''}<div class="item-actions"><button id="bootErrorRetry" class="primary">Retry load</button><button id="bootErrorCopy">Copy error details</button></div>`;
  el.classList.remove('hidden');
  $('#bootErrorRetry')?.addEventListener('click', () => bootstrapDashboard());
  $('#bootErrorCopy')?.addEventListener('click', () => copyBootErrorDetails());
}
function clearBootError(){
  const el = $('#bootError');
  if(!el) return;
  el.innerHTML = '';
  el.classList.add('hidden');
}
function copyBootErrorDetails(){
  if(!lastBootError) return;
  showSelectableCopy('Boot error details', bootErrorPayload());
}
async function handleInitError(error){
  console.error('Dashboard bootstrap failed', error);
  lastBootError = {
    time: new Date().toISOString(),
    message: error?.message || String(error || 'Unknown startup error'),
    stack: error?.stack || '',
  };
  let status = null;
  try {
    const r = await fetch('/api/auth/status', { cache: 'no-store' });
    status = await r.json();
    if(r.ok) authState = status;
  } catch {}
  const authRequired = !!(status && status.auth_enabled && !status.authenticated);
  if(authRequired){
    clearBootError();
    renderBootErrorStatus();
    showLogin();
    return;
  }
  hideLogin();
  setBootError('Dashboard failed to finish loading.', lastBootError.message);
  renderBootErrorStatus();
}
async function bootstrapDashboard(){
  clearBootError();
  const route = urlToRoute();
  const s = await refreshAuthState();
  if(s.auth_enabled && !s.authenticated){
    renderBootErrorStatus();
    showLogin();
    return;
  }
  hideLogin();
  await loadStats();
  await initRealtime();
  if(route.tab !== 'overview' || route.drawer) await applyRoute(route);
  renderBootErrorStatus();
}
function esc(s){ return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function shortId(value, head=8, tail=6){ const s = String(value || '').trim(); return s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s; }
function prettyTime(value){
  if(!value) return '';
  const d = new Date(value);
  if(Number.isNaN(d.getTime())) return String(value);
  return new Intl.DateTimeFormat(undefined, {day:'numeric', month:'short', year:'numeric', hour:'numeric', minute:'2-digit'}).format(d);
}
function meta(item, opts={}){
  const status = item.status || 'active';
  const scope = String(item.scope || '').trim();
  const session = String(item.session_id || '').trim();
  const rawTime = item.timestamp || item.created_at || '';
  const timeLabel = prettyTime(rawTime);
  const kind = item.memory_kind || item.tier || item.source || 'memory';
  const veracity = String(item.veracity || 'unknown').toLowerCase();
  const lifecycle = item.degradation_label ? `${item.degradation_label}${item.degradation_tier ? ` · T${item.degradation_tier}` : ''}` : '';
  const scopeBadge = scope && scope !== 'session' ? `<span class="badge" title="scope: ${esc(scope)}">${esc(scope)}</span>` : '';
  const sessionBadge = opts.sessionLink !== false && session && session !== 'default' ? `<button type="button" class="badge session-link" data-session="${esc(session)}" title="Open session: ${esc(session)}">session ${esc(shortId(session))}</button>` : '';
  const timeBadge = timeLabel ? `<span class="meta-time" title="${esc(rawTime)}">${esc(timeLabel)}</span>` : '';
  const veracityBadge = `<span class="badge trust-${esc(veracity)}" title="veracity: ${esc(veracity)} · recall weight ${Number(item.trust_weight ?? 0).toFixed(2)}">${esc(veracity)}</span>`;
  const lifecycleBadge = lifecycle ? `<span class="badge lifecycle-${esc(item.degradation_label)}" title="degradation tier: ${esc(item.degradation_tier)} · recall weight ${Number(item.degradation_weight ?? 1).toFixed(2)}">${esc(lifecycle)}</span>` : '';
  return `<div class="meta"><span class="badge">${esc(kind)}</span><span class="badge status-${esc(status)}">${esc(status)}</span>${veracityBadge}${lifecycleBadge}<span class="badge">importance ${Number(item.importance ?? 0).toFixed(2)}</span>${scopeBadge}${sessionBadge}${timeBadge}</div>`;
}
function roleOf(content){ const m = String(content || '').match(/^\[(USER|ASSISTANT|SYSTEM)\]/i); return m ? m[1].toLowerCase() : ''; }
function liveEventMeta(item){
  const eventType = String(item.live_event_type || item.event_type || '').toUpperCase();
  const map = {
    MEMORY_ADDED: ['new', 'new', 'live-badge-new'],
    MEMORY_UPDATED: ['updated', 'updated', 'live-badge-updated'],
    MEMORY_RECALLED: ['recalled', 'recalled', 'live-badge-recalled'],
    MEMORY_INVALIDATED: ['invalidated', 'invalidated', 'live-badge-invalidated'],
    MEMORY_CONSOLIDATED: ['consolidated', 'consolidated', 'live-badge-consolidated'],
  };
  return map[eventType] || ['', ''];
}
function memoryItem(item, opts={}){ const role = roleOf(item.content); const roleBadge = role ? `<span class="role role-${role}">${role}</span>` : ''; const selectedSet = opts.selectedSet || bulkSelection; const checkClass = opts.checkClass || 'memory-check'; const selectable = opts.selectable ? `<label class="memory-select" title="Select memory"><input type="checkbox" class="${esc(checkClass)}" data-id="${esc(item.id)}" ${selectedSet.has(item.id) ? 'checked' : ''} /></label>` : ''; const [liveClass, liveLabel, liveBadgeClass] = liveEventMeta(item); const liveBadge = liveLabel ? `<span class="badge live-badge ${esc(liveBadgeClass)}">${esc(liveLabel)}</span>` : ''; return `<div class="item memory-card ${role ? 'has-role' : ''} ${opts.selectable ? 'selectable' : ''} ${liveClass ? `live-${esc(liveClass)}` : ''}" data-id="${esc(item.id)}">${selectable}${meta(item)}${liveBadge}${roleBadge}<div class="content">${esc(item.content)}</div></div>`; }
function canonicalTab(tab){
  if(tab === 'constellation') return 'visualiserlegacy';
  if(tab === 'visualiser3d') return 'visualiser';
  if(tab === 'history') return 'activity';
  return tab || 'overview';
}
function routeTabState(tab=currentRoute.tab || 'overview'){ return { tab: canonicalTab(tab) }; }
function routeToUrl(state){
  const params = new URLSearchParams(location.search);
  ['tab','memory','session'].forEach(k => params.delete(k));
  params.set('tab', state.tab || 'overview');
  if(state.drawer?.type === 'memory') params.set('memory', state.drawer.id);
  if(state.drawer?.type === 'session') params.set('session', state.drawer.id);
  const qs = params.toString();
  return location.pathname + (qs ? `?${qs}` : '');
}
function urlToRoute(){
  const params = new URLSearchParams(location.search);
  const route = { tab: canonicalTab(params.get('tab') || 'overview') };
  if(params.get('memory')) route.drawer = { type:'memory', id:params.get('memory') };
  else if(params.get('session')) route.drawer = { type:'session', id:params.get('session') };
  if(route.drawer && (!params.get('tab') || route.tab === 'overview')) route.tab = route.drawer.type === 'memory' ? 'memories' : 'timelineView';
  return route;
}
function pushRoute(state, replace=false){
  if(applyingHistory) return;
  currentRoute = { ...state };
  const fn = replace ? 'replaceState' : 'pushState';
  history[fn](currentRoute, '', routeToUrl(currentRoute));
}
function closeDetail(opts={}){
  $('#detail').classList.add('hidden');
  if(opts.push !== false) pushRoute(routeTabState());
}
async function applyRoute(state){
  applyingHistory = true;
  try {
    const route = state || urlToRoute();
    switchTab(route.tab || 'overview', { push:false });
    if(route.drawer?.type === 'memory') await openMemoryDetail(route.drawer.id, { push:false });
    else if(route.drawer?.type === 'session') await openSessionDetail(route.drawer.id, { push:false });
    else closeDetail({ push:false });
    currentRoute = route;
    const canonicalUrl = routeToUrl(route);
    if(location.pathname + location.search !== canonicalUrl) history.replaceState(route, '', canonicalUrl);
  } finally {
    applyingHistory = false;
  }
}
function showSelectableCopy(label, value){
  openActionModal({
    title: label,
    description: 'Select the text below and press Cmd/Ctrl+C to copy. This works on non-HTTPS local dashboards.',
    kicker: 'Copy',
    confirmText: 'Done',
    bodyHtml: `<label class="modal-field"><span>${esc(label)}</span><textarea id="manualCopyValue" class="copy-value" rows="4" readonly>${esc(value || '')}</textarea></label>`,
    readValue: () => true
  });
  setTimeout(() => { const el = $('#manualCopyValue'); el?.focus(); el?.select(); }, 60);
}
function showDetail(obj, title='Detail', opts={}){
  const titleEl = document.querySelector('.drawer-title');
  if(titleEl) titleEl.textContent = title;
  $('#detailBody').classList.remove('html-detail');
  $('#detailBody').textContent = JSON.stringify(obj, null, 2);
  $('#detail').classList.remove('hidden');
  if(opts.push !== false) pushRoute({ ...routeTabState(), drawer:{ type:'json', title, value:obj } });
}
function showHtmlDetail(html, title='Detail'){
  const titleEl = document.querySelector('.drawer-title');
  if(titleEl) titleEl.textContent = title;
  $('#detailBody').classList.add('html-detail');
  $('#detailBody').innerHTML = html;
  $('#detail').classList.remove('hidden');
}

function modalTemplate(){
  let modal = $('#actionModal');
  if(modal) return modal;
  document.body.insertAdjacentHTML('beforeend', `
    <div id="actionModal" class="action-modal hidden" role="dialog" aria-modal="true">
      <div class="action-modal-card glass">
        <button id="actionModalClose" class="modal-close" aria-label="Close dialog">×</button>
        <div id="actionModalKicker" class="modal-kicker">Memory maintenance</div>
        <h2 id="actionModalTitle">Confirm action</h2>
        <p id="actionModalDescription" class="muted"></p>
        <div id="actionModalBody"></div>
        <p id="actionModalError" class="modal-error"></p>
        <div class="modal-actions">
          <button id="actionModalCancel">Cancel</button>
          <button id="actionModalConfirm" class="primary">Confirm</button>
        </div>
      </div>
    </div>`);
  return $('#actionModal');
}
function openActionModal({title, description='', kicker='Memory maintenance', confirmText='Confirm', tone='', bodyHtml='', readValue=()=>true, validate=()=>''}){
  return new Promise(resolve => {
    const modal = modalTemplate();
    $('#actionModalKicker').textContent = kicker;
    $('#actionModalTitle').textContent = title;
    $('#actionModalDescription').textContent = description;
    $('#actionModalBody').innerHTML = bodyHtml;
    $('#actionModalConfirm').textContent = confirmText;
    $('#actionModalConfirm').className = `primary ${tone}`.trim();
    $('#actionModalError').textContent = '';
    const close = (value) => { modal.classList.add('hidden'); document.removeEventListener('keydown', onKey); resolve(value); };
    const onKey = (e) => { if(e.key === 'Escape') close(null); if(e.key === 'Enter' && !e.target.matches('textarea')) $('#actionModalConfirm').click(); };
    $('#actionModalClose').onclick = () => close(null);
    $('#actionModalCancel').onclick = () => close(null);
    modal.onclick = (e) => { if(e.target === modal) close(null); };
    $('#actionModalConfirm').onclick = () => {
      const value = readValue(modal);
      const error = validate(value);
      if(error){ $('#actionModalError').textContent = error; return; }
      close(value);
    };
    modal.classList.remove('hidden');
    document.addEventListener('keydown', onKey);
    const first = modal.querySelector('textarea,input,button.primary');
    setTimeout(() => first?.focus(), 30);
  });
}
function confirmAction(opts){ return openActionModal(opts); }
function askImportance(current){
  return openActionModal({
    title: 'Edit importance',
    description: 'Set a value from 0.00 to 1.00. Higher importance makes this memory more likely to surface.',
    confirmText: 'Save importance',
    bodyHtml: `<label class="modal-field"><span>Importance</span><input id="modalImportance" type="number" min="0" max="1" step="0.01" value="${esc(Number(current ?? 0.5).toFixed(2))}" /></label>`,
    readValue: () => Number($('#modalImportance').value),
    validate: (v) => Number.isFinite(v) && v >= 0 && v <= 1 ? '' : 'Enter a number between 0.00 and 1.00.'
  });
}
function askReplacement(content){
  return openActionModal({
    title: 'Supersede memory',
    description: 'Create a corrected replacement memory and expire the old one. The original stays in history.',
    confirmText: 'Create replacement',
    tone: 'dangerish',
    bodyHtml: `<label class="modal-field"><span>Replacement memory content</span><textarea id="modalReplacement" rows="9">${esc(content || '')}</textarea></label>`,
    readValue: () => $('#modalReplacement').value.trim(),
    validate: (v) => v ? '' : 'Replacement content cannot be empty.'
  });
}
function askVeracity(current){
  const value = String(current || 'unknown').toLowerCase();
  return openActionModal({
    title: 'Set trust / veracity',
    description: 'Use this only after human review. Lifecycle hot/warm/cold stays automatic.',
    confirmText: 'Save trust',
    bodyHtml: `<label class="modal-field"><span>Trust / veracity</span><select id="modalVeracity">
      ${['stated','inferred','tool','imported','unknown'].map(v => `<option value="${v}"${v === value ? ' selected' : ''}>${v}</option>`).join('')}
    </select></label>`,
    readValue: () => $('#modalVeracity').value,
    validate: (v) => ['stated','inferred','tool','imported','unknown'].includes(v) ? '' : 'Choose a valid trust value.'
  });
}
function askExpiry(current){
  return openActionModal({
    title: 'Set expiry',
    description: 'Set valid_until as an ISO timestamp, or leave blank to clear expiry. Expire now remains the safer one-click option for wrong memories.',
    confirmText: 'Save expiry',
    bodyHtml: `<label class="modal-field"><span>Valid until</span><input id="modalExpiry" type="text" placeholder="2026-06-01T00:00:00" value="${esc(current || '')}" /></label><p class="muted">Blank means no scheduled expiry.</p>`,
    readValue: () => $('#modalExpiry').value.trim(),
    validate: (v) => {
      if(!v) return '';
      const d = Date.parse(v);
      return Number.isFinite(d) ? '' : 'Enter an ISO timestamp like 2026-06-01T00:00:00, or leave blank.';
    }
  });
}

function fmtBytes(n){
  n = Number(n || 0);
  if(!n) return '0 B';
  const units = ['B','KB','MB','GB'];
  let i = 0;
  while(n >= 1024 && i < units.length - 1){ n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}
function optionsFrom(rows, key, labelKey=key){
  const seen = new Set();
  return rows.map(r => ({value: r[key] || '', label: r[labelKey] || r[key] || 'unknown', count: r.count || 0}))
    .filter(o => o.value && !seen.has(o.value) && seen.add(o.value));
}
function fillSelect(sel, options, first){
  const current = sel.value;
  sel.innerHTML = `<option value="">${first}</option>` + options.map(o => `<option value="${esc(o.value)}">${esc(o.label)} (${o.count})</option>`).join('');
  if([...sel.options].some(o => o.value === current)) sel.value = current;
}
function breakdown(rows, labelKey, max=8){
  return rows.slice(0,max).map(r => `<div class="break-row" data-filter="${esc(r[labelKey] || '')}"><span>${esc(r[labelKey] || 'unknown')}</span><strong>${Number(r.count).toLocaleString()}</strong></div>`).join('') || '<p class="muted">No data</p>';
}
function closeMobileMenu(){
  document.body.classList.remove('mobile-menu-open');
  const menuToggle = $('#mobileMenuToggle');
  if(menuToggle) {
    menuToggle.setAttribute('aria-expanded', 'false');
    menuToggle.textContent = '☰';
  }
}
function closeMobileMenuForViewportChange(){
  const activeElement = document.activeElement;
  if(activeElement && activeElement.closest('.menu-search')) return;
  closeMobileMenu();
}
function showPanel(sectionId, panelId){
  const section = $(`#${sectionId}`);
  if(!section || !panelId) return;
  section.querySelectorAll('.subpanel').forEach(panel => panel.classList.toggle('active', panel.id === panelId));
  section.querySelectorAll('.section-tabs button').forEach(button => button.classList.toggle('active', button.dataset.panel === panelId));
}
function sectionFor(name){
  return ({ visualiser:'visualiser3d', palace:'memoryPalace', visualiserlegacy:'constellation', constellation:'constellation', recall:'explore', memories:'explore', history:'activity', timelineView:'activity', consolidations:'activity', triples:'graph', todayAdded:'today', todayRecalled:'today', todayTriples:'today', todayConsolidations:'today' })[name] || name;
}
function defaultPanelFor(section){
  return ({ explore:'exploreMemories', activity:'activityTimeline', graph:'graphGraph', today:'todayAdded' })[section];
}
function panelFor(name){
  return ({ memories:'exploreMemories', recall:'exploreRecall', history:'activityTimeline', timelineView:'activityTimeline', consolidations:'activityConsolidations', graph:'graphGraph', triples:'graphTriples', today:'todayAdded', todayAdded:'todayAdded', todayRecalled:'todayRecalled', todayTriples:'todayTriples', todayConsolidations:'todayConsolidations' })[name] || defaultPanelFor(name);
}
function stopCanvasVisualiserLoop(){
  if(constellationScene.frame) cancelAnimationFrame(constellationScene.frame);
  constellationScene.frame = 0;
  constellationScene.drag = null;
  constellationScene.pointers?.clear?.();
  constellationScene.lastFrameTime = 0;
  constellationScene.renderLastTime = 0;
}
function isCanvasVisualiserActive(){ return $('#constellation')?.classList.contains('active'); }
function visualiserResponsiveFill(width, height){
  const w = Math.max(0, Number(width) || 0);
  const h = Math.max(0, Number(height) || 0);
  if(w < 760 || h < 520) return 1;
  const widthFill = Math.max(0, Math.min(1, (w - 760) / 760));
  const heightFill = Math.max(0, Math.min(1, (h - 520) / 360));
  return 1 + Math.min(.22, (widthFill * .16) + (heightFill * .06));
}
async function toggleVisualiserFullscreen(selector){
  const el = $(selector);
  if(!el || !document.fullscreenEnabled) return;
  if(document.fullscreenElement === el) await document.exitFullscreen();
  else await el.requestFullscreen();
}
async function exitVisualiserFullscreen(event){
  event?.stopPropagation?.();
  if(document.fullscreenElement) await document.exitFullscreen();
}
function updateVisualiserFullscreenButtons(){
  const current = document.fullscreenElement;
  const legacy = current === $('.constellation-wrap');
  const three = current === $('#threeViewport');
  const palace = current === $('#palaceViewport');
  const legacyButton = $('#constellationFullscreen');
  const threeButton = $('#threeFullscreen');
  const palaceButton = $('#palaceFullscreen');
  if(legacyButton) legacyButton.textContent = legacy ? 'Exit fullscreen' : 'Fullscreen';
  if(threeButton) threeButton.textContent = three ? 'Exit fullscreen' : 'Fullscreen';
  if(palaceButton) palaceButton.textContent = palace ? 'Exit fullscreen' : 'Fullscreen';
  if(isCanvasVisualiserActive() && constellationScene.data) drawConstellation(constellationScene.data);
  if(threeVis.renderer) resizeThree();
  if(memoryPalace.renderer) resizeMemoryPalace();
}
function switchTab(name, opts={}){
  const section = sectionFor(name);
  if(section !== 'constellation') stopCanvasVisualiserLoop();
  if(section !== 'visualiser3d' && threeVis?.renderer) clearThreeScene();
  if(section !== 'memoryPalace' && memoryPalace?.renderer) clearPalaceScene();
  document.body.classList.toggle('compact-page', section !== 'overview');
  $$('.tab, nav button').forEach(x=>x.classList.remove('active'));
  $(`#${section}`).classList.add('active');
  const nav = document.querySelector(`nav button[data-tab="${canonicalTab(name)}"]`) || document.querySelector(`nav button[data-tab="${section}"]`);
  if(nav) nav.classList.add('active');
  showPanel(section, panelFor(name));
  closeDetail({ push:false });
  closeMobileMenu();
  currentRoute = routeTabState(name);
  if(opts.push !== false) pushRoute(currentRoute);
  if(name==='graph' || section==='graph') loadGraph();
  if(name==='triples') loadTriples();
  if(name==='consolidations') loadConsolidations();
  if(name==='memories') loadMemories();
  if(name==='search') loadGlobalSearch();
  if(name==='recall') loadRecallDebug();
  if(name==='timelineView' || section==='activity') loadTimeline();
  if(section==='today') loadTodayDigest();
  if(section==='profile') loadProfile();
  if(section==='review') loadReview();
  if(section==='lifecycle') loadLifecycle();
  if(section==='constellation') loadConstellation();
  if(section==='visualiser3d') loadThreeVisualiser();
  if(section==='memoryPalace') loadMemoryPalace();
  if(section==='settings') { loadAuthStatus(); loadDiagnostics(); loadRuntimeDiagnostics(); loadRealtimePanel(); }
  if(section==='memoria') loadMemoria();
}

async function loadStats(){
  const s = await api('/api/stats');
  $('#dbPath').textContent = s.db_path;
  $('#dbPath').title = s.db_path;
  const cards = [
    ['Working', s.counts.working_memory], ['Episodic', s.counts.episodic_memory], ['Needs review', s.contamination?.total || 0], ['Degraded', s.degradation?.degraded || 0], ['Triples', s.counts.triples], ['Consolidations', s.counts.consolidation_log]
  ];
  $('#cards').innerHTML = cards.map(([label,num]) => `<div class="card"><div class="num">${Number(num).toLocaleString()}</div><div class="label">${label}</div></div>`).join('');
  $('#sourceBreakdown').innerHTML = breakdown(s.by_source, 'source');
  $('#scopeBreakdown').innerHTML = breakdown(s.by_scope, 'scope');
  $('#sessionBreakdown').innerHTML = breakdown(s.by_session, 'session_id', 6);
  $('#veracityBreakdown').innerHTML = breakdown(s.by_veracity || [], 'veracity', 8);
  $('#degradationBreakdown').innerHTML = breakdown(s.by_degradation || [], 'degradation_label', 8);
  fillSelect($('#memorySource'), optionsFrom(s.by_source, 'source'), 'all sources');
  fillSelect($('#memoryScope'), optionsFrom(s.by_scope, 'scope'), 'all scopes');
  fillSelect($('#memorySession'), optionsFrom(s.by_session, 'session_id'), 'all sessions');
  bindBreakdownClicks();
  loadLiveMemoryStream(false);
}
function renderRealtimeStatus(){
  // Realtime diagnostics belong in Settings, not the Overview hero.
}
function sortRealtimeEventsNewestFirst(events){
  return [...events].sort((a,b) => Date.parse(b.timestamp || 0) - Date.parse(a.timestamp || 0));
}
function renderLiveMemoryStream(){
  const list = $('#liveMemoryStream');
  if(!list) return;
  list.innerHTML = liveMemoryItems.length ? liveMemoryItems.map(memoryItem).join('') : stateHtml('empty', 'No memories found.', 'The memory stream will appear here once memories exist.');
  bindMemoryClicks($('#liveMemoryStream'));
  const status = $('#liveMemoryStatus');
  if(status){
    status.textContent = liveMemoryLoading ? 'Loading older memories…' : liveMemoryHasMore ? 'Scroll to load older memories.' : 'End of memory stream.';
  }
}
async function loadLiveMemoryStream(append=false){
  if(liveMemoryLoading) return;
  if(append && !liveMemoryHasMore) return;
  liveMemoryLoading = true;
  renderLiveMemoryStream();
  if(!append){ liveMemoryItems = []; liveMemoryOffset = 0; liveMemoryHasMore = true; }
  const params = new URLSearchParams({
    kind: 'all',
    status: 'active',
    sort: 'recent',
    limit: String(LIVE_MEMORY_PAGE_SIZE),
    offset: String(liveMemoryOffset),
  });
  try {
    const data = await api(`/api/memories?${params.toString()}`);
    const items = data.items || [];
    const seen = new Set(liveMemoryItems.map(item => item.id));
    liveMemoryItems = append ? [...liveMemoryItems, ...items.filter(item => !seen.has(item.id))] : items;
    liveMemoryOffset += items.length;
    liveMemoryHasMore = items.length === LIVE_MEMORY_PAGE_SIZE;
  } finally {
    liveMemoryLoading = false;
    renderLiveMemoryStream();
  }
}
function initLiveMemoryInfiniteScroll(){
  const sentinel = $('#liveMemorySentinel');
  if(!sentinel) return;
  if(liveMemoryObserver) liveMemoryObserver.disconnect();
  if(!('IntersectionObserver' in window)){
    window.addEventListener('scroll', () => {
      if(liveMemoryHasMore && !liveMemoryLoading && window.innerHeight + window.scrollY >= document.body.offsetHeight - 700) loadLiveMemoryStream(true);
    }, {passive:true});
    return;
  }
  liveMemoryObserver = new IntersectionObserver(entries => {
    if(entries.some(entry => entry.isIntersecting)) loadLiveMemoryStream(true);
  }, {rootMargin:'700px 0px'});
  liveMemoryObserver.observe(sentinel);
}
function addLiveMemoryEvent(event){
  if(!event || !event.memory_id) return;
  const existing = liveMemoryItems.find(item => item.id === event.memory_id);
  if(existing && event.event_type === 'MEMORY_SNAPSHOT') return;
  const item = {
    ...(existing || {}),
    id: event.memory_id,
    content: event.content || existing?.content || '',
    source: event.source || existing?.source || '',
    timestamp: event.timestamp || existing?.timestamp || '',
    created_at: event.timestamp || existing?.created_at || '',
    importance: event.importance ?? existing?.importance ?? 0,
    veracity: event.veracity || existing?.veracity || 'unknown',
    memory_kind: event.memory_kind || existing?.memory_kind || 'memory',
    status: event.status || existing?.status || 'active',
    live_event_type: event.event_type || 'MEMORY_ADDED',
  };
  if(event.event_type === 'MEMORY_INVALIDATED'){
    liveMemoryItems = liveMemoryItems.map(existingItem => existingItem.id === item.id ? item : existingItem);
  } else {
    liveMemoryItems = [item, ...liveMemoryItems.filter(existingItem => existingItem.id !== item.id)];
  }
  renderLiveMemoryStream();
}
function renderRealtimeEvents(){
  const feeds = ['#liveEventFeed', '#realtimeEventFeed'].map(sel => $(sel)).filter(Boolean);
  if(!feeds.length) return;
  const orderedEvents = sortRealtimeEventsNewestFirst(realtimeState.events);
  const html = orderedEvents.length ? orderedEvents.slice(0, 20).map(ev => {
    const kind = ev.memory_kind || 'memory';
    const label = ev.event_type || 'MEMORY_EVENT';
    const when = ev.timestamp ? prettyTime(ev.timestamp) : 'just now';
    const source = ev.source ? `<span class="badge">${esc(ev.source)}</span>` : '';
    return `<div class="realtime-event" data-memory-id="${esc(ev.memory_id || '')}" tabindex="0" role="button"><div><strong>${esc(label)}</strong> <span class="muted">${esc(kind)}</span></div><div class="meta"><span class="badge">${esc(shortId(ev.memory_id || 'unknown'))}</span><span class="badge trust-${esc(ev.veracity || 'unknown')}">${esc(ev.veracity || 'unknown')}</span>${source}<span class="meta-time">${esc(when)}</span></div><div class="content realtime-content">${esc(ev.content || '')}</div></div>`;
  }).join('') : '<div class="state-empty">Waiting for memory events…</div>';
  feeds.forEach(feed => {
    feed.innerHTML = html;
    feed.querySelectorAll('.realtime-event').forEach(row => {
      row.onclick = () => openMemoryDetail(row.dataset.memoryId || '');
      row.onkeydown = e => { if(e.key === 'Enter' || e.key === ' ') openMemoryDetail(row.dataset.memoryId || ''); };
    });
  });
}
function renderRealtimePanel(){
  const status = realtimeState.status || {};
  const cards = [
    ['Streaming', status.streaming_supported ? 'Ready' : 'Unavailable'],
    ['DeltaSync', status.deltasync_supported ? 'Ready' : 'Unavailable'],
    ['Installed package', status.mnemosyne_version || 'unknown'],
    ['Realtime API', status.realtime_generation || 'unknown'],
    ['Events', status.snapshot_event_count || 0],
  ];
  const delta = $('#settingsDeltaSync');
  if(delta) delta.innerHTML = cards.map(([label,num]) => `<div class="realtime-kv"><strong>${esc(label)}</strong><span>${esc(num)}</span></div>`).join('') + `<div class="realtime-kv"><strong>Transport</strong><span>${esc(status.transport || 'sse')}</span></div><div class="realtime-kv"><strong>Tables</strong><span>${esc((status.deltasync_tables || []).join(', ') || 'none')}</span></div><div class="realtime-kv"><strong>DeltaSync methods</strong><span>${esc((status.deltasync_methods || []).join(', ') || 'none')}</span></div><div class="realtime-kv"><strong>Event types</strong><span>${esc((status.event_types || []).join(', ') || 'none')}</span></div><div class="realtime-kv"><strong>Payload policy</strong><span>${esc(status.payload_policy || 'private dashboard payload')}</span></div><div class="realtime-kv"><strong>DB modified</strong><span>${esc(status.db_modified_at || '')}</span></div>`;
}
function runtimeRow(label, value, opts={}){
  const safe = value === undefined || value === null || value === '' ? '—' : value;
  return `<div class="diag-row ${opts.wide ? 'wide' : ''}"><span>${esc(label)}</span><strong title="${esc(safe)}">${esc(safe)}</strong></div>`;
}
function renderRuntimeDiagnostics(runtime){
  const el = $('#runtimeDiagnostics');
  if(!el) return;
  const probe = runtime.probe || {};
  const cfg = runtime.config || {};
  const health = runtime.running && runtime.reachable && !runtime.stale_pid && !runtime.runtime_stale ? 'Healthy' : 'Needs attention';
  const started = runtime.started_at ? prettyTime(Number(runtime.started_at) * 1000) : '';
  el.innerHTML = [
    runtimeRow('Status', health),
    runtimeRow('PID', runtime.pid),
    runtimeRow('PID file', runtime.pid_file_pid),
    runtimeRow('Listener PID', (runtime.listener_pids || []).join(', ') || 'none'),
    runtimeRow('Launch source', runtime.runtime_source || 'server.py'),
    runtimeRow('Stale PID', runtime.stale_pid ? 'yes — repaired on restart/start' : 'no'),
    runtimeRow('Runtime stale', runtime.runtime_stale ? 'yes' : 'no'),
    runtimeRow('Probe', `${probe.status || 'n/a'} ${probe.url || ''}`, {wide:true}),
    runtimeRow('Local URL', cfg.local_url || '', {wide:true}),
    runtimeRow('LAN URL', cfg.lan_url || 'not exposed', {wide:true}),
    runtimeRow('Started', started || runtime.started_at || '', {wide:true}),
  ].join('');
}
async function loadRuntimeDiagnostics(){
  try {
    renderRuntimeDiagnostics(await api('/api/runtime/status'));
  } catch(e) {
    const el = $('#runtimeDiagnostics');
    if(el) el.innerHTML = `<div class="state-card state-error"><strong>Runtime diagnostics unavailable</strong><p>${esc(e.message)}</p></div>`;
  }
}
async function loadRealtimePanel(){
  try {
    realtimeState.status = await api('/api/realtime/status');
    renderRealtimeStatus();
    renderRealtimePanel();
  } catch(e) {
    const delta = $('#settingsDeltaSync');
    if(delta) delta.innerHTML = `<div class="state-card state-error"><strong>Sync diagnostics unavailable</strong><p>${esc(e.message)}</p></div>`;
  }
}
function addRealtimeEvent(event){
  if(realtimeState.paused) return;
  if(!event || !event.memory_id) return;
  realtimeState.events = sortRealtimeEventsNewestFirst([event, ...realtimeState.events.filter(e => `${e.event_type}:${e.memory_id}:${e.timestamp}` !== `${event.event_type}:${event.memory_id}:${event.timestamp}`)]).slice(0, 50);
  renderRealtimeEvents();
  addLiveMemoryEvent(event);
}
function toggleLiveUpdates(){
  realtimeState.paused = !realtimeState.paused;
  renderRealtimeStatus();
  renderRealtimePanel();
}
async function initRealtime(){
  try {
    realtimeState.status = await api('/api/realtime/status');
    renderRealtimeStatus();
    renderRealtimeEvents();
  } catch(e) {
    return;
  }
  if(!('EventSource' in window)) return;
  if(realtimeState.source) realtimeState.source.close();
  const source = new EventSource('/api/realtime/events?limit=25');
  realtimeState.source = source;
  source.addEventListener('status', e => { realtimeState.status = JSON.parse(e.data); renderRealtimeStatus(); });
  source.addEventListener('memory', e => addRealtimeEvent(JSON.parse(e.data)));
}
function bindBreakdownClicks(){
  $$('#sourceBreakdown .break-row').forEach(row => row.onclick = () => { $('#memorySource').value = row.dataset.filter || ''; switchTab('memories'); });
  $$('#scopeBreakdown .break-row').forEach(row => row.onclick = () => { $('#memoryScope').value = row.dataset.filter || ''; switchTab('memories'); });
  $$('#veracityBreakdown .break-row').forEach(row => row.onclick = () => { $('#memoryVeracity').value = row.dataset.filter || ''; switchTab('memories'); });
  $$('#degradationBreakdown .break-row').forEach(row => row.onclick = () => { const map={hot:'1',warm:'2',cold:'3'}; $('#memoryDegradation').value = map[row.dataset.filter] || ''; switchTab('memories'); });
  $$('#sessionBreakdown .break-row').forEach(row => row.onclick = () => openSessionDetail(row.dataset.filter || ''));
}
async function loadMemories(){
  const trustPreset = $('#memoryTrustPreset').value;
  const params = new URLSearchParams({
    kind: $('#memoryKind').value,
    q: $('#memoryQuery').value.trim(),
    source: $('#memorySource').value,
    scope: $('#memoryScope').value,
    session_id: $('#memorySession').value,
    veracity: $('#memoryVeracity').value,
    degradation_tier: $('#memoryDegradation').value,
    contaminated_only: trustPreset === 'contaminated' ? '1' : '',
    degraded_only: trustPreset === 'degraded' ? '1' : '',
    due_for_degradation: trustPreset === 'due' ? '1' : '',
    status: $('#memoryStatus').value,
    sort: $('#memorySort').value,
    limit: '150'
  });
  const data = await api(`/api/memories?${params.toString()}`);
  latestMemoryItems = data.items || [];
  $('#memoryList').innerHTML = latestMemoryItems.map(item => memoryItem(item, {selectable:true})).join('') || stateHtml('empty', 'No memories found.', 'Try clearing filters or broadening the memory content search.');
  bindMemoryClicks($('#memoryList'));
  bindBulkMemoryControls();
  updateBulkBar();
}
function updateBulkBar(){
  const bar = $('#bulkMemoryBar');
  if(!bar) return;
  const admin = canAdmin();
  bar.classList.toggle('hidden', !latestMemoryItems.length);
  const actionable = latestMemoryItems.filter(x => bulkSelection.has(x.id) && isMutableMemory(x)).length;
  $('#bulkSelectionStatus').textContent = `${bulkSelection.size} selected · ${actionable} active`;
  $('#bulkExpire').disabled = !admin || !actionable;
  $('#bulkVeracity').disabled = !admin || !actionable;
  $('#bulkExpiry').disabled = !admin || !actionable;
  $('#bulkImportance').disabled = !admin || !actionable;
  $('#bulkSelectAll').checked = latestMemoryItems.length > 0 && latestMemoryItems.every(x => bulkSelection.has(x.id));
  $('#bulkSelectAll').disabled = !latestMemoryItems.length;
}
function bindBulkMemoryControls(){
  $$('#memoryList .memory-check').forEach(chk => chk.onchange = e => { e.stopPropagation(); chk.checked ? bulkSelection.add(chk.dataset.id) : bulkSelection.delete(chk.dataset.id); updateBulkBar(); });
}
async function expireSelectedMemories(){
  const ids = latestMemoryItems.filter(x => bulkSelection.has(x.id) && isMutableMemory(x)).map(x => x.id);
  if(!ids.length) return;
  const ok = await confirmAction({title:'Expire selected memories?', description:`Expire ${ids.length} selected active memories. Backups and audit entries will be created.`, confirmText:'Expire selected', tone:'warn'});
  if(!ok) return;
  for(const id of ids) await postJson('/api/admin/memory/invalidate', {memory_id:id, backup: $('#backupBeforeMutation') ? $('#backupBeforeMutation').checked : true});
  bulkSelection.clear(); await loadStats(); await loadMemories();
}
async function setSelectedImportance(){
  const ids = latestMemoryItems.filter(x => bulkSelection.has(x.id) && isMutableMemory(x)).map(x => x.id);
  if(!ids.length) return;
  const v = await askImportance(0.5);
  if(v === null) return;
  for(const id of ids) await postJson('/api/admin/memory/importance', {memory_id:id, importance:Number(v), backup: $('#backupBeforeMutation') ? $('#backupBeforeMutation').checked : true});
  bulkSelection.clear(); await loadStats(); await loadMemories();
}
async function setSelectedVeracity(){
  const ids = latestMemoryItems.filter(x => bulkSelection.has(x.id) && isMutableMemory(x)).map(x => x.id);
  if(!ids.length) return;
  const v = await askVeracity('stated');
  if(v === null) return;
  for(const id of ids) await postJson('/api/admin/memory/veracity', {memory_id:id, veracity:v, backup: $('#backupBeforeMutation') ? $('#backupBeforeMutation').checked : true});
  bulkSelection.clear(); await loadStats(); await loadMemories();
}
async function setSelectedExpiry(){
  const ids = latestMemoryItems.filter(x => bulkSelection.has(x.id) && isMutableMemory(x)).map(x => x.id);
  if(!ids.length) return;
  const v = await askExpiry('');
  if(v === null) return;
  for(const id of ids) await postJson('/api/admin/memory/expiry', {memory_id:id, valid_until:v, backup: $('#backupBeforeMutation') ? $('#backupBeforeMutation').checked : true});
  bulkSelection.clear(); await loadStats(); await loadMemories();
}
function bindMemoryClicks(root){
  root.querySelectorAll('.session-link').forEach(btn => btn.onclick = (e) => { e.stopPropagation(); openSessionDetail(btn.dataset.session || ''); });
  root.querySelectorAll('.item[data-id]').forEach(el => el.onclick = (e) => { if(e.target.closest('.session-link,button,a,label,input')) return; openMemoryDetail(el.dataset.id); });
}
function canAdmin(){ const cfg = authState.config || {}; const localOnly = ['127.0.0.1','localhost','::1'].includes(cfg.host || '0.0.0.0'); return !!(cfg.memory_admin_enabled && (localOnly || (authState.auth_enabled && authState.authenticated))); }
function isMutableMemory(item){ return String(item?.status || 'active').toLowerCase() === 'active'; }
function whyMemoryHtml(item){
  const reasons = [];
  const q = $('#memoryQuery')?.value.trim();
  const source = $('#memorySource')?.value;
  const scope = $('#memoryScope')?.value;
  const session = $('#memorySession')?.value;
  const status = $('#memoryStatus')?.value;
  const veracity = $('#memoryVeracity')?.value;
  const degradation = $('#memoryDegradation')?.value;
  const trustPreset = $('#memoryTrustPreset')?.value;
  const sort = $('#memorySort')?.value;
  if(q) reasons.push(`matches browser query “${q}” across content, id, session, source, or scope`);
  if(source && item.source === source) reasons.push(`source filter matched ${source}`);
  if(scope && item.scope === scope) reasons.push(`scope filter matched ${scope}`);
  if(session && item.session_id === session) reasons.push(`session filter matched ${session}`);
  if(veracity && item.veracity === veracity) reasons.push(`trust filter matched ${veracity}`);
  if(degradation && String(item.degradation_tier || '') === String(degradation)) reasons.push(`lifecycle filter matched tier ${degradation}`);
  if(trustPreset === 'contaminated' && item.contaminated) reasons.push('needs-review filter matched');
  if(trustPreset === 'degraded' && item.degraded_at) reasons.push('degraded-only filter matched');
  if(!reasons.length) reasons.push('shown from the current list/search context');
  return `<div class="result-section why-panel"><h3>Why shown <span>${esc(item.status || 'active')}</span></h3><div class="diag-grid compact">
    <div class="diag-row"><span>Reason</span><strong>${esc(reasons.join(' · '))}</strong></div>
    <div class="diag-row"><span>Ranking</span><strong>${esc(sort || 'recent')} · importance ${Number(item.importance ?? 0).toFixed(2)} · recalled ${Number(item.recall_count || 0).toLocaleString()}×</strong></div>
    <div class="diag-row"><span>Freshness</span><strong>created ${esc(prettyTime(item.created_at) || item.created_at || 'unknown')} · last recalled ${esc(prettyTime(item.last_recalled) || item.last_recalled || 'never')}</strong></div>
    <div class="diag-row"><span>Origin</span><strong>${esc(item.memory_kind || item.tier || 'memory')} · ${esc(item.source || 'unknown source')} · ${esc(item.scope || 'unknown scope')}</strong></div>
  </div></div>`;
}
function memoryDetailHtml(item){
  const admin = canAdmin();
  const mutable = isMutableMemory(item);
  const adminActions = admin && mutable ? '<button id="expireMemory" class="drawer-action warn">Expire now</button><button id="editVeracity" class="drawer-action">Set trust</button><button id="editExpiry" class="drawer-action">Set expiry</button><button id="editImportance" class="drawer-action">Edit importance</button><button id="supersedeMemory" class="drawer-action primary">Supersede</button>' : '';
  const actionNote = admin ? (mutable ? '' : `<span class="muted">This memory is ${esc(item.status || 'not active')}; mutation actions are disabled.</span>`) : '<span class="muted">Enable Settings → Memory maintenance to modify memories.</span>';
  const trust = String(item.veracity || 'unknown').toLowerCase();
  const lifecycle = item.degradation_label ? `${item.degradation_label} · tier ${item.degradation_tier}` : 'not degraded';
  return `
    <div class="memory-detail">
      ${meta(item, {sessionLink:false})}
      <div class="content detail-content">${esc(item.content)}</div>
      <div class="trust-strip">
        <span class="trust-chip trust-${esc(trust)}">${esc(trust)} trust · ×${Number(item.trust_weight ?? 0).toFixed(2)}</span>
        <span class="trust-chip lifecycle-${esc(item.degradation_label || 'none')}">${esc(lifecycle)}${item.degradation_weight != null ? ` · ×${Number(item.degradation_weight).toFixed(2)}` : ''}</span>
        <span class="trust-chip">effective ×${Number(item.effective_memory_weight ?? 0).toFixed(2)}</span>
        ${item.contaminated ? '<span class="trust-chip review">needs review</span>' : ''}
      </div>
      ${whyMemoryHtml(item)}
      <div class="diag-grid compact">
        <div class="diag-row"><span>ID</span><strong>${esc(item.id)}</strong></div>
        <div class="diag-row"><span>Session</span>${item.session_id && item.session_id !== 'default' ? `<button id="memorySessionLink" class="diag-link" title="Open session: ${esc(item.session_id)}">${esc(item.session_id)}</button>` : `<strong>${esc(item.session_id || 'default')}</strong>`}</div>
        <div class="diag-row"><span>Source</span><strong>${esc(item.source || 'unknown')}</strong></div>
        <div class="diag-row"><span>Trust</span><strong>${esc(trust)} · recall weight ×${Number(item.trust_weight ?? 0).toFixed(2)}${item.contaminated ? ' · review recommended' : ''}</strong></div>
        <div class="diag-row"><span>Lifecycle</span><strong>${esc(lifecycle)} · degraded ${esc(item.degraded_at || 'never')} · recall weight ×${Number(item.degradation_weight ?? 1).toFixed(2)}</strong></div>
        <div class="diag-row"><span>Effective weight</span><strong>×${Number(item.effective_memory_weight ?? 0).toFixed(2)}</strong></div>
        <div class="diag-row"><span>Valid until</span><strong>${esc(item.valid_until || 'none')}</strong></div>
        <div class="diag-row"><span>Superseded by</span><strong>${esc(item.superseded_by || 'none')}</strong></div>
      </div>
      <div class="drawer-actions memory-actions">
        <button id="copyMemoryId" class="drawer-action">Copy ID</button>
        ${adminActions}${actionNote}
      </div>
      <p id="memoryActionStatus" class="muted"></p>
    </div>`;
}
async function openMemoryDetail(memoryId, opts={}){
  await refreshAuthState();
  const item = (await api('/api/memory?id=' + encodeURIComponent(memoryId))).item;
  showHtmlDetail(memoryDetailHtml(item), 'Memory detail');
  if(opts.push !== false) pushRoute({ ...routeTabState(), drawer:{ type:'memory', id:memoryId } });
  const sessionLink = $('#memorySessionLink');
  if(sessionLink) sessionLink.onclick = () => openSessionDetail(item.session_id || '');
  $('#copyMemoryId').onclick = () => showSelectableCopy('Memory ID', item.id);
  if(!canAdmin() || !isMutableMemory(item)) return;
  const backup = () => $('#backupBeforeMutation') ? $('#backupBeforeMutation').checked : true;
  $('#expireMemory').onclick = async () => {
    const ok = await confirmAction({
      title: 'Expire this memory?',
      description: 'It will disappear from active recall, but the original record stays available for history and audit.',
      confirmText: 'Expire memory',
      tone: 'warn'
    });
    if(!ok) return;
    try { const r = await postJson('/api/admin/memory/invalidate', {memory_id:item.id, backup: backup()}); $('#memoryActionStatus').textContent = `Expired. Backup: ${r.backup?.path || 'not created'}`; await loadMemories(); await openMemoryDetail(item.id); }
    catch(e){ $('#memoryActionStatus').textContent = e.message; }
  };
  $('#editImportance').onclick = async () => {
    const v = await askImportance(item.importance ?? 0.5);
    if(v === null) return;
    try { const r = await postJson('/api/admin/memory/importance', {memory_id:item.id, importance:Number(v), backup: backup()}); $('#memoryActionStatus').textContent = `Importance updated to ${r.importance}.`; await loadStats(); await loadMemories(); await openMemoryDetail(item.id); }
    catch(e){ $('#memoryActionStatus').textContent = e.message; }
  };
  $('#editVeracity').onclick = async () => {
    const v = await askVeracity(item.veracity || 'unknown');
    if(v === null) return;
    try { const r = await postJson('/api/admin/memory/veracity', {memory_id:item.id, veracity:v, backup: backup()}); $('#memoryActionStatus').textContent = `Trust updated to ${r.veracity}.`; await loadStats(); await loadMemories(); await openMemoryDetail(item.id); }
    catch(e){ $('#memoryActionStatus').textContent = e.message; }
  };
  $('#editExpiry').onclick = async () => {
    const v = await askExpiry(item.valid_until || '');
    if(v === null) return;
    try { const r = await postJson('/api/admin/memory/expiry', {memory_id:item.id, valid_until:v, backup: backup()}); $('#memoryActionStatus').textContent = `Expiry ${r.valid_until ? `set to ${r.valid_until}` : 'cleared'}.`; await loadStats(); await loadMemories(); await openMemoryDetail(item.id); }
    catch(e){ $('#memoryActionStatus').textContent = e.message; }
  };
  $('#supersedeMemory').onclick = async () => {
    const replacement = await askReplacement(item.content || '');
    if(replacement === null) return;
    try { const r = await postJson('/api/admin/memory/supersede', {memory_id:item.id, content:replacement, importance:Number(item.importance ?? 0.5), backup: backup()}); $('#memoryActionStatus').textContent = `Superseded by ${r.replacement_id}.`; $('#memoryStatus').value = 'all'; await loadStats(); await loadMemories(); await openMemoryDetail(r.replacement_id); }
    catch(e){ $('#memoryActionStatus').textContent = e.message; }
  };
}
function sessionEvent(e){ return `<div class="session-event" data-json='${esc(JSON.stringify(e.item))}'><div class="meta"><span class="badge">${esc(e.type)}</span><span>${esc(e.timestamp || '')}</span></div><div class="content"><strong>${esc(e.title)}</strong><br>${esc(e.preview || '')}</div></div>`; }
async function openSessionDetail(sessionId, opts={}){
  if(!sessionId || sessionId === 'unknown') return;
  const data = await api(`/api/session?id=${encodeURIComponent(sessionId)}&limit=200`);
  const c = data.counts || {};
  showHtmlDetail(`
    <div class="session-summary">
      <div class="diag-pill"><strong>${esc(c.memories || 0)}</strong><span>memories</span></div>
      <div class="diag-pill"><strong>${esc(c.triples || 0)}</strong><span>triples</span></div>
      <div class="diag-pill"><strong>${esc(c.consolidations || 0)}</strong><span>consolidations</span></div>
    </div>
    <div class="drawer-actions session-actions"><button id="sessionBrowseMemories" class="drawer-action primary">Browse memories</button><button id="sessionTimeline" class="drawer-action">Timeline by session</button><button id="sessionCopy" class="drawer-action">Copy session ID</button></div>
    <div class="result-section"><h3>Timeline <span>${esc(c.events || 0)}</span></h3><div class="timeline">${(data.events || []).map(sessionEvent).join('') || '<p class="muted">No events for this session.</p>'}</div></div>
  `, `Session ${sessionId}`);
  if(opts.push !== false) pushRoute({ ...routeTabState(), drawer:{ type:'session', id:sessionId } });
  $('#sessionBrowseMemories').onclick = () => { $('#memorySession').value = sessionId; $('#memoryKind').value = 'all'; $('#memoryQuery').value = ''; switchTab('memories'); closeDetail({ push:false }); };
  $('#sessionTimeline').onclick = () => { $('#timelineGroup').value = 'session'; $('#timelineQuery').value = sessionId; switchTab('timelineView'); closeDetail({ push:false }); };
  $('#sessionCopy').onclick = () => showSelectableCopy('Session ID', sessionId);
  $$('#detailBody .session-event').forEach(el => el.onclick = () => showDetail(JSON.parse(el.dataset.json), 'Session event detail'));
}
async function loadTriples(){
  const q = encodeURIComponent($('#tripleQuery').value.trim());
  const data = await api(`/api/triples?q=${q}&limit=300`);
  $('#tripleRows').innerHTML = data.items.map(t => `<tr class="triple-row" data-triple='${esc(JSON.stringify(t))}'><td>${esc(t.subject)}</td><td>${esc(t.predicate)}</td><td>${esc(t.object)}</td><td>${esc(t.confidence ?? '')}</td></tr>`).join('') || '<tr><td colspan="4" class="empty-cell">No triples found.</td></tr>';
  $$('#tripleRows .triple-row').forEach(row => row.onclick = () => showDetail(JSON.parse(row.dataset.triple), 'Triple detail'));
}

function consolidationItem(c){
  return `<div class="item consolidation-item" data-consolidation='${esc(JSON.stringify(c))}'>
    <div class="meta"><span class="badge">${esc(c.session_id || 'unknown session')}</span><span class="badge">${esc(c.items_consolidated)} items</span><span>${esc(c.created_at)}</span></div>
    <div class="content">${esc(c.summary_preview)}</div>
    <div class="item-actions"><button class="tiny inspect-consolidation">Inspect</button><button class="tiny view-session" data-session="${esc(c.session_id || '')}">View session memories</button></div>
  </div>`;
}
function renderConsolidations(){
  const q = ($('#consolidationQuery')?.value || '').trim().toLowerCase();
  const rows = q ? consolidationState.filter(c => `${c.session_id || ''} ${c.summary_preview || ''} ${c.created_at || ''}`.toLowerCase().includes(q)) : consolidationState;
  $('#consolidationList').innerHTML = rows.map(consolidationItem).join('') || '<p class="muted">No consolidations found.</p>';
  $$('#consolidationList .consolidation-item').forEach(el => {
    const data = JSON.parse(el.dataset.consolidation);
    el.onclick = (e) => { if(e.target.closest('button')) return; showDetail(data, 'Consolidation detail'); };
    el.querySelector('.inspect-consolidation').onclick = () => showDetail(data, 'Consolidation detail');
    el.querySelector('.view-session').onclick = () => openSessionDetail(data.session_id || '');
  });
}
async function loadConsolidations(){
  const data = await api('/api/consolidations?limit=200');
  consolidationState = data.items;
  renderConsolidations();
}

function searchMemoryCard(m){ return memoryItem(m); }
function tripleCard(t){ return `<div class="item" data-json='${esc(JSON.stringify(t))}'><div class="meta"><span class="badge">fact</span><span>${esc(t.created_at || t.valid_from || '')}</span></div><div class="content"><strong>${esc(t.subject)}</strong> — ${esc(t.predicate)} → <strong>${esc(t.object)}</strong></div></div>`; }
function consolidationCard(c){ return `<div class="item" data-json='${esc(JSON.stringify(c))}'><div class="meta"><span class="badge">consolidation</span><span class="badge">${esc(c.items_consolidated)} items</span><span>${esc(c.created_at)}</span></div><div class="content">${esc(c.session_id || '')}: ${esc(c.summary_preview || '')}</div></div>`; }
function bindJsonCards(root, title){ root.querySelectorAll('[data-json]').forEach(el => el.onclick = () => showDetail(JSON.parse(el.dataset.json), title)); }
function stateHtml(kind, title, body=''){
  return `<div class="state-card state-${esc(kind)}"><strong>${esc(title)}</strong>${body ? `<p>${esc(body)}</p>` : ''}</div>`;
}
function countLabel(n, noun){ return `${Number(n || 0).toLocaleString()} ${noun}${Number(n || 0) === 1 ? '' : 's'}`; }
async function runSearchFromInput(inputId){
  const q = $(inputId)?.value.trim() || '';
  if(!q) return;
  $('#globalSearchQuery').value = q;
  switchTab('search');
  await loadGlobalSearch();
}
async function menuSearch(){ await runSearchFromInput('#menuSearchQuery'); }
async function loadGlobalSearch(){
  const q = $('#globalSearchQuery')?.value.trim() || '';
  if(!q){ $('#globalSearchResults').innerHTML = stateHtml('empty', 'Search from the sidebar or type a query above.', 'Search looks across memories, facts, and consolidations.'); return; }
  $('#globalSearchResults').innerHTML = stateHtml('loading', 'Searching memory…', q);
  try{
    const data = await api(`/api/search?q=${encodeURIComponent(q)}&limit=30`);
    const memories = data.memories || [];
    const triples = data.triples || [];
    const consolidations = data.consolidations || [];
    const total = memories.length + triples.length + consolidations.length;
    $('#globalSearchResults').innerHTML = `
      <div class="search-summary glass"><h3>Search results for “${esc(q)}”</h3><p>${countLabel(total, 'result')} · ${countLabel(memories.length, 'memory')} · ${countLabel(triples.length, 'fact')} · ${countLabel(consolidations.length, 'consolidation')}</p></div>
      ${total ? '' : stateHtml('empty', 'No results found.', 'Try broader terms, a person/project name, or search inside Memories for record-only filters.')}
      <div class="result-section"><h3>Memories <span>${memories.length}</span></h3><div class="memory-grid">${memories.map(searchMemoryCard).join('') || stateHtml('empty', 'No memory records matched.')}</div></div>
      <div class="result-section"><h3>Facts <span>${triples.length}</span></h3><div class="memory-grid">${triples.map(tripleCard).join('') || stateHtml('empty', 'No graph facts matched.')}</div></div>
      <div class="result-section"><h3>Consolidations <span>${consolidations.length}</span></h3><div class="memory-grid">${consolidations.map(consolidationCard).join('') || stateHtml('empty', 'No consolidation summaries matched.')}</div></div>`;
    bindMemoryClicks($('#globalSearchResults'));
    bindJsonCards($('#globalSearchResults'), 'Search result detail');
  }catch(e){
    $('#globalSearchResults').innerHTML = stateHtml('error', 'Search failed.', e.message || 'The dashboard could not load search results.');
  }
}
function recallItem(x){
  const m = x.memory;
  return `<div class="item" data-id="${esc(m.id)}"><div class="meta"><span class="badge">score ${esc(x.approx_score)}</span></div>${meta(m)}<div class="content">${esc(m.content)}</div><div class="reasons">${x.reasons.map(r=>`<span>${esc(r)}</span>`).join('')}</div></div>`;
}
async function loadRecallDebug(){
  const q = $('#recallQuery')?.value.trim() || '';
  if(!q){ $('#recallNote').textContent = 'Type a query to explain approximate recall ranking.'; $('#recallResults').innerHTML = ''; return; }
  const data = await api(`/api/recall-debug?q=${encodeURIComponent(q)}&limit=30`);
  $('#recallNote').textContent = data.note;
  $('#recallResults').innerHTML = data.items.map(recallItem).join('') || '<p class="muted">No matching memories.</p>';
  bindMemoryClicks($('#recallResults'));
}
function timelineEvent(e){ return `<div class="timeline-event item" data-json='${esc(JSON.stringify(e.item))}'><div class="meta"><span class="badge">${esc(e.type)}</span><button class="session-chip" data-session="${esc(e.session_id || '')}">${esc(e.session_id || 'no session')}</button><span>${esc(e.timestamp)}</span></div><div class="content"><strong>${esc(e.title)}</strong><br>${esc(e.preview)}</div></div>`; }
async function loadTimeline(){
  const q = $('#timelineQuery')?.value.trim() || '';
  const group = $('#timelineGroup')?.value || 'day';
  const data = await api(`/api/timeline?q=${encodeURIComponent(q)}&group=${encodeURIComponent(group)}&limit=300`);
  $('#timelineResults').innerHTML = data.groups.map(g => `<div class="timeline-group"><div class="section-head mini"><h2>${esc(g.key)}</h2><span>${g.count} events</span>${group === 'session' && g.key !== 'no session' ? `<button class="tiny open-session" data-session="${esc(g.key)}">Open session</button>` : ''}</div><div class="timeline">${g.events.map(timelineEvent).join('')}</div></div>`).join('') || '<p class="muted">No timeline events.</p>';
  bindJsonCards($('#timelineResults'), 'Timeline event detail');
  $$('#timelineResults .session-chip').forEach(btn => btn.onclick = (e) => { e.stopPropagation(); openSessionDetail(btn.dataset.session || ''); });
  $$('#timelineResults .open-session').forEach(btn => btn.onclick = () => openSessionDetail(btn.dataset.session || ''));
}
function tinyRows(rows, key='label'){ return (rows || []).map(r => `<div class="break-row"><span>${esc(r[key] || r.label || 'unknown')}</span><strong>${Number(r.count || 0).toLocaleString()}</strong></div>`).join('') || '<p class="muted">No data</p>'; }
function tripleItem(t){ return `<div class="item" data-json='${esc(JSON.stringify(t))}'><div class="meta"><span class="badge">fact</span><span>${esc(t.created_at || t.valid_from || '')}</span></div><div class="content"><strong>${esc(t.subject)}</strong> — ${esc(t.predicate)} → <strong>${esc(t.object)}</strong></div></div>`; }
async function loadTodayDigest(day=''){
  const suffix = day ? `&day=${encodeURIComponent(day)}` : '';
  const data = await api(`/api/digest/today?limit=80${suffix}`);
  const c = data.counts || {};
  $('#todayCards').innerHTML = [['Added', c.memories_added], ['Retrieved', c.memories_recalled], ['Needs review', c.contaminated_added], ['Lifecycle changes', c.degraded_added], ['Facts', c.triples_added], ['Consolidations', c.consolidations]].map(([label,num]) => `<div class="card"><div class="num">${Number(num || 0).toLocaleString()}</div><div class="label">${label}</div></div>`).join('');
  $('#todayEntities').innerHTML = tinyRows(data.breakdowns?.entities || []);
  $('#todayVeracity').innerHTML = tinyRows(data.breakdowns?.veracity || []);
  $('#todayDegradation').innerHTML = tinyRows(data.breakdowns?.degradation || []);
  $('#todaySources').innerHTML = tinyRows(data.breakdowns?.sources || []);
  $('#todaySessions').innerHTML = tinyRows(data.breakdowns?.sessions || []);
  $('#todayAdded .memory-grid').innerHTML = (data.memories_added || []).map(memoryItem).join('') || '<p class="muted">No memories added today.</p>';
  $('#todayRecalled .memory-grid').innerHTML = (data.memories_recalled || []).map(memoryItem).join('') || '<p class="muted">No memories recalled today.</p>';
  $('#todayTriples .memory-grid').innerHTML = (data.triples_added || []).map(tripleItem).join('') || stateHtml('empty', 'No facts added today.');
  $('#todayConsolidations .memory-grid').innerHTML = (data.consolidations || []).map(consolidationCard).join('') || '<p class="muted">No consolidations today.</p>';
  ['todayAdded','todayRecalled'].forEach(id => bindMemoryClicks($(`#${id}`)));
  bindJsonCards($('#todayTriples'), 'Triple detail');
  bindJsonCards($('#todayConsolidations'), 'Consolidation detail');
}
function contextLabel(label){
  return ({'Temporary context':'Short-term notes','Project context':'Project notes'})[label] || label;
}
function contextSummary(data){
  const s = data.summary || {};
  const typeChips = (s.types || []).map(t => `<span class="context-type-chip">${esc(contextLabel(t.label))} <strong>${Number(t.count || 0).toLocaleString()}</strong></span>`).join('');
  return `<div class="context-summary glass">
    <div><span>Indexed signals</span><strong>${Number(s.indexed_signals || s.active_items || 0).toLocaleString()}</strong></div>
    <div><span>Needs review</span><strong>${Number(s.needs_review || 0).toLocaleString()}</strong></div>
    <div><span>Sensitive</span><strong>${Number(s.sensitive || 0).toLocaleString()}</strong></div>
    <div><span>Sections</span><strong>${Number(s.sections || 0).toLocaleString()}</strong></div>
    ${typeChips ? `<div class="context-types">${typeChips}</div>` : ''}
  </div>`;
}
function profileItem(row){
  const item = row.item || {};
  const attrs = row.kind === 'memory' ? `data-id="${esc(item.id || '')}"` : `data-json='${esc(JSON.stringify(item))}'`;
  const confidence = row.confidence_label || 'Confidence unknown';
  const pct = Number(row.confidence_pct || row.importance * 100 || 0);
  const extracted = (row.extracted || []).slice(0,3).map(m => `<span title="${esc(m.value)}">${esc(m.label)}: ${esc(m.value)}</span>`).join('');
  const provenance = [row.category, row.tier || row.kind, row.source, row.scope, row.status].filter(Boolean).slice(0,5).map(x => `<span>${esc(x)}</span>`).join('');
  return `<div class="profile-item context-card ${esc(row.type_tone || '')}" ${attrs}>
    <div class="context-card-head"><span class="badge">${esc(contextLabel(row.context_type || row.kind))}</span><span class="confidence ${pct < 70 ? 'warn' : ''}">${esc(confidence)} · ${Math.round(pct)}%</span></div>
    <p>${esc(row.label || '')}</p>
    ${extracted ? `<div class="context-meta extracted">${extracted}</div>` : ''}
    <div class="context-meta"><span>${esc(prettyTime(row.timestamp) || row.timestamp || '')}</span>${provenance}</div>
  </div>`;
}
function patternSummary(data={}){
  const s = data.summary || {};
  const items = [
    ['Memories scanned', s.indexed_memories || 0],
    ['Triples scanned', s.indexed_triples || 0],
    ['Patterns found', s.patterns_found || data.mnemosyne_summary?.patterns_found || 0],
    ['Provider', data.provider ? 'Mnemosyne' : 'Dashboard'],
  ];
  return items.map(([label,value]) => `<div><span>${esc(label)}</span><strong>${typeof value === 'number' ? Number(value || 0).toLocaleString() : esc(value || '')}</strong></div>`).join('');
}
function renderPatternBars(items=[], kind='pattern'){
  if(!items.length) return '<span class="muted">No patterns yet.</span>';
  const max = Math.max(...items.map(item => Number(item.count || 0)), 1);
  return items.map(item => {
    const count = Number(item.count || 0);
    const pct = Math.max(5, Math.round((count / max) * 100));
    const query = item.query ?? item.label ?? '';
    return `<button class="pattern-bar" data-pattern-kind="${esc(kind)}" data-pattern-query="${esc(query)}" title="Filter memories for ${esc(item.label || '')}"><span class="pattern-bar-fill" style="width:${pct}%"></span><span class="pattern-bar-label">${esc(item.label || '')}</span><strong>${count.toLocaleString()}</strong></button>`;
  }).join('');
}
function renderPatternChips(items=[]){ return renderPatternBars(items); }
function applyPatternFilter(kind='', query=''){
  switchTab('memories');
  $('#memoryKind').value = 'all';
  $('#memoryStatus').value = 'active';
  $('#memorySort').value = 'importance';
  $('#memorySource').value = '';
  $('#memoryScope').value = '';
  $('#memorySession').value = '';
  $('#memoryVeracity').value = '';
  $('#memoryDegradation').value = '';
  $('#memoryTrustPreset').value = '';
  $('#memoryQuery').value = query || '';
  loadMemories();
}
async function loadPatternInsights(){
  const data = await api('/api/patterns?limit=10');
  $('#patternSummary').innerHTML = patternSummary(data);
  $('#patternContent').innerHTML = renderPatternBars(data.content_patterns || [], 'content-pattern');
  $('#patternTemporal').innerHTML = renderPatternBars(data.temporal_patterns || [], 'temporal-pattern');
  $('#patternSequence').innerHTML = renderPatternBars(data.sequence_patterns || [], 'sequence-pattern');
  $('#contextDomainBars').innerHTML = renderPatternBars(data.context_domains || [], 'context-domain');
  $('#patternOrigins').innerHTML = renderPatternBars(data.origins || data.sources || [], 'origin');
  $('#patternTypes').innerHTML = renderPatternBars(data.memory_types || [], 'type');
  $$('#patternInsights .pattern-bar,#contextDomains .pattern-bar').forEach(el => el.onclick = () => applyPatternFilter(el.dataset.patternKind || '', el.dataset.patternQuery || ''));
}
async function loadProfile(){
  const [data] = await Promise.all([api('/api/profile/inferred?limit=10'), loadPatternInsights()]);
  $('#profileGrid').innerHTML = `${contextSummary(data)}${(data.sections || []).map(s => `<section class="profile-section glass"><div class="section-head mini"><h2>${esc(contextLabel(s.name))}</h2><span>${esc(s.count)} active item${Number(s.count) === 1 ? '' : 's'}</span></div>${(s.items || []).map(profileItem).join('')}</section>`).join('') || '<p class="muted">No inferred profile data found.</p>'}`;
  $$('#profileGrid .profile-item[data-id]').forEach(el => el.onclick = () => openMemoryDetail(el.dataset.id));
  $$('#profileGrid .profile-item[data-json]').forEach(el => el.onclick = () => showDetail(JSON.parse(el.dataset.json), 'Profile source detail'));
}
function applyReviewFilter(filter={}){
  $('#memoryKind').value = filter.kind || 'all';
  $('#memoryQuery').value = '';
  $('#memorySource').value = '';
  $('#memoryScope').value = '';
  $('#memorySession').value = '';
  $('#memoryVeracity').value = filter.veracity || '';
  $('#memoryDegradation').value = filter.degradation_tier || '';
  $('#memoryTrustPreset').value = filter.contaminated_only ? 'contaminated' : filter.degraded_only ? 'degraded' : filter.due_for_degradation ? 'due' : '';
  $('#memoryStatus').value = filter.status || 'active';
  $('#memorySort').value = filter.sort || 'importance';
  switchTab('memories');
}
function reviewReasonBadges(key, item={}){
  const reasons = [];
  if(key === 'contaminated' || item.veracity && item.veracity !== 'stated') reasons.push('Needs review');
  if(key === 'important_contaminated' || Number(item.importance || 0) >= 0.75) reasons.push('High importance');
  if(key === 'degraded' || Number(item.degradation_tier || 1) > 1) reasons.push('Degraded');
  if(key === 'due_degradation') reasons.push('Due for degradation');
  return [...new Set(reasons)].map(reason => `<span>${esc(reason)}</span>`).join('');
}
function reviewMemoryItem(key, item, opts={}){
  const reasons = reviewReasonBadges(key, item);
  return `<div class="review-memory-wrap">${memoryItem(item, opts)}${reasons ? `<div class="review-reasons" aria-label="Review reasons">${reasons}</div>` : ''}</div>`;
}
function reviewQueueHtml(key, queue, opts={}){
  const items = queue.items || [];
  const selectAction = opts.triage ? `<button class="tiny review-select-visible" data-review-key="${esc(key)}">Select visible</button>` : '';
  const renderedItems = opts.triage ? items.map(item => reviewMemoryItem(key, item, {selectable:true, selectedSet:reviewSelection, checkClass:'review-check'})).join('') : items.map(item => reviewMemoryItem(key, item)).join('');
  return `<section class="review-queue glass" data-review-key="${esc(key)}">
    <div class="section-head mini"><h2>${esc(queue.title || key)}</h2><span>${items.length} listed</span></div>
    <p class="muted">${esc(queue.description || '')}</p>
    <div class="review-actions"><button class="tiny primary review-filter" data-review-key="${esc(key)}">Open filtered browser</button>${selectAction}</div>
    <div class="list memory-grid">${renderedItems || stateHtml('empty', 'No items in this queue.', 'This queue is clear for now.')}</div>
  </section>`;
}
function reviewActionableIds(){ return [...new Set(latestReviewItems.filter(x => reviewSelection.has(x.id) && isMutableMemory(x)).map(x => x.id))]; }
function updateReviewBulkBar(){
  const bar = $('#reviewBulkBar');
  if(!bar) return;
  const admin = canAdmin();
  const visible = latestReviewItems.length;
  const actionable = reviewActionableIds().length;
  bar.classList.toggle('hidden', !visible);
  $('#reviewSelectionStatus').textContent = `${reviewSelection.size} selected`;
  $('#reviewConfirm').disabled = !admin || !actionable;
  $('#reviewVeracity').disabled = !admin || !actionable;
  $('#reviewExpiry').disabled = !admin || !actionable;
  $('#reviewExpire').disabled = !admin || !actionable;
  $('#reviewSelectAll').checked = visible > 0 && latestReviewItems.every(x => reviewSelection.has(x.id));
  $('#reviewSelectAll').disabled = !visible;
}
function bindReviewControls(queues){
  $$('#review .review-check').forEach(chk => chk.onchange = e => { e.stopPropagation(); chk.checked ? reviewSelection.add(chk.dataset.id) : reviewSelection.delete(chk.dataset.id); updateReviewBulkBar(); });
  $$('#review .review-select-visible').forEach(el => el.onclick = e => {
    e.stopPropagation();
    latestReviewItems.forEach(x => reviewSelection.add(x.id));
    $$('#review .review-check').forEach(chk => { chk.checked = true; });
    updateReviewBulkBar();
  });
}
function reviewFilterParams(){
  const params = new URLSearchParams(`queue=${encodeURIComponent(selectedReviewQueue)}&limit=${REVIEW_PAGE_SIZE}&offset=${reviewOffset}`);
  const q = ($('#reviewSearchQuery')?.value || '').trim();
  const minImportance = ($('#reviewMinImportance')?.value || '').trim();
  if(q) params.set('q', q);
  if(minImportance && Number(minImportance) > 0) params.set('min_importance', minImportance);
  return params;
}
function updateReviewImportanceLabel(){
  const slider = $('#reviewMinImportance');
  const label = $('#reviewMinImportanceValue');
  if(!slider || !label) return;
  const value = Number(slider.value || 0);
  label.textContent = value > 0 ? `≥ ${value.toFixed(2)}` : 'any';
}
function renderSelectedReviewQueue(data, append=false){
  latestReviewData = data;
  const queues = data.queues || {};
  const cards = data.cards || [];
  const keys = cards.map(card => card.key).filter(key => queues[key]);
  if(!keys.length){
    latestReviewItems = [];
    $('#reviewCards').innerHTML = '';
    $('#reviewQueueSelect').innerHTML = '';
    $('#reviewQueueCount').textContent = '0 listed';
    $('#reviewQueues').innerHTML = '<p class="muted">No review queues available.</p>';
    $('#reviewLoadMore').classList.add('hidden');
    updateReviewBulkBar();
    return;
  }
  if(!queues[selectedReviewQueue]) selectedReviewQueue = data.queue || keys[0];
  const selectedCard = cards.find(card => card.key === selectedReviewQueue) || {count: data.total || 0};
  $('#reviewCards').innerHTML = '';
  $('#reviewQueueSelect').innerHTML = cards.map(card => `<option value="${esc(card.key)}" ${card.key === selectedReviewQueue ? 'selected' : ''}>${esc(card.title)} (${Number(card.count || 0).toLocaleString()})</option>`).join('');
  const newItems = queues[selectedReviewQueue]?.items || [];
  latestReviewItems = append ? [...new Map([...latestReviewItems, ...newItems].map(item => [item.id, item])).values()] : [...new Map(newItems.map(item => [item.id, item])).values()];
  $('#reviewQueueCount').textContent = `${Number(data.total ?? selectedCard.count ?? 0).toLocaleString()} total · ${latestReviewItems.length.toLocaleString()} listed`;
  const renderedQueue = {...queues[selectedReviewQueue], items:latestReviewItems};
  $('#reviewQueues').innerHTML = reviewQueueHtml(selectedReviewQueue, renderedQueue, {triage:true});
  bindMemoryClicks($('#review'));
  bindReviewControls(queues);
  updateReviewBulkBar();
  $('#reviewQueueSelect').onchange = e => { selectedReviewQueue = e.target.value; reviewOffset = 0; reviewSelection.clear(); loadReviewPage(false); };
  $('#reviewMinImportance').oninput = updateReviewImportanceLabel;
  updateReviewImportanceLabel();
  $('#reviewApplyFilters').onclick = () => { reviewOffset = 0; reviewSelection.clear(); loadReviewPage(false); };
  $('#reviewClearFilters').onclick = () => { $('#reviewSearchQuery').value = ''; $('#reviewMinImportance').value = '0'; updateReviewImportanceLabel(); reviewOffset = 0; reviewSelection.clear(); loadReviewPage(false); };
  $('#reviewLoadMore').onclick = () => { if(data.next_offset != null){ reviewOffset = data.next_offset; loadReviewPage(true); } };
  $('#reviewLoadMore').classList.toggle('hidden', !data.has_more);
  $$('#review .review-filter').forEach(el => {
    el.onclick = e => { e.stopPropagation(); const key = el.dataset.reviewKey; applyReviewFilter(queues[key]?.filter || {}); };
  });
}
async function loadReviewPage(append=false){
  const data = await api(`/api/review?${reviewFilterParams().toString()}`);
  renderSelectedReviewQueue(data, append);
}
async function confirmSelectedReviewMemories(){
  const ids = reviewActionableIds();
  if(!ids.length) return;
  const ok = await confirmAction({title:'Confirm selected memories?', description:`Mark ${ids.length} selected active memories as stated.`, confirmText:'Confirm selected'});
  if(!ok) return;
  const backup = $('#backupBeforeMutation') ? $('#backupBeforeMutation').checked : true;
  for(const id of ids) await postJson('/api/admin/memory/veracity', {memory_id:id, veracity:'stated', backup});
  reviewSelection.clear(); await loadStats(); await loadReview();
}
async function setSelectedReviewVeracity(){
  const ids = reviewActionableIds();
  if(!ids.length) return;
  const v = await askVeracity('stated');
  if(v === null) return;
  const backup = $('#backupBeforeMutation') ? $('#backupBeforeMutation').checked : true;
  for(const id of ids) await postJson('/api/admin/memory/veracity', {memory_id:id, veracity:v, backup});
  reviewSelection.clear(); await loadStats(); await loadReview();
}
async function setSelectedReviewExpiry(){
  const ids = reviewActionableIds();
  if(!ids.length) return;
  const v = await askExpiry('');
  if(v === null) return;
  const backup = $('#backupBeforeMutation') ? $('#backupBeforeMutation').checked : true;
  for(const id of ids) await postJson('/api/admin/memory/expiry', {memory_id:id, valid_until:v, backup});
  reviewSelection.clear(); await loadStats(); await loadReview();
}
async function expireSelectedReviewMemories(){
  const ids = reviewActionableIds();
  if(!ids.length) return;
  const ok = await confirmAction({title:'Expire selected memories?', description:`Expire ${ids.length} selected active memories. Backups and audit entries will be created.`, confirmText:'Expire selected', tone:'warn'});
  if(!ok) return;
  const backup = $('#backupBeforeMutation') ? $('#backupBeforeMutation').checked : true;
  for(const id of ids) await postJson('/api/admin/memory/invalidate', {memory_id:id, backup});
  reviewSelection.clear(); await loadStats(); await loadReview();
}
async function loadReview(){
  reviewOffset = 0;
  reviewSelection.clear();
  await loadReviewPage(false);
}
function lifecycleQueueHtml(key, queue){
  return reviewQueueHtml(key, queue).replace('review-queue glass', 'review-queue lifecycle-queue glass').replace('Open filtered browser', 'Open lifecycle filter');
}
async function loadLifecycle(){
  const data = await api('/api/lifecycle?limit=80');
  const queues = data.queues || {};
  const t = data.thresholds || {};
  const weights = t.weights || {};
  $('#lifecycleThresholds').innerHTML = [
    `Tier 2 after ${Number(t.tier2_days || 30).toLocaleString()} days`,
    `Tier 3 after ${Number(t.tier3_days || 180).toLocaleString()} days`,
    `Weights: hot ×${Number(weights['1'] || 1).toFixed(2)} · warm ×${Number(weights['2'] || .5).toFixed(2)} · cold ×${Number(weights['3'] || .25).toFixed(2)}`,
    'Read-only: no degradation is triggered from this page'
  ].map(x => `<span>${esc(x)}</span>`).join('');
  $('#lifecycleCards').innerHTML = (data.cards || []).map(card => `<button class="card review-card lifecycle-card" data-lifecycle-key="${esc(card.key)}"><div class="num">${Number(card.count || 0).toLocaleString()}</div><div class="label">${esc(card.title)}</div><p>${esc(card.description || '')}</p></button>`).join('');
  $('#lifecycleQueues').innerHTML = Object.entries(queues).map(([key, queue]) => lifecycleQueueHtml(key, queue)).join('') || '<p class="muted">No lifecycle queues available.</p>';
  bindMemoryClicks($('#lifecycle'));
  $$('#lifecycle [data-lifecycle-key]').forEach(el => el.onclick = e => { e.stopPropagation(); applyReviewFilter(queues[el.dataset.lifecycleKey]?.filter || {}); });
  $$('#lifecycle .review-filter').forEach(el => el.onclick = e => { e.stopPropagation(); const key = el.closest('[data-review-key]')?.dataset.reviewKey; applyReviewFilter(queues[key]?.filter || {}); });
}

function constellationInspectorDefault(){
  const neural = constellationScene.visualiserMode === 'neural';
  $('#constellationInspector').innerHTML = neural
    ? `<div class="inspector-kicker">Neural inspector</div><h3>Nothing selected</h3><p class="muted">Pick a neuron hub, memory soma, or synapse to inspect the underlying read-only source.</p>`
    : `<div class="inspector-kicker">Constellation inspector</div><h3>Nothing selected</h3><p class="muted">Pick a star, memory, or link to inspect the underlying read-only source.</p>`;
}
function inspectConstellationNode(node){
  $('#constellationInspector').innerHTML = `<div class="inspector-kicker">${esc(node.kind || 'entity')}</div><h3>${esc(node.label)}</h3><p class="muted">${esc(node.category || 'Other')} · ${Number(node.count || 0).toLocaleString()} signal(s) · weight ${Number(node.weight || 0).toFixed(2)}</p>${node.preview ? `<p>${esc(node.preview)}</p>` : ''}<div class="inspector-actions">${node.memory_id ? '<button id="constellationMemory" class="primary tiny">Open memory</button>' : ''}<button id="constellationSearch" class="tiny">Search this</button></div>`;
  if(node.memory_id) $('#constellationMemory').onclick = () => openMemoryDetail(node.memory_id);
  $('#constellationSearch').onclick = () => { $('#memoryQuery').value = node.label.replace(/^memory:/,''); switchTab('memories'); };
}
function constellationColors(){
  const light = document.documentElement.dataset.theme === 'light';
  return light ? { light:true, bg:'#fbf8f3', nebula:'rgba(101,214,255,.11)', star:'#087fa6', memory:'#c9a96e', text:'#2b2927', muted:'rgba(66,58,52,.62)', edge:'rgba(25,65,108,.50)', memoryEdge:'rgba(130,78,18,.48)' } : { light:false, bg:'#050711', nebula:'rgba(101,214,255,.14)', star:'#65d6ff', memory:'#ffe08a', text:'#f7f8ff', muted:'rgba(213,219,239,.64)', edge:'rgba(198,224,255,.44)', memoryEdge:'rgba(255,224,138,.50)' };
}
function projectConstellationNode(n, w, h, t){
  const rot = constellationScene.rotation;
  const cos = Math.cos(rot), sin = Math.sin(rot);
  const x = n.x * cos - n.z * sin;
  const z0 = n.x * sin + n.z * cos;
  const tilt = constellationScene.tilt;
  const y = n.y * Math.cos(tilt) - z0 * Math.sin(tilt);
  const z = n.y * Math.sin(tilt) + z0 * Math.cos(tilt);
  const depth = 760;
  const scale = depth / (depth + z + 260);
  const fill = visualiserResponsiveFill(w, h);
  const fit = w < 620 ? Math.min(.72, Math.max(.58, (w - 36) / 680)) : Math.min(1.18, Math.max(.62, (w - 72) / 760) * fill);
  const cameraScale = fit * constellationScene.zoom;
  return { x:w/2 + constellationScene.panX + x*scale*cameraScale, y:h/2 + constellationScene.panY + y*scale*cameraScale, z, scale:scale*constellationScene.zoom, visible:scale > .35 };
}
function buildConstellationScene(data){
  const nodes = (data.nodes || []).slice(0,160);
  const categories = [...new Set(nodes.map(n => n.category || 'Other'))];
  const catIndex = Object.fromEntries(categories.map((c,i)=>[c,i]));
  nodes.forEach((n,i) => {
    const ci = catIndex[n.category || 'Other'] || 0;
    const angle = (i / Math.max(nodes.length,1)) * Math.PI * 2 + ci * .62;
    const band = n.kind === 'memory' ? 1.28 : .72 + (ci % 4) * .16;
    const radius = 250 * band + (i % 7) * 16;
    n.x = Math.cos(angle) * radius;
    n.y = Math.sin(angle * 1.23) * (100 + (ci % 5) * 24) + (((i * 53) % 131) - 65) * .82;
    n.z = Math.sin(angle) * radius * .82 + (((i * 97) % 181) - 90) * 1.55 + ((ci % 5) - 2) * 42;
    n.size = Math.min(22, 4 + Math.sqrt(Number(n.weight || n.count || 1))*3.4) * (n.kind === 'memory' ? 1.08 : 1);
    n.twinkle = (i % 17) / 17;
    const twinkleTier = i % 11 === 0 ? 2 : (i % 5 === 0 ? 1 : 0);
    n.twinkleFreq = twinkleTier === 2 ? .0062 + ((i * 29) % 70) / 100000 : (twinkleTier === 1 ? .0030 + ((i * 29) % 80) / 100000 : .00115 + ((i * 29) % 95) / 100000);
    n.twinkleAmp = twinkleTier === 2 ? .18 : (twinkleTier === 1 ? .12 : .075 + ((i * 31) % 55) / 1000);
  });
  constellationScene.nodes = nodes;
  constellationScene.edges = (data.edges || []).filter(e => nodes.some(n => n.id === e.source) && nodes.some(n => n.id === e.target)).slice(0,300);
  constellationScene.byId = Object.fromEntries(nodes.map(n=>[n.id,n]));
  constellationScene.regions = [];
  constellationScene.data = data;
  constellationScene.stars = Array.from({length:140}, (_,i) => {
    const fast = i % 13 === 0;
    const medium = !fast && i % 6 === 0;
    return { x:((i*73)%1000)/1000, y:((i*191)%680)/680, r:.35 + ((i*37)%100)/90, a:.18 + ((i*29)%100)/240, phase:(i*47)%628/100, freq:fast ? .0058 + ((i*41)%80)/100000 : (medium ? .0027 + ((i*41)%90)/100000 : .00048 + ((i*41)%95)/100000) };
  });
}
function buildNeuralMapScene(data){
  const nodes = (data.nodes || []).slice(0,170).map(n => ({...n}));
  const nodeIds = new Set(nodes.map(n => n.id));
  const edges = (data.edges || []).filter(e => nodeIds.has(e.source) && nodeIds.has(e.target)).slice(0,340);
  const categories = [...new Set(nodes.map(n => n.category || 'Other'))];
  const catIndex = Object.fromEntries(categories.map((c,i)=>[c,i]));
  const regionCount = Math.max(1, categories.length);
  const regions = Object.fromEntries(categories.map((cat, i) => {
    // Place category regions inside a real 3D ellipsoid rather than on a flat ring.
    // Golden-angle distribution gives an organic brain-cloud feel while remaining deterministic.
    const t = regionCount === 1 ? 0 : (i / Math.max(1, regionCount - 1)) * 2 - 1;
    const angle = -Math.PI / 2 + i * 2.399963;
    const radial = Math.sqrt(Math.max(0, 1 - t * t));
    const side = i % 2 === 0 ? -1 : 1;
    return [cat, {
      label:cat,
      angle,
      cx:Math.cos(angle) * radial * 230,
      cy:t * 150 + Math.sin(angle * .7) * 24,
      cz:Math.sin(angle) * radial * 190 + side * 28,
      spread:78 + (i % 4) * 12
    }];
  }));
  const degree = new Map();
  edges.forEach(e => { degree.set(e.source, (degree.get(e.source) || 0) + 1); degree.set(e.target, (degree.get(e.target) || 0) + 1); });
  const hubsByCategory = {};
  nodes.filter(n => n.kind !== 'memory').sort((a,b)=>(Number(b.weight || b.count || 0)+ (degree.get(b.id)||0)) - (Number(a.weight || a.count || 0)+(degree.get(a.id)||0))).forEach(n => {
    const cat = n.category || 'Other';
    if(!hubsByCategory[cat]) hubsByCategory[cat] = [];
    hubsByCategory[cat].push(n);
  });
  const byId = Object.fromEntries(nodes.map(n => [n.id, n]));
  nodes.forEach((n,i) => {
    const cat = n.category || 'Other';
    const region = regions[cat] || regions.Other || { cx:0, cy:0, cz:0, angle:0, spread:80 };
    const ci = catIndex[cat] || 0;
    const weight = Math.max(1, Number(n.weight || n.count || 1));
    const d = degree.get(n.id) || 0;
    if(n.kind === 'memory'){
      const linked = edges.find(e => e.source === n.id || e.target === n.id);
      const parent = linked ? byId[linked.source === n.id ? linked.target : linked.source] : null;
      const parentX = parent && parent.kind !== 'memory' && Number.isFinite(parent.x) ? parent.x : region.cx;
      const parentY = parent && parent.kind !== 'memory' && Number.isFinite(parent.y) ? parent.y : region.cy;
      const parentZ = parent && parent.kind !== 'memory' && Number.isFinite(parent.z) ? parent.z : region.cz;
      const branch = ((i * 137.508 + ci * 19) % 360) * Math.PI / 180;
      const yUnit = ((((i * 43 + ci * 17) % 97) + .5) / 97) * 2 - 1;
      const radial = Math.sqrt(Math.max(0, 1 - yUnit * yUnit));
      const dist = 46 + (i % 6) * 13 + Math.min(48, Math.sqrt(weight) * 10);
      n.x = parentX + Math.cos(branch) * radial * dist;
      n.y = parentY + yUnit * dist * .82;
      n.z = parentZ + Math.sin(branch) * radial * dist * .86;
    } else {
      const rank = Math.max(0, (hubsByCategory[cat] || []).indexOf(n));
      const orbit = rank === 0 ? 0 : 30 + Math.sqrt(rank) * 20;
      const angle = region.angle + rank * 2.399963 + (ci % 3) * .24;
      const yUnit = rank === 0 ? 0 : ((((rank * 37 + ci * 11) % 89) + .5) / 89) * 2 - 1;
      const radial = Math.sqrt(Math.max(0, 1 - yUnit * yUnit));
      n.x = region.cx + Math.cos(angle) * radial * orbit;
      n.y = region.cy + yUnit * orbit * .86;
      n.z = region.cz + Math.sin(angle) * radial * orbit * .80;
    }
    n.size = Math.min(30, 8 + Math.sqrt(weight + d) * (n.kind === 'memory' ? 3.2 : 4.1));
    n.twinkle = (i % 17) / 17;
    n.twinkleFreq = .0017 + ((i * 31) % 80) / 100000;
    n.twinkleAmp = .08 + ((i * 19) % 40) / 1000;
    n.neuralRegion = cat;
  });
  constellationScene.nodes = nodes;
  constellationScene.edges = edges;
  constellationScene.byId = Object.fromEntries(nodes.map(n=>[n.id,n]));
  constellationScene.regions = Object.values(regions);
  constellationScene.data = data;
  constellationScene.stars = Array.from({length:60}, (_,i) => ({ x:((i*89)%1000)/1000, y:((i*157)%680)/680, r:.25 + ((i*17)%100)/120, a:.10 + ((i*23)%100)/340, phase:(i*41)%628/100, freq:.00045 + ((i*29)%70)/100000 }));
}
function projectNeuralNode(n, w, h){
  const fit = w < 620 ? Math.min(.88, Math.max(.62, (w - 38) / 620)) : Math.min(1.10, Math.max(.76, (w - 80) / 720));
  const cameraScale = fit * constellationScene.zoom;
  const x = Number(n.x || 0), y = Number(n.y || 0), z = Number(n.z || 0);
  const cosR=Math.cos(constellationScene.rotation || 0), sinR=Math.sin(constellationScene.rotation || 0);
  const xr=x*cosR - z*sinR, zr=x*sinR + z*cosR;
  const cosT=Math.cos(constellationScene.tilt || 0), sinT=Math.sin(constellationScene.tilt || 0);
  const yr=y*cosT - zr*sinT, zt=y*sinT + zr*cosT;
  const cameraDistance = w < 620 ? 760 : 980;
  const perspective = Math.max(.48, Math.min(1.85, cameraDistance / Math.max(260, cameraDistance - zt)));
  const depthAlpha = Math.max(.36, Math.min(1, .58 + zt / 620));
  return {
    x:w/2 + constellationScene.panX + xr*cameraScale*perspective,
    y:h/2 + constellationScene.panY + yr*cameraScale*perspective,
    z:zt,
    scale:cameraScale*perspective,
    alpha:depthAlpha,
    visible:true
  };
}
function drawSynapse(ctx, a, b, e, c, t, compactCanvas, pulse=false){
  const mx=(a.x+b.x)/2, my=(a.y+b.y)/2;
  const dx=b.x-a.x, dy=b.y-a.y;
  const len=Math.max(1, Math.hypot(dx,dy));
  const curve=Math.min(compactCanvas ? 30 : 48, len*.16) * (((e.id || '').length % 2) ? 1 : -1);
  const cx=mx - dy/len*curve, cy=my + dx/len*curve;
  const depth=Math.min(1, Math.max(.42, ((a.alpha || 1) + (b.alpha || 1)) / 2));
  ctx.strokeStyle=e.kind === 'memory' ? c.memorySynapse : c.synapse;
  ctx.globalAlpha=(compactCanvas ? .24 : .30) * depth;
  ctx.lineWidth=compactCanvas ? .66 : .82;
  ctx.setLineDash([]);
  ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.quadraticCurveTo(cx,cy,b.x,b.y); ctx.stroke();
  if(!pulse) return;
  const phase=((t*.00012 + ((e.id || '').length % 17)/17) % 1);
  const inv=1-phase;
  const qx=inv*inv*a.x + 2*inv*phase*cx + phase*phase*b.x;
  const qy=inv*inv*a.y + 2*inv*phase*cy + phase*phase*b.y;
  ctx.globalAlpha=(compactCanvas ? .36 : .54) * depth;
  ctx.fillStyle=e.kind === 'memory' ? c.memory : c.star;
  ctx.beginPath(); ctx.arc(qx,qy,compactCanvas ? 1.55 : 2.15,0,Math.PI*2); ctx.fill();
}
function drawNeuronSoma(ctx, n, p, c, t, compactCanvas, fast=false){
  const weight=Math.max(1, Number(n.weight || n.count || 1));
  const base=n.kind === 'memory' ? c.memory : c.star;
  const r=Math.min(compactCanvas ? 7.5 : 11, Math.max(compactCanvas ? 3.4 : 4.6, (2.8 + Math.sqrt(weight)*1.15) * p.scale));
  const pulse=1 + Math.sin(t*(n.twinkleFreq || .0017) + n.twinkle*6.28)*(n.twinkleAmp || .07);
  const somaR=r*pulse;
  const halo=somaR*(n.kind === 'memory' ? 2.0 : 2.4);
  const depthAlpha = p.alpha || 1;
  if(fast){
    ctx.globalAlpha=(c.light ? .34 : .48) * depthAlpha;
    ctx.fillStyle=base;
    ctx.beginPath(); ctx.arc(p.x,p.y,somaR*.92,0,Math.PI*2); ctx.fill();
    ctx.globalAlpha=.88 * depthAlpha;
    ctx.fillStyle='rgba(255,255,255,.82)';
    ctx.beginPath(); ctx.arc(p.x,p.y,Math.max(.65,somaR*.30),0,Math.PI*2); ctx.fill();
    ctx.globalAlpha=1;
    return { r:somaR, halo };
  }
  const glow=ctx.createRadialGradient(p.x,p.y,0,p.x,p.y,halo);
  glow.addColorStop(0,'rgba(255,255,255,.82)');
  glow.addColorStop(.20,base);
  glow.addColorStop(1,'rgba(0,0,0,0)');
  ctx.globalAlpha=(c.light ? .20 : .30) * depthAlpha;
  ctx.fillStyle=glow; ctx.beginPath(); ctx.arc(p.x,p.y,halo,0,Math.PI*2); ctx.fill();
  ctx.save(); ctx.translate(p.x,p.y); ctx.rotate((n.twinkle || 0)*Math.PI*2 + t*.00004);
  ctx.strokeStyle=base; ctx.lineCap='round'; ctx.shadowColor=base; ctx.shadowBlur=compactCanvas ? 5 : 8;
  const dendrites=n.kind === 'memory' ? 3 : 6;
  for(let i=0;i<dendrites;i++){
    const a=(i/dendrites)*Math.PI*2 + Math.sin(t*.00018+i)*.10;
    const length=somaR*(n.kind === 'memory' ? 1.55 : 2.15) + (i%3)*2.5;
    ctx.globalAlpha=(c.light ? .22 : .34) * depthAlpha;
    ctx.lineWidth=Math.max(.55,somaR*.10);
    ctx.beginPath(); ctx.moveTo(Math.cos(a)*somaR*.72, Math.sin(a)*somaR*.72); ctx.lineTo(Math.cos(a)*length, Math.sin(a)*length); ctx.stroke();
    if(n.kind !== 'memory'){
      ctx.globalAlpha=(c.light ? .16 : .24) * depthAlpha;
      const fork=length*.72;
      ctx.beginPath(); ctx.moveTo(Math.cos(a)*fork, Math.sin(a)*fork); ctx.lineTo(Math.cos(a+.38)*length*.96, Math.sin(a+.38)*length*.96); ctx.stroke();
    }
  }
  ctx.globalAlpha=.96 * depthAlpha; ctx.fillStyle='rgba(255,255,255,.92)'; ctx.beginPath(); ctx.arc(0,0,somaR*.88,0,Math.PI*2); ctx.fill();
  ctx.globalAlpha=.78 * depthAlpha; ctx.fillStyle=base; ctx.beginPath(); ctx.arc(0,0,somaR*.58,0,Math.PI*2); ctx.fill();
  ctx.globalAlpha=.72 * depthAlpha; ctx.fillStyle=c.bg; ctx.beginPath(); ctx.arc(-somaR*.16,-somaR*.18,somaR*.18,0,Math.PI*2); ctx.fill();
  ctx.restore();
  return { r:somaR, halo };
}

function neuralFastMode(t=performance.now()){
  return constellationScene.visualiserMode === 'neural' && (Boolean(constellationScene.drag) || t - (constellationScene.lastInteraction || 0) < 220);
}
function visualiserDpr(compactCanvas, mode){
  const raw = window.devicePixelRatio || 1;
  if(mode === 'neural') return Math.min(raw, compactCanvas ? 1.8 : 1.25);
  return Math.min(raw, compactCanvas ? 2 : 1.5);
}
function drawNeuralFrame(t=0){
  const canvas = $('#constellationCanvas');
  if(!canvas) return;
  const wrap = canvas.parentElement;
  const w = Math.max(320, wrap.clientWidth || canvas.clientWidth || 1000);
  const h = Math.max(430, wrap.clientHeight || canvas.clientHeight || 680);
  const compactCanvas = w < 620;
  const dpr = visualiserDpr(compactCanvas, 'neural');
  if(canvas.width !== Math.floor(w*dpr) || canvas.height !== Math.floor(h*dpr)){ canvas.width = Math.floor(w*dpr); canvas.height = Math.floor(h*dpr); }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr,0,0,dpr,0,0);
  const c = neuralColors();
  const fast = false;
  if(!constellationScene.paused && !constellationScene.drag && !window.matchMedia('(prefers-reduced-motion: reduce)').matches){
    const delta = constellationScene.lastFrameTime ? Math.min(48, t - constellationScene.lastFrameTime) : 16;
    constellationScene.rotation += delta * 0.000032;
  }
  constellationScene.lastFrameTime = t;
  clampConstellationCamera(w, h);
  ctx.clearRect(0,0,w,h);
  const bg = ctx.createRadialGradient(w*.48,h*.44,18,w*.48,h*.44,Math.max(w,h)*.78);
  bg.addColorStop(0, c.core);
  bg.addColorStop(.48, c.mid);
  bg.addColorStop(1, c.bg);
  ctx.fillStyle=bg; ctx.fillRect(0,0,w,h);
  constellationScene.stars.forEach((s)=>{ const pulse=.50 + Math.sin(t*s.freq + s.phase)*.30; ctx.globalAlpha=s.a*Math.max(.10, pulse)*(c.light ? .35 : .55); ctx.fillStyle=c.text; ctx.beginPath(); ctx.arc(s.x*w, s.y*h, s.r*(c.light ? .55 : .75), 0, Math.PI*2); ctx.fill(); });
  ctx.globalAlpha=1;
  const projected = new Map();
  constellationScene.nodes.forEach(n => projected.set(n.id, projectNeuralNode(n,w,h)));
  (constellationScene.regions || []).slice(0,10).forEach((region, i) => {
    const rp = projectNeuralNode({x:region.cx,y:region.cy,z:region.cz || 0},w,h);
    const rx = (region.spread || 82) * (compactCanvas ? 1.20 : 1.55) * rp.scale;
    const ry = (region.spread || 82) * (compactCanvas ? .76 : .98) * rp.scale;
    const hue = i % 3;
    const fill = c.light
      ? (hue === 0 ? 'rgba(76,171,158,.075)' : hue === 1 ? 'rgba(101,214,255,.065)' : 'rgba(255,209,102,.060)')
      : (hue === 0 ? 'rgba(76,171,158,.115)' : hue === 1 ? 'rgba(101,214,255,.092)' : 'rgba(255,209,102,.070)');
    ctx.save();
    ctx.translate(rp.x,rp.y);
    ctx.rotate(region.angle*.42);
    ctx.globalAlpha=1;
    ctx.fillStyle=fill;
    ctx.beginPath();
    ctx.ellipse(0,0,rx,ry,0,0,Math.PI*2);
    ctx.fill();
    ctx.globalAlpha=c.light ? .14 : .18;
    ctx.strokeStyle=hue === 2 ? c.memorySynapse : c.synapseHot;
    ctx.lineWidth=.8;
    ctx.beginPath(); ctx.ellipse(0,0,rx*.72,ry*.72,0,0,Math.PI*2); ctx.stroke();
    if(!compactCanvas && region.label){
      ctx.globalAlpha=c.light ? .32 : .28;
      ctx.fillStyle=c.text;
      ctx.font='10px Inter, system-ui, sans-serif';
      ctx.fillText(region.label.slice(0,22), -rx*.42, -ry*.48);
    }
    ctx.restore();
  });
  const edgeDegree = new Map();
  let edgeDrawn = 0;
  const edgeLimit = fast ? (compactCanvas ? 48 : 112) : (compactCanvas ? 58 : 132);
  const degreeLimit = fast ? (compactCanvas ? 3 : 4) : (compactCanvas ? 3 : 5);
  for(const e of constellationScene.edges){
    const a=projected.get(e.source), b=projected.get(e.target);
    if(!a || !b) continue;
    if(edgeDrawn >= edgeLimit) break;
    const da=edgeDegree.get(e.source) || 0, db=edgeDegree.get(e.target) || 0;
    if(da >= degreeLimit || db >= degreeLimit) continue;
    edgeDegree.set(e.source, da+1); edgeDegree.set(e.target, db+1); edgeDrawn++;
    const pulseStride = compactCanvas ? 4 : 3;
    const pulseLimit = compactCanvas ? 24 : 72;
    const shouldPulse = edgeDrawn <= (fast ? Math.floor(pulseLimit * .75) : pulseLimit) && ((edgeDrawn + ((e.id || '').length % pulseStride)) % pulseStride === 0);
    drawSynapse(ctx,a,b,e,c,t,compactCanvas,shouldPulse);
  }
  ctx.globalAlpha=1; ctx.setLineDash([]);
  const hits=[];
  const labelBoxes=[];
  const nodeDegrees = new Map();
  constellationScene.edges.forEach(e => { nodeDegrees.set(e.source, (nodeDegrees.get(e.source) || 0) + 1); nodeDegrees.set(e.target, (nodeDegrees.get(e.target) || 0) + 1); });
  [...constellationScene.nodes].sort((a,b)=>(Number(a.z||0)-Number(b.z||0))).forEach(n => {
    const p=projected.get(n.id); if(!p) return;
    const drawn=drawNeuronSoma(ctx,n,p,c,t,compactCanvas,fast);
    const labelRaw=(n.label || '').replace(/^memory:/,'mem ');
    const compactRaw=labelRaw.trim();
    const alphaChars=(compactRaw.match(/[A-Za-z]/g) || []).length;
    const isHashLike=/^[a-f0-9]{10,}$/i.test(compactRaw) || /^mem\s+[a-f0-9]{6,}$/i.test(compactRaw);
    const isMachineToken=/^[A-Z0-9_:/.-]{14,}$/.test(compactRaw) && /[_:/.-]/.test(compactRaw);
    const degree=nodeDegrees.get(n.id) || 0;
    const weight=Math.max(1, Number(n.weight || n.count || 1));
    const showLabel = !isHashLike && !isMachineToken && alphaChars >= 4 && (compactCanvas ? (n.kind !== 'memory' && (weight > 7.2 || degree > 2)) : (degree > 1 || weight > 4.2 || n.kind !== 'memory'));
    if(showLabel){
      const label=/^[A-Z][A-Z_\s-]{2,}$/.test(labelRaw) ? labelRaw.toLowerCase().replace(/(^|[_\s-])([a-z])/g, (_m, sep, ch) => (sep === '_' ? ' ' : sep) + ch.toUpperCase()) : labelRaw;
      const short=label.length>22?label.slice(0,19)+'…':label;
      ctx.font=`${Math.round((compactCanvas ? 9 : 10) + Math.min(3,Math.sqrt(weight)))}px Inter, system-ui, sans-serif`;
      const lx=p.x+drawn.halo*.55+6, ly=p.y+4, tw=ctx.measureText(short).width;
      const box={x:lx-4,y:ly-14,w:tw+8,h:19};
      const onCanvas=box.x>=10 && box.x+box.w<=w-10 && box.y>=10 && box.y+box.h<=h-10;
      const collides=labelBoxes.some(b => !(box.x+box.w<b.x || b.x+b.w<box.x || box.y+box.h<b.y || b.y+b.h<box.y));
      if(onCanvas && !collides){ labelBoxes.push(box); ctx.lineWidth=5; ctx.strokeStyle=c.bg; ctx.fillStyle=c.text; ctx.globalAlpha=Math.min(.82,.40+p.scale*.32) * (p.alpha || 1); ctx.strokeText(short,lx,ly); ctx.fillText(short,lx,ly); ctx.globalAlpha=1; }
    }
    hits.push({x:p.x,y:p.y,r:Math.max(15,drawn.halo*.75),node:n});
  });
  constellationScene.hits=hits;
  if(!window.matchMedia('(prefers-reduced-motion: reduce)').matches && isCanvasVisualiserActive()) constellationScene.frame=requestAnimationFrame(drawVisualiserFrame);
}
function neuralColors(){
  const light = document.documentElement.dataset.theme === 'light';
  return light ? { light:true, bg:'#f7f0e7', core:'rgba(24,128,107,.18)', mid:'rgba(185,54,46,.12)', star:'#087f73', memory:'#c63e35', text:'#252220', synapse:'rgba(18,116,100,.34)', synapseHot:'rgba(8,126,106,.62)', memorySynapse:'rgba(190,54,46,.58)' } : { light:false, bg:'#06100f', core:'rgba(34,130,111,.28)', mid:'rgba(95,31,29,.40)', star:'#66e8c6', memory:'#ff5f57', text:'#f6fbf7', synapse:'rgba(82,214,181,.22)', synapseHot:'rgba(90,238,196,.52)', memorySynapse:'rgba(255,95,87,.58)' };
}
function updateVisualiserModeUI(){
  const mode = constellationScene.visualiserMode === 'neural' ? 'neural' : 'constellation';
  $$('.visualiser-tabs button').forEach(b => b.classList.toggle('active', b.dataset.visualiser === mode));
  const wrap = $('#constellationCanvas')?.parentElement;
  if(wrap) wrap.dataset.visualiser = mode;
  const legend = $('.constellation-legend');
  if(legend) legend.innerHTML = mode === 'neural'
    ? '<span><i class="legend-dot entity"></i>Neuron hub</span><span><i class="legend-dot memory"></i>Memory soma</span><span><i class="legend-line"></i>Synapse</span>'
    : '<span><i class="legend-dot entity"></i>Entity/topic</span><span><i class="legend-dot memory"></i>Memory</span><span><i class="legend-line"></i>Link</span>';
  const help = $('#visualiserHelp');
  if(help) help.textContent = mode === 'neural' ? (window.matchMedia('(max-width: 760px)').matches ? 'Drag to orbit · Pan mode to move · pinch to zoom · tap a neuron.' : 'Drag to orbit the neural cloud · Pan mode/Shift-drag to pan · wheel/pinch to zoom.') : 'Drag to rotate · Pan mode/Shift-drag to pan · wheel/pinch to zoom.';
  const pause = $('#constellationPause');
  if(pause){ pause.style.display = ''; pause.textContent = constellationScene.paused ? (mode === 'neural' ? 'Resume drift' : 'Resume rotation') : (mode === 'neural' ? 'Pause drift' : 'Pause rotation'); }
  const pan = $('#constellationPanMode');
  if(pan) pan.textContent = constellationScene.mode === 'pan' ? (mode === 'neural' ? 'Orbit mode' : 'Rotate mode') : 'Pan mode';
}
function switchVisualiserMode(mode){
  constellationScene.visualiserMode = mode === 'neural' ? 'neural' : 'constellation';
  localStorage.setItem(VISUALISER_MODE_KEY, constellationScene.visualiserMode);
  constellationScene.drag = null;
  constellationScene.pointers.clear();
  Object.assign(constellationScene, constellationScene.visualiserMode === 'neural' ? { rotation:.34, tilt:.38, zoom:1, panX:0, panY:0, mode:'rotate', lastFrameTime:0, renderLastTime:0 } : { ...CONSTELLATION_DEFAULT_CAMERA, mode:'rotate', lastFrameTime:0, renderLastTime:0 });
  updateVisualiserModeUI();
  if(constellationScene.data) drawConstellation(constellationScene.data);
}
function drawVisualiserFrame(t=0){
  if(!isCanvasVisualiserActive()){ stopCanvasVisualiserLoop(); return; }
  const mode = constellationScene.visualiserMode === 'neural' ? 'neural' : 'constellation';
  const interval = 16;
  if(t && constellationScene.renderLastTime && t - constellationScene.renderLastTime < interval){
    constellationScene.frame = isCanvasVisualiserActive() ? requestAnimationFrame(drawVisualiserFrame) : 0;
    return;
  }
  constellationScene.renderLastTime = t || 0;
  if(mode === 'neural') drawNeuralFrame(t);
  else drawConstellationFrame(t);
}
function drawConstellationFrame(t=0){
  const canvas = $('#constellationCanvas');
  if(!canvas) return;
  const wrap = canvas.parentElement;
  // Use content-box dimensions only. getBoundingClientRect() includes the
  // wrapper border; writing that value back to canvas.style.height creates a
  // per-frame growth loop on mobile.
  const w = Math.max(320, wrap.clientWidth || canvas.clientWidth || 1000);
  const h = Math.max(430, wrap.clientHeight || canvas.clientHeight || 680);
  const compactCanvas = w < 620;
  const dpr = visualiserDpr(compactCanvas, 'constellation');
  if(canvas.width !== Math.floor(w*dpr) || canvas.height !== Math.floor(h*dpr)){ canvas.width = Math.floor(w*dpr); canvas.height = Math.floor(h*dpr); }
  const ctx = canvas.getContext('2d');
  if(!constellationScene.paused && !constellationScene.drag){
    const delta = constellationScene.lastFrameTime ? Math.min(48, t - constellationScene.lastFrameTime) : 16;
    constellationScene.rotation += delta * 0.000065;
  }
  constellationScene.lastFrameTime = t;
  ctx.setTransform(dpr,0,0,dpr,0,0);
  const c = constellationColors();
  clampConstellationCamera(w, h);
  ctx.clearRect(0,0,w,h);
  const bg = ctx.createRadialGradient(w*.52,h*.44,20,w*.52,h*.44,Math.max(w,h)*.72);
  bg.addColorStop(0, compactCanvas ? 'rgba(101,214,255,.055)' : c.nebula); bg.addColorStop(.45, compactCanvas ? 'rgba(60,110,150,.018)' : 'rgba(72,130,160,.035)'); bg.addColorStop(1,c.bg);
  ctx.fillStyle = bg; ctx.fillRect(0,0,w,h);
  constellationScene.stars.forEach((s)=>{ const pulse=.42 + Math.sin(t*s.freq + s.phase)*.34 + Math.sin(t*s.freq*.37 + s.phase*1.9)*.18; ctx.globalAlpha=s.a*Math.max(.12, Math.min(1, pulse))*(c.light ? .48 : .78); ctx.fillStyle=c.text; ctx.beginPath(); ctx.arc(s.x*w, s.y*h, s.r*(c.light ? .72 : .9), 0, Math.PI*2); ctx.fill(); });
  ctx.globalAlpha=1;
  const projected = new Map();
  constellationScene.nodes.forEach(n => projected.set(n.id, projectConstellationNode(n,w,h,t)));
  const edgeDegree = new Map();
  let edgeDrawn = 0;
  const edgeLimit = compactCanvas ? 44 : 140;
  const degreeLimit = compactCanvas ? 2 : 4;
  for(const e of constellationScene.edges){
    const a=projected.get(e.source), b=projected.get(e.target);
    if(!a || !b || !a.visible || !b.visible) continue;
    if(edgeDrawn >= edgeLimit) break;
    const da=edgeDegree.get(e.source) || 0, db=edgeDegree.get(e.target) || 0;
    if(da >= degreeLimit || db >= degreeLimit) continue;
    edgeDegree.set(e.source, da+1); edgeDegree.set(e.target, db+1); edgeDrawn++;
    const depthAlpha = Math.min(c.light ? .58 : .58, Math.max(c.light ? .24 : .24, (a.scale+b.scale) / (c.light ? 5.4 : 5.2)));
    ctx.strokeStyle = e.kind === 'memory' ? c.memoryEdge : c.edge;
    ctx.globalAlpha = depthAlpha * (compactCanvas ? .74 : .92);
    ctx.lineWidth = (c.light ? .68 : .78) + Math.max(a.scale,b.scale) * (c.light ? .20 : .26);
    ctx.setLineDash(e.kind === 'memory' ? [5,7] : [4,8]);
    ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
  }
  ctx.globalAlpha=1;
  ctx.setLineDash([]);
  const hits=[];
  const labelBoxes=[];
  const compactLabels = compactCanvas;
  const nodeDegrees = new Map();
  constellationScene.edges.forEach(e => { nodeDegrees.set(e.source, (nodeDegrees.get(e.source) || 0) + 1); nodeDegrees.set(e.target, (nodeDegrees.get(e.target) || 0) + 1); });
  const labelCounts = new Map();
  const categoryCounts = new Map();
  constellationScene.nodes.forEach(n => {
    const key=(n.label || '').replace(/^memory:/,'mem ').trim().toLowerCase();
    if(key) labelCounts.set(key, (labelCounts.get(key) || 0) + 1);
    const category=(n.category || '').trim().toLowerCase();
    if(category) categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1);
  });
  [...constellationScene.nodes].sort((a,b)=>projected.get(a.id).z-projected.get(b.id).z).forEach(n => {
    const p=projected.get(n.id); if(!p?.visible) return;
    const base=n.kind === 'memory' ? c.memory : c.star;
    const pulse=1 + Math.sin(t*(n.twinkleFreq || .0017) + n.twinkle*6.28)*(n.twinkleAmp || .09) + Math.sin(t*(n.twinkleFreq || .0017)*.43 + n.twinkle*11.7)*((n.twinkleAmp || .09)*.48);
    const weight = Math.max(1, Number(n.weight || n.count || 1));
    const starR = Math.min(compactCanvas ? 3.2 : 4.6, Math.max(compactCanvas ? .85 : 1.05, (1 + Math.sqrt(weight)) * p.scale * (compactCanvas ? .42 : .54))) * pulse;
    const important = weight > 3.2 || n.kind === 'memory';
    const flare = Math.min(compactCanvas ? 8.5 : 12.5, starR * (important ? 2.45 : 1.65));
    const halo = Math.max(2.4, starR * (important ? 3.2 : 2.35));
    ctx.globalAlpha=Math.max(c.light ? .14 : .10, Math.min(compactCanvas ? .28 : .34, p.scale * (compactCanvas ? .18 : .24)));
    const glow=ctx.createRadialGradient(p.x,p.y,0,p.x,p.y,halo);
    glow.addColorStop(0,'rgba(255,255,255,.92)'); glow.addColorStop(.18,base); glow.addColorStop(.62,base); glow.addColorStop(1,'rgba(0,0,0,0)');
    ctx.fillStyle=glow; ctx.beginPath(); ctx.arc(p.x,p.y,halo,0,Math.PI*2); ctx.fill();
    ctx.save();
    ctx.translate(p.x,p.y);
    ctx.rotate(t*.00012 + n.twinkle*Math.PI);
    ctx.shadowColor=base;
    ctx.shadowBlur=compactCanvas ? 3 : 5;
    ctx.strokeStyle=base;
    ctx.lineCap='round';
    const majorStar = weight > (compactCanvas ? 7.5 : 6.2) || (n.kind === 'memory' && weight > (compactCanvas ? 5.6 : 4.8));
    if(majorStar){
      ctx.globalAlpha=Math.max(.34, Math.min(.68, p.scale*.60));
      ctx.lineWidth=Math.max(.45, starR*.18);
      ctx.beginPath(); ctx.moveTo(-flare,0); ctx.lineTo(flare,0); ctx.moveTo(0,-flare); ctx.lineTo(0,flare); ctx.stroke();
      ctx.globalAlpha=Math.max(.16, Math.min(.36, p.scale*.32));
      ctx.lineWidth=Math.max(.35, starR*.13);
      const diag=flare*.45;
      ctx.beginPath(); ctx.moveTo(-diag,-diag); ctx.lineTo(diag,diag); ctx.moveTo(-diag,diag); ctx.lineTo(diag,-diag); ctx.stroke();
    }
    ctx.shadowBlur=compactCanvas ? 5 : 7;
    ctx.globalAlpha=.96;
    ctx.fillStyle='rgba(255,255,255,.98)';
    ctx.beginPath(); ctx.arc(0,0,Math.max(.62, starR*.52),0,Math.PI*2); ctx.fill();
    ctx.fillStyle=base;
    ctx.globalAlpha=.72;
    ctx.beginPath(); ctx.arc(0,0,Math.max(.28, starR*.20),0,Math.PI*2); ctx.fill();
    ctx.globalAlpha=1;
    ctx.restore();
    const labelRaw=(n.label || '').replace(/^memory:/,'mem ');
    const labelKey=labelRaw.trim().toLowerCase();
    const compactRaw=labelRaw.trim();
    const alphaChars=(compactRaw.match(/[A-Za-z]/g) || []).length;
    const isHashLike=/^[a-f0-9]{10,}$/i.test(compactRaw) || /^mem\s+[a-f0-9]{6,}$/i.test(compactRaw);
    const isMachineToken=/^[A-Z0-9_:/.-]{14,}$/.test(compactRaw) && /[_:/.-]/.test(compactRaw);
    const isDateLike=/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(compactRaw);
    const lowInformation=alphaChars < 4;
    const technicalLabel=isHashLike || isMachineToken || isDateLike || lowInformation;
    const degree = nodeDegrees.get(n.id) || 0;
    const frequency = labelCounts.get(labelKey) || 1;
    const categoryFrequency = categoryCounts.get((n.category || '').trim().toLowerCase()) || 1;
    const dominantCategory = categoryFrequency > constellationScene.nodes.length * .35;
    const shoutingDominantToken = /^[A-Z]{4,}$/.test(compactRaw) && dominantCategory;
    const specificity = Math.max(.35, Math.min(1.15, 1 / Math.sqrt(frequency)));
    const categorySpecificity = Math.max(.05, Math.min(1.10, Math.log1p(constellationScene.nodes.length / categoryFrequency) / 2.4));
    const lengthQuality = Math.max(.25, Math.min(1.1, (alphaChars - 2) / 8));
    const labelScore = (p.scale * 2.05) + (Math.log1p(weight) * .52) + (Math.log1p(degree) * .38) + specificity + categorySpecificity + lengthQuality + (n.kind === 'memory' ? .15 : 0) - (shoutingDominantToken ? 1.25 : 0);
    const showLabel = !technicalLabel && (compactLabels ? labelScore > 4.15 : labelScore > 3.95);
    if(showLabel){
      const label=/^[A-Z][A-Z_\s-]{2,}$/.test(labelRaw) ? labelRaw.toLowerCase().replace(/(^|[_\s-])([a-z])/g, (_m, sep, ch) => (sep === '_' ? ' ' : sep) + ch.toUpperCase()) : labelRaw;
      const short=label.length>22?label.slice(0,19)+'…':label;
      ctx.font=`${Math.round((compactLabels ? 9 : 10) + p.scale*2.5)}px Inter, system-ui, sans-serif`;
      const lx=p.x+flare+6, ly=p.y+4, tw=ctx.measureText(short).width;
      const labelPad = compactLabels ? 4 : 4;
      const box={x:lx-labelPad,y:ly-(compactLabels ? 13 : 14),w:tw+labelPad*2,h:compactLabels ? 18 : 19};
      const onCanvas=box.x>=10 && box.x+box.w<=w-10 && box.y>=10 && box.y+box.h<=h-10;
      const collides=labelBoxes.some(b => !(box.x+box.w<b.x || b.x+b.w<box.x || box.y+box.h<b.y || b.y+b.h<box.y));
      if(onCanvas && !collides){ labelBoxes.push(box); ctx.lineWidth=5; ctx.strokeStyle=c.bg; ctx.fillStyle=c.text; ctx.globalAlpha=Math.min(.78,.30+p.scale*.42); ctx.strokeText(short,lx,ly); ctx.fillText(short,lx,ly); ctx.globalAlpha=1; }
    }
    hits.push({x:p.x,y:p.y,r:Math.max(14,flare+8),node:n});
  });
  constellationScene.hits=hits;
  if(!window.matchMedia('(prefers-reduced-motion: reduce)').matches && isCanvasVisualiserActive()) constellationScene.frame=requestAnimationFrame(drawVisualiserFrame);
}
function clampConstellationCamera(w, h){
  constellationScene.zoom = Math.max(CONSTELLATION_MIN_ZOOM, Math.min(CONSTELLATION_MAX_ZOOM, Number.isFinite(constellationScene.zoom) ? constellationScene.zoom : 1));
  constellationScene.rotation = Number.isFinite(constellationScene.rotation) ? constellationScene.rotation : 0;
  constellationScene.tilt = Math.max(-1.05, Math.min(1.05, Number.isFinite(constellationScene.tilt) ? constellationScene.tilt : .35));
  const panLimitX = Math.max(80, w * (.24 + constellationScene.zoom * .22));
  const panLimitY = Math.max(90, h * (.16 + constellationScene.zoom * .14));
  constellationScene.panX = Math.max(-panLimitX, Math.min(panLimitX, Number.isFinite(constellationScene.panX) ? constellationScene.panX : 0));
  constellationScene.panY = Math.max(-panLimitY, Math.min(panLimitY, Number.isFinite(constellationScene.panY) ? constellationScene.panY : 0));
}
function resetConstellationView(){
  Object.assign(constellationScene, constellationScene.visualiserMode === 'neural' ? { rotation:.34, tilt:.38, zoom:1, panX:0, panY:0, mode:'rotate', drag:null, lastFrameTime:0, renderLastTime:0 } : { ...CONSTELLATION_DEFAULT_CAMERA, mode:'rotate', drag:null, lastFrameTime:0, renderLastTime:0 });
  constellationScene.pointers.clear();
  updateConstellationPauseButton();
  updateConstellationPanButton();
  updateVisualiserModeUI();
}
function updateConstellationPauseButton(){
  const btn = $('#constellationPause');
  if(btn) btn.textContent = constellationScene.paused ? (constellationScene.visualiserMode === 'neural' ? 'Resume drift' : 'Resume rotation') : (constellationScene.visualiserMode === 'neural' ? 'Pause drift' : 'Pause rotation');
}
function updateConstellationPanButton(){
  const btn = $('#constellationPanMode');
  if(btn) btn.textContent = constellationScene.mode === 'pan' ? (constellationScene.visualiserMode === 'neural' ? 'Orbit mode' : 'Rotate mode') : 'Pan mode';
}
function toggleConstellationPanMode(){
  constellationScene.mode = constellationScene.mode === 'pan' ? 'rotate' : 'pan';
  updateConstellationPanButton();
}
function toggleConstellationPause(){
  constellationScene.paused = !constellationScene.paused;
  constellationScene.lastFrameTime = 0;
  updateConstellationPauseButton();
}
function zoomConstellation(factor, cx, cy){
  constellationScene.lastInteraction = performance.now();
  const canvas = $('#constellationCanvas');
  if(!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const oldZoom = constellationScene.zoom;
  const nextZoom = Math.max(CONSTELLATION_MIN_ZOOM, Math.min(CONSTELLATION_MAX_ZOOM, oldZoom * factor));
  if(Math.abs(nextZoom - oldZoom) < .001) return;
  const x = cx - rect.left - rect.width/2 - constellationScene.panX;
  const y = cy - rect.top - rect.height/2 - constellationScene.panY;
  const ratio = nextZoom / oldZoom;
  constellationScene.panX -= x * (ratio - 1);
  constellationScene.panY -= y * (ratio - 1);
  constellationScene.zoom = nextZoom;
  clampConstellationCamera(rect.width, rect.height);
}
function bindConstellationControls(canvas){
  if(canvas.dataset.controlsBound === 'true') return;
  canvas.dataset.controlsBound = 'true';
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    zoomConstellation(Math.exp(-e.deltaY * 0.0012), e.clientX, e.clientY);
  }, { passive:false });
  canvas.addEventListener('pointerdown', e => {
    constellationScene.lastInteraction = performance.now();
    if(e.cancelable) e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch(_err) {}
    constellationScene.pointers.set(e.pointerId, { x:e.clientX, y:e.clientY });
    if(constellationScene.pointers.size === 2){
      const pts=[...constellationScene.pointers.values()];
      constellationScene.drag = { mode:'pinch', dist:Math.hypot(pts[0].x-pts[1].x, pts[0].y-pts[1].y), midX:(pts[0].x+pts[1].x)/2, midY:(pts[0].y+pts[1].y)/2, zoom:constellationScene.zoom, panX:constellationScene.panX, panY:constellationScene.panY };
      return;
    }
    constellationScene.drag = { mode:(constellationScene.mode === 'pan' || e.shiftKey || e.button === 1 || e.button === 2) ? 'pan' : 'rotate', x:e.clientX, y:e.clientY, rotation:constellationScene.rotation, tilt:constellationScene.tilt, panX:constellationScene.panX, panY:constellationScene.panY, moved:false };
  });
  canvas.addEventListener('pointermove', e => {
    if(constellationScene.drag) constellationScene.lastInteraction = performance.now();
    if(constellationScene.drag && e.cancelable) e.preventDefault();
    if(constellationScene.pointers.has(e.pointerId)) constellationScene.pointers.set(e.pointerId, { x:e.clientX, y:e.clientY });
    const d = constellationScene.drag;
    if(!d) return;
    if(d.mode === 'pinch'){
      if(constellationScene.pointers.size < 2) return;
      const pts=[...constellationScene.pointers.values()];
      const dist=Math.max(1, Math.hypot(pts[0].x-pts[1].x, pts[0].y-pts[1].y));
      const midX=(pts[0].x+pts[1].x)/2, midY=(pts[0].y+pts[1].y)/2;
      constellationScene.zoom = Math.max(CONSTELLATION_MIN_ZOOM, Math.min(CONSTELLATION_MAX_ZOOM, d.zoom * (dist / Math.max(1, d.dist))));
      constellationScene.panX = d.panX + (midX - d.midX);
      constellationScene.panY = d.panY + (midY - d.midY);
      clampConstellationCamera(canvas.clientWidth || canvas.getBoundingClientRect().width, canvas.clientHeight || canvas.getBoundingClientRect().height);
      return;
    }
    const dx=e.clientX-d.x, dy=e.clientY-d.y;
    if(Math.abs(dx)+Math.abs(dy) > 3) d.moved = true;
    if(d.mode === 'pan'){
      constellationScene.panX = d.panX + dx;
      constellationScene.panY = d.panY + dy;
      canvas.style.cursor = 'grabbing';
    } else {
      constellationScene.rotation = d.rotation + dx * 0.008;
      constellationScene.tilt = Math.max(-1.05, Math.min(1.05, d.tilt + dy * 0.006));
      canvas.style.cursor = 'grabbing';
    }
  });
  const endPointer = e => {
    constellationScene.pointers.delete(e.pointerId);
    if(constellationScene.pointers.size === 0){
      if(constellationScene.drag?.moved) canvas.dataset.suppressClick = 'true';
      constellationScene.drag = null;
      constellationScene.lastInteraction = performance.now();
      canvas.style.cursor = 'grab';
    }
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
}
function drawConstellation(data){
  if(!isCanvasVisualiserActive()) return;
  if(constellationScene.frame) cancelAnimationFrame(constellationScene.frame);
  constellationScene.frame = 0;
  constellationScene.renderLastTime = 0;
  if(constellationScene.visualiserMode === 'neural') buildNeuralMapScene(data); else buildConstellationScene(data);
  updateVisualiserModeUI();
  const canvas = $('#constellationCanvas');
  bindConstellationControls(canvas);
  canvas.onclick = e => { if(canvas.dataset.suppressClick === 'true'){ canvas.dataset.suppressClick = 'false'; return; } const rect=canvas.getBoundingClientRect(); const x=e.clientX-rect.left, y=e.clientY-rect.top; const hit=[...constellationScene.hits].reverse().find(h => Math.hypot(h.x-x,h.y-y) <= h.r); if(hit) inspectConstellationNode(hit.node); };
  canvas.onpointermove = e => { if(constellationScene.drag) return; const rect=canvas.getBoundingClientRect(); const x=e.clientX-rect.left, y=e.clientY-rect.top; canvas.style.cursor = constellationScene.hits.some(h => Math.hypot(h.x-x,h.y-y) <= h.r) ? 'pointer' : 'grab'; };
  $('#constellationClusters').innerHTML = (data.clusters || []).map(c => `<span class="cluster-pill">${esc(c.label)} <strong>${Number(c.count).toLocaleString()}</strong></span>`).join('');
  constellationInspectorDefault();
  drawVisualiserFrame(0);
}
async function loadConstellation(){ drawConstellation(await api('/api/constellation?limit=240')); }
async function loadDiagnostics(){
  const diag = await api('/api/diagnostics');
  const counts = diag.table_counts || {};
  const core = ['working_memory','episodic_memory','triples','consolidation_log'].filter(t => t in counts);
  $('#diagnosticsSummary').innerHTML = `
    <div class="diag-row"><span>Status</span><strong>${diag.ok ? 'OK' : 'Needs attention'}</strong></div>
    <div class="diag-row"><span>DB path</span><strong title="${esc(diag.db_path)}">${esc(diag.db_path)}</strong></div>
    <div class="diag-row"><span>Readable</span><strong>${diag.readable ? 'yes' : 'no'}</strong></div>
    <div class="diag-row"><span>Size</span><strong>${fmtBytes(diag.size_bytes)}</strong></div>
    <div class="diag-row"><span>Last modified</span><strong>${esc(diag.modified_at || 'n/a')}</strong></div>
    <div class="diag-row"><span>Tables</span><strong>${esc((diag.tables || []).length)}</strong></div>
    <div class="diag-row wide"><span>Core rows</span><strong>${core.map(t => `${t}: ${Number(counts[t] || 0).toLocaleString()}`).join(' · ') || 'none'}</strong></div>`;
  $('#diagnosticsStatus').textContent = diag.error || ((diag.missing_expected_tables || []).length ? `Missing expected tables: ${diag.missing_expected_tables.join(', ')}` : 'Database looks healthy.');
  window.lastDiagnostics = diag;
}
async function copyDiagnostics(){
  if(!window.lastDiagnostics) await loadDiagnostics();
  showSelectableCopy('Diagnostics JSON', JSON.stringify(window.lastDiagnostics, null, 2));
}
async function refreshAuthState(){
  authState = await api('/api/auth/status');
  return authState;
}
async function loadAuthStatus(){
  const data = await refreshAuthState();
  const cfg = data.config || {};
  $('#configHost').value = cfg.host || '';
  $('#configPort').value = cfg.port || '';
  $('#configDbPath').value = cfg.db_path || '';
  const urls = [`This Mac: ${cfg.local_url || ''}`];
  if (cfg.lan_url) urls.push(`LAN: ${cfg.lan_url}`);
  $('#configStatus').textContent = `Current access URLs — ${urls.join(' · ')}`;
  authState = data;
  $('#authEnabled').checked = !!data.auth_enabled;
  $('#authStatus').textContent = data.has_password ? 'Password is set.' : 'No password set.';
  $('#memoryAdminEnabled').checked = !!cfg.memory_admin_enabled;
  $('#memoryAdminStatus').textContent = cfg.memory_admin_enabled ? (['127.0.0.1','localhost','::1'].includes(cfg.host || '0.0.0.0') ? 'Local-only admin mode is enabled. Mutations are audited; password is only required for LAN/non-local hosts.' : 'Admin maintenance mode is enabled. LAN/non-local mutations require password auth and are audited.') : 'Admin maintenance mode is disabled; dashboard is read-only.';
}

function graphInspectorDefault(){
  $('#graphInspector').innerHTML = `<div class="inspector-kicker">Graph inspector</div><h3>Nothing selected</h3><p class="muted">Pick a node or edge to inspect connected triples, then jump into the Triples table.</p>`;
}
function inspectNode(node){
  const connected = graphState.edges.filter(e => e.source === node.id || e.target === node.id);
  $$('.node, .edge, .edgeLabel').forEach(x => x.classList.remove('selected','dim'));
  $$('.node').forEach(x => { if(x.dataset.id !== node.id) x.classList.add('dim'); });
  connected.forEach(e => {
    const edgeEl = document.querySelector(`.edge[data-id="${CSS.escape(e.id)}"]`);
    const labelEl = document.querySelector(`.edgeLabel[data-id="${CSS.escape(e.id)}"]`);
    if(edgeEl) edgeEl.classList.add('selected');
    if(labelEl) labelEl.classList.add('selected');
  });
  const rows = connected.slice(0,12).map(e => `<button class="inspector-row" data-edge="${esc(e.id)}"><strong>${esc(e.predicate)}</strong><span>${esc(e.subject)} → ${esc(e.object)}</span></button>`).join('');
  $('#graphInspector').innerHTML = `<div class="inspector-kicker">Selected node</div><h3>${esc(node.label)}</h3><p class="muted">${connected.length} connected triple${connected.length === 1 ? '' : 's'}.</p><div class="inspector-actions"><button id="graphFilterTriples" class="primary tiny">Show in Triples</button><button id="graphSearchMemories" class="tiny">Search memories</button></div><div class="inspector-list">${rows || '<p class="muted">No connected edges.</p>'}</div>`;
  $('#graphFilterTriples').onclick = () => { $('#tripleQuery').value = node.label; switchTab('triples'); };
  $('#graphSearchMemories').onclick = () => { $('#memoryQuery').value = node.label; switchTab('memories'); };
  $$('#graphInspector .inspector-row').forEach(btn => btn.onclick = () => inspectEdge(graphState.edges.find(e => e.id === btn.dataset.edge)));
}
function inspectEdge(edge){
  if(!edge) return;
  $$('.node, .edge, .edgeLabel').forEach(x => x.classList.remove('selected','dim'));
  $$('.edge').forEach(x => { if(x.dataset.id !== edge.id) x.classList.add('dim'); });
  const edgeEl = document.querySelector(`.edge[data-id="${CSS.escape(edge.id)}"]`);
  const labelEl = document.querySelector(`.edgeLabel[data-id="${CSS.escape(edge.id)}"]`);
  if(edgeEl) edgeEl.classList.add('selected');
  if(labelEl) labelEl.classList.add('selected');
  $('#graphInspector').innerHTML = `<div class="inspector-kicker">Selected triple</div><h3>${esc(edge.predicate)}</h3><p><strong>${esc(edge.subject)}</strong> → <strong>${esc(edge.object)}</strong></p><p class="muted">Confidence: ${esc(edge.confidence ?? 'n/a')} · ${esc(edge.created_at || edge.valid_from || '')}</p><div class="inspector-actions"><button id="edgeDetail" class="primary tiny">Inspect JSON</button><button id="edgeTriples" class="tiny">Show in Triples</button></div>`;
  $('#edgeDetail').onclick = () => showDetail(edge, 'Triple edge detail');
  $('#edgeTriples').onclick = () => { $('#tripleQuery').value = `${edge.subject} ${edge.predicate} ${edge.object}`; switchTab('triples'); };
}
function applyGraphView(){
  const vp = $('#graphViewport');
  if(vp) vp.setAttribute('transform', `translate(${graphView.x} ${graphView.y}) scale(${graphView.scale})`);
}
function resetGraphView(){ graphView = { scale:1, x:0, y:0, dragging:false, sx:0, sy:0, ox:0, oy:0 }; applyGraphView(); }
function bindGraphPanZoom(){
  const svg = $('#graphSvg');
  if(!svg || svg.dataset.panzoomBound) return;
  svg.dataset.panzoomBound = '1';
  svg.addEventListener('wheel', e => {
    e.preventDefault();
    const rect = svg.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width * 1000;
    const py = (e.clientY - rect.top) / rect.height * 650;
    const old = graphView.scale;
    const next = Math.max(0.35, Math.min(4, old * (e.deltaY < 0 ? 1.12 : 0.88)));
    graphView.x = px - (px - graphView.x) * (next / old);
    graphView.y = py - (py - graphView.y) * (next / old);
    graphView.scale = next;
    applyGraphView();
  }, { passive:false });
  svg.addEventListener('pointerdown', e => { if(e.target.closest('.node,.edge,.edgeLabel')) return; graphView.dragging = true; graphView.sx = e.clientX; graphView.sy = e.clientY; graphView.ox = graphView.x; graphView.oy = graphView.y; svg.setPointerCapture(e.pointerId); svg.classList.add('panning'); });
  svg.addEventListener('pointermove', e => { if(!graphView.dragging) return; graphView.x = graphView.ox + (e.clientX - graphView.sx); graphView.y = graphView.oy + (e.clientY - graphView.sy); applyGraphView(); });
  svg.addEventListener('pointerup', e => { graphView.dragging = false; svg.classList.remove('panning'); try{ svg.releasePointerCapture(e.pointerId); }catch{} });
  svg.addEventListener('pointerleave', () => { graphView.dragging = false; svg.classList.remove('panning'); });
}
function drawGraph(g){
  const svg = $('#graphSvg'); svg.innerHTML = '';
  graphState = { ...g, byId: Object.fromEntries(g.nodes.map(n => [n.id, n])) };
  svg.insertAdjacentHTML('afterbegin', `<defs><linearGradient id="edgeGradient" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="#65d6ff" stop-opacity=".25"/><stop offset="55%" stop-color="#7c7cff" stop-opacity=".78"/><stop offset="100%" stop-color="#ffd166" stop-opacity=".35"/></linearGradient></defs><g id="graphViewport"></g>`);
  const vp = $('#graphViewport');
  const w=1000,h=650,cx=w/2,cy=h/2,r=260;
  const nodes = g.nodes.slice(0,160).map((n,i,a)=>({...n,x:cx+Math.cos(i/a.length*Math.PI*2)*r*(.65+((i%5)/10)),y:cy+Math.sin(i/a.length*Math.PI*2)*r*(.65+((i%7)/14))}));
  const byId = Object.fromEntries(nodes.map(n=>[n.id,n]));
  graphState.nodes = nodes; graphState.byId = byId;
  const edges = g.edges.filter(e=>byId[e.source]&&byId[e.target]).slice(0,300);
  graphState.edges = edges;
  if(!nodes.length){ svg.insertAdjacentHTML('beforeend', '<text x="500" y="325" text-anchor="middle" class="nodeText">No triples match this graph filter. Add facts with mnemosyne_triple_add or mnemosyne_remember(... extract=true).</text>'); graphInspectorDefault(); bindGraphPanZoom(); return; }
  for(const e of edges){ const s=byId[e.source], t=byId[e.target];
    const line = document.createElementNS('http://www.w3.org/2000/svg','line'); line.setAttribute('x1',s.x);line.setAttribute('y1',s.y);line.setAttribute('x2',t.x);line.setAttribute('y2',t.y);line.setAttribute('class','edge'); line.dataset.id = e.id; line.onclick = () => inspectEdge(e); vp.appendChild(line);
    const label = document.createElementNS('http://www.w3.org/2000/svg','text'); label.textContent=e.predicate; label.setAttribute('x',(s.x+t.x)/2);label.setAttribute('y',(s.y+t.y)/2);label.setAttribute('class','edgeLabel'); label.dataset.id = e.id; label.onclick = () => inspectEdge(e); vp.appendChild(label);
  }
  for(const n of nodes){
    const c=document.createElementNS('http://www.w3.org/2000/svg','circle'); c.setAttribute('cx',n.x);c.setAttribute('cy',n.y);c.setAttribute('r',Math.min(14, 6 + Math.sqrt(n.count || 1)));c.setAttribute('class','node'); c.dataset.id = n.id; c.onclick = () => inspectNode(n); vp.appendChild(c);
    const text=document.createElementNS('http://www.w3.org/2000/svg','text'); text.textContent=n.label.length>38?n.label.slice(0,35)+'…':n.label; text.setAttribute('x',n.x+12);text.setAttribute('y',n.y+4);text.setAttribute('class','nodeText'); text.dataset.id = n.id; text.onclick = () => inspectNode(n); vp.appendChild(text);
  }
  resetGraphView();
  bindGraphPanZoom();
  graphInspectorDefault();
  centerGraphOnMobile();
}
function centerGraphOnMobile(){
  const wrap = document.querySelector('.graph-wrap');
  if(!wrap || !window.matchMedia('(max-width: 760px)').matches) return;
  requestAnimationFrame(() => {
    wrap.scrollLeft = Math.max(0, (wrap.scrollWidth - wrap.clientWidth) / 2);
  });
}
async function loadGraph(){
  const q = encodeURIComponent($('#graphQuery')?.value.trim() || '');
  drawGraph(await api(`/api/graph?q=${q}&limit=300`));
}


let threeModulePromise = null;
let threeVis = {
  mode: 'constellation', data: null, renderer: null, scene: null, camera: null, group: null,
  nodes: [], edgePairs: [], labels: [], pulses: [], frame: 0, paused: false, panMode: false,
  drag: null, pointer: new Map(), yaw: 0, pitch: 0.32, cameraZ: 780, panX: 0, panY: 0, lastT: 0
};
function loadThreeModule(){
  if(!threeModulePromise) threeModulePromise = import('/static/vendor/three.module.min.js');
  return threeModulePromise;
}
function threeInspectorDefault(){
  const neural = threeVis.mode === 'neural';
  $('#threeInspector').innerHTML = neural
    ? `<div class="inspector-kicker">Neural inspector</div><h3>Nothing selected</h3><p class="muted">Pick a neuron hub, memory soma, or synapse to inspect the underlying read-only source.</p>`
    : `<div class="inspector-kicker">Constellation inspector</div><h3>Nothing selected</h3><p class="muted">Pick a star, memory, or link to inspect the underlying read-only source.</p>`;
}
function inspectThreeNode(node){
  const mode = threeVis.mode === 'neural' ? 'Neural Map 3D' : 'Constellation 3D';
  $('#threeInspector').innerHTML = `<div class="inspector-kicker">${mode} · ${esc(node.kind || 'entity')}</div><h3>${esc(node.label)}</h3><p class="muted">${esc(node.category || 'Other')} · ${Number(node.count || 0).toLocaleString()} signal(s) · weight ${Number(node.weight || 0).toFixed(2)}</p>${node.preview ? `<p>${esc(node.preview)}</p>` : ''}<div class="inspector-actions">${node.memory_id ? '<button id="threeMemory" class="primary tiny">Open memory</button>' : ''}<button id="threeSearch" class="tiny">Search this</button></div>`;
  if(node.memory_id) $('#threeMemory').onclick = () => openMemoryDetail(node.memory_id);
  $('#threeSearch').onclick = () => { $('#memoryQuery').value = String(node.label || '').replace(/^memory:/,''); switchTab('memories'); };
}
function updateThreeUI(){
  $$('.visualiser-tabs button[data-three-mode]').forEach(b => b.classList.toggle('active', b.dataset.threeMode === threeVis.mode));
  const viewport = $('#threeViewport'); if(viewport) viewport.dataset.threeMode = threeVis.mode;
  const legend = $('#threeLegend');
  if(legend) legend.innerHTML = threeVis.mode === 'neural'
    ? '<span><i class="legend-dot entity"></i>Neuron hub</span><span><i class="legend-dot memory"></i>Memory soma</span><span><i class="legend-line"></i>Synapse</span>'
    : '<span><i class="legend-dot entity"></i>Entity/topic</span><span><i class="legend-dot memory"></i>Memory</span><span><i class="legend-line"></i>Link</span>';
  const help = $('#threeHelp'); if(help) help.textContent = threeVis.mode === 'neural'
    ? (window.matchMedia('(max-width: 760px)').matches ? 'Drag to orbit · Pan mode to move · pinch to zoom · tap a neuron.' : 'Drag to orbit the neural cloud · Pan mode/Shift-drag to pan · wheel/pinch to zoom.')
    : 'Drag to rotate · Pan mode/Shift-drag to pan · wheel/pinch to zoom.';
  const pause = $('#threePause'); if(pause) pause.textContent = threeVis.paused ? (threeVis.mode === 'neural' ? 'Resume drift' : 'Resume rotation') : (threeVis.mode === 'neural' ? 'Pause drift' : 'Pause rotation');
  const pan = $('#threePanMode'); if(pan) pan.textContent = threeVis.panMode ? 'Orbit mode' : 'Pan mode';
}
function resetThreeCamera(){ Object.assign(threeVis, { yaw: threeVis.mode === 'neural' ? .12 : .70, pitch: threeVis.mode === 'neural' ? .10 : .96, cameraZ: threeVis.mode === 'neural' ? 600 : 760, panX:0, panY: threeVis.mode === 'neural' ? -10 : -84, lastT:0 }); }
function clearThreeScene(){
  if(threeVis.frame) cancelAnimationFrame(threeVis.frame);
  threeVis.frame = 0;
  if(threeVis.renderer){ threeVis.renderer.dispose(); threeVis.renderer.domElement.remove(); }
  $('#threeLabels').innerHTML = '';
  Object.assign(threeVis, { renderer:null, scene:null, camera:null, group:null, nodes:[], edgePairs:[], labels:[], pulses:[] });
}
function cssHexToInt(hex){
  const m = String(hex || '').match(/^#([0-9a-f]{6})$/i);
  return m ? parseInt(m[1], 16) : 0xffffff;
}
function colorForTheme(){
  const c = threeVis.mode === 'neural' ? neuralColors() : constellationColors();
  return {
    bg: cssHexToInt(c.bg),
    entity: cssHexToInt(c.star),
    memory: cssHexToInt(c.memory),
    link: cssHexToInt(threeVis.mode === 'neural' ? (c.light ? '#127464' : '#52d6b5') : (c.light ? '#19416c' : '#c6e0ff')),
    pulse: cssHexToInt(threeVis.mode === 'neural' ? (c.light ? '#6f6048' : '#fffaf0') : c.memory),
    text: c.text,
    light: c.light
  };
}
function makePointTexture(THREE, kind){
  const canvas = document.createElement('canvas');
  canvas.width = 128; canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const cx=64, cy=64;
  if(kind === 'star'){
    const g=ctx.createRadialGradient(cx,cy,0,cx,cy,60);
    g.addColorStop(0,'rgba(255,255,255,1)');
    g.addColorStop(.28,'rgba(255,255,255,.92)');
    g.addColorStop(.58,'rgba(255,255,255,.38)');
    g.addColorStop(1,'rgba(255,255,255,0)');
    ctx.fillStyle=g; ctx.beginPath(); ctx.arc(cx,cy,60,0,Math.PI*2); ctx.fill();
    ctx.strokeStyle='rgba(255,255,255,.72)'; ctx.lineWidth=1.3;
    ctx.beginPath(); ctx.moveTo(cx,14); ctx.lineTo(cx,114); ctx.moveTo(14,cy); ctx.lineTo(114,cy); ctx.stroke();
  } else if(kind === 'neuron') {
    const g=ctx.createRadialGradient(cx,cy,0,cx,cy,62);
    g.addColorStop(0,'rgba(255,255,255,1)');
    g.addColorStop(.13,'rgba(255,255,255,.94)');
    g.addColorStop(.42,'rgba(255,255,255,.28)');
    g.addColorStop(1,'rgba(255,255,255,0)');
    ctx.fillStyle=g; ctx.beginPath(); ctx.arc(cx,cy,61,0,Math.PI*2); ctx.fill();
    ctx.strokeStyle='rgba(255,255,255,.70)'; ctx.lineCap='round'; ctx.lineJoin='round';
    for(let i=0;i<9;i++){
      const a=(i/9)*Math.PI*2 + .13;
      const len=22 + (i%4)*4;
      const fork=len*.62;
      const sx=cx+Math.cos(a)*13, sy=cy+Math.sin(a)*13;
      const mx=cx+Math.cos(a+.10*Math.sin(i))*fork, my=cy+Math.sin(a+.10*Math.sin(i))*fork;
      const ex=cx+Math.cos(a)*len, ey=cy+Math.sin(a)*len;
      ctx.lineWidth=i%3===0?2.25:1.45;
      ctx.beginPath(); ctx.moveTo(sx,sy); ctx.quadraticCurveTo(mx,my,ex,ey); ctx.stroke();
      ctx.lineWidth=.9;
      ctx.globalAlpha=.72;
      ctx.beginPath(); ctx.moveTo(mx,my); ctx.lineTo(cx+Math.cos(a+.38)*len*.66,cy+Math.sin(a+.38)*len*.66); ctx.stroke();
      if(i%3===0){ ctx.beginPath(); ctx.moveTo(mx,my); ctx.lineTo(cx+Math.cos(a-.34)*len*.60,cy+Math.sin(a-.34)*len*.60); ctx.stroke(); }
      ctx.globalAlpha=1;
    }
    ctx.fillStyle='rgba(255,255,255,.98)'; ctx.beginPath(); ctx.arc(cx,cy,34,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='rgba(255,255,255,.54)'; ctx.beginPath(); ctx.arc(cx-8,cy-9,8,0,Math.PI*2); ctx.fill();
  } else if(kind === 'soma') {
    const g=ctx.createRadialGradient(cx,cy,0,cx,cy,62);
    g.addColorStop(0,'rgba(255,255,255,1)');
    g.addColorStop(.18,'rgba(255,255,255,.96)');
    g.addColorStop(.42,'rgba(255,255,255,.34)');
    g.addColorStop(1,'rgba(255,255,255,0)');
    ctx.fillStyle=g; ctx.beginPath(); ctx.arc(cx,cy,62,0,Math.PI*2); ctx.fill();
    ctx.strokeStyle='rgba(255,255,255,.68)'; ctx.lineCap='round'; ctx.lineWidth=1.55;
    for(let i=0;i<5;i++){
      const a=(i/5)*Math.PI*2+.22, len=21+(i%2)*4;
      ctx.beginPath(); ctx.moveTo(cx+Math.cos(a)*18,cy+Math.sin(a)*18); ctx.lineTo(cx+Math.cos(a)*len,cy+Math.sin(a)*len); ctx.stroke();
    }
    ctx.lineWidth=3.4; ctx.beginPath(); ctx.arc(cx,cy,40,0,Math.PI*2); ctx.stroke();
    ctx.fillStyle='rgba(255,255,255,1)'; ctx.beginPath(); ctx.arc(cx,cy,35,0,Math.PI*2); ctx.fill();
  } else {
    const g=ctx.createRadialGradient(cx,cy,0,cx,cy,60);
    g.addColorStop(0,'rgba(255,255,255,1)');
    g.addColorStop(.44,'rgba(255,255,255,.82)');
    g.addColorStop(.78,'rgba(255,255,255,.22)');
    g.addColorStop(1,'rgba(255,255,255,0)');
    ctx.fillStyle=g; ctx.beginPath(); ctx.arc(cx,cy,60,0,Math.PI*2); ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}
function buildThreePositions(data){
  if(threeVis.mode === 'neural') return buildThreeNeuralPositions(data);
  const nodes = (data.nodes || []).slice(0,160).map(n => ({...n}));
  const categories = [...new Set(nodes.map(n => n.category || 'Other'))];
  const catIndex = Object.fromEntries(categories.map((c,i)=>[c,i]));
  nodes.forEach((n,i) => {
    const cat = n.category || 'Other';
    const ci = catIndex[cat] || 0;
    const weight = Math.max(1, Number(n.weight || n.count || 1));
    const shell = n.kind === 'memory' ? 1.12 : .74 + (ci % 3) * .10;
    const radius = 285 * shell + (i % 7) * 18 + Math.min(46, Math.sqrt(weight) * 5.5);
    const longitude = ((i * 137.508 + ci * 23) % 360) * Math.PI / 180;
    const latitudeSeed = (((i * 53 + ci * 29) % 101) + .5) / 101;
    const latitude = Math.acos(1 - 2 * latitudeSeed) - Math.PI / 2;
    const radial = Math.cos(latitude);
    const orbitBias = Math.sin((i / Math.max(nodes.length,1)) * Math.PI * 2 + ci * .62) * 22;
    n.x = Math.cos(longitude) * radial * radius;
    n.y = Math.sin(latitude) * radius * .92 + orbitBias;
    n.z = Math.sin(longitude) * radial * radius * 1.12 + Math.cos(longitude * 1.7 + ci) * 54;
    const sizeJitter = 1 + (((i * 37) % 11) - 5) * .035;
    n.size = Math.min(42, 9 + Math.sqrt(weight)*6.2 + (n.kind === 'memory' ? 3.5 : 4.5)) * sizeJitter;
    n.twinkle = (i % 23) / 23;
    const twinkleTier = i % 17 === 0 ? 2 : (i % 5 === 0 ? 1 : 0);
    n.twinkleFreq = twinkleTier === 2 ? .0048 + ((i * 41) % 130) / 100000 : (twinkleTier === 1 ? .0024 + ((i * 47) % 120) / 100000 : .00125 + ((i * 53) % 110) / 100000);
    n.twinkleAmp = twinkleTier === 2 ? .34 : (twinkleTier === 1 ? .24 : .15 + ((i * 29) % 70) / 1000);
    n._degree = 0; n._weight = weight;
  });
  return nodes;
}
function buildThreeNeuralPositions(data){
  const nodes = (data.nodes || []).slice(0,170).map(n => ({...n}));
  const nodeIds = new Set(nodes.map(n => n.id));
  const edges = (data.edges || []).filter(e => nodeIds.has(e.source) && nodeIds.has(e.target)).slice(0,340);
  const categories = [...new Set(nodes.map(n => n.category || 'Other'))];
  const catIndex = Object.fromEntries(categories.map((c,i)=>[c,i]));
  const regionCount = Math.max(1, categories.length);
  const regions = Object.fromEntries(categories.map((cat, i) => {
    const angle = -Math.PI / 2 + (i / regionCount) * Math.PI * 2;
    const radius = regionCount <= 2 ? 86 : (i === regionCount - 1 && regionCount > 5 ? 70 : 142 + (i % 2) * 18);
    const lap = Math.floor(i / Math.max(1, regionCount));
    return [cat, {
      label:cat,
      angle,
      cx:Math.cos(angle) * radius + lap * 18,
      cy:Math.sin(angle) * radius * .96,
      cz:((i * 41) % 89 - 44) * .72,
      spread:94 + (i % 4) * 10
    }];
  }));
  const degree = new Map();
  edges.forEach(e => { degree.set(e.source, (degree.get(e.source) || 0) + 1); degree.set(e.target, (degree.get(e.target) || 0) + 1); });
  const hubsByCategory = {};
  nodes.filter(n => n.kind !== 'memory').sort((a,b)=>(Number(b.weight || b.count || 0)+ (degree.get(b.id)||0)) - (Number(a.weight || a.count || 0)+(degree.get(a.id)||0))).forEach(n => {
    const cat = n.category || 'Other'; if(!hubsByCategory[cat]) hubsByCategory[cat] = []; hubsByCategory[cat].push(n);
  });
  const byId = Object.fromEntries(nodes.map(n => [n.id, n]));
  nodes.forEach((n,i) => {
    const cat = n.category || 'Other';
    const region = regions[cat] || regions.Other || { cx:0, cy:0, cz:0, angle:0, spread:80 };
    const ci = catIndex[cat] || 0;
    const weight = Math.max(1, Number(n.weight || n.count || 1));
    const d = degree.get(n.id) || 0;
    if(n.kind === 'memory'){
      const linked = edges.find(e => e.source === n.id || e.target === n.id);
      const parent = linked ? byId[linked.source === n.id ? linked.target : linked.source] : null;
      const parentX = parent && parent.kind !== 'memory' && Number.isFinite(parent.x) ? parent.x : region.cx;
      const parentY = parent && parent.kind !== 'memory' && Number.isFinite(parent.y) ? parent.y : region.cy;
      const parentZ = parent && parent.kind !== 'memory' && Number.isFinite(parent.z) ? parent.z : region.cz;
      const branch = ((i * 137.508 + ci * 19) % 360) * Math.PI / 180;
      const yUnit = ((((i * 43 + ci * 17) % 97) + .5) / 97) * 2 - 1;
      const radial = Math.sqrt(Math.max(0, 1 - yUnit * yUnit));
      const dist = 46 + (i % 6) * 13 + Math.min(48, Math.sqrt(weight) * 10);
      n.x = parentX + Math.cos(branch) * radial * dist;
      n.y = parentY + yUnit * dist * .82;
      n.z = parentZ + Math.sin(branch) * radial * dist * .86;
    } else {
      const rank = Math.max(0, (hubsByCategory[cat] || []).indexOf(n));
      const orbit = rank === 0 ? 0 : 30 + Math.sqrt(rank) * 20;
      const angle = region.angle + rank * 2.399963 + (ci % 3) * .24;
      const yUnit = rank === 0 ? 0 : ((((rank * 37 + ci * 11) % 89) + .5) / 89) * 2 - 1;
      const radial = Math.sqrt(Math.max(0, 1 - yUnit * yUnit));
      n.x = region.cx + Math.cos(angle) * radial * orbit;
      n.y = region.cy + yUnit * orbit * .86;
      n.z = region.cz + Math.sin(angle) * radial * orbit * .80;
    }
    n.size = Math.min(30, 8 + Math.sqrt(weight + d) * (n.kind === 'memory' ? 3.2 : 4.1));
    n._degree = d; n._weight = weight; n.neuralRegion = cat;
  });
  threeVis.neuralRegions = Object.values(regions);
  return nodes;
}
function limitedThreeEdges(data, byId, mobile=false){
  const degree = new Map(); const out=[];
  const limit = threeVis.mode === 'neural' ? 132 : (mobile ? 92 : 140);
  const degreeLimit = threeVis.mode === 'neural' ? 5 : (mobile ? 3 : 4);
  for(const e of (data.edges || [])){
    const a=byId.get(e.source), b=byId.get(e.target); if(!a || !b) continue;
    const da=degree.get(e.source)||0, db=degree.get(e.target)||0; if(da>=degreeLimit || db>=degreeLimit) continue;
    degree.set(e.source, da+1); degree.set(e.target, db+1); a._degree++; b._degree++; out.push({ ...e, a, b });
    if(out.length >= limit) break;
  }
  return out;
}
function neuralAuraOverlay(regions){
  if(threeVis.mode !== 'neural') return '';
  const regionList = (regions || []).slice(0,9);
  return `<div class="three-aura-layer">${regionList.map((r,i)=>`<span class="three-aura-oval" data-region="${esc(r.label || '')}" style="opacity:0;transform:translate(-50%,-50%) rotate(${(Number(r.angle || 0) * 28).toFixed(1)}deg)"></span>`).join('')}</div>`;
}
function makeAuraOvalTexture(THREE){
  const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 320;
  const ctx = canvas.getContext('2d'); const cx=256, cy=160;
  const g = ctx.createRadialGradient(cx, cy, 12, cx, cy, 230);
  g.addColorStop(0, 'rgba(102,232,198,.24)');
  g.addColorStop(.52, 'rgba(102,232,198,.13)');
  g.addColorStop(1, 'rgba(102,232,198,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.ellipse(cx, cy, 238, 142, 0, 0, Math.PI*2); ctx.fill();
  ctx.strokeStyle='rgba(102,232,198,.16)'; ctx.lineWidth=2;
  for(let i=0;i<3;i++){
    ctx.beginPath(); ctx.ellipse(cx, cy, 88+i*48, 46+i*28, 0, 0, Math.PI*2); ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas); tex.needsUpdate = true; return tex;
}
function addNeuralAuraOvals(THREE, group, regions, colors){
  const texture = makeAuraOvalTexture(THREE);
  (regions || []).slice(0,10).forEach((region, i) => {
    const material = new THREE.SpriteMaterial({ map:texture, color:colors.entity, transparent:true, opacity:colors.light ? .13 : .18, depthWrite:false, depthTest:false, blending:THREE.AdditiveBlending, rotation:(region.angle || 0) * .42 });
    const sprite = new THREE.Sprite(material);
    sprite.position.set(region.cx || 0, region.cy || 0, (region.cz || 0) - 18 - i*.8);
    const spread = region.spread || 86;
    sprite.scale.set(spread * (3.9 + (i%3)*.35), spread * (2.35 + (i%2)*.22), 1);
    sprite.renderOrder = -10 + i;
    group.add(sprite);
  });
}
function addHaloPoints(THREE, scene, nodes, kind, color, size){
  let selected = nodes.filter(n => (n.kind === 'memory') === (kind === 'memory'));
  if(threeVis.mode !== 'neural'){
    selected = selected
      .filter(n => {
        const weight = Math.max(1, Number(n.weight || n.count || 1));
        return weight > (kind === 'memory' ? 3.6 : 4.4) || Number(n._degree || 0) > 3;
      })
      .sort((a,b)=>(Math.max(1, Number(b.weight || b.count || 1)) + Number(b._degree || 0)) - (Math.max(1, Number(a.weight || a.count || 1)) + Number(a._degree || 0)))
      .slice(0, kind === 'memory' ? 30 : 44);
  }
  const positions = new Float32Array(selected.length * 3);
  selected.forEach((n,i)=>{ positions[i*3]=n.x; positions[i*3+1]=n.y; positions[i*3+2]=n.z; });
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.BufferAttribute(positions,3));
  const themeColors = colorForTheme();
  const isNeural = threeVis.mode === 'neural';
  const opacity = isNeural
    ? (kind === 'memory' ? (themeColors.light ? .16 : .28) : (themeColors.light ? .18 : .34))
    : (kind === 'memory' ? (themeColors.light ? .12 : .24) : (themeColors.light ? .13 : .26));
  const material = new THREE.PointsMaterial({ color, map:makePointTexture(THREE, 'orb'), alphaTest:.015, size, sizeAttenuation:true, transparent:true, opacity, depthWrite:false, blending:themeColors.light ? THREE.NormalBlending : THREE.AdditiveBlending });
  const points = new THREE.Points(geometry, material); scene.add(points); return points;
}
function addNeuralDendrites(THREE, group, nodes, colors){
  const trunks=[]; const twigs=[]; const tips=[];
  nodes.slice(0,150).forEach((n,i)=>{
    const arms = n.kind === 'memory' ? 3 : 6;
    const base = n.kind === 'memory' ? 10 : 17;
    for(let a=0;a<arms;a++){
      const theta=(a/arms)*Math.PI*2 + (i%11)*.19;
      const phi=Math.sin(i*.37+a)*.58;
      const len=base + ((i+a*13)%9);
      const mid=[n.x+Math.cos(theta+.16)*Math.cos(phi)*len*.50, n.y+Math.sin(phi)*len*.36, n.z+Math.sin(theta+.16)*Math.cos(phi)*len*.50];
      const end=[n.x+Math.cos(theta)*Math.cos(phi)*len*.78, n.y+Math.sin(phi)*len*.54, n.z+Math.sin(theta)*Math.cos(phi)*len*.78];
      trunks.push(n.x,n.y,n.z, mid[0],mid[1],mid[2], mid[0],mid[1],mid[2], end[0],end[1],end[2]);
      if(n.kind !== 'memory' && a%2===0){
        const side=theta+(a%2?.44:-.40);
        const fork=[mid[0]+Math.cos(side)*len*.18, mid[1]+Math.sin(phi+.25)*len*.12, mid[2]+Math.sin(side)*len*.18];
        twigs.push(mid[0],mid[1],mid[2], fork[0],fork[1],fork[2]);
      }
      if(i%3===0 && a%2===0) tips.push(end[0],end[1],end[2]);
    }
  });
  const trunkGeom = new THREE.BufferGeometry(); trunkGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(trunks),3));
  group.add(new THREE.LineSegments(trunkGeom, new THREE.LineBasicMaterial({ color:colors.entity, transparent:true, opacity:colors.light ? .34 : .36, blending:colors.light ? THREE.NormalBlending : THREE.AdditiveBlending, depthWrite:false })));
  const twigGeom = new THREE.BufferGeometry(); twigGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(twigs),3));
  group.add(new THREE.LineSegments(twigGeom, new THREE.LineBasicMaterial({ color:colors.link, transparent:true, opacity:colors.light ? .28 : .24, blending:colors.light ? THREE.NormalBlending : THREE.AdditiveBlending, depthWrite:false })));
  const tipGeom = new THREE.BufferGeometry(); tipGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(tips),3));
  group.add(new THREE.Points(tipGeom, new THREE.PointsMaterial({ color:colors.entity, map:makePointTexture(THREE, 'orb'), alphaTest:.03, size:3.8, transparent:true, opacity:colors.light ? .54 : .72, depthWrite:false, blending:colors.light ? THREE.NormalBlending : THREE.AdditiveBlending })));
}
function addPoints(THREE, scene, nodes, kind, color, size){
  const selected = nodes.filter(n => (n.kind === 'memory') === (kind === 'memory'));
  const positions = new Float32Array(selected.length * 3);
  const sizes = new Float32Array(selected.length);
  const phases = new Float32Array(selected.length);
  const freqs = new Float32Array(selected.length);
  const amps = new Float32Array(selected.length);
  const majors = new Float32Array(selected.length);
  selected.forEach((n,i)=>{
    const weight = Math.max(1, Number(n.weight || n.count || 1));
    positions[i*3]=n.x; positions[i*3+1]=n.y; positions[i*3+2]=n.z;
    const degreeBoost = Math.min(10, Number(n._degree || 0) * 1.9);
    const variedSize = (n.size || size) + degreeBoost;
    sizes[i]=Math.max(size * 1.14, Math.min(size * 2.65, variedSize * 1.62));
    phases[i]=(n.twinkle || 0) * Math.PI * 2;
    freqs[i]=n.twinkleFreq || .0012;
    amps[i]=n.twinkleAmp || .12;
    majors[i]=weight > 6.2 || (kind === 'memory' && weight > 4.8) ? 1 : 0;
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions,3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes,1));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases,1));
  geometry.setAttribute('aFreq', new THREE.BufferAttribute(freqs,1));
  geometry.setAttribute('aAmp', new THREE.BufferAttribute(amps,1));
  geometry.setAttribute('aMajor', new THREE.BufferAttribute(majors,1));
  const themeColors = colorForTheme();
  let material;
  if(threeVis.mode === 'neural'){
    material = new THREE.PointsMaterial({ color, map:makePointTexture(THREE, kind === 'memory' ? 'soma' : 'neuron'), alphaTest:.04, size, sizeAttenuation:true, transparent:true, opacity:kind === 'memory' ? (themeColors.light ? .88 : .98) : (themeColors.light ? .76 : .86), depthWrite:false, blending:themeColors.light ? THREE.NormalBlending : THREE.AdditiveBlending });
  } else {
    material = new THREE.ShaderMaterial({
      uniforms:{
        uTime:{value:0},
        uScale:{value:420},
        uColor:{value:new THREE.Color(color)},
        uIsStar:{value:kind === 'memory' ? 0 : 1},
        uOpacity:{value:kind === 'memory' ? .98 : .96}
      },
      vertexShader:`
        attribute float aSize;
        attribute float aPhase;
        attribute float aFreq;
        attribute float aAmp;
        attribute float aMajor;
        uniform float uTime;
        uniform float uScale;
        varying float vPulse;
        varying float vMajor;
        void main(){
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          float wave = sin(uTime * aFreq + aPhase) + sin(uTime * aFreq * 0.43 + aPhase * 1.71) * 0.45;
          vPulse = 1.0 + wave * aAmp;
          vMajor = aMajor;
          gl_PointSize = aSize * (0.98 + (vPulse - 1.0) * 0.32) * (uScale / max(72.0, -mvPosition.z));
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader:`
        uniform vec3 uColor;
        uniform float uIsStar;
        uniform float uOpacity;
        varying float vPulse;
        varying float vMajor;
        void main(){
          vec2 p = gl_PointCoord - vec2(0.5);
          float d = length(p);
          if(d > 0.5) discard;
          float core = 1.0 - smoothstep(0.026, 0.060, d);
          float body = 1.0 - smoothstep(0.060, 0.135, d);
          float halo = (1.0 - smoothstep(0.13, 0.48, d)) * (0.15 + clamp(vPulse - 1.0, -0.30, 0.46) * 0.82);
          float rayH = max(0.0, 1.0 - abs(p.y) / 0.010) * (1.0 - smoothstep(0.07, 0.44, abs(p.x)));
          float rayV = max(0.0, 1.0 - abs(p.x) / 0.010) * (1.0 - smoothstep(0.07, 0.44, abs(p.y)));
          float diag1 = max(0.0, 1.0 - abs(p.x - p.y) / 0.013) * (1.0 - smoothstep(0.06, 0.26, d));
          float diag2 = max(0.0, 1.0 - abs(p.x + p.y) / 0.013) * (1.0 - smoothstep(0.06, 0.26, d));
          float rays = vMajor * (max(rayH, rayV) * 0.50 + max(diag1, diag2) * 0.16);
          float alpha = (body * 0.46 + core * 1.02 + halo + rays) * uOpacity * clamp(0.72 + (vPulse - 1.0) * 0.92, 0.46, 1.35);
          if(alpha < 0.022) discard;
          vec3 starCore = mix(uColor, vec3(1.0), core * 0.88 + rays * 0.38);
          vec3 memoryCore = mix(uColor, vec3(1.0), core * 0.34);
          vec3 crisp = mix(memoryCore, starCore, uIsStar);
          gl_FragColor = vec4(crisp * (0.92 + (vPulse - 1.0) * 0.22), min(alpha, 1.0));
        }
      `,
      transparent:true,
      depthWrite:false,
      blending:THREE.NormalBlending
    });
  }
  const points = new THREE.Points(geometry, material); points.userData.nodes = selected; scene.add(points); return points;
}
function buildThreeLinkSegments(THREE, edges){
  const positions = [];
  edges.forEach((e,i)=>{
    if(threeVis.mode === 'neural'){
      const ax=e.a.x, ay=e.a.y, az=e.a.z, bx=e.b.x, by=e.b.y, bz=e.b.z;
      const dx=bx-ax, dy=by-ay, dz=bz-az;
      const len=Math.max(1, Math.hypot(dx,dy,dz));
      const bend=(i%2?1:-1) * Math.min(58, 18 + len*.12);
      const cx=(ax+bx)/2 + (-dy/len)*bend;
      const cy=(ay+by)/2 + (dx/len)*bend*.55 + Math.sin(i*.71)*18;
      const cz=(az+bz)/2 + Math.cos(i*.53)*bend*.72;
      e._curve={cx,cy,cz};
      let px=ax, py=ay, pz=az;
      for(let step=1; step<=7; step++){
        const t=step/7, inv=1-t;
        const x=inv*inv*ax+2*inv*t*cx+t*t*bx;
        const y=inv*inv*ay+2*inv*t*cy+t*t*by;
        const z=inv*inv*az+2*inv*t*cz+t*t*bz;
        positions.push(px,py,pz,x,y,z); px=x; py=y; pz=z;
      }
    } else {
      positions.push(e.a.x,e.a.y,e.a.z,e.b.x,e.b.y,e.b.z);
    }
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions),3));
  return geometry;
}
async function renderThreeVisualiser(data){
  const THREE = await loadThreeModule();
  clearThreeScene(); threeVis.data = data; updateThreeUI(); threeInspectorDefault();
  const viewport = $('#threeViewport'); if(!viewport) return;
  const colors = colorForTheme();
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias:true, alpha:true, powerPreference:'high-performance' });
  } catch(err) {
    $('#threeViewport').classList.add('three-fallback');
    $('#threeLabels').innerHTML = `<div class="three-fallback-card"><h3>3D visualiser unavailable</h3><p>The original Visualiser remains available for this browser.</p></div>`;
    $('#threeInspector').innerHTML = `<div class="inspector-kicker">Constellation inspector</div><h3>3D visualiser unavailable</h3><p class="muted">Try the original Visualiser, or reopen this page in a browser that supports the 3D view.</p>`;
    return;
  }
  $('#threeViewport').classList.remove('three-fallback');
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); renderer.setClearColor(colors.bg, 0);
  viewport.prepend(renderer.domElement);
  const scene = new THREE.Scene(); scene.fog = new THREE.FogExp2(colors.bg, threeVis.mode === 'neural' ? .0011 : .0009);
  const mobileThree = (viewport.getBoundingClientRect?.().width || 650) < 520;
  const camera = new THREE.PerspectiveCamera(48, 1, 1, 5000);
  const group = new THREE.Group(); scene.add(group);
  const ambient = new THREE.AmbientLight(0xffffff, .55); scene.add(ambient);
  const light = new THREE.PointLight(colors.entity, 1.2, 1200); light.position.set(180,220,260); scene.add(light);
  const nodes = buildThreePositions(data); const byId = new Map(nodes.map(n=>[n.id,n])); const edges = limitedThreeEdges(data, byId, mobileThree);
  const linkGeom = buildThreeLinkSegments(THREE, edges);
  const linkMaterial = threeVis.mode === 'neural'
    ? new THREE.LineBasicMaterial({ color:colors.link, transparent:true, opacity:colors.light ? .30 : .40, blending:colors.light ? THREE.NormalBlending : THREE.AdditiveBlending, depthWrite:false })
    : new THREE.LineDashedMaterial({ color:colors.link, transparent:true, opacity:colors.light ? (mobileThree ? .14 : .16) : (mobileThree ? .13 : .12), dashSize:9, gapSize:8, blending:THREE.NormalBlending, depthWrite:false });
  const linkLines = new THREE.LineSegments(linkGeom, linkMaterial);
  if(threeVis.mode !== 'neural') linkLines.computeLineDistances();
  group.add(linkLines);
  if(threeVis.mode === 'neural'){
    addHaloPoints(THREE, group, nodes, 'entity', colors.entity, 50);
    addHaloPoints(THREE, group, nodes, 'memory', colors.memory, 48);
    addNeuralDendrites(THREE, group, nodes, colors);
  } else {
    // Constellation already has per-star shader halos. A separate halo layer made
    // the mobile view read like blurry particles instead of the original star map.
  }
  group.add(addPoints(THREE, group, nodes, 'entity', colors.entity, threeVis.mode === 'neural' ? 30 : 52));
  group.add(addPoints(THREE, group, nodes, 'memory', colors.memory, threeVis.mode === 'neural' ? 26 : 50));
  const starCount = threeVis.mode === 'neural' ? 360 : 420;
  const starPositions = new Float32Array(starCount*3);
  for(let i=0;i<starCount;i++){ const r=600+((i*37)%480), a=i*2.17, b=((i*53)%180-90)*Math.PI/180; starPositions.set([Math.cos(a)*Math.cos(b)*r, Math.sin(b)*r, Math.sin(a)*Math.cos(b)*r], i*3); }
  const starGeom = new THREE.BufferGeometry(); starGeom.setAttribute('position', new THREE.BufferAttribute(starPositions,3));
  scene.add(new THREE.Points(starGeom, new THREE.PointsMaterial({ color:0xffffff, map:makePointTexture(THREE, 'orb'), alphaTest:.04, size:1.25, transparent:true, opacity:threeVis.mode === 'neural' ? .38 : .24, depthWrite:false })));
  const pulseEdges = threeVis.mode === 'neural' ? edges.slice(0, 90) : [];
  const pulseGeom = new THREE.BufferGeometry(); const pulsePositions = new Float32Array(pulseEdges.length*3); pulseGeom.setAttribute('position', new THREE.BufferAttribute(pulsePositions,3));
  const pulsePoints = new THREE.Points(pulseGeom, new THREE.PointsMaterial({ color:colors.pulse, map:makePointTexture(THREE, 'star'), alphaTest:.03, size:threeVis.mode === 'neural' ? 10.5 : 5.2, transparent:true, opacity:threeVis.mode === 'neural' ? (colors.light ? .54 : .98) : .85, depthWrite:false, depthTest:false, blending:colors.light ? THREE.NormalBlending : THREE.AdditiveBlending })); group.add(pulsePoints);
  const labelNodes = nodes.filter(n => !/^[a-f0-9]{10,}$/i.test(String(n.label||''))).sort((a,b)=>(b._degree+b._weight)-(a._degree+a._weight)).slice(0, threeVis.mode === 'neural' ? 72 : 56);
  $('#threeLabels').innerHTML = neuralAuraOverlay(threeVis.neuralRegions) + labelNodes.map((n,i)=>`<span class="three-label ${n.kind === 'memory' ? 'memory' : ''}" data-i="${i}">${esc(String(n.label||'').replace(/^memory:/,'mem ').slice(0,24))}</span>`).join('');
  Object.assign(threeVis, { THREE, renderer, scene, camera, group, nodes, edgePairs:edges, labels:labelNodes, pulses:pulseEdges, pulsePoints });
  $('#threeClusters').innerHTML = (data.clusters || []).map(c => `<span class="cluster-pill">${esc(c.label)} <strong>${Number(c.count).toLocaleString()}</strong></span>`).join('');
  resetThreeCamera(); bindThreeControls(); resizeThree(); animateThree(0);
}
function resizeThree(){
  if(!threeVis.renderer) return;
  const viewport = $('#threeViewport'); const rect = viewport.getBoundingClientRect();
  const w = Math.max(320, rect.width), h = Math.max(320, rect.height);
  threeVis.renderer.setSize(w,h,false); threeVis.camera.aspect = w/h; threeVis.camera.updateProjectionMatrix();
}
function threeEffectiveCameraZ(rect){
  const box = rect || $('#threeViewport')?.getBoundingClientRect?.() || {width:650,height:650};
  const fill = visualiserResponsiveFill(box.width, box.height);
  const mobile = box.width < 760 || box.height < 520;
  return threeVis.cameraZ / (mobile ? 1 : fill);
}
function updateThreeAuras(rect, projectVector){
  if(threeVis.mode !== 'neural') return;
  const mobile = rect.width < 520;
  $$('#threeLabels .three-aura-oval').forEach(el => {
    const region = el.dataset.region || '';
    const pts = threeVis.nodes.filter(n => n.neuralRegion === region);
    const screens = [];
    pts.forEach(n => {
      projectVector.set(n.x,n.y,n.z).applyMatrix4(threeVis.group.matrixWorld).project(threeVis.camera);
      if(projectVector.z < 1 && projectVector.z > -1) screens.push({ x:(projectVector.x*.5+.5)*rect.width, y:(-projectVector.y*.5+.5)*rect.height });
    });
    if(screens.length < 2){ el.style.opacity = '0'; return; }
    const xs = screens.map(p=>p.x), ys = screens.map(p=>p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const maxW = mobile ? rect.width * .62 : Math.min(340, rect.width * .34);
    const maxH = mobile ? rect.height * .30 : Math.min(230, rect.height * .26);
    const w = Math.max(mobile ? 92 : 128, Math.min(maxW, (maxX - minX) + (mobile ? 46 : 74)));
    const h = Math.max(mobile ? 58 : 78, Math.min(maxH, (maxY - minY) + (mobile ? 34 : 56)));
    el.style.left = `${cx}px`; el.style.top = `${cy}px`; el.style.width = `${w}px`; el.style.height = `${h}px`; el.style.opacity = screens.length > 4 ? '.42' : '.28';
  });
}
function updateThreeLabels(){
  if(!threeVis.camera || !threeVis.group) return;
  const viewport = $('#threeViewport'); const rect = viewport.getBoundingClientRect(); const v = new threeVis.THREE.Vector3();
  updateThreeAuras(rect, v);
  const labelBoxes = [];
  const effectiveCameraZ = threeEffectiveCameraZ(rect);
  const zoomReveal = threeVis.mode === 'neural' ? Math.max(0, Math.min(1, (900 - effectiveCameraZ) / 420)) : Math.max(0, Math.min(1, (760 - effectiveCameraZ) / 520));
  const maxLabels = threeVis.mode === 'neural' ? ((rect.width < 520 ? 14 : 24) + Math.round(zoomReveal * (rect.width < 520 ? 14 : 18))) : (rect.width < 520 ? (12 + Math.round(zoomReveal * 12)) : (20 + Math.round(zoomReveal * 18)));
  let shown = 0;
  $$('#threeLabels .three-label').forEach((el,i)=>{
    const n = threeVis.labels[i]; if(!n) return;
    v.set(n.x,n.y,n.z).applyMatrix4(threeVis.group.matrixWorld).project(threeVis.camera);
    const sx = (v.x*.5+.5)*rect.width, sy = (-v.y*.5+.5)*rect.height;
    const visible = v.z < 1 && v.z > -1 && sx > 8 && sx < rect.width - 8 && sy > 8 && sy < rect.height - 8;
    const pulse = threeVis.mode === 'neural' && i > 3 ? Math.sin((threeVis.lastT || 0) * .00032 + i * 1.73) : 1;
    const box = {x:sx-54,y:sy-13,w:108,h:24};
    const collides = labelBoxes.some(b => !(box.x+box.w<b.x || b.x+b.w<box.x || box.y+box.h<b.y || b.y+b.h<box.y));
    const show = visible && shown < maxLabels && !collides && (threeVis.mode !== 'neural' || i <= 3 || pulse > .08);
    el.style.display = show ? '' : 'none';
    if(show){
      shown++; labelBoxes.push(box);
      el.style.left = `${sx}px`; el.style.top = `${sy}px`;
      const depthAlpha = Math.max(.32, Math.min(.86, 1 - Math.abs(v.z)*.35));
      const pulseAlpha = threeVis.mode === 'neural' && i > 3 ? Math.min(.78, .38 + pulse * .36) : depthAlpha;
      el.style.opacity = String(Math.min(depthAlpha, pulseAlpha));
    }
  });
}
function animateThree(t=0){
  if(!threeVis.renderer) return;
  resizeThree();
  const delta = threeVis.lastT ? Math.min(48, t - threeVis.lastT) : 16; threeVis.lastT = t;
  if(!threeVis.paused && !threeVis.drag) threeVis.yaw += delta * (threeVis.mode === 'neural' ? .00009 : .000055);
  clampThreeCamera();
  threeVis.group.rotation.y = threeVis.yaw; threeVis.group.rotation.x = threeVis.pitch;
  const viewport = $('#threeViewport'); const rect = viewport?.getBoundingClientRect?.() || {width:650,height:650};
  const effectiveCameraZ = threeEffectiveCameraZ(rect);
  threeVis.camera.position.set(threeVis.panX, threeVis.panY, effectiveCameraZ); threeVis.camera.lookAt(threeVis.panX, threeVis.panY, 0);
  if(threeVis.pulsePoints){
    const attr = threeVis.pulsePoints.geometry.attributes.position; const arr = attr.array;
    threeVis.pulses.forEach((e,i)=>{ const phase=(t*.00030 + (i%17)/17)%1; const inv=1-phase; if(e._curve){ arr[i*3]=inv*inv*e.a.x+2*inv*phase*e._curve.cx+phase*phase*e.b.x; arr[i*3+1]=inv*inv*e.a.y+2*inv*phase*e._curve.cy+phase*phase*e.b.y; arr[i*3+2]=inv*inv*e.a.z+2*inv*phase*e._curve.cz+phase*phase*e.b.z; } else { arr[i*3]=e.a.x+(e.b.x-e.a.x)*phase; arr[i*3+1]=e.a.y+(e.b.y-e.a.y)*phase; arr[i*3+2]=e.a.z+(e.b.z-e.a.z)*phase; } });
    attr.needsUpdate = true;
  }
  threeVis.scene.traverse(obj => {
    if(obj.isPoints && obj.material?.uniforms?.uTime){
      obj.material.uniforms.uTime.value = t;
      obj.material.uniforms.uScale.value = Math.max(360, Math.min(820, threeVis.renderer.domElement.clientHeight || 420));
    }
  });
  threeVis.renderer.render(threeVis.scene, threeVis.camera); updateThreeLabels();
  threeVis.frame = requestAnimationFrame(animateThree);
}
async function loadThreeVisualiser(){ renderThreeVisualiser(await api('/api/constellation?limit=320')); }
function switchThreeMode(mode){ threeVis.mode = mode === 'neural' ? 'neural' : 'constellation'; if(threeVis.data) renderThreeVisualiser(threeVis.data); else loadThreeVisualiser(); }
function clampThreeCamera(){
  const viewport = $('#threeViewport'); const rect = viewport?.getBoundingClientRect?.() || {width:650,height:650};
  const fallbackZ = threeVis.mode === 'neural' ? 600 : 760;
  const minCameraZ = fallbackZ / 10;
  threeVis.cameraZ = Math.max(minCameraZ, Math.min(1800, Number.isFinite(threeVis.cameraZ) ? threeVis.cameraZ : fallbackZ));
  threeVis.yaw = Number.isFinite(threeVis.yaw) ? threeVis.yaw : 0;
  threeVis.pitch = Math.max(-1.15, Math.min(1.15, Number.isFinite(threeVis.pitch) ? threeVis.pitch : .32));
  const zoomFactor = 900 / Math.max(80, threeVis.cameraZ);
  const panLimitX = Math.max(120, rect.width * (.45 + zoomFactor * .18));
  const panLimitY = Math.max(120, rect.height * (.34 + zoomFactor * .12));
  threeVis.panX = Math.max(-panLimitX, Math.min(panLimitX, Number.isFinite(threeVis.panX) ? threeVis.panX : 0));
  threeVis.panY = Math.max(-panLimitY, Math.min(panLimitY, Number.isFinite(threeVis.panY) ? threeVis.panY : 0));
}
function bindThreeControls(){
  const viewport = $('#threeViewport'); if(!viewport || viewport.dataset.controlsBound === 'true') return; viewport.dataset.controlsBound = 'true';
  const pointers = threeVis.pointer || new Map(); threeVis.pointer = pointers;
  const dist = () => { const ps=[...pointers.values()]; return ps.length < 2 ? 1 : Math.max(1, Math.hypot(ps[0].x-ps[1].x, ps[0].y-ps[1].y)); };
  const center = () => { const ps=[...pointers.values()]; return ps.length < 2 ? {x:0,y:0} : {x:(ps[0].x+ps[1].x)/2, y:(ps[0].y+ps[1].y)/2}; };
  viewport.addEventListener('contextmenu', e=>e.preventDefault());
  viewport.addEventListener('wheel', e=>{ if(e.cancelable) e.preventDefault(); threeVis.cameraZ *= Math.exp(e.deltaY*.001); clampThreeCamera(); }, {passive:false});
  viewport.addEventListener('pointerdown', e=>{
    if(e.cancelable) e.preventDefault();
    try { viewport.setPointerCapture?.(e.pointerId); } catch(_err) {}
    pointers.set(e.pointerId, {x:e.clientX,y:e.clientY});
    if(pointers.size >= 2){ const c=center(); threeVis.drag={mode:'pinch',x:c.x,y:c.y,dist:dist(),cameraZ:threeVis.cameraZ,panX:threeVis.panX,panY:threeVis.panY,moved:false}; }
    else threeVis.drag = {mode:'drag',x:e.clientX,y:e.clientY,yaw:threeVis.yaw,pitch:threeVis.pitch,panX:threeVis.panX,panY:threeVis.panY,moved:false};
    viewport.style.cursor='grabbing';
  }, {passive:false});
  viewport.addEventListener('pointermove', e=>{
    if(!pointers.has(e.pointerId) || !threeVis.drag) return;
    if(e.cancelable) e.preventDefault();
    pointers.set(e.pointerId, {x:e.clientX,y:e.clientY});
    const d=threeVis.drag;
    if(d.mode === 'pinch'){
      if(pointers.size < 2) return;
      const c=center(); const scale=dist()/Math.max(1,d.dist);
      threeVis.cameraZ = d.cameraZ / Math.max(.35, Math.min(2.8, scale));
      threeVis.panX = d.panX - (c.x-d.x)*.72;
      threeVis.panY = d.panY + (c.y-d.y)*.72;
      d.moved = d.moved || Math.abs(c.x-d.x)+Math.abs(c.y-d.y)>3 || Math.abs(scale-1)>.015;
      clampThreeCamera(); return;
    }
    const dx=e.clientX-d.x, dy=e.clientY-d.y; if(Math.abs(dx)+Math.abs(dy)>3) d.moved=true;
    if(threeVis.panMode || e.shiftKey){ threeVis.panX=d.panX-dx*.7; threeVis.panY=d.panY+dy*.7; }
    else { threeVis.yaw=d.yaw+dx*.006; threeVis.pitch=d.pitch+dy*.004; }
    clampThreeCamera();
  }, {passive:false});
  const end=e=>{
    pointers.delete(e.pointerId);
    if(threeVis.drag?.moved) viewport.dataset.suppressClick='true';
    if(pointers.size === 1){ const p=[...pointers.values()][0]; threeVis.drag={mode:'drag',x:p.x,y:p.y,yaw:threeVis.yaw,pitch:threeVis.pitch,panX:threeVis.panX,panY:threeVis.panY,moved:true}; }
    else { threeVis.drag=null; viewport.style.cursor='grab'; }
  };
  viewport.addEventListener('pointerup', end); viewport.addEventListener('pointercancel', end); viewport.addEventListener('pointerleave', end);
  viewport.addEventListener('click', e=>{ if(viewport.dataset.suppressClick==='true'){ viewport.dataset.suppressClick='false'; return; } pickThreeNode(e); });
}
function pickThreeNode(e){
  if(!threeVis.camera || !threeVis.group) return;
  const rect = $('#threeViewport').getBoundingClientRect(); const mouseX=e.clientX-rect.left, mouseY=e.clientY-rect.top;
  const v = new threeVis.THREE.Vector3(); let best=null, bestD=Infinity;
  for(const n of threeVis.nodes){
    v.set(n.x,n.y,n.z).applyMatrix4(threeVis.group.matrixWorld).project(threeVis.camera);
    if(v.z < -1 || v.z > 1) continue;
    const sx=(v.x*.5+.5)*rect.width, sy=(-v.y*.5+.5)*rect.height; const d=Math.hypot(sx-mouseX, sy-mouseY);
    if(d < bestD && d < 18){ bestD=d; best=n; }
  }
  if(best) inspectThreeNode(best);
}


const palaceKeys = {};
let memoryPalace = {
  data:null, renderer:null, scene:null, camera:null, group:null, nodes:[], labels:[], frame:0,
  yaw:0, pitch:-.05, pos:null, velocity:null, raycaster:null, mouse:null, avatar:null, drone:null,
  beacon:null, beaconNode:null, joystick:{x:0,y:0}, lastT:0, pointer:null,
  cullTick:0, lastObjectCount:0, streamedChunks:null, streamTick:0, colors:null
};
function palaceInspectorDefault(){
  $('#palaceInspector').innerHTML = `<div class="inspector-kicker">Mnemosyne Labyrinth</div><h3>The Archive Gate</h3><p class="muted">Move between artifact rooms, scan relics on pedestals, and use search to summon a golden thread.</p><div class="trust-strip"><span class="trust-chip">WASD / joystick</span><span class="trust-chip">Drag to look</span><span class="trust-chip">Tap relic</span></div>`;
}
function clearPalaceScene(){
  if(memoryPalace.frame) cancelAnimationFrame(memoryPalace.frame);
  memoryPalace.frame = 0;
  if(memoryPalace.renderer){ memoryPalace.renderer.dispose(); memoryPalace.renderer.domElement.remove(); }
  $('#palaceLabels').innerHTML = '';
  Object.assign(memoryPalace, { renderer:null, scene:null, camera:null, group:null, nodes:[], labels:[], avatar:null, drone:null, beacon:null, beaconNode:null, lastT:0 });
}
function resetMemoryPalaceDiver(){
  if(!memoryPalace.THREE) return;
  memoryPalace.pos = new memoryPalace.THREE.Vector3(0, 118, 940);
  memoryPalace.velocity = new memoryPalace.THREE.Vector3();
  memoryPalace.yaw = 0; memoryPalace.pitch = -.24;
  $('#palaceHudStatus').textContent = 'drifting at palace gate';
}
function palaceRoomsForCategories(categories){
  const base = [
    { label:'The Archive Gate', x:0, y:0, z:620, color:0xffe08a },
    { label:'Episodic Vault', x:-360, y:0, z:120, color:0x65d6ff },
    { label:'Working Memory Stream', x:360, y:0, z:80, color:0x52d6b5 },
    { label:'Entity Gardens', x:-520, y:0, z:-520, color:0xb9a6ff },
    { label:'Cold Storage', x:520, y:0, z:-560, color:0x8aa0c9 },
    { label:'Review Wing', x:0, y:0, z:-980, color:0xff5f87 }
  ];
  categories.slice(0, Math.max(0, base.length - 1)).forEach((cat,i) => { base[i + 1].category = cat; });
  return base;
}
function palacePositions(data){
  const nodes = (data.nodes || []).slice(0,190).map(n => ({...n}));
  const categories = [...new Set(nodes.map(n => n.category || 'Other'))];
  const rooms = palaceRoomsForCategories(categories);
  nodes.forEach((n,i)=>{
    const contaminated = ['unknown','inferred','imported'].includes(String(n.veracity || '').toLowerCase()) || /contaminat|unknown|untrusted/i.test(String(n.reason || n.preview || ''));
    const room = contaminated ? rooms.find(r => r.label === 'Review Wing') : (n.kind === 'memory' ? rooms[1 + (i % Math.max(1, rooms.length - 2))] : rooms[1 + ((i + 2) % Math.max(1, rooms.length - 2))]);
    const weight = Math.max(1, Number(n.weight || n.count || 1));
    const slot = i % 28;
    const ring = Math.floor(slot / 7) + 1;
    const angle = (slot % 7) / 7 * Math.PI * 2 + ring * .27;
    const radius = 54 + ring * 34 + Math.sqrt(weight) * 5;
    n.x = room.x + Math.cos(angle) * radius;
    n.y = 18 + (slot % 3) * 8 + (n.kind === 'memory' ? 0 : 18);
    n.z = room.z + Math.sin(angle) * radius;
    n.size = Math.min(30, 8 + Math.sqrt(weight) * (n.kind === 'memory' ? 4.8 : 5.8));
    n._weight = weight; n.room = room.label; n.contaminated = contaminated;
  });
  nodes.rooms = rooms;
  return nodes;
}
function palaceCreateArtifactMaterial(THREE, node, colors){
  if(node.contaminated){
    node.scanLabel = 'Needs-review memory';
    return new THREE.MeshStandardMaterial({ color:0xff4f87, emissive:0x8d0035, emissiveIntensity:.72, roughness:.28, metalness:.12 });
  }
  const color = node.kind === 'memory' ? cssHexToInt(colors.memory) : cssHexToInt(colors.star);
  return new THREE.MeshStandardMaterial({ color, emissive:color, emissiveIntensity:node.kind === 'memory' ? .34 : .42, roughness:.33, metalness:.08 });
}
function palaceCreatePedestal(THREE, node){
  const group = new THREE.Group();
  const base = new THREE.Mesh(new THREE.CylinderGeometry(18, 24, 8, 6), new THREE.MeshStandardMaterial({ color:0x2a2235, emissive:0x0b0712, roughness:.72 }));
  base.position.set(node.x, 3, node.z);
  const plinth = new THREE.Mesh(new THREE.CylinderGeometry(12, 16, 10, 8), new THREE.MeshStandardMaterial({ color:node.contaminated ? 0x4b1630 : 0x3a3042, roughness:.62 }));
  plinth.position.set(node.x, 12, node.z);
  group.add(base, plinth);
  return group;
}
function palaceCreatePortal(THREE, room, target, color=0xffe08a){
  const group = new THREE.Group();
  const dx = target.x - room.x, dz = target.z - room.z;
  const angle = Math.atan2(dx, dz);
  const arch = new THREE.Mesh(new THREE.TorusGeometry(18, 1.6, 8, 32, Math.PI), new THREE.MeshBasicMaterial({ color, transparent:true, opacity:.46 }));
  arch.rotation.z = Math.PI;
  arch.position.y = 34;
  const light = new THREE.PointLight(color, .58, 125); light.position.y = 32;
  group.add(arch, light);
  group.position.set(room.x + Math.sin(angle) * 142, 0, room.z + Math.cos(angle) * 142);
  group.rotation.y = angle;
  return group;
}
function palaceCreateRoomEdges(THREE, scene, mesh, color=0xffe08a, opacity=.18){
  const edges = new THREE.EdgesGeometry(mesh.geometry);
  const lines = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color, transparent:true, opacity }));
  lines.position.copy(mesh.position);
  lines.rotation.copy(mesh.rotation);
  lines.scale.copy(mesh.scale);
  scene.add(lines);
  return lines;
}
function palaceCreateRoomWalls(THREE, scene, room, index, floorMat, wallMat){
  const size = index === 0 ? 330 : 260;
  room.floor = new THREE.Mesh(new THREE.BoxGeometry(size, 10, size), floorMat);
  room.floor.position.set(room.x, -6, room.z);
  scene.add(room.floor);
  palaceCreateRoomEdges(THREE, scene, room.floor, 0xffe08a, .20);
  const wallHeight = index === 0 ? 74 : 58;
  const wallThickness = 12;
  const wallLength = size * .92;
  const openings = [0, Math.PI / 2, Math.PI, Math.PI * 1.5];
  openings.forEach((angle, side) => {
    const horizontal = side % 2 === 0;
    const wall = new THREE.Mesh(new THREE.BoxGeometry(horizontal ? wallLength : wallThickness, wallHeight, horizontal ? wallThickness : wallLength), wallMat);
    const offset = size / 2;
    wall.position.set(room.x + (horizontal ? 0 : (side === 1 ? offset : -offset)), wallHeight / 2 - 2, room.z + (horizontal ? (side === 0 ? offset : -offset) : 0));
    room.wall = wall;
    scene.add(wall);
    palaceCreateRoomEdges(THREE, scene, wall, 0x8a76a4, .16);
  });
  const ceiling = new THREE.Mesh(new THREE.BoxGeometry(size * .74, 3, size * .74), new THREE.MeshBasicMaterial({ color:room.color, transparent:true, opacity:.045 }));
  ceiling.position.set(room.x, wallHeight + 10, room.z); scene.add(ceiling);
}
function palaceCreateDungeonRooms(THREE, scene, rooms){
  const floorMat = new THREE.MeshStandardMaterial({ color:0x3b3048, roughness:.82, metalness:.03 });
  const wallMat = new THREE.MeshStandardMaterial({ color:0x4d3d5d, emissive:0x160d20, roughness:.78 });
  const corridorMat = new THREE.MeshStandardMaterial({ color:0x3b3048, emissive:0x150c1d, roughness:.82 });
  const lineMat = new THREE.LineBasicMaterial({ color:0xffe08a, transparent:true, opacity:.22 });
  const corridorPoints = [];
  const gate = rooms[0];
  rooms.forEach((room,i)=>{
    palaceCreateRoomWalls(THREE, scene, room, i, floorMat, wallMat);
    const obelisk = new THREE.Mesh(new THREE.ConeGeometry(15, i === 0 ? 92 : 64, 5), new THREE.MeshStandardMaterial({ color:room.color, emissive:room.color, emissiveIntensity:.34, roughness:.40 }));
    obelisk.position.set(room.x, i === 0 ? 48 : 34, room.z); scene.add(obelisk);
    const roomLight = new THREE.PointLight(room.color, i === 0 ? 1.0 : .72, i === 0 ? 420 : 320); roomLight.position.set(room.x, 88, room.z); scene.add(roomLight);
    if(i > 0){
      const dx = room.x - gate.x, dz = room.z - gate.z;
      const len = Math.max(1, Math.hypot(dx, dz));
      const midX = (room.x + gate.x) / 2, midZ = (room.z + gate.z) / 2;
      const corridor = new THREE.Mesh(new THREE.BoxGeometry(76, 6, len), corridorMat);
      corridor.position.set(midX, -8, midZ);
      corridor.rotation.y = Math.atan2(dx, dz);
      scene.add(corridor);
      palaceCreateRoomEdges(THREE, scene, corridor, 0xffe08a, .14);
      corridorPoints.push(gate.x, 6, gate.z, room.x, 6, room.z);
      scene.add(palaceCreatePortal(THREE, gate, room, room.color));
    }
  });
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(corridorPoints), 3));
  scene.add(new THREE.LineSegments(geometry, lineMat));
}
function palaceCreateAvatar(THREE){
  const avatar = new THREE.Group();
  const suit = new THREE.Mesh(new THREE.CylinderGeometry(6, 8, 24, 16), new THREE.MeshStandardMaterial({ color:0xd8e8ff, emissive:0x102040, roughness:.35 }));
  const visor = new THREE.Mesh(new THREE.SphereGeometry(7.8, 18, 12), new THREE.MeshStandardMaterial({ color:0x101b2e, emissive:0x65d6ff, emissiveIntensity:.38, metalness:.2, roughness:.18 }));
  visor.position.y = 16;
  const lantern = new THREE.PointLight(0xffe08a, 1.4, 160); lantern.position.set(10, 8, -8);
  avatar.add(suit, visor, lantern);
  return avatar;
}
function palaceCreateHammyDrone(THREE){
  const drone = new THREE.Group();
  const body = new THREE.Mesh(new THREE.SphereGeometry(5.5, 18, 12), new THREE.MeshStandardMaterial({ color:0xffd1a1, emissive:0x3a1908, roughness:.42 }));
  const glow = new THREE.PointLight(0xffb86b, .9, 120); glow.position.set(0, 0, 0);
  drone.add(body, glow);
  return drone;
}
function inspectPalaceNode(node){
  const scanLabel = node.scanLabel || (node.kind === 'memory' ? 'Memory book' : 'Entity obelisk');
  $('#palaceInspector').innerHTML = `<div class="inspector-kicker">${esc(scanLabel)} · ${esc(node.room || node.category || 'Artifact room')}</div><h3>${esc(node.label || 'Memory artifact')}</h3><p class="muted">${Number(node.count || 0).toLocaleString()} signal(s) · weight ${Number(node.weight || node._weight || 0).toFixed(2)}</p>${node.preview ? `<p>${esc(node.preview)}</p>` : ''}<div class="inspector-actions">${node.memory_id ? '<button id="palaceOpenMemory" class="primary tiny">Open memory</button>' : ''}<button id="palaceBeaconHere" class="tiny">Beacon here</button></div>`;
  if(node.memory_id) $('#palaceOpenMemory').onclick = () => openMemoryDetail(node.memory_id);
  $('#palaceBeaconHere').onclick = () => palaceSetBeacon(node);
}
function palaceSetBeacon(node){
  if(!node || !memoryPalace.THREE || !memoryPalace.scene) return;
  if(memoryPalace.beacon) memoryPalace.beacon.removeFromParent();
  const THREE = memoryPalace.THREE;
  const beacon = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.TorusGeometry(24, 1.2, 8, 48), new THREE.MeshBasicMaterial({ color:0xffe08a, transparent:true, opacity:.82 }));
  const light = new THREE.PointLight(0xffe08a, 1.8, 220); light.position.y = 22;
  beacon.add(ring, light); beacon.position.set(node.x, node.y + 28, node.z);
  memoryPalace.scene.add(beacon); memoryPalace.beacon = beacon; memoryPalace.beaconNode = node;
  $('#palaceHudStatus').textContent = `beacon: ${String(node.label || '').slice(0,34)}`;
}
function palaceSearchBeacon(){
  const q = $('#palaceSearchQuery').value.trim().toLowerCase();
  if(!q){ $('#palaceHudStatus').textContent = 'type a search to place beacon'; return; }
  const node = memoryPalace.nodes.find(n => [n.label,n.category,n.preview].some(v => String(v || '').toLowerCase().includes(q)));
  if(node){ palaceSetBeacon(node); inspectPalaceNode(node); }
  else $('#palaceHudStatus').textContent = `no artifact found for “${q.slice(0,32)}”`;
}
async function renderMemoryPalace(data){
  const THREE = await loadThreeModule();
  clearPalaceScene(); memoryPalace.data = data; memoryPalace.THREE = THREE; palaceInspectorDefault();
  const viewport = $('#palaceViewport'); if(!viewport) return;
  const colors = constellationColors();
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ antialias:true, alpha:true, powerPreference:'high-performance' }); }
  catch(err){ $('#palaceLabels').innerHTML = `<div class="three-fallback-card"><h3>Mnemosyne Labyrinth unavailable</h3><p>This browser could not start WebGL.</p></div>`; return; }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); renderer.setClearColor(cssHexToInt(colors.bg), 0);
  viewport.prepend(renderer.domElement);
  const scene = new THREE.Scene(); scene.fog = new THREE.FogExp2(0x0b0712, .00092);
  const camera = new THREE.PerspectiveCamera(62, 1, 1, 7000);
  const group = new THREE.Group(); scene.add(group);
  scene.add(new THREE.AmbientLight(0xd8c7ff, .42));
  const torch = new THREE.PointLight(0xffe08a, 1.4, 900); torch.position.set(0, 220, 520); scene.add(torch);
  const nodes = palacePositions(data); const byId = new Map(nodes.map(n => [n.id, n]));
  palaceCreateDungeonRooms(THREE, scene, nodes.rooms || []);
  nodes.forEach((n,i)=>{
    group.add(palaceCreatePedestal(THREE, n));
    const geo = n.contaminated ? new THREE.IcosahedronGeometry(n.size || 12, 1) : (n.kind === 'memory' ? new THREE.OctahedronGeometry(n.size || 12, 1) : new THREE.ConeGeometry((n.size || 12) * .75, (n.size || 12) * 2.9, 5));
    const mesh = new THREE.Mesh(geo, palaceCreateArtifactMaterial(THREE, n, colors));
    mesh.position.set(n.x,n.y + 16,n.z); mesh.userData.node = n; n.mesh = mesh; group.add(mesh);
    if(i % 3 === 0 || n.contaminated){ const halo = new THREE.PointLight(n.contaminated ? 0xff4f87 : (n.kind === 'memory' ? cssHexToInt(colors.memory) : cssHexToInt(colors.star)), n.contaminated ? .62 : .32, n.contaminated ? 190 : 130); halo.position.copy(mesh.position); group.add(halo); }
  });
  const lines=[];
  (data.edges || []).slice(0,150).forEach(e=>{ const a=byId.get(e.source), b=byId.get(e.target); if(a && b) lines.push(a.x,a.y,a.z,b.x,b.y,b.z); });
  const lineGeom = new THREE.BufferGeometry(); lineGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(lines), 3));
  group.add(new THREE.LineSegments(lineGeom, new THREE.LineBasicMaterial({ color:0xffe08a, transparent:true, opacity:.15 })));
  const stars = new Float32Array(650*3); for(let i=0;i<650;i++){ stars.set([((i*97)%2000)-1000, ((i*53)%900)-450, -((i*131)%2400)-150], i*3); }
  const starGeom = new THREE.BufferGeometry(); starGeom.setAttribute('position', new THREE.BufferAttribute(stars, 3));
  scene.add(new THREE.Points(starGeom, new THREE.PointsMaterial({ color:0xffffff, size:1.2, transparent:true, opacity:.42, depthWrite:false })));
  const avatar = palaceCreateAvatar(THREE); const drone = palaceCreateHammyDrone(THREE); scene.add(drone);
  Object.assign(memoryPalace, { renderer, scene, camera, group, nodes, rooms:nodes.rooms || [], labels:nodes.filter(n => !/^[a-f0-9]{10,}$/i.test(String(n.label || ''))).slice(0,54), raycaster:new THREE.Raycaster(), mouse:new THREE.Vector2(), avatar, drone });
  $('#palaceLabels').innerHTML = memoryPalace.labels.map((n,i)=>`<span class="three-label ${n.kind === 'memory' ? 'memory' : ''}" data-i="${i}">${esc(String(n.label || '').replace(/^memory:/,'mem ').slice(0,26))}</span>`).join('');
  resetMemoryPalaceDiver(); bindPalaceControls(); resizeMemoryPalace(); animateMemoryPalace(0);
}
function resizeMemoryPalace(){
  if(!memoryPalace.renderer) return;
  const rect = $('#palaceViewport').getBoundingClientRect();
  const w = Math.max(320, rect.width), h = Math.max(320, rect.height);
  memoryPalace.renderer.setSize(w,h,false); memoryPalace.camera.aspect = w/h; memoryPalace.camera.updateProjectionMatrix();
}
function palaceForwardRight(){
  const THREE = memoryPalace.THREE;
  return { forward:new THREE.Vector3(Math.sin(memoryPalace.yaw), 0, -Math.cos(memoryPalace.yaw)), right:new THREE.Vector3(Math.cos(memoryPalace.yaw), 0, Math.sin(memoryPalace.yaw)) };
}
function palaceClampFpsPosition(){
  if(!memoryPalace.pos) return;
  const z = memoryPalace.pos.z;
  let xLimit = 900;
  // Keep the entry path/corridor playable: walking straight should not drift into unbuilt black void.
  if(z > -260) xLimit = 185;
  else if(z > -720) xLimit = 260;
  else if(z > -1320) xLimit = 420;
  memoryPalace.pos.x = Math.max(-xLimit, Math.min(xLimit, memoryPalace.pos.x));
  memoryPalace.pos.y = Math.max(46, Math.min(150, memoryPalace.pos.y));
  memoryPalace.pos.z = Math.max(-1500, Math.min(720, memoryPalace.pos.z));
}
function updatePalaceLabels(){
  if(!memoryPalace.camera) return;
  const rect = $('#palaceViewport').getBoundingClientRect(); const v = new memoryPalace.THREE.Vector3(); let shown=0;
  $$('#palaceLabels .three-label').forEach((el,i)=>{
    const n = memoryPalace.labels[i]; if(!n) return;
    v.set(n.x,n.y,n.z).project(memoryPalace.camera);
    const sx=(v.x*.5+.5)*rect.width, sy=(-v.y*.5+.5)*rect.height;
    const close = memoryPalace.pos ? memoryPalace.pos.distanceTo(n.mesh.position) < 420 : false;
    const visible = close && v.z > -1 && v.z < 1 && sx > 14 && sx < rect.width-14 && sy > 14 && sy < rect.height-14 && shown < 18;
    el.style.display = visible ? '' : 'none';
    if(visible){ shown++; el.style.left = `${sx}px`; el.style.top = `${sy}px`; el.style.opacity = String(Math.max(.34, 1 - Math.abs(v.z)*.42)); }
  });
}
function palaceNearestMemory(maxDist=170){
  if(!memoryPalace.pos) return null;
  let best=null, bestD=maxDist;
  memoryPalace.nodes.forEach(n=>{
    if(!n.mesh || n.kind !== 'memory') return;
    const d=Math.hypot(memoryPalace.pos.x-n.x, memoryPalace.pos.z-n.z);
    if(d<bestD){ best=n; bestD=d; }
  });
  return best;
}
function updatePalaceNearbyPrompt(){
  const near = palaceNearestMemory(155);
  if(near) $('#palaceHudStatus').textContent = `tap to scan memory: ${String(near.label || '').replace(/^memory:/,'').slice(0,30)}`;
  else if($('#palaceHudStatus').textContent.startsWith('tap to scan memory:')) $('#palaceHudStatus').textContent = 'walk forward — memories are grouped by domain';
}
function palaceApplyVisibilityCulling(){
  if(!memoryPalace.scene || !memoryPalace.pos) return;
  memoryPalace.cullTick = (memoryPalace.cullTick || 0) + 1;
  if(memoryPalace.cullTick % 8 !== 0) return;
  let total=0, visible=0;
  const p = memoryPalace.pos;
  // Spatial streaming-lite: keep only nearby scene objects visible/renderable; do not draw the whole labyrinth at once.
  memoryPalace.scene.traverse(obj=>{
    total += 1;
    if(obj === memoryPalace.drone || obj === memoryPalace.beacon || obj.isHemisphereLight || obj.isDirectionalLight){ obj.visible = true; visible += 1; return; }
    if(!obj.parent || obj === memoryPalace.scene){ visible += 1; return; }
    const wp = obj.getWorldPosition ? obj.getWorldPosition(new memoryPalace.THREE.Vector3()) : obj.position;
    const d = Math.hypot(wp.x - p.x, wp.z - p.z);
    const limit = obj.isLight ? 760 : (obj.userData?.node ? 620 : 980);
    obj.visible = d < limit;
    if(obj.visible) visible += 1;
  });
  memoryPalace.lastObjectCount = total;
  memoryPalace.lastVisibleObjectCount = visible;
}
function updatePalaceZoneBadge(){
  const badge = $('.palace-zone-badge');
  if(!badge || !memoryPalace.pos) return;
  let best = null, bestD = Infinity;
  const zones = (memoryPalace.pathSections?.length ? memoryPalace.pathSections : memoryPalace.rooms) || [];
  zones.forEach(r => { const d = Math.hypot(memoryPalace.pos.x - r.x, memoryPalace.pos.z - r.z); if(d < bestD){ bestD = d; best = r; } });
  badge.textContent = best?.label || 'The Archive Gate';
}
function animateMemoryPalace(t=0){
  if(!memoryPalace.renderer) return;
  resizeMemoryPalace();
  const delta = memoryPalace.lastT ? Math.min(48, t - memoryPalace.lastT) / 1000 : .016; memoryPalace.lastT = t;
  const {forward,right} = palaceForwardRight(); const move = new memoryPalace.THREE.Vector3();
  if(palaceKeys.w || palaceKeys.ArrowUp) move.add(forward);
  if(palaceKeys.s || palaceKeys.ArrowDown) move.sub(forward);
  if(palaceKeys.d || palaceKeys.ArrowRight) move.add(right);
  if(palaceKeys.a || palaceKeys.ArrowLeft) move.sub(right);
  if(palaceKeys.q) move.y -= 1; if(palaceKeys.e || palaceKeys[' ']) move.y += 1;
  if(memoryPalace.joystick.x || memoryPalace.joystick.y){ move.addScaledVector(right, memoryPalace.joystick.x); move.addScaledVector(forward, -memoryPalace.joystick.y); }
  if(move.lengthSq() > 0) move.normalize().multiplyScalar((palaceKeys.Shift ? 380 : 210) * delta);
  memoryPalace.pos.add(move);
  memoryPalace.pos.x = Math.max(-1050, Math.min(1050, memoryPalace.pos.x)); memoryPalace.pos.y = Math.max(-260, Math.min(360, memoryPalace.pos.y)); memoryPalace.pos.z = Math.max(-2800, Math.min(860, memoryPalace.pos.z));
  memoryPalace.camera.rotation.order = 'YXZ'; memoryPalace.camera.position.copy(memoryPalace.pos); memoryPalace.camera.rotation.y = memoryPalace.yaw; memoryPalace.camera.rotation.x = memoryPalace.pitch;
  if(memoryPalace.avatar){ const avatarPos = memoryPalace.pos.clone().add(forward.clone().multiplyScalar(58)).add(new memoryPalace.THREE.Vector3(0,-34,0)); memoryPalace.avatar.position.lerp(avatarPos, .18); memoryPalace.avatar.rotation.y = memoryPalace.yaw; }
  if(memoryPalace.drone){ const bob = Math.sin(t*.002)*5; const dronePos = memoryPalace.pos.clone().add(right.clone().multiplyScalar(42)).add(new memoryPalace.THREE.Vector3(0,18+bob,-30)); memoryPalace.drone.position.lerp(dronePos, .12); }
  if(memoryPalace.beacon) memoryPalace.beacon.rotation.y += delta * 1.4;
  memoryPalace.nodes.forEach((n,i)=>{ if(n.mesh){ n.mesh.rotation.y += delta * (.18 + (i%5)*.03); n.mesh.rotation.x += delta * .05; }});
  memoryPalace.renderer.render(memoryPalace.scene, memoryPalace.camera); updatePalaceLabels(); updatePalaceZoneBadge();
  memoryPalace.frame = requestAnimationFrame(animateMemoryPalace);
}
async function loadMemoryPalace(){ renderMemoryPalace(await api('/api/constellation?limit=360')); }
function pickPalaceNode(e){
  if(!memoryPalace.raycaster) return;
  const rect = $('#palaceViewport').getBoundingClientRect();
  memoryPalace.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1; memoryPalace.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  memoryPalace.raycaster.setFromCamera(memoryPalace.mouse, memoryPalace.camera);
  const meshes = memoryPalace.nodes.map(n=>n.mesh).filter(Boolean);
  const hit = memoryPalace.raycaster.intersectObjects(meshes, false)[0];
  if(hit?.object?.userData?.node){ inspectPalaceNode(hit.object.userData.node); return; }
  const near = palaceNearestMemory(180);
  if(near){ inspectPalaceNode(near); return; }
  $('#palaceHudStatus').textContent = 'walk nearer to a memory book, then tap to scan';
}
function stopPalaceJoystickEvent(e){
  e.stopPropagation();
  if(e.cancelable) e.preventDefault();
}
function bindPalaceControls(){
  const viewport = $('#palaceViewport'); if(!viewport || viewport.dataset.controlsBound === 'true') return; viewport.dataset.controlsBound = 'true';
  window.addEventListener('keydown', e => { if(sectionFor(currentRoute.tab) === 'memoryPalace') palaceKeys[e.key.length === 1 ? e.key.toLowerCase() : e.key] = true; });
  window.addEventListener('keyup', e => { palaceKeys[e.key.length === 1 ? e.key.toLowerCase() : e.key] = false; });
  viewport.addEventListener('pointerdown', e=>{ if(e.target.closest('.fullscreen-exit') || e.target.closest('#palaceJoystick')) return; viewport.setPointerCapture?.(e.pointerId); memoryPalace.pointer={x:e.clientX,y:e.clientY,moved:false}; });
  viewport.addEventListener('pointermove', e=>{ if(!memoryPalace.pointer) return; const dx=e.clientX-memoryPalace.pointer.x, dy=e.clientY-memoryPalace.pointer.y; memoryPalace.pointer.x=e.clientX; memoryPalace.pointer.y=e.clientY; memoryPalace.pointer.moved = memoryPalace.pointer.moved || Math.abs(dx)+Math.abs(dy)>3; memoryPalace.yaw -= dx*.0032; memoryPalace.pitch = Math.max(-1.05, Math.min(.82, memoryPalace.pitch - dy*.0024)); });
  const end=()=>{ setTimeout(()=>{ memoryPalace.pointer=null; }, 0); }; viewport.addEventListener('pointerup', end); viewport.addEventListener('pointercancel', end);
  viewport.addEventListener('click', e=>{ if(e.target.closest('#palaceJoystick') || memoryPalace.pointer?.moved) return; pickPalaceNode(e); });
  const joy = $('#palaceJoystick');
  const updateJoy = e => {
    stopPalaceJoystickEvent(e); if(joy.dataset.active !== 'true') return;
    const r=joy.getBoundingClientRect(), cx=r.left+r.width/2, cy=r.top+r.height/2, max=r.width*.38;
    let dx=e.clientX-cx, dy=e.clientY-cy; const dist=Math.hypot(dx,dy);
    if(dist > max){ dx = dx/dist*max; dy = dy/dist*max; }
    const rawX = dx/max, rawY = dy/max, mag = Math.min(1, Math.hypot(rawX, rawY));
    const dead = .16, scaled = mag <= dead ? 0 : (mag-dead)/(1-dead);
    const nx = mag ? rawX/mag*scaled : 0, ny = mag ? rawY/mag*scaled : 0;
    memoryPalace.joystick={x:nx, y:ny}; joy.querySelector('span').style.transform=`translate(${rawX*28}px,${rawY*28}px)`;
  };
  joy.addEventListener('pointerdown', e=>{ stopPalaceJoystickEvent(e); joy.setPointerCapture?.(e.pointerId); joy.dataset.active='true'; memoryPalace.pointer=null; updateJoy(e); });
  joy.addEventListener('pointermove', updateJoy);
  const stopJoy=e=>{ stopPalaceJoystickEvent(e); joy.dataset.active='false'; memoryPalace.joystick={x:0,y:0}; joy.querySelector('span').style.transform='translate(0,0)'; }; joy.addEventListener('pointerup', stopJoy); joy.addEventListener('pointercancel', stopJoy);
}


// V4: game-first isometric dungeon view. Keep the older first-person prototype above as
// reusable primitives, but render the Labyrinth as a readable game board by default.
function palaceIsoRoomLayout(data){
  const nodes = (data.nodes || []).slice(0,150).map(n => ({...n}));
  const categories = [...new Set(nodes.map(n => n.category || 'Other'))];
  const rooms = [
    { label:'Archive Gate', x:0, z:420, w:320, d:250, color:0xffd166 },
    { label:'Episodic Vault', x:-520, z:40, w:300, d:240, color:0x65d6ff },
    { label:'Working Stream', x:520, z:20, w:300, d:240, color:0x52d6b5 },
    { label:'Entity Gardens', x:-560, z:-420, w:300, d:240, color:0xb9a6ff },
    { label:'Cold Storage', x:520, z:-450, w:300, d:240, color:0x8aa0c9 },
    { label:'Review Wing', x:0, z:-760, w:340, d:260, color:0xff5f87 }
  ];
  categories.slice(0,4).forEach((cat,i)=>{ rooms[i+1].category = cat; rooms[i+1].label = String(cat).slice(0,18); });
  nodes.forEach((n,i)=>{
    const contaminated = ['unknown','inferred','imported'].includes(String(n.veracity || '').toLowerCase()) || /contaminat|unknown|untrusted/i.test(String(n.reason || n.preview || ''));
    const room = contaminated ? rooms[5] : rooms[1 + (i % 4)];
    const col = i % 5, row = Math.floor((i % 25) / 5);
    n.x = room.x - room.w*.34 + col * (room.w*.17);
    n.z = room.z - room.d*.28 + row * (room.d*.14);
    n.y = 34;
    n.room = room.label; n.contaminated = contaminated;
    n.size = Math.min(22, 9 + Math.sqrt(Math.max(1, Number(n.weight || n.count || 1))) * 3.5);
  });
  nodes.rooms = rooms;
  return nodes;
}
function palaceIsoMaterial(THREE, color, opts={}){
  return new THREE.MeshStandardMaterial({
    color,
    emissive:opts.emissive || 0x07040d,
    emissiveIntensity:opts.emissiveIntensity ?? .18,
    roughness:opts.roughness ?? .72,
    metalness:opts.metalness ?? .04
  });
}
function palaceAddIsoRoom(THREE, scene, room, i){
  const floorMat = palaceIsoMaterial(THREE, i === 0 ? 0x44344f : 0x342945, { emissive:room.color, emissiveIntensity:.035 });
  const edgeMat = new THREE.LineBasicMaterial({ color:room.color, transparent:true, opacity:.46 });
  const wallMat = palaceIsoMaterial(THREE, 0x5b4967, { emissive:room.color, emissiveIntensity:.055, roughness:.80 });
  const floor = new THREE.Mesh(new THREE.BoxGeometry(room.w, 14, room.d), floorMat);
  floor.position.set(room.x, 0, room.z); floor.receiveShadow = true; scene.add(floor);
  const floorEdges = new THREE.LineSegments(new THREE.EdgesGeometry(floor.geometry), edgeMat);
  floorEdges.position.copy(floor.position); scene.add(floorEdges);
  const wallH = i === 0 ? 56 : 48, t = 18;
  [
    [0, room.d/2, room.w, t], [0, -room.d/2, room.w, t],
    [room.w/2, 0, t, room.d], [-room.w/2, 0, t, room.d]
  ].forEach(([ox,oz,w,d],side)=>{
    const wall = new THREE.Mesh(new THREE.BoxGeometry(w, wallH, d), wallMat);
    wall.position.set(room.x + ox, wallH/2 + 7, room.z + oz); wall.castShadow = true; wall.receiveShadow = true; scene.add(wall);
    const lines = new THREE.LineSegments(new THREE.EdgesGeometry(wall.geometry), new THREE.LineBasicMaterial({ color:0xd8c7ff, transparent:true, opacity:.20 }));
    lines.position.copy(wall.position); scene.add(lines);
    if(side < 2){
      for(let k=-2;k<=2;k++){
        const crenel = new THREE.Mesh(new THREE.BoxGeometry(26, 18, t+4), wallMat);
        crenel.position.set(room.x + k*44, wallH + 22, room.z + oz); crenel.castShadow = true; scene.add(crenel);
      }
    }
  });
  const gridPts = [];
  for(let gx=-Math.floor(room.w/2)+44; gx<room.w/2; gx+=44){ gridPts.push(room.x+gx,8,room.z-room.d/2+18, room.x+gx,8,room.z+room.d/2-18); }
  for(let gz=-Math.floor(room.d/2)+44; gz<room.d/2; gz+=44){ gridPts.push(room.x-room.w/2+18,8,room.z+gz, room.x+room.w/2-18,8,room.z+gz); }
  const tileGeom = new THREE.BufferGeometry(); tileGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(gridPts), 3));
  scene.add(new THREE.LineSegments(tileGeom, new THREE.LineBasicMaterial({ color:0xffffff, transparent:true, opacity:.075 })));
  const banner = new THREE.Mesh(new THREE.CylinderGeometry(7,7,70,6), palaceIsoMaterial(THREE, room.color, { emissive:room.color, emissiveIntensity:.62, roughness:.35 }));
  banner.position.set(room.x, 52, room.z); banner.castShadow = true; scene.add(banner);
  if(i === 0){
    const gateMat = palaceIsoMaterial(THREE, 0xffd166, { emissive:0xffb84d, emissiveIntensity:.42, roughness:.42, metalness:.08 });
    const left = new THREE.Mesh(new THREE.BoxGeometry(24,92,24), gateMat); left.position.set(room.x-58,66,room.z+46);
    const right = left.clone(); right.position.x = room.x+58;
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(140,24,28), gateMat); lintel.position.set(room.x,116,room.z+46);
    const portal = new THREE.Mesh(new THREE.TorusGeometry(47,3.2,8,48), new THREE.MeshBasicMaterial({ color:0xffe6a3, transparent:true, opacity:.74 }));
    portal.rotation.y = Math.PI/2; portal.position.set(room.x,70,room.z+49);
    left.castShadow = right.castShadow = lintel.castShadow = true; scene.add(left,right,lintel,portal);
    const gateLight = new THREE.PointLight(0xffd166, 1.25, 430); gateLight.position.set(room.x,110,room.z+70); scene.add(gateLight);
  }
  const light = new THREE.PointLight(room.color, .72, 360); light.position.set(room.x, 120, room.z); scene.add(light);
}
function palaceAddIsoCorridor(THREE, scene, a, b){
  const dx=b.x-a.x, dz=b.z-a.z, len=Math.hypot(dx,dz), midX=(a.x+b.x)/2, midZ=(a.z+b.z)/2;
  const mat = palaceIsoMaterial(THREE, 0x3f344d, { emissive:0xffd166, emissiveIntensity:.04 });
  const road = new THREE.Mesh(new THREE.BoxGeometry(82, 10, len), mat);
  road.position.set(midX, -5, midZ); road.rotation.y = Math.atan2(dx,dz); road.receiveShadow = true; scene.add(road);
  const edge = new THREE.LineSegments(new THREE.EdgesGeometry(road.geometry), new THREE.LineBasicMaterial({ color:0xffd166, transparent:true, opacity:.28 }));
  edge.position.copy(road.position); edge.rotation.copy(road.rotation); scene.add(edge);
}
function palaceAddIsoRelic(THREE, scene, node, colors){
  const plinth = new THREE.Mesh(new THREE.CylinderGeometry(15, 20, 12, 6), palaceIsoMaterial(THREE, 0x20182b));
  plinth.position.set(node.x, 17, node.z); plinth.castShadow = true; plinth.receiveShadow = true; scene.add(plinth);
  const color = node.contaminated ? 0xff4f87 : (node.kind === 'memory' ? cssHexToInt(colors.memory) : cssHexToInt(colors.star));
  const geo = node.contaminated ? new THREE.IcosahedronGeometry(node.size,1) : (node.kind === 'memory' ? new THREE.OctahedronGeometry(node.size,1) : new THREE.BoxGeometry(node.size*1.1,node.size*2.0,node.size*1.1));
  const relic = new THREE.Mesh(geo, palaceIsoMaterial(THREE, color, { emissive:color, emissiveIntensity: node.contaminated ? .55 : .34, roughness:.34, metalness:.08 }));
  relic.position.set(node.x, 40 + node.size*.25, node.z); relic.castShadow = true; relic.userData.node = node; node.mesh = relic; scene.add(relic);
  if(node.contaminated) node.scanLabel = 'Needs-review memory';
  const glow = new THREE.PointLight(color, node.contaminated ? .55 : .22, 110); glow.position.copy(relic.position); scene.add(glow);
}
async function renderMemoryPalace(data){
  const THREE = await loadThreeModule();
  clearPalaceScene(); memoryPalace.data = data; memoryPalace.THREE = THREE; palaceInspectorDefault();
  const viewport = $('#palaceViewport'); if(!viewport) return;
  const colors = constellationColors();
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ antialias:true, alpha:true, powerPreference:'high-performance' }); }
  catch(err){ $('#palaceLabels').innerHTML = `<div class="three-fallback-card"><h3>Mnemosyne Labyrinth unavailable</h3><p>This browser could not start WebGL.</p></div>`; return; }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(cssHexToInt(colors.bg), 0);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  viewport.prepend(renderer.domElement);
  const scene = new THREE.Scene(); scene.fog = new THREE.FogExp2(0x08050e, .00052);
  const camera = new THREE.OrthographicCamera(-700,700,420,-420,1,5000);
  const nodes = palaceIsoRoomLayout(data); const rooms = nodes.rooms || [];
  scene.add(new THREE.HemisphereLight(0xb9a6ff, 0x08050e, .82));
  const sun = new THREE.DirectionalLight(0xffe7c0, 1.35); sun.position.set(620,980,720); sun.castShadow = true; sun.shadow.mapSize.set(2048,2048); scene.add(sun);
  const underlay = new THREE.Mesh(new THREE.PlaneGeometry(1900,1900), new THREE.MeshBasicMaterial({ color:0x0a0711, transparent:true, opacity:.62 }));
  underlay.rotation.x = -Math.PI/2; underlay.position.y = -16; scene.add(underlay);
  rooms.slice(1).forEach(room => palaceAddIsoCorridor(THREE, scene, rooms[0], room));
  rooms.forEach((room,i)=>palaceAddIsoRoom(THREE, scene, room, i));
  nodes.forEach(n => palaceAddIsoRelic(THREE, scene, n, colors));
  const player = palaceCreateAvatar(THREE); player.scale.setScalar(1.35); player.position.set(rooms[0]?.x || 0, 52, (rooms[0]?.z || 0) - 38); scene.add(player);
  const drone = palaceCreateHammyDrone(THREE); drone.scale.setScalar(1.35); scene.add(drone);
  Object.assign(memoryPalace, { renderer, scene, camera, group:scene, nodes, rooms, labels:rooms.map((r,i)=>({ label:r.label, x:r.x, y:110, z:r.z, kind:i===0?'memory':'room' })).concat(nodes.filter(n => n.contaminated || n.kind === 'memory').filter(n => !/^[a-f0-9]{10,}$/i.test(String(n.label || ''))).slice(0,8)), raycaster:new THREE.Raycaster(), mouse:new THREE.Vector2(), avatar:player, drone, pos:new THREE.Vector3(0,0,-170), velocity:new THREE.Vector3(), yaw:0, pitch:0, iso:true });
  $('#palaceLabels').innerHTML = memoryPalace.labels.map((n,i)=>`<span class="three-label ${n.kind === 'memory' ? 'memory' : ''}" data-i="${i}">${esc(String(n.label || '').replace(/^memory:/,'mem ').slice(0,24))}</span>`).join('');
  $('#palaceHudStatus').textContent = 'isometric dungeon map online';
  bindPalaceControls(); resizeMemoryPalace(); animateMemoryPalace(0);
}
function resizeMemoryPalace(){
  if(!memoryPalace.renderer) return;
  const rect = $('#palaceViewport').getBoundingClientRect();
  const w = Math.max(320, rect.width), h = Math.max(320, rect.height);
  memoryPalace.renderer.setSize(w,h,false);
  if(memoryPalace.camera?.isOrthographicCamera){
    const view = Math.max(980, Math.min(1480, 1260 * Math.max(.82, Math.min(1.12, w / Math.max(h,1)))));
    memoryPalace.camera.left = -view * w / h / 2; memoryPalace.camera.right = view * w / h / 2;
    memoryPalace.camera.top = view / 2; memoryPalace.camera.bottom = -view / 2;
  } else if(memoryPalace.camera){ memoryPalace.camera.aspect = w/h; }
  memoryPalace.camera?.updateProjectionMatrix();
}
function updatePalaceLabels(){
  if(!memoryPalace.camera) return;
  const rect = $('#palaceViewport').getBoundingClientRect(); const v = new memoryPalace.THREE.Vector3(); let shown=0;
  $$('#palaceLabels .three-label').forEach((el,i)=>{
    const n = memoryPalace.labels[i]; if(!n) return;
    v.set(n.x,n.y,n.z).project(memoryPalace.camera);
    const sx=(v.x*.5+.5)*rect.width, sy=(-v.y*.5+.5)*rect.height;
    const visible = v.z > -1 && v.z < 1 && sx > 10 && sx < rect.width-10 && sy > 10 && sy < rect.height-10 && shown < 30;
    el.style.display = visible ? '' : 'none';
    if(visible){ shown++; el.style.left = `${sx}px`; el.style.top = `${sy}px`; el.style.opacity = String(n.room ? .78 : .96); }
  });
}
function animateMemoryPalace(t=0){
  if(!memoryPalace.renderer) return;
  resizeMemoryPalace();
  const THREE = memoryPalace.THREE;
  const delta = memoryPalace.lastT ? Math.min(48, t - memoryPalace.lastT) / 1000 : .016; memoryPalace.lastT = t;
  const speed = (palaceKeys.Shift ? 520 : 300) * delta;
  if(palaceKeys.w || palaceKeys.ArrowUp) memoryPalace.pos.z -= speed;
  if(palaceKeys.s || palaceKeys.ArrowDown) memoryPalace.pos.z += speed;
  if(palaceKeys.a || palaceKeys.ArrowLeft) memoryPalace.pos.x -= speed;
  if(palaceKeys.d || palaceKeys.ArrowRight) memoryPalace.pos.x += speed;
  if(memoryPalace.joystick.x || memoryPalace.joystick.y){ memoryPalace.pos.x += memoryPalace.joystick.x * speed; memoryPalace.pos.z += memoryPalace.joystick.y * speed; }
  memoryPalace.pos.x = Math.max(-760, Math.min(760, memoryPalace.pos.x)); memoryPalace.pos.z = Math.max(-980, Math.min(560, memoryPalace.pos.z));
  memoryPalace.camera.position.set(memoryPalace.pos.x + 760, 980, memoryPalace.pos.z + 860);
  memoryPalace.camera.lookAt(new THREE.Vector3(memoryPalace.pos.x, 0, memoryPalace.pos.z));
  if(memoryPalace.avatar){ memoryPalace.avatar.position.x += (memoryPalace.pos.x - memoryPalace.avatar.position.x) * .16; memoryPalace.avatar.position.z += (memoryPalace.pos.z + 360 - memoryPalace.avatar.position.z) * .16; memoryPalace.avatar.rotation.y = Math.PI * .75; }
  if(memoryPalace.drone && memoryPalace.avatar){ const bob = Math.sin(t*.004)*8; memoryPalace.drone.position.set(memoryPalace.avatar.position.x + 42, memoryPalace.avatar.position.y + 38 + bob, memoryPalace.avatar.position.z - 34); }
  if(memoryPalace.beacon) memoryPalace.beacon.rotation.y += delta * 1.4;
  memoryPalace.nodes.forEach((n,i)=>{ if(n.mesh){ n.mesh.rotation.y += delta * (.25 + (i%5)*.035); }});
  memoryPalace.renderer.render(memoryPalace.scene, memoryPalace.camera); updatePalaceLabels(); updatePalaceZoneBadge();
  memoryPalace.frame = requestAnimationFrame(animateMemoryPalace);
}


// V7: solid first-person memory dungeon. The Labyrinth must feel like walking inside the
// memory archive, not viewing a whole strategy/minimap board.
function palaceFpsRooms(data){
  const raw = (data.nodes || []).map(n => ({...n}));
  const memoryNodes = raw.filter(n => n.kind === 'memory' || n.memory_id);
  const domainSource = (memoryNodes.length ? memoryNodes : raw).slice(0,140);
  const domainGroups = {};
  domainSource.forEach(n => {
    const c = String(n.category || 'Other');
    if(!domainGroups[c]) domainGroups[c] = [];
    domainGroups[c].push(n);
  });
  const countByCat = Object.fromEntries(Object.entries(domainGroups).map(([cat, items]) => [cat, items.length]));
  const cats = Object.keys(countByCat).sort((a,b)=>countByCat[b]-countByCat[a] || a.localeCompare(b));
  const nodes = [];
  for(let round=0; nodes.length < 40 && round < 20; round++){
    cats.forEach(cat => {
      const n = domainGroups[cat]?.[round];
      if(n && nodes.length < 40) nodes.push(n);
    });
  }
  const rooms = [
    { label:'Archive Gate', x:0, z:0, w:420, d:360, color:0xffd166 },
    { label:String(cats[0] || 'Episodic Vault').slice(0,20), x:-520, z:-520, w:380, d:340, color:0x65d6ff },
    { label:String(cats[1] || 'Working Stream').slice(0,20), x:520, z:-520, w:380, d:340, color:0x52d6b5 },
    { label:String(cats[2] || 'Entity Gardens').slice(0,20), x:-520, z:-1120, w:380, d:340, color:0xb9a6ff },
    { label:String(cats[3] || 'Cold Storage').slice(0,20), x:520, z:-1120, w:380, d:340, color:0x8aa0c9 },
    { label:'Review Wing', x:0, z:-1680, w:430, d:360, color:0xff5f87 }
  ];
  const sectionColors = [0xffd166,0x65d6ff,0x52d6b5,0xb9a6ff,0xff9f6e,0x8aa0c9];
  const pathSections = cats.slice(0,6).map((cat,i)=>({
    label:String(cat || 'Other').slice(0,20), category:cat, x:0, y:150, z:245 - i*330,
    kind:'section', chunkId:Math.floor((245 - i*330 + 1600) / 350), color:sectionColors[i % sectionColors.length], count:countByCat[cat] || 0
  }));
  const seenInSection = {};
  let featured = 0;
  nodes.forEach((n,i)=>{
    const contaminated = ['unknown','inferred','imported'].includes(String(n.veracity || '').toLowerCase()) || /contaminat|unknown|untrusted/i.test(String(n.reason || n.preview || ''));
    let room = contaminated ? rooms[5] : rooms[1 + (i % 4)];
    if(!contaminated && n.kind === 'memory' && featured < 24){
      // Group the first playable walk by memory domain so the dungeon reads like a map, not random books.
      const cat = String(n.category || 'Other');
      const section = pathSections.find(s => s.category === cat) || pathSections[0] || { label:'Archive Gate', z:245 };
      const within = seenInSection[cat] || 0; seenInSection[cat] = within + 1;
      room = rooms[0];
      const side = within % 2 === 0 ? -1 : 1;
      const row = Math.floor(within / 2);
      n.x = side * (row < 2 ? 58 : 86);
      n.z = section.z - row * 105;
      n.y = 34; n.room = section.label; n.pathGroup = section.label; n.featuredPath = true;
      featured += 1;
    } else {
      const col = i % 4, row = Math.floor((i % 20) / 4);
      n.x = room.x - room.w*.30 + col * (room.w*.20);
      n.z = room.z - room.d*.22 + row * (room.d*.11);
      n.y = 34; n.room = room.label;
    }
    n.contaminated = contaminated;
    n.size = Math.min(28, 10 + Math.sqrt(Math.max(1, Number(n.weight || n.count || 1))) * 4);
    n.chunkId = Math.floor((n.z + 1600) / 350);
  });
  nodes.pathSections = pathSections;
  nodes.rooms = rooms;
  return nodes;
}
function palaceFpsMat(THREE, color, opts={}){
  return new THREE.MeshStandardMaterial({ color, emissive:opts.emissive || 0x05030a, emissiveIntensity:opts.emissiveIntensity ?? .08, roughness:opts.roughness ?? .76, metalness:opts.metalness ?? .04 });
}
function palaceFpsBox(THREE, scene, size, pos, mat){
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), mat);
  mesh.position.set(...pos); mesh.castShadow = true; mesh.receiveShadow = true; scene.add(mesh);
  return mesh;
}
function palaceFpsTexture(THREE, kind, base='#4b344d', line='rgba(255,224,138,.28)'){
  const c = document.createElement('canvas'); c.width = 128; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = base; g.fillRect(0,0,128,128);
  if(kind === 'stone'){
    g.strokeStyle = line; g.lineWidth = 2;
    for(let y=0;y<=128;y+=32){ g.beginPath(); g.moveTo(0,y+.5); g.lineTo(128,y+.5); g.stroke(); }
    for(let y=0;y<128;y+=32){ for(let x=(y/32)%2?32:0;x<128;x+=64){ g.beginPath(); g.moveTo(x+.5,y); g.lineTo(x+.5,y+32); g.stroke(); } }
    g.fillStyle = 'rgba(255,255,255,.055)'; for(let i=0;i<70;i++) g.fillRect(Math.random()*128, Math.random()*128, 1.5, 1.5);
    g.fillStyle = 'rgba(0,0,0,.16)'; for(let i=0;i<40;i++) g.fillRect(Math.random()*128, Math.random()*128, 2, 1);
  } else if(kind === 'gold'){
    const grad = g.createLinearGradient(0,0,128,128); grad.addColorStop(0,'#f3d589'); grad.addColorStop(.45,base); grad.addColorStop(1,'#7f622b');
    g.fillStyle = grad; g.fillRect(0,0,128,128);
    g.strokeStyle = 'rgba(255,245,190,.34)'; g.lineWidth = 3; for(let y=18;y<128;y+=28){ g.beginPath(); g.moveTo(0,y); g.lineTo(128,y+10); g.stroke(); }
    g.fillStyle = 'rgba(0,0,0,.10)'; for(let i=0;i<45;i++) g.fillRect(Math.random()*128, Math.random()*128, 2, 2);
  } else if(kind === 'door'){
    const grad = g.createRadialGradient(64,58,5,64,64,78); grad.addColorStop(0,'#ffc078'); grad.addColorStop(.45,base); grad.addColorStop(1,'#2f1f25');
    g.fillStyle = grad; g.fillRect(0,0,128,128);
    g.strokeStyle = 'rgba(255,220,150,.24)'; g.lineWidth = 2; for(let x=18;x<128;x+=24){ g.beginPath(); g.moveTo(x,0); g.lineTo(x+6,128); g.stroke(); }
  }
  const tex = new THREE.CanvasTexture(c); tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.anisotropy = 2; return tex;
}
function palaceFpsTexturedBasic(THREE, kind, color, repeat=[1,1], opacity=1){
  const map = palaceFpsTexture(THREE, kind, color);
  map.repeat.set(...repeat);
  return new THREE.MeshBasicMaterial({ color:0xffffff, map, transparent:opacity < 1, opacity, side:THREE.DoubleSide });
}
function palaceFpsAddRoom(THREE, scene, room, i){
  const floorMat = palaceFpsMat(THREE, i === 0 ? 0x3f314a : 0x30243d, { emissive:room.color, emissiveIntensity:.025 });
  const wallMat = palaceFpsMat(THREE, 0x554461, { emissive:room.color, emissiveIntensity:.035, roughness:.82 });
  palaceFpsBox(THREE, scene, [room.w, 16, room.d], [room.x, -8, room.z], floorMat, room.color, .28);
  const wallH = i === 0 ? 150 : 126, t = 24;
  const door = 120;
  [[0,room.d/2,room.w,t,'north'],[0,-room.d/2,room.w,t,'south'],[room.w/2,0,t,room.d,'east'],[-room.w/2,0,t,room.d,'west']].forEach(([ox,oz,w,d,side])=>{
    const isDoorSide = i === 0 && side === 'north';
    if(isDoorSide){
      palaceFpsBox(THREE, scene, [(w-door)/2, wallH, d], [room.x - (w+door)/4, wallH/2, room.z+oz], wallMat, 0xe8d8ff, .16);
      palaceFpsBox(THREE, scene, [(w-door)/2, wallH, d], [room.x + (w+door)/4, wallH/2, room.z+oz], wallMat, 0xe8d8ff, .16);
      palaceFpsBox(THREE, scene, [door+32, 24, d+8], [room.x, wallH+12, room.z+oz], wallMat, 0xffd166, .35);
      return;
    }
    palaceFpsBox(THREE, scene, [w, wallH, d], [room.x+ox, wallH/2, room.z+oz], wallMat, 0xe8d8ff, .13);
  });
  // Keep the FPS view solid, not wireframe/skeletal. Subtle floor blocks give scale without debug grid lines.
  const tileMat = palaceFpsMat(THREE, 0x473854, { emissive:room.color, emissiveIntensity:.018, roughness:.86 });
  for(let x=-room.w/2+64; x<room.w/2-24; x+=96){
    for(let z=-room.d/2+64; z<room.d/2-24; z+=96){
      const inset = new THREE.Mesh(new THREE.BoxGeometry(54, 2, 54), tileMat);
      inset.position.set(room.x+x, 2, room.z+z); inset.receiveShadow = true; scene.add(inset);
    }
  }
  const light = new THREE.PointLight(room.color, i === 0 ? 1.1 : .72, 480); light.position.set(room.x,130,room.z); scene.add(light);
  if(i === 0){
    // Mobile Chrome crushes subtle StandardMaterial lighting; the first screen needs deliberate unlit, high-contrast shapes.
    const gateMat = palaceFpsTexturedBasic(THREE, 'gold', '#caa45c', [2.2,1.1]);
    const sideMat = palaceFpsTexturedBasic(THREE, 'stone', '#4b344d', [1,4]);
    const floorMat = palaceFpsTexturedBasic(THREE, 'stone', '#2f2440', [3,8]);
    const railMat = palaceFpsTexturedBasic(THREE, 'gold', '#d7b36d', [1,5]);
    const doorMat = palaceFpsTexturedBasic(THREE, 'door', '#9b6041', [1.2,1], .62);
    palaceFpsBox(THREE, scene, [360, 14, 660], [room.x, -7, room.z+270], floorMat);
    palaceFpsBox(THREE, scene, [22, 18, 620], [room.x-116, 8, room.z+254], railMat);
    palaceFpsBox(THREE, scene, [22, 18, 620], [room.x+116, 8, room.z+254], railMat);
    for(let z=450; z>-80; z-=90){ palaceFpsBox(THREE, scene, [230, 8, 12], [room.x, 6, room.z+z], railMat); }
    palaceFpsBox(THREE, scene, [46,168,46], [room.x-126,86,room.z-120], gateMat);
    palaceFpsBox(THREE, scene, [46,168,46], [room.x+126,86,room.z-120], gateMat);
    palaceFpsBox(THREE, scene, [298,42,52], [room.x,170,room.z-120], gateMat);
    palaceFpsBox(THREE, scene, [34,132,430], [room.x-210,66,room.z+90], sideMat);
    palaceFpsBox(THREE, scene, [34,132,430], [room.x+210,66,room.z+90], sideMat);
    palaceFpsBox(THREE, scene, [156,122,18], [room.x,76,room.z-152], palaceFpsTexturedBasic(THREE, 'door', '#6f4e3a', [1,1]));
    // No circular portal at the starting view: rings read as bullseyes on real mobile. Use a lit doorway instead.
    const doorway = new THREE.Mesh(new THREE.PlaneGeometry(126, 104), doorMat);
    doorway.position.set(room.x,80,room.z-164); scene.add(doorway);
    [-1,1].forEach(side=>{
      const torch = new THREE.Mesh(new THREE.BoxGeometry(14,46,12), new THREE.MeshBasicMaterial({ color:0xffdf9b }));
      torch.position.set(room.x + side*158, 112, room.z-82); scene.add(torch);
      const flame = new THREE.PointLight(0xffb35c, 2.1, 460); flame.position.copy(torch.position); scene.add(flame);
    });
    const glow = new THREE.PointLight(0xffd166, 2.4, 720); glow.position.set(room.x,112,room.z-150); scene.add(glow);
    // Continue the authored path beyond the entrance so walking straight never drops into blank space.
    const hallFloor = palaceFpsBox(THREE, scene, [240, 10, 1500], [room.x, -5, room.z-860], floorMat);
    hallFloor.userData.walkable = true;
    palaceFpsBox(THREE, scene, [18, 16, 1450], [room.x-112, 5, room.z-840], railMat);
    palaceFpsBox(THREE, scene, [18, 16, 1450], [room.x+112, 5, room.z-840], railMat);
    for(let z=-260; z>-1280; z-=240){
      palaceFpsBox(THREE, scene, [150, 8, 10], [room.x, 8, room.z+z], railMat);
      [-1,1].forEach(side=>{
        palaceFpsBox(THREE, scene, [16, 60, 16], [room.x+side*150, 34, room.z+z], gateMat);
      });
    }
    palaceFpsBox(THREE, scene, [300, 120, 26], [room.x, 60, room.z-1510], sideMat);
    palaceFpsBox(THREE, scene, [170, 88, 18], [room.x, 62, room.z-1494], doorMat);
    const endLight = new THREE.PointLight(0xffd166, 1.1, 360); endLight.position.set(room.x, 92, room.z-1420); scene.add(endLight);
  }
}
function palaceFpsAddPathSections(THREE, scene, sections){
  const markerMat = color => new THREE.MeshBasicMaterial({ color, transparent:true, opacity:.82 });
  (sections || []).forEach(section=>{
    const mat = markerMat(section.color || 0xffd166);
    palaceFpsBox(THREE, scene, [250, 8, 18], [0, 12, section.z + 42], mat);
    palaceFpsBox(THREE, scene, [18, 92, 18], [-138, 48, section.z + 42], mat);
    palaceFpsBox(THREE, scene, [18, 92, 18], [138, 48, section.z + 42], mat);
    const glow = new THREE.PointLight(section.color || 0xffd166, .55, 300); glow.position.set(0, 86, section.z + 42); scene.add(glow);
  });
}
function palaceFpsAddCorridor(THREE, scene, a, b){
  const dx=b.x-a.x, dz=b.z-a.z, len=Math.hypot(dx,dz), midX=(a.x+b.x)/2, midZ=(a.z+b.z)/2;
  const mat = palaceFpsMat(THREE, 0x372a46, { emissive:0xffd166, emissiveIntensity:.025 });
  const road = palaceFpsBox(THREE, scene, [118, 12, len], [midX, -6, midZ], mat, 0xffd166, .18);
  road.rotation.y = Math.atan2(dx,dz);
  const wallMat = palaceFpsMat(THREE, 0x4a3a58, { emissive:0x140a20, emissiveIntensity:.04 });
  [-1,1].forEach(side=>{
    const wall = new THREE.Mesh(new THREE.BoxGeometry(18,86,len), wallMat);
    wall.position.set(midX + Math.cos(road.rotation.y)*side*68, 43, midZ - Math.sin(road.rotation.y)*side*68);
    wall.rotation.y = road.rotation.y; wall.castShadow = wall.receiveShadow = true; scene.add(wall);
  });
}
function palaceFpsAddRelic(THREE, scene, node, colors){
  const plinth = new THREE.Mesh(new THREE.CylinderGeometry(17,24,16,7), palaceFpsMat(THREE, 0x21172c));
  plinth.position.set(node.x,10,node.z); plinth.castShadow = plinth.receiveShadow = false; scene.add(plinth);
  const color = node.contaminated ? 0xff4f87 : cssHexToInt(colors.memory);
  if(node.featuredPath){
    const bookMat = new THREE.MeshBasicMaterial({ color:0xffd166 });
    const cover = new THREE.Mesh(new THREE.BoxGeometry(44, 54, 8), bookMat);
    cover.position.set(node.x, 48, node.z); cover.rotation.x = -.18; cover.userData.node = node; node.mesh = cover; scene.add(cover);
    const page = new THREE.Mesh(new THREE.BoxGeometry(34, 40, 4), new THREE.MeshBasicMaterial({ color:0xfff0c2 }));
    page.position.set(node.x, 50, node.z-5); page.rotation.x = -.18; scene.add(page);
    const plaque = new THREE.Mesh(new THREE.BoxGeometry(58, 4, 34), new THREE.MeshBasicMaterial({ color:0x5b3f2d }));
    plaque.position.set(node.x, 23, node.z+18); scene.add(plaque);
    const halo = new THREE.PointLight(color, .55, 220); halo.position.copy(cover.position); scene.add(halo);
    return;
  }
  const geo = node.contaminated ? new THREE.IcosahedronGeometry(node.size,1) : new THREE.OctahedronGeometry(node.size,1);
  const relic = new THREE.Mesh(geo, palaceFpsMat(THREE, color, { emissive:color, emissiveIntensity:node.contaminated ? .48 : .24, roughness:.32, metalness:.08 }));
  relic.position.set(node.x,40 + node.size*.2,node.z); relic.castShadow = false; relic.userData.node = node; node.mesh = relic; scene.add(relic);
  if(node.contaminated){
    const halo = new THREE.PointLight(color, .45, 150); halo.position.copy(relic.position); scene.add(halo); node.scanLabel = 'Needs-review memory';
  }
}
function palaceStreamRelicChunks(force=false){
  if(!memoryPalace.scene || !memoryPalace.THREE || !memoryPalace.pos || !memoryPalace.streamedChunks) return;
  memoryPalace.streamTick = (memoryPalace.streamTick || 0) + 1;
  if(!force && memoryPalace.streamTick % 10 !== 0) return;
  const THREE = memoryPalace.THREE, active = new Set();
  const current = Math.floor((memoryPalace.pos.z + 1600) / 350);
  [current-1,current,current+1].forEach(id => active.add(id));
  for(const [id, group] of memoryPalace.streamedChunks.entries()){
    if(!active.has(id)){
      group.traverse(obj => { if(obj.userData?.node) obj.userData.node.mesh = null; });
      group.removeFromParent(); memoryPalace.streamedChunks.delete(id);
    }
  }
  active.forEach(id=>{
    if(memoryPalace.streamedChunks.has(id)) return;
    const group = new THREE.Group(); group.userData.chunkId = id;
    memoryPalace.nodes.filter(n => n.chunkId === id).forEach(n => palaceFpsAddRelic(THREE, group, n, memoryPalace.colors));
    memoryPalace.scene.add(group); memoryPalace.streamedChunks.set(id, group);
  });
}
async function renderMemoryPalace(data){
  const THREE = await loadThreeModule();
  clearPalaceScene(); memoryPalace.data = data; memoryPalace.THREE = THREE; palaceInspectorDefault();
  const viewport = $('#palaceViewport'); if(!viewport) return;
  const colors = constellationColors();
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ antialias:true, alpha:true, powerPreference:'high-performance' }); }
  catch(err){ $('#palaceLabels').innerHTML = `<div class="three-fallback-card"><h3>Mnemosyne Labyrinth unavailable</h3><p>This browser could not start WebGL.</p></div>`; return; }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.4)); renderer.setClearColor(cssHexToInt(colors.bg), 0);
  // Performance-first FPS: shadows and high DPR made desktop unplayably laggy.
  renderer.shadowMap.enabled = false;
  viewport.prepend(renderer.domElement);
  const scene = new THREE.Scene(); scene.fog = new THREE.FogExp2(0x08050e, .00115);
  const camera = new THREE.PerspectiveCamera(72, 1, 1, 4200);
  scene.add(new THREE.HemisphereLight(0xcdbaff, 0x07030c, .78));
  const key = new THREE.DirectionalLight(0xffe8c4, .78); key.position.set(260,520,380); scene.add(key);
  const nodes = palaceFpsRooms(data); const rooms = nodes.rooms || [], pathSections = nodes.pathSections || [];
  rooms.slice(1).forEach(room => palaceFpsAddCorridor(THREE, scene, rooms[0], room));
  rooms.forEach((room,i)=>palaceFpsAddRoom(THREE, scene, room, i));
  palaceFpsAddPathSections(THREE, scene, pathSections);
  const drone = palaceCreateHammyDrone(THREE); scene.add(drone);
  const mobilePalace = window.matchMedia('(max-width:760px), (max-width:940px) and (max-height:520px)').matches;
  Object.assign(memoryPalace, { renderer, scene, camera, group:scene, nodes, rooms, pathSections, colors, streamedChunks:new Map(), labels:pathSections.map(s=>({ label:`${s.label} (${s.count})`, x:s.x, y:s.y, z:s.z, kind:'section' })).concat(nodes.filter(n => n.featuredPath || n.contaminated || n.kind === 'memory').filter(n => !/^[a-f0-9]{10,}$/i.test(String(n.label || ''))).slice(0,18)), raycaster:new THREE.Raycaster(), mouse:new THREE.Vector2(), avatar:null, drone, pos:new THREE.Vector3(0,mobilePalace ? 82 : 78,mobilePalace ? 430 : 360), velocity:new THREE.Vector3(), yaw:0, pitch:mobilePalace ? -.14 : -.10, iso:false });
  palaceStreamRelicChunks(true);
  $('#palaceLabels').innerHTML = memoryPalace.labels.map((n,i)=>`<span class="three-label ${n.kind === 'memory' ? 'memory' : ''}" data-i="${i}">${esc(String(n.label || '').replace(/^memory:/,'mem ').slice(0,24))}</span>`).join('');
  $('#palaceHudStatus').textContent = 'walk forward — memories are grouped by domain';
  bindPalaceControls(); resizeMemoryPalace(); animateMemoryPalace(0);
}
function resizeMemoryPalace(){
  if(!memoryPalace.renderer) return;
  const rect = $('#palaceViewport').getBoundingClientRect(); const w = Math.max(320, rect.width), h = Math.max(320, rect.height);
  memoryPalace.renderer.setSize(w,h,false); memoryPalace.camera.aspect = w/h; memoryPalace.camera.updateProjectionMatrix();
}
function animateMemoryPalace(t=0){
  if(!memoryPalace.renderer) return;
  resizeMemoryPalace();
  const delta = memoryPalace.lastT ? Math.min(48, t - memoryPalace.lastT) / 1000 : .016; memoryPalace.lastT = t;
  const {forward,right} = palaceForwardRight(); const move = new memoryPalace.THREE.Vector3();
  if(palaceKeys.w || palaceKeys.ArrowUp) move.add(forward);
  if(palaceKeys.s || palaceKeys.ArrowDown) move.sub(forward);
  if(palaceKeys.d || palaceKeys.ArrowRight) move.add(right);
  if(palaceKeys.a || palaceKeys.ArrowLeft) move.sub(right);
  if(memoryPalace.joystick.x || memoryPalace.joystick.y){ move.addScaledVector(right, memoryPalace.joystick.x); move.addScaledVector(forward, -memoryPalace.joystick.y); }
  if(move.lengthSq() > 1) move.normalize();
  if(move.lengthSq() > 0) move.multiplyScalar((palaceKeys.Shift ? 420 : 235) * delta);
  memoryPalace.pos.add(move);
  palaceClampFpsPosition();
  memoryPalace.camera.rotation.order = 'YXZ'; memoryPalace.camera.position.copy(memoryPalace.pos); memoryPalace.camera.rotation.y = memoryPalace.yaw; memoryPalace.camera.rotation.x = memoryPalace.pitch;
  if(memoryPalace.drone){ const bob = Math.sin(t*.003)*5; const dronePos = memoryPalace.pos.clone().add(right.clone().multiplyScalar(38)).add(forward.clone().multiplyScalar(-46)).add(new memoryPalace.THREE.Vector3(0,14+bob,0)); memoryPalace.drone.position.lerp(dronePos, .16); }
  palaceStreamRelicChunks();
  if(memoryPalace.beacon) memoryPalace.beacon.rotation.y += delta * 1.4;
  memoryPalace.nodes.forEach((n,i)=>{ if(n.mesh && n.mesh.visible && (n.featuredPath || i < 18)){ n.mesh.rotation.y += delta * (.14 + (i%5)*.02); }});
  palaceApplyVisibilityCulling();
  memoryPalace.renderer.render(memoryPalace.scene, memoryPalace.camera); updatePalaceNearbyPrompt(); updatePalaceLabels(); updatePalaceZoneBadge();
  memoryPalace.frame = requestAnimationFrame(animateMemoryPalace);
}

// ── Memoria Tab ──────────────────────────────────────────────────────

async function loadMemoria(){
  const nameMap = {facts:'Facts', timelines:'Timelines', instructions:'Instructions', kg:'KG', preferences:'Preferences'};
  const stats = await api('/api/memoria/stats');
  $('#memoriaCards').innerHTML = Object.entries(stats.tables || {}).map(([tbl, info]) =>
    `<div class="card"><div class="num">${Number(info.count).toLocaleString()}</div><div class="label">${nameMap[tbl.replace('memoria_','')]||tbl.replace('memoria_','')}</div></div>`
  ).join('');
  $('#memoriaCounts').innerHTML = Object.entries(stats.tables || {}).map(([tbl, info]) =>
    `<div class="break-row"><span>${nameMap[tbl.replace('memoria_','')]||tbl.replace('memoria_','')}</span><strong>${Number(info.count).toLocaleString()}</strong></div>`
  ).join('');
  const sessionEl = $('#memoriaSessions');
  sessionEl.innerHTML = (stats.top_sessions || []).map(s =>
    `<div class="break-row"><span>${esc(s.session_id.slice(0,24))}</span><strong>${s.count}</strong></div>`
  ).join('') || '<span class="muted">no data</span>';
  // Load initial data for each subpanel
  loadMemoriaTable('memoriaFacts', '/api/memoria/facts', 'memoriaFactsList', 'memoriaFactsCount');
  loadMemoriaTable('memoriaTimelines', '/api/memoria/timelines', 'memoriaTimelinesList', 'memoriaTimelinesCount');
  loadMemoriaTable('memoriaInstructions', '/api/memoria/instructions', 'memoriaInstructionsList', 'memoriaInstructionsCount');
  loadMemoriaKg();
  loadMemoriaTable('memoriaPreferences', '/api/memoria/preferences', 'memoriaPreferencesList', 'memoriaPreferencesCount');
}

async function loadMemoriaTable(inputId, apiPath, listId, countId){
  const q = $(`#${inputId}Query`)?.value?.trim() || '';
  const r = await api(`${apiPath}?q=${encodeURIComponent(q)}&limit=200`);
  const items = r.items || [];
  if(countId) $(`#${countId}`).textContent = `${items.length} entries`;
  const list = $(`#${listId}`);
  if(!list) return;
  if(!items.length){
    list.innerHTML = '<div class="muted" style="padding:2rem;text-align:center">No entries found.</div>';
    return;
  }
  // Determine table type from apiPath
  const renderer = memoriaRenderer(apiPath);
  list.innerHTML = items.map(item => renderer(item)).join('');
}

function memoriaRenderer(apiPath){
  // Common hidden/internal fields — never shown
  const hidden = new Set(['id', 'message_idx', 'updated_msg_idx', 'valid_from_msg_idx', 'valid_to_msg_idx', 'version_id', 'previous_value']);
  if(apiPath.includes('/facts')){
    return function(item){
      const key = esc(item.key || '');
      const value = esc(item.value || '');
      const ctx = item.context_snippet ? esc(item.context_snippet) : '';
      const meta = [
        item.fact_type ? `<span class="badge">${esc(item.fact_type)}</span>` : '',
        item.importance ? `<span class="badge">imp ${Number(item.importance).toFixed(2)}</span>` : '',
        item.session_id && item.session_id !== 'default' ? `<span class="badge">${esc(item.session_id.slice(0,19))}</span>` : '',
      ].filter(Boolean).join('');
      return `<div class="item"><div class="meta">${meta}</div><div class="content"><strong>${key}</strong>${value ? ': ' + value : ''}</div>${ctx ? `<div class="content" style="font-size:.85em;opacity:.7;word-break:break-word">${ctx}</div>` : ''}</div>`;
    };
  }
  if(apiPath.includes('/timelines')){
    return function(item){
      const desc = esc(String(item.description || ''));
      const date = item.date ? esc(item.date) : '';
      const meta = [
        date ? `<span class="badge">${date}</span>` : '',
        item.source ? `<span class="badge">${esc(item.source)}</span>` : '',
        item.session_id && item.session_id !== 'default' ? `<span class="badge">${esc(item.session_id.slice(0,19))}</span>` : '',
      ].filter(Boolean).join('');
      return `<div class="item"><div class="meta">${meta}</div><div class="content">${desc}</div></div>`;
    };
  }
  if(apiPath.includes('/instructions')){
    return function(item){
      const instr = esc(item.instruction || '');
      const topic = item.topic ? esc(item.topic) : '';
      const ctx = item.context_snippet ? esc(item.context_snippet) : '';
      const meta = [
        topic ? `<span class="badge">${topic}</span>` : '',
        item.active == 1 ? '<span class="badge status-active">active</span>' : '<span class="badge status-expired">inactive</span>',
        item.session_id && item.session_id !== 'default' ? `<span class="badge">${esc(item.session_id.slice(0,19))}</span>` : '',
      ].filter(Boolean).join('');
      return `<div class="item"><div class="meta">${meta}</div><div class="content">${instr}</div>${ctx ? `<div class="content" style="font-size:.85em;opacity:.7;word-break:break-word">${ctx}</div>` : ''}</div>`;
    };
  }
  // Generic renderer for preferences etc.
  return function(item){
    const content = item.preference || item.instruction || item.description || item.value || JSON.stringify(item);
    const meta = Object.entries(item).filter(([k,v]) => !hidden.has(k) && v !== null && v !== undefined && v !== '' && !['preference','instruction','description','value','context_snippet','key'].includes(k))
      .map(([k,v]) => `<span class="badge">${esc(k)}: ${esc(String(v).slice(0,40))}</span>`).join('');
    return `<div class="item"><div class="meta">${meta}</div><div class="content">${esc(String(content).slice(0,500))}</div></div>`;
  };
}

async function loadMemoriaKg(){
  const q = $('#memoriaKgQuery')?.value?.trim() || '';
  const r = await api(`/api/memoria/kg?q=${encodeURIComponent(q)}&limit=200`);
  const items = r.items || [];
  $('#memoriaKgCount').textContent = `${items.length} entries`;
  const tbody = $('#memoriaKgRows');
  if(!tbody) return;
  if(!items.length){
    tbody.innerHTML = '<tr><td colspan="4" class="muted" style="text-align:center">No triples found.</td></tr>';
    return;
  }
  tbody.innerHTML = items.map(item => {
    const confidence = item.confidence !== null && item.confidence !== undefined ? Number(item.confidence).toFixed(2) : '—';
    return `<tr><td>${esc(item.subject||'')}</td><td>${esc(item.predicate||'')}</td><td>${esc(item.object||'')}</td><td>${confidence}</td></tr>`;
  }).join('');
}

$$('nav button').forEach(b => b.onclick = () => switchTab(b.dataset.tab));
$$('.section-tabs button').forEach(b => b.onclick = () => {
  const panelRoute = ({ exploreMemories:'memories', exploreRecall:'recall', activityTimeline:'timelineView', activityConsolidations:'consolidations', graphGraph:'graph', graphTriples:'triples', todayAdded:'todayAdded', todayRecalled:'todayRecalled', todayTriples:'todayTriples', todayConsolidations:'todayConsolidations' })[b.dataset.panel];
  if(panelRoute) { switchTab(panelRoute); return; }
  const section = b.closest('.tab')?.id;
  showPanel(section, b.dataset.panel);
});
$$('[data-jump]').forEach(b => b.onclick = () => switchTab(b.dataset.jump));
$('#mobileMenuToggle').onclick = () => {
  document.body.classList.toggle('mobile-menu-open');
  const isOpen = document.body.classList.contains('mobile-menu-open');
  $('#mobileMenuToggle').textContent = isOpen ? '×' : '☰';
  $('#mobileMenuToggle').setAttribute('aria-expanded', String(isOpen));
};
window.addEventListener('resize', closeMobileMenuForViewportChange, { passive: true });
window.addEventListener('orientationchange', closeMobileMenuForViewportChange, { passive: true });
document.addEventListener('fullscreenchange', updateVisualiserFullscreenButtons);
$('#memorySearch').onclick = loadMemories;
$('#bulkSelectAll').onchange = () => { latestMemoryItems.forEach(x => $('#bulkSelectAll').checked ? bulkSelection.add(x.id) : bulkSelection.delete(x.id)); loadMemories(); };
$('#bulkClear').onclick = () => { bulkSelection.clear(); loadMemories(); };
$('#bulkExpire').onclick = expireSelectedMemories;
$('#bulkVeracity').onclick = setSelectedVeracity;
$('#bulkExpiry').onclick = setSelectedExpiry;
$('#bulkImportance').onclick = setSelectedImportance; $('#memoryQuery').onkeydown = e => { if(e.key==='Enter') loadMemories(); };
$('#reviewSelectAll').onchange = () => {
  const checked = $('#reviewSelectAll').checked;
  latestReviewItems.forEach(x => checked ? reviewSelection.add(x.id) : reviewSelection.delete(x.id));
  $$('#review .review-check').forEach(chk => { chk.checked = checked; });
  updateReviewBulkBar();
};
$('#reviewClear').onclick = () => { reviewSelection.clear(); loadReview(); };
$('#reviewConfirm').onclick = confirmSelectedReviewMemories;
$('#reviewVeracity').onclick = setSelectedReviewVeracity;
$('#reviewExpiry').onclick = setSelectedReviewExpiry;
$('#reviewExpire').onclick = expireSelectedReviewMemories;
$('#globalSearchButton').onclick = loadGlobalSearch; $('#globalSearchQuery').onkeydown = e => { if(e.key==='Enter') loadGlobalSearch(); };
$('#menuSearchButton').onclick = menuSearch; $('#menuSearchQuery').onkeydown = e => { if(e.key==='Enter') menuSearch(); };
$('#recallButton').onclick = loadRecallDebug; $('#recallQuery').onkeydown = e => { if(e.key==='Enter') loadRecallDebug(); };
$('#timelineButton').onclick = loadTimeline; $('#timelineQuery').onkeydown = e => { if(e.key==='Enter') loadTimeline(); }; $('#timelineGroup').onchange = loadTimeline;
$('#memoryClear').onclick = () => { ['memoryQuery','memorySource','memoryScope','memorySession','memoryVeracity','memoryDegradation','memoryTrustPreset'].forEach(id => $('#'+id).value = ''); $('#memoryKind').value = 'all'; $('#memoryStatus').value = 'active'; $('#memorySort').value = 'recent'; loadMemories(); };
['memoryKind','memorySource','memoryScope','memorySession','memoryVeracity','memoryDegradation','memoryTrustPreset','memoryStatus','memorySort'].forEach(id => $('#'+id).onchange = loadMemories);
$('#tripleSearch').onclick = loadTriples; $('#tripleQuery').onkeydown = e => { if(e.key==='Enter') loadTriples(); };
$('#graphRefresh').onclick = loadGraph; $('#graphQuery').onkeydown = e => { if(e.key==='Enter') loadGraph(); };
$('#graphClear').onclick = () => { $('#graphQuery').value = ''; loadGraph(); };
$('#graphResetView').onclick = resetGraphView;
$('#constellationRefresh').onclick = loadConstellation;
$('#constellationReset').onclick = resetConstellationView;
$('#constellationPanMode').onclick = toggleConstellationPanMode;
$('#constellationPause').onclick = toggleConstellationPause;
$('#constellationFullscreen').onclick = () => toggleVisualiserFullscreen('.constellation-wrap');
$('#constellationExitFullscreen').onclick = exitVisualiserFullscreen;
$$('.visualiser-tabs button[data-visualiser]').forEach(b => b.onclick = () => switchVisualiserMode(b.dataset.visualiser));
$('#threeRefresh').onclick = loadThreeVisualiser;
$('#threeReset').onclick = () => { resetThreeCamera(); threeInspectorDefault(); };
$('#threePanMode').onclick = () => { threeVis.panMode = !threeVis.panMode; updateThreeUI(); };
$('#threePause').onclick = () => { threeVis.paused = !threeVis.paused; updateThreeUI(); };
$('#threeFullscreen').onclick = () => toggleVisualiserFullscreen('#threeViewport');
$('#threeExitFullscreen').onclick = exitVisualiserFullscreen;
$('#palaceRefresh').onclick = loadMemoryPalace;
$('#palaceReset').onclick = resetMemoryPalaceDiver;
$('#palaceSearchButton').onclick = palaceSearchBeacon;
$('#palaceSearchQuery').onkeydown = e => { if(e.key === 'Enter') palaceSearchBeacon(); };
$('#palaceFullscreen').onclick = () => toggleVisualiserFullscreen('#palaceViewport');
$('#palaceExitFullscreen').onclick = exitVisualiserFullscreen;
$$('.visualiser-tabs button[data-three-mode]').forEach(b => b.onclick = () => switchThreeMode(b.dataset.threeMode));
updateVisualiserModeUI();
updateConstellationPauseButton();
updateConstellationPanButton();
$('#consolidationQuery').oninput = renderConsolidations;
$('#consolidationClear').onclick = () => { $('#consolidationQuery').value = ''; renderConsolidations(); };
// Memoria search handlers
$('#memoriaFactsSearch').onclick = () => loadMemoriaTable('memoriaFacts', '/api/memoria/facts', 'memoriaFactsList', 'memoriaFactsCount');
$('#memoriaFactsQuery').onkeydown = e => { if(e.key==='Enter') $('#memoriaFactsSearch').click(); };
$('#memoriaTimelinesSearch').onclick = () => loadMemoriaTable('memoriaTimelines', '/api/memoria/timelines', 'memoriaTimelinesList', 'memoriaTimelinesCount');
$('#memoriaTimelinesQuery').onkeydown = e => { if(e.key==='Enter') $('#memoriaTimelinesSearch').click(); };
$('#memoriaInstructionsSearch').onclick = () => loadMemoriaTable('memoriaInstructions', '/api/memoria/instructions', 'memoriaInstructionsList', 'memoriaInstructionsCount');
$('#memoriaInstructionsQuery').onkeydown = e => { if(e.key==='Enter') $('#memoriaInstructionsSearch').click(); };
$('#memoriaKgSearch').onclick = loadMemoriaKg;
$('#memoriaKgQuery').onkeydown = e => { if(e.key==='Enter') loadMemoriaKg(); };
$('#memoriaPreferencesSearch').onclick = () => loadMemoriaTable('memoriaPreferences', '/api/memoria/preferences', 'memoriaPreferencesList', 'memoriaPreferencesCount');
$('#memoriaPreferencesQuery').onkeydown = e => { if(e.key==='Enter') $('#memoriaPreferencesSearch').click(); };
$('#closeDetail').onclick = () => closeDetail();
$('#loginButton').onclick = async () => {
  try { await postJson('/api/auth/login', {password: $('#loginPassword').value}); hideLogin(); $('#loginError').textContent=''; await refreshAuthState(); loadStats(); }
  catch(e){ $('#loginError').textContent = e.message; }
};
$('#loginPassword').onkeydown = e => { if(e.key==='Enter') $('#loginButton').click(); };
$('#refreshDiagnostics').onclick = loadDiagnostics;
$('#copyDiagnostics').onclick = copyDiagnostics;
$('#saveRuntimeConfig').onclick = async () => {
  try {
    const body = {host: $('#configHost').value.trim(), port: $('#configPort').value.trim(), db_path: $('#configDbPath').value.trim()};
    const r = await postJson('/api/config', body);
    const cfg = r.config || {};
    $('#configHost').value = cfg.host || '';
    $('#configPort').value = cfg.port || '';
    $('#configDbPath').value = cfg.db_path || '';
    const urls = [`This Mac: ${cfg.local_url || ''}`];
    if (cfg.lan_url) urls.push(`LAN: ${cfg.lan_url}`);
    $('#configStatus').textContent = `${r.message || 'Saved. Restart the dashboard to apply server/database changes.'} ${urls.join(' · ')}`;
  } catch(e) { $('#configStatus').textContent = e.message; }
};
$('#saveAuth').onclick = async () => {
  try { const body = {auth_enabled: $('#authEnabled').checked}; if($('#authPassword').value) body.password = $('#authPassword').value; const r = await postJson('/api/config', body); $('#authPassword').value=''; $('#authStatus').textContent = r.message || 'Saved'; }
  catch(e){ $('#authStatus').textContent = e.message; }
};
$('#clearAuth').onclick = async () => {
  try {
    const r = await postJson('/api/config', {clear_password:true});
    $('#authEnabled').checked=false;
    $('#authPassword').value='';
    $('#memoryAdminEnabled').checked=!!(r.config && r.config.memory_admin_enabled);
    $('#authStatus').textContent = r.message || 'Auth disabled';
    await loadAuthStatus();
  } catch(e){
    $('#authStatus').textContent = e.message;
  }
};
$('#saveMemoryAdmin').onclick = async () => {
  try { const r = await postJson('/api/config', {memory_admin_enabled: $('#memoryAdminEnabled').checked}); authState.config = r.config || {}; $('#memoryAdminStatus').textContent = r.message || 'Saved'; await loadAuthStatus(); }
  catch(e){ $('#memoryAdminStatus').textContent = e.message; }
};
$('#createBackup').onclick = async () => {
  try { const r = await postJson('/api/admin/backup', {}); $('#memoryAdminStatus').textContent = `Backup created: ${r.backup.path}`; }
  catch(e){ $('#memoryAdminStatus').textContent = e.message; }
};
$('#viewAuditLog').onclick = async () => {
  try { const r = await api('/api/admin/audit?limit=50'); showDetail(r.items, 'Memory audit log'); }
  catch(e){ $('#memoryAdminStatus').textContent = e.message; }
};
$('#retryBootstrap').onclick = () => bootstrapDashboard().catch(handleInitError);
$('#copyBootError').onclick = copyBootErrorDetails;
$('#logoutAuth').onclick = async () => { await postJson('/api/auth/logout', {}); showLogin(); };
function toggleTheme(){ setTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'); }
$('#themeToggle').onclick = toggleTheme;
$('#mobileThemeToggle').onclick = toggleTheme;
initLiveMemoryInfiniteScroll();
window.addEventListener('popstate', e => applyRoute(e.state || urlToRoute()));
initTheme();
const initialRoute = urlToRoute();
pushRoute(initialRoute, true);
renderBootErrorStatus();
bootstrapDashboard().catch(handleInitError);
