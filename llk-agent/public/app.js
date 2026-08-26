let employees = [], templates = {}, active = null, currentPreview = null, currentReport = null, personalStage = null, verificationStageToken = null, busy = false;
const loginFlows = new Map();
let bootstrapFlow = sessionStorage.getItem('bootstrapFlow');
let verificationTargets = [];
let loginPollTimer = null;
const editDayState = new Set();
let calendarDays = new Map();
let calendarMonth = new Date(2026, new Date().getMonth(), 1);
let calendarSelection = { start: null, end: null };
const isoDate = date => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
const parseIsoDate = value => { const [year,month,day]=String(value||'').split('-').map(Number); return year ? new Date(year,month-1,day) : null; };
const formatIndonesianDate = value => value ? new Intl.DateTimeFormat('id-ID',{weekday:'short',day:'numeric',month:'short',year:'numeric'}).format(parseIsoDate(value)) : 'Belum dipilih';
const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function feedback(message = '', isError = false) {
  const node = $('#appFeedback');
  if (!node) return;
  if (!message) {
    node.hidden = true;
    node.textContent = '';
    return;
  }
  node.hidden = false;
  node.textContent = message;
  node.className = `inline-feedback ${isError ? 'is-error' : ''}`;
}

function log(message) {
  const box = $('#logBox');
  if (!box) return;
  const stamp = new Date().toLocaleTimeString('id-ID', { hour12: false });
  const entry = `[${stamp}] ${message}`;
  const latest = $('#logLatest'); if (latest) latest.textContent = message;
  if (!box.dataset.touched) {
    box.dataset.touched = 'true';
    box.textContent = entry;
    return;
  }
  const lines = [entry, ...box.textContent.split('\n')].filter(Boolean).slice(0, 30);
  box.textContent = lines.join('\n');
}

function setBusy(value) {
  busy = value;
  document.body.classList.toggle('is-busy', value);
  syncControls();
}

function syncControls() {
  document.querySelectorAll('#application button, #application input, #application select, #application textarea').forEach(control => {
    control.disabled = busy;
  });

  const flow = active && loginFlows.get(active.id);
  const loginBtn = $('#loginBtn');
  const completeLoginBtn = $('#completeLoginBtn');
  const cancelLoginBtn = $('#cancelLoginBtn');
  const submitBtn = $('#submitBtn');
  const applyPersonalTemplateBtn = $('#applyPersonalTemplateBtn');
  const deleteConfirmBtn = $('#deleteConfirmBtn');

  if (loginBtn) loginBtn.disabled = busy || flow === 'waiting' || flow === 'completing';
  if (completeLoginBtn) completeLoginBtn.disabled = busy || flow !== 'waiting';
  if (cancelLoginBtn) cancelLoginBtn.disabled = busy || (flow !== 'waiting' && flow !== 'completing');
  if (submitBtn) submitBtn.disabled = busy || !currentPreview || !$('#confirmCheck')?.checked;
  if (applyPersonalTemplateBtn) applyPersonalTemplateBtn.disabled = busy || !personalStage || !$('#personalStageConfirm')?.checked;
  if (deleteConfirmBtn) deleteConfirmBtn.disabled = busy || $('#deleteConfirm')?.value !== (active?.id || 'HAPUS');
}

async function api(path, options = {}) {
  const headers = options.body instanceof FormData ? options.headers : { 'content-type': 'application/json', ...(options.headers || {}) };
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Permintaan gagal (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function pollOperationProgress(employeeId,signal){
  if(!employeeId)return;
  let since=0;
  while(!signal.aborted){
    try{
      const state=await api(`/api/progress?employeeId=${encodeURIComponent(employeeId)}&since=${since}`);
      for(const event of state.events||[]){since=Math.max(since,event.sequence||0);log(`${event.message}${event.page?` (halaman ${event.page})`:''}${event.rowsFound!=null?` · ${event.rowsFound} target`:''}${event.validCount!=null?` · ${event.validCount} siap`:''}${event.invalidCount?` · ${event.invalidCount} ditahan`:''}`);}
    }catch{}
    await new Promise(resolve=>setTimeout(resolve,750));
  }
}

async function runBusy(action, operationName = 'Operasi') {
  if (busy) return;
  setBusy(true);
  feedback();
  const controller=new AbortController();
  const polling=pollOperationProgress(active?.id,controller.signal);
  try {
    return await action();
  } catch (error) {
    const msg = `${operationName} gagal: ${error.message}`;
    log(msg);
    feedback(msg, true);
  } finally {
    controller.abort();
    await polling;
    setBusy(false);
  }
}

async function loadTemplates() {
  templates = await api('/api/templates');
  const groups = templates.departments || templates.templates || templates;
  const options = Object.entries(groups)
    .filter(([, value]) => value && typeof value === 'object' && Array.isArray(value.activities))
    .map(([key, value]) => `<option value="${escapeHtml(key)}">${escapeHtml(value.label)}</option>`).join('');
  for (const select of [$('#generalTemplateSelect'), $('#sourceDepartmentSelect')]) if (select) select.innerHTML = options;
  renderGeneralTemplate($('#generalTemplateSelect')?.value);
}

function activityRows(activities, sourceLabel) {
  return activities.length ? activities.map(activity => `
    <tr>
      <td><strong>${escapeHtml(activity.description || activity.nama)}</strong></td>
      <td>${escapeHtml(activity.start || '—')} – ${escapeHtml(activity.end || '—')}</td>
      <td>${escapeHtml(activity.type || activity.kategori || 'Pendukung')}</td>
      <td>Selesai</td>
      <td><small>${escapeHtml(activity.count ? `${activity.count}x` : sourceLabel)}</small></td>
    </tr>`).join('') : '<tr><td colspan="5" class="emp-pos">Belum ada kegiatan pada sumber ini.</td></tr>';
}

function renderGeneralTemplate(key) {
  const groups = templates.departments || templates.templates || templates;
  const group = groups?.[key], tbody = $('#generalTemplateBody');
  if (tbody) tbody.innerHTML = activityRows(group?.activities || [], 'template umum');
}

$('#generalTemplateSelect')?.addEventListener('change', event => renderGeneralTemplate(event.target.value));

function renderEmployeeList() {
  const query = ($('#employeeSearch')?.value || '').trim().toLowerCase();
  const list = $('#employeeList');
  if (!list) return;
  const filtered = employees.filter(employee => {
    if (!query) return true;
    const name = String(employee.name || '').toLowerCase();
    const nip = String(employee.nip || '').toLowerCase();
    const pos = String(employee.position || '').toLowerCase();
    return name.includes(query) || nip.includes(query) || pos.includes(query);
  });

  list.innerHTML = filtered.length ? filtered.map(employee => `
    <button type="button" class="emp-item ${active?.id === employee.id ? 'active' : ''}" data-id="${escapeHtml(employee.id)}">
      <span class="emp-name">${escapeHtml(employee.name)}</span>
      <span class="emp-pos">${escapeHtml(employee.position)} · NIP ${escapeHtml(employee.nip || '—')}</span>
    </button>
  `).join('') : '<p class="emp-pos">Tidak ada profil yang sesuai.</p>';
}

async function loadEmployees() {
  employees = await api('/api/employees');
  renderEmployeeList();
}


async function loadApp() {
  log('Memulai LLK Agent…');
  await Promise.all([loadTemplates(), loadEmployees(), loadCalendar()]);
  const initial = employees[0] || null;
  const satker = initial?.satker || '';
  $('#satkerSelect').textContent = satker || 'Satker lainnya';
  if (initial) selectEmployee(initial);
  log(`Sistem siap. Satker: ${satker || 'Satker lainnya'}. Profil aktif: ${initial?.name || 'Belum dipilih'}`);
  if (!employees.length) {
    setNewProfileMode(true);
    feedback('Belum ada profil pegawai. Isi NIP atasan langsung, lalu login SSO untuk memulai.');
  }
  const bootstrapStatus = await api('/api/bootstrap/status').catch(() => ({ active: [] }));
  const pendingBootstrap = bootstrapStatus.active?.[0];
  if (pendingBootstrap) {
    bootstrapFlow = pendingBootstrap.tempId;
    sessionStorage.setItem('bootstrapFlow', bootstrapFlow);
    setNewProfileMode(true);
    $('#quickSsoLoginBtn').hidden = true;
    $('#quickSsoFetchBtn').hidden = false;
    $('#quickSsoRestartBtn').hidden = false;
    feedback(pendingBootstrap.authenticated
      ? 'Sesi Edge sudah login. Klik Saya sudah login untuk mengambil profil dan daftar LLK.'
      : 'Sesi Edge belum login atau sudah berakhir. Klik Buka ulang SSO, selesaikan login, lalu klik Saya sudah login.');
  }
}
function renderLoginFlow() {
  const state = (active && loginFlows.get(active.id)) || 'idle';
  const waiting = state === 'waiting' || state === 'completing';
  const loginBtn = $('#loginBtn');
  const completeLoginBtn = $('#completeLoginBtn');
  const cancelLoginBtn = $('#cancelLoginBtn');
  const detail = $('#loginFlowDetail');
  const stateBadge = $('#authStepState');

  if (loginBtn) loginBtn.hidden = waiting;
  if (completeLoginBtn) completeLoginBtn.hidden = !waiting;
  if (cancelLoginBtn) cancelLoginBtn.hidden = !waiting;

  if (detail) {
    detail.textContent = state === 'waiting'
      ? 'Jendela Edge terbuka. Selesaikan SSO; aplikasi akan mendeteksi login otomatis.'
      : state === 'completing'
        ? 'Login terdeteksi. Memeriksa identitas dan relasi verifikator…'
        : state === 'review'
          ? 'Login berhasil dan sesi aktif.'
          : 'Buka SSO untuk memulai. Kredensial tidak disimpan aplikasi.';
  }

  if (stateBadge) {
    stateBadge.textContent = state === 'waiting' ? 'Menunggu SSO'
      : state === 'completing' ? 'Memverifikasi'
      : state === 'review' ? 'Login aktif' : 'Belum masuk';
  }

  syncControls();
}
function stopLoginPolling() {
  clearTimeout(loginPollTimer);
  loginPollTimer = null;
}
function setWizardStep(step) {
  document.querySelectorAll('.workflow-step[data-step]').forEach(node => {
    const n = Number(node.dataset.step);
    node.classList.toggle('is-active', n === step);
    node.classList.toggle('is-pending', n > step);
    node.classList.toggle('is-done', n < step);
  });
  syncControls();
}

async function completeLoginFlow(employeeId) {
  if (loginFlows.get(employeeId) === 'completing') return;
  loginFlows.set(employeeId, 'completing');
  if (active?.id === employeeId) renderLoginFlow();
  log('Login SSO terdeteksi. Memverifikasi akun…');
  try {
    const result = await api(`/api/employees/${employeeId}/login/complete`, { method: 'POST', body: '{}' });
    loginFlows.set(employeeId, 'review');
    if (result.employee) {
      const idx = employees.findIndex(e => e.id === result.employee.id);
      if (idx >= 0) employees[idx] = result.employee;
      active = result.employee;
      const titleNode = $('#workspaceTitle');
      if (titleNode) titleNode.textContent = result.employee.name;
      const positionNode = $('#profilePosition');
      if (positionNode) positionNode.textContent = result.employee.position;
      const activeNameNode = $('#activeProfileName');
      if (activeNameNode) activeNameNode.textContent = `${result.employee.name} (${result.employee.nip || result.employee.id})`;
      renderEmployeeList();
    }
    if (active?.id === employeeId) {
      renderLoginCompletion(result);
      renderLoginFlow();
      const loginBadge = $('#loginBadge');
      if (loginBadge) loginBadge.textContent = 'Login aktif';
      const nextBtn = $('#loginNextBtn');
      if (nextBtn) nextBtn.hidden = false;
      setWizardStep(2);
    }
    log('Login terverifikasi. Sesi aktif.');
  } catch (error) {
    loginFlows.set(employeeId, 'waiting');
    if (active?.id === employeeId) renderLoginFlow();
    throw error;
  }
}

function pollLogin(employeeId) {
  stopLoginPolling();
  const check = async () => {
    if (loginFlows.get(employeeId) !== 'waiting') return;
    try {
      const status = await api(`/api/employees/${employeeId}/login/status`);
      if (!status.active) {
        loginFlows.delete(employeeId);
        if (active?.id === employeeId) renderLoginFlow();
        log('Jendela login ditutup atau waktu login berakhir.');
        return;
      }
      if (status.authenticated) {
        await completeLoginFlow(employeeId);
        return;
      }
    } catch (error) {
      log(`Pemeriksaan login otomatis tertunda: ${error.message}`);
    }
    loginPollTimer = setTimeout(check, 1500);
  };
  loginPollTimer = setTimeout(check, 800);
}

function renderLoginCompletion(result) {
  const staged = result.history || result.personalTemplateStage || result.personalTemplate || result.stagedPersonalTemplate || result.stage;


  const loginCompletionReview = $('#loginCompletionReview');
  if (loginCompletionReview) {
    loginCompletionReview.hidden = false;
    loginCompletionReview.innerHTML = '<strong>Login berhasil diverifikasi</strong><p class="field-help">Sesi siap digunakan untuk menyiapkan dan mengirim LLK.</p>';
  }

  if (staged) renderPersonalDiff(staged);
}

function selectEmployee(employee) {
  stopLoginPolling();
  active = employee;
  currentPreview = null;
  currentReport = null;
  personalStage = null;
  setWizardStep(2);
  const satker = employee?.satker || '';
  const select = $('#satkerSelect');
  if (select) select.textContent = satker || 'Terisi otomatis setelah login SSO';
  const picker=$('#profilePicker');
  if(picker){picker.hidden=employees.length===0;picker.innerHTML=employees.map(item=>`<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} · ${escapeHtml(item.nip||item.id)} · Atasan: ${escapeHtml(item.supervisor?.name||item.supervisor?.nip||'Belum terbaca')}</option>`).join('');picker.value=employee.id;}

  renderEmployeeList();

  const workspace = $('#workspace');
  if (workspace) workspace.hidden = false;

  const titleNode = $('#workspaceTitle');
  if (titleNode) titleNode.textContent = employee.name;

  const positionNode = $('#profilePosition');
  if (positionNode) positionNode.textContent = `${employee.position}${employee.satker && employee.satker !== 'Satker Lain' ? ` · ${employee.satker}` : ' · Satker belum terdeteksi dari LLK'}`;

  const activeNameNode = $('#activeProfileName');
  if (activeNameNode) activeNameNode.textContent = `${employee.name} (${employee.nip || employee.id})`;

  const loginBadge = $('#loginBadge');
  if (loginBadge) loginBadge.textContent = 'Belum masuk';


  const previewArea = $('#previewArea');
  if (previewArea) previewArea.hidden = true;

  const reviewStep = $('#reviewStep');
  if (reviewStep) reviewStep.classList.add('is-pending');

  const reportArea = $('#reportArea');
  if (reportArea) reportArea.hidden = true;

  const confirmCheck = $('#confirmCheck');
  if (confirmCheck) confirmCheck.checked = false;


  const delGroup = $('#deleteConfirmGroup');
  if (delGroup) delGroup.hidden = true;

  const delConfirm = $('#deleteConfirm');
  if (delConfirm) delConfirm.value = '';

  const delTarget = $('#deleteTargetId');
  if (delTarget) delTarget.textContent = employee.id;

  renderLoginFlow();
  loadPersonalTemplate(employee.id).catch(() => {});
  syncControls();
}

function minutes(time) {
  const [hours, mins] = String(time).split(':').map(Number);
  return (hours || 0) * 60 + (mins || 0);
}

function matchesOfficialSchedule(day) {
  const friday = new Date(`${day.date}T00:00:00`).getDay() === 5;
  const allowed = friday
    ? [[['08:00', '17:00']], [['08:00', '12:00'], ['12:00', '13:30'], ['13:30', '17:00']]]
    : [[['08:00', '16:30']], [['08:00', '12:00'], ['12:00', '13:00'], ['13:00', '16:30']]];
  const timesMatch = allowed.some(pattern => pattern.length === day.items.length && pattern.every(([start, end], index) => day.items[index].start === start && day.items[index].end === end));
  return timesMatch && (day.items.length === 1 || (day.items[1].description === 'Istirahat' && day.items[1].type === 'Pendukung'));
}
function validatePreview(preview) {
  const errors = [];
  preview.forEach(day => {
    day.items.forEach((item, index) => {
      const label = `${day.date}, baris ${index + 1}`;
      if (!/^\d{2}:\d{2}$/.test(item.start) || !/^\d{2}:\d{2}$/.test(item.end) || minutes(item.start) >= minutes(item.end)) errors.push(`${label}: rentang waktu tidak valid.`);
      if (!item.description.trim() || !item.result.trim()) errors.push(`${label}: kegiatan dan hasil wajib diisi.`);
      if (!['Utama', 'Pendukung'].includes(item.type)) errors.push(`${label}: jenis tidak valid.`);
    });
    if (!matchesOfficialSchedule(day)) errors.push(`${day.date}: gunakan pola jam kerja resmi; pola terpisah wajib memuat baris Istirahat.`);
  });
  const feedbackNode = $('#previewFeedback');
  if (feedbackNode) {
    feedbackNode.hidden = !errors.length;
    feedbackNode.textContent = errors.join(' ');
  }
  return !errors.length;
}

function toggleDayCardEdit(dayIndex) {
  if (editDayState.has(dayIndex)) editDayState.delete(dayIndex);
  else editDayState.add(dayIndex);
  if (currentPreview) renderPreview(currentPreview);
}

function syncPreviewFromForm() {
  document.querySelectorAll('.day-card[data-day]').forEach(card => {
    const dayIndex = Number(card.dataset.day);
    const day = currentPreview[dayIndex];
    card.querySelectorAll('tr[data-item]').forEach(row => {
      const itemIndex = Number(row.dataset.item);
      const item = day.items[itemIndex];
      for (const field of ['start', 'end', 'description', 'type', 'result']) {
        const el = row.querySelector(`[data-field="${field}"]`);
        if (el) item[field] = el.value;
      }
      const dur = row.querySelector('.duration');
      if (dur) dur.textContent = `${Math.max(0, minutes(item.end) - minutes(item.start))} m`;
    });
  });
  const check = $('#confirmCheck');
  if (check) check.checked = false;
  updatePreviewStatuses(currentPreview);
  syncControls();
}

function updatePreviewStatuses(preview, report = null) {
  const reportByDate = new Map((report?.results || []).map(result => [result.date, result]));
  preview?.forEach((day, dayIndex) => {
    const result = reportByDate.get(day.date);
    let state = result ? statusOf(result) : 'ready';
    let label = result ? (result.statusLabel || { verified:'Tersimpan di LLK', saved:'Tersimpan di LLK', skipped:'Sudah ada di LLK', failed:'Gagal' }[state] || state) : 'Siap';
    if (!result) {
      const dayErrors = [];
      day.items.forEach(item => {
        if (!/^\d{2}:\d{2}$/.test(item.start) || !/^\d{2}:\d{2}$/.test(item.end) || minutes(item.start) >= minutes(item.end) || !item.description.trim() || !item.result.trim() || !['Utama','Pendukung'].includes(item.type)) dayErrors.push(true);
      });
      if (!matchesOfficialSchedule(day)) dayErrors.push(true);
      if (dayErrors.length) { state = 'failed'; label = 'Perlu diperbaiki'; }
    }
    const badge = document.querySelector(`[data-day-status="${dayIndex}"]`);
    if (badge) {
      badge.className = `preview-status status-${escapeHtml(state)}`;
      badge.textContent = label;
    }
  });
  validatePreview(preview || []);
}


function renderPreview(preview) {
  currentPreview = preview;
  const previewArea = $('#previewArea');
  if (previewArea) previewArea.hidden = false;

  const reviewStep = $('#reviewStep');
  if (reviewStep) reviewStep.classList.remove('is-pending');

  const countNode = $('#previewCount');
  if (countNode) countNode.textContent = `${preview.length} hari`;

  const container = $('#previewCards');
  if (container) {
    container.innerHTML = preview.map((day, di) => {
      const isEditing = editDayState.has(di);
      const verifier = day.verifier || day.supervisor || active?.verifier || active?.supervisor || {};
      const verifiedSupervisor = verifier.verified === true && (verifier.source === 'llk-form' || verifier.source === 'llk-select2' || verifier.source === 'llk-api');
      return `
        <article class="day-card" data-day="${di}">
          <header class="day-card-header">
            <div>
              <div class="day-title-row">
                <strong class="day-date">${escapeHtml(day.date)}</strong>
                <span class="preview-status status-ready" data-day-status="${di}">Siap</span>
              </div>
              <small class="day-meta ${verifiedSupervisor ? 'supervisor-verified' : 'supervisor-unverified'}">Atasan: ${escapeHtml(verifier.name || 'Belum diverifikasi')} · NIP ${escapeHtml(verifier.nip || verifier.id || verifier.routeId || '—')} <span class="supervisor-source">${verifiedSupervisor ? 'Terverifikasi dari LLK' : 'Belum terverifikasi'}</span></small>
              <small class="day-meta">Kegiatan: ${day.activitySource === 'llk-page-1' ? 'halaman terakhir LLK' : 'template umum'}</small>
            </div>
            <button class="btn btn-sm btn-outline edit-toggle-btn" type="button" data-toggle-edit="${di}">${isEditing ? 'Tutup edit' : 'Edit isian'}</button>
          </header>
          ${isEditing ? `
            <div class="table-scroll">
              <table class="preview-table">
                <thead><tr><th>Mulai</th><th>Selesai</th><th>Kegiatan</th><th>Jenis</th><th>Hasil</th><th>Durasi</th></tr></thead>
                <tbody>
                  ${day.items.map((item, ii) => `
                    <tr data-item="${ii}">
                      <td><input class="form-control" data-field="start" type="time" value="${escapeHtml(item.start)}"></td>
                      <td><input class="form-control" data-field="end" type="time" value="${escapeHtml(item.end)}"></td>
                      <td><textarea class="form-control activity-control" data-field="description">${escapeHtml(item.description)}</textarea></td>
                      <td><select class="form-control" data-field="type"><option${item.type === 'Utama' ? ' selected' : ''}>Utama</option><option${item.type === 'Pendukung' ? ' selected' : ''}>Pendukung</option></select></td>
                      <td><textarea class="form-control activity-control" data-field="result">${escapeHtml(item.result)}</textarea></td>
                      <td class="duration">${minutes(item.end) - minutes(item.start)} m</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          ` : `
            <ul class="day-summary-list">
              ${day.items.map(item => `
                <li class="day-summary-item">
                  <span class="day-time">${escapeHtml(item.start)} – ${escapeHtml(item.end)}</span>
                  <span class="day-desc">${escapeHtml(item.description)}</span>
                  <span class="day-type-tag">${escapeHtml(item.type)}</span>
                </li>
              `).join('')}
            </ul>
          `}
        </article>
      `;
    }).join('');
  }

  const check = $('#confirmCheck');
  if (check) check.checked = false;
  updatePreviewStatuses(preview);
  syncControls();
}

function statusOf(row) {
  return String(row.status || row.state || (row.verified ? 'verified' : row.ok ? 'success' : 'failed')).toLowerCase();
}

function renderReport(report) {
  currentReport = report;
  const reportArea = $('#reportArea');
  if (!reportArea) return;
  reportArea.hidden = false;

  const results = report.results || report.dates || [];
  const counts = results.reduce((acc, r) => {
    const s = r.status === 'awaiting_supervisor' || r.submitted || r.verified ? 'saved' : r.skipped ? 'skipped' : 'failed';
    acc[s] = (acc[s] || 0) + 1;
    return acc;
  }, {});

  const summary = $('#reportSummary');
  if (summary) {
    summary.innerHTML = `<strong>Ringkasan:</strong> ${counts.saved || 0} tanggal tersimpan di LLK · ${counts.skipped || 0} dilewati (duplikat) · ${counts.failed || 0} gagal`;
  }

  const meta = $('#reportMeta');
  if (meta) {
    meta.innerHTML = `<dl>
      <div><dt>Waktu</dt><dd>${escapeHtml(report.at || '—')}</dd></div>
      <div><dt>Profil</dt><dd>${escapeHtml(report.employee?.name || active?.name || '—')}</dd></div>
      <div><dt>Kebijakan</dt><dd>${escapeHtml(report.duplicatePolicy || '—')}</dd></div>
    </dl>`;
  }

  const resultsNode = $('#reportResults');
  if (resultsNode) {
    resultsNode.innerHTML = results.length ? results.map(row => `
      <div class="result-card status-${escapeHtml(row.status === 'awaiting_supervisor' || row.submitted || row.verified ? 'verified' : row.skipped ? 'skipped' : 'failed')}">
        <div class="result-header">
          <strong>${escapeHtml(row.date)}</strong>
          <span class="tag-badge">${escapeHtml(row.statusLabel || (row.submitted || row.verified ? 'Tersimpan di LLK' : row.skipped ? 'Sudah ada' : 'Gagal'))}</span>
        </div>
        <p class="result-message">${escapeHtml(row.message || row.error || 'Tersimpan ke sistem LLK (menunggu verifikasi atasan).')}</p>
      </div>
    `).join('') : '<p class="field-help">Belum ada rincian laporan.</p>';
  }

  updatePreviewStatuses(currentPreview, report);
  reportArea.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderPersonalTemplate(info) {
  const activities = info.source === 'personal' ? (info.activities || []) : [];
  const sourceText = $('#personalTemplateSourceText'); if (sourceText) sourceText.textContent = 'Halaman terakhir LLK';
  const fallbackText = $('#personalTemplateFallbackText'); if (fallbackText) fallbackText.textContent = active?.department || info.fallbackLabel || '—';
  const countNode = $('#personalTemplateCount'); if (countNode) countNode.textContent = `${activities.length} kegiatan`;
  const tbody = $('#pageTemplateBody'); if (tbody) tbody.innerHTML = activityRows(activities, 'halaman LLK');
}

async function loadPersonalTemplate(employeeId) {
  if (!employeeId) return;
  try { renderPersonalTemplate(await api(`/api/employees/${employeeId}/personal-template`)); }
  catch (error) { log(`Gagal memuat daftar halaman LLK: ${error.message}`); }
}

function renderPersonalDiff(staged) {
  personalStage = staged;
  const box = $('#personalStageBox');
  if (!box) return;
  box.hidden = false;

  const confirm = $('#personalStageConfirm');
  if (confirm) confirm.checked = false;

  const normalize = a => ({ ...a, description: a.description || a.nama || '—', type: a.type || a.kategori || 'Utama', result: a.result || a.output || '—' });
  const activities = (staged.candidate?.activities || []).map(normalize);
  const added = (staged.diff?.added || []).map(normalize);
  const removed = (staged.diff?.removed || []).map(normalize);

  const summary = $('#personalStageSummary');
  if (summary) summary.textContent = `${activities.length} total (${added.length} baru)`;

  const diffRows = [
    ...added.map(act => ({ status: 'BARU', rowClass: 'tag-badge', act })),
    ...activities.filter(a => !added.some(add => add.description === a.description)).map(act => ({ status: 'TETAP', rowClass: 'tag-support', act })),
    ...removed.map(act => ({ status: 'HAPUS', rowClass: 'status-failed', act }))
  ];

  const tbody = $('#personalStageDiffBody');
  if (tbody) {
    tbody.innerHTML = diffRows.length ? diffRows.map(({ status, rowClass, act }) => `
      <tr>
        <td><span class="tag-badge ${rowClass}">${escapeHtml(status)}</span></td>
        <td><strong>${escapeHtml(act.description)}</strong></td>
        <td>${escapeHtml(act.start || '—')} – ${escapeHtml(act.end || '—')}</td>
        <td>${escapeHtml(act.type)} / ${escapeHtml(act.result)}</td>
        <td>${escapeHtml(act.count != null ? `${act.count}x` : '—')}</td>
        <td><small>${escapeHtml(act.lastSeen || act.dates?.[act.dates.length - 1] || '—')}</small></td>
      </tr>
    `).join('') : '<tr><td colspan="6" class="emp-pos">Tidak ada perbedaan kegiatan.</td></tr>';
  }

  syncControls();
}

function downloadJson(data, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

async function loadCalendar() {
  const calendar = await api('/api/calendar/2026');
  calendarDays = new Map((calendar.days || []).map(day => [day.date, day]));
  renderCalendar();
}

function updateCalendarSelection(start, end = start) {
  calendarSelection = { start, end };
  const startInput = $('#startDate'), endInput = $('#endDate');
  if (startInput) startInput.value = start || '';
  if (endInput) endInput.value = end || '';
  const startLabel = $('#startDateLabel'), endLabel = $('#endDateLabel');
  if (startLabel) startLabel.textContent = formatIndonesianDate(start);
  if (endLabel) endLabel.textContent = formatIndonesianDate(end);
  renderCalendar();
}

function renderCalendar() {
  const grid = $('#calendarGrid');
  if (!grid) return;
  const year = calendarMonth.getFullYear(), month = calendarMonth.getMonth();
  $('#calendarMonthTitle').textContent = new Intl.DateTimeFormat('id-ID',{month:'long',year:'numeric'}).format(calendarMonth);
  const firstWeekday = (new Date(year,month,1).getDay()+6)%7;
  const lastDay = new Date(year,month+1,0).getDate();
  const today = isoDate(new Date());
  const cells = Array.from({length:firstWeekday},()=>'<span class="calendar-empty"></span>');
  let excluded = 0;
  for (let day=1; day<=lastDay; day++) {
    const date = new Date(year,month,day), iso = isoDate(date), weekday = date.getDay();
    const official = calendarDays.get(iso), weekend = weekday===0 || weekday===6;
    const disabled = iso > today || weekend || Boolean(official);
    const selected = calendarSelection.start && iso>=calendarSelection.start && iso<=(calendarSelection.end||calendarSelection.start);
    if (selected && disabled) excluded++;
    const type = official?.type || (weekend ? 'weekend' : 'workday');
    const title = official?.label || (weekend ? (weekday===6?'Sabtu':'Minggu') : 'Hari kerja');
    cells.push(`<button type="button" class="calendar-day is-${type}${selected?' is-selected':''}${iso===calendarSelection.start?' is-start':''}${iso===calendarSelection.end?' is-end':''}" data-calendar-date="${iso}" ${disabled?'disabled':''} aria-label="${escapeHtml(`${day} ${title}${selected?', dipilih':''}`)}"><strong>${day}</strong>${official?`<small>${official.type==='collective'?'Cuti':'Libur'}</small>`:weekend?'<small>Libur</small>':''}</button>`);
  }
  grid.innerHTML = cells.join('');
  const summary = $('#calendarSummary');
  if (summary) summary.textContent = calendarSelection.start ? `${formatIndonesianDate(calendarSelection.start)} – ${formatIndonesianDate(calendarSelection.end)}${excluded ? ` · ${excluded} hari nonkerja otomatis dilewati` : ''}` : 'Pilih tanggal mulai dan selesai.';
  $('#calendarPrevBtn').disabled = year===2026 && month===0;
  $('#calendarNextBtn').disabled = year===2026 && month===11;
}

function setDatePreset(type) {
  const now = new Date();
  let start = new Date(now), end = new Date(now);
  const nonwork = date => date.getDay()===0 || date.getDay()===6 || calendarDays.has(isoDate(date));
  if (type === 'today') {
    while (nonwork(start)) start.setDate(start.getDate()-1);
    end = new Date(start);
  } else if (type === 'week') {
    const day = now.getDay(), diffToMonday = (day === 0 ? -6 : 1) - day;
    start.setDate(now.getDate() + diffToMonday); end = new Date(start); end.setDate(start.getDate() + 4);
  } else if (type === 'month') {
    start = new Date(now.getFullYear(), now.getMonth(), 1); end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  }
  calendarMonth = new Date(start.getFullYear(),start.getMonth(),1);
  updateCalendarSelection(isoDate(start), isoDate(end));
}

$('#calendarGrid')?.addEventListener('click', event => {
  const button = event.target.closest('[data-calendar-date]');
  if (!button) return;
  const date = button.dataset.calendarDate;
  if (!calendarSelection.start || calendarSelection.end) updateCalendarSelection(date, null);
  else if (date < calendarSelection.start) updateCalendarSelection(date, calendarSelection.start);
  else updateCalendarSelection(calendarSelection.start, date);
});
$('#calendarPrevBtn')?.addEventListener('click',()=>{calendarMonth=new Date(2026,calendarMonth.getMonth()-1,1);renderCalendar();});
$('#calendarNextBtn')?.addEventListener('click',()=>{calendarMonth=new Date(2026,calendarMonth.getMonth()+1,1);renderCalendar();});

// Event Listeners
function setNewProfileMode(open) {
  const form = $('#employeeForm'), chip = $('.profile-chip'), picker = $('#profilePicker'), button = $('#newEmployee'), workspace = $('#workspace');
  if (!form) return;
  form.hidden = !open;
  if (chip) chip.hidden = open;
  if (picker) picker.hidden = open || !employees.length;
  if (workspace) workspace.hidden = open || !active;
  if (button) { button.textContent = open ? 'Batal' : 'Tambah profil'; button.classList.toggle('btn-outline', open); button.classList.toggle('btn-primary', !open); }
  if (open) {
    form.reset();
    $('#quickSsoLoginBtn').hidden = false;
    $('#quickSsoFetchBtn').hidden = true;
    $('#satkerSelect').textContent = 'Terisi setelah login SSO';
    form.elements.supervisorNip?.focus();
  } else if (active) selectEmployee(active);
  else $('#satkerSelect').textContent = 'Satker lainnya';
}

function openEmployeeForm() {
  setNewProfileMode($('#employeeForm')?.hidden !== true ? false : true);
}

$('#newEmployee')?.addEventListener('click', openEmployeeForm);

function verificationList(items, state = 'ready') {
  if (!items.length) return '';
  return `<ol class="verification-list">${items.map((item, index) => {
    const ready = state === 'ready' ? item.valid !== false : item.success;
    const label = state === 'ready' ? (ready ? 'Siap' : 'Ditahan') : (ready ? 'Berhasil' : 'Gagal');
    const fallback = state === 'ready' ? (item.issues?.join('; ') || item.summary) : (item.error || (ready ? 'Berhasil diproses.' : `HTTP ${item.status || '—'}`));
    const summary = String(item.summary || '');
    const employee = String(item.employeeName || (summary.match(/^\s*\d+\s+(.+?),\s*Tanggal Kegiatan\s*:/i) || [])[1] || '').trim();
    const activities = Array.isArray(item.activities) ? item.activities.filter(activity => activity.start || activity.end || activity.description) : [];
    const schedule = activities.length ? `<ul class="verification-schedule">${activities.map(activity => `<li><time>${escapeHtml(`${activity.start || '—'}–${activity.end || '—'}`)}</time><span>${escapeHtml(activity.description || 'Kegiatan tidak terbaca')}</span><small>${escapeHtml(activity.type || '')}</small></li>`).join('')}</ul>` : `<p class="verification-detail">${escapeHtml(fallback || 'Rincian LLK tidak tersedia.')}</p>`;
    return `<li class="verification-item verification-item--${ready ? 'ready' : 'failed'}"><span class="verification-number">${index + 1}</span><div class="verification-item-body"><div class="verification-item-head"><div><strong>${escapeHtml(item.date || item.hllk || 'Target tanpa tanggal')}</strong>${employee ? `<span class="verification-employee">${escapeHtml(employee)}</span>` : ''}</div><span class="verification-status">${label}</span></div>${state === 'ready' && item.hllk ? `<code class="verification-id">ID LLK ${escapeHtml(item.hllk)}</code>` : ''}${schedule}</div></li>`;
  }).join('')}</ol>`;
}
function verificationRecovery(error) {
  const loginRequired = error?.status === 401 || /kedaluwarsa|login ulang|sesi .*tidak/i.test(String(error?.message || ''));
  const title = loginRequired ? 'Sesi LLK perlu diperbarui' : 'Pemindaian belum selesai';
  const instruction = loginRequired ? 'Klik Buka SSO, login dengan profil aktif, pilih Saya sudah login, lalu kembali ke Verifikasi LLK Anggota.' : 'Klik Pindai Ulang. Jika pesan ini muncul lagi, buka SSO dan login ulang untuk membuat sesi baru.';
  return `<section class="verification-recovery verification-recovery--${loginRequired ? 'login' : 'retry'}" role="alert"><div class="verification-recovery-mark" aria-hidden="true">!</div><div><strong>${title}</strong><p>${escapeHtml(instruction)}</p><button class="btn btn-outline btn-sm" type="button" data-go-step="1">${loginRequired ? 'Buka proses login' : 'Kembali ke login'}</button></div></section>`;
}

async function refreshWizardVerification() {
  if (!active) return;
  try {
    const result = await api(`/api/verification/preview?employeeId=${encodeURIComponent(active.id)}`);
    verificationTargets = (result.targets || []).filter(item => item.valid !== false); verificationStageToken = result.stageToken || null;
    const count = $('#wizardVerificationCount');
    if (count) count.textContent = `${result.validCount ?? verificationTargets.length} LLK siap diverifikasi · filter Belum Terverifikasi berdasarkan NIP terbukti aktif`;
    const preview = $('#wizardVerificationPreview');
    const held = Array.isArray(result.invalidTargets) ? result.invalidTargets : [];
    if (preview) preview.innerHTML = `<section class="verification-command"><div class="verification-filter verification-filter--active"><span>Filter aktif</span><strong>Belum Terverifikasi</strong><span>berdasarkan NIP</span></div>${verificationTargets.length ? `<div class="verification-summary"><strong>${verificationTargets.length}</strong><span>LLK siap diverifikasi</span></div>${verificationList(verificationTargets)}` : '<p class="verification-empty">Tidak ada LLK anggota berstatus Belum Terverifikasi.</p>'}${held.length ? `<div class="verification-held"><strong>${held.length} LLK ditahan</strong><span>Belum lolos pemeriksaan sebelum verifikasi.</span></div>${verificationList(held)}` : ''}</section>`;
    $('#runWizardVerificationBtn').disabled = !verificationTargets.length;
  } catch (error) {
    verificationTargets = []; verificationStageToken = null;
    $('#runWizardVerificationBtn').disabled = true;
    const count = $('#wizardVerificationCount'); if (count) count.textContent = 'Verifikasi belum dapat dimulai';
    const preview = $('#wizardVerificationPreview'); if (preview) preview.innerHTML = verificationRecovery(error);
    throw error;
  }
}

document.querySelectorAll('[name="workflowMode"]').forEach(input => input.addEventListener('change', () => {const verify = document.querySelector('[name="workflowMode"]:checked')?.value === 'verify';$('#createLlkMode').hidden = verify;$('#verifyLlkMode').hidden = !verify;if (verify) runBusy(refreshWizardVerification, 'Pindai LLK Anggota');}));
$('#refreshWizardVerificationBtn')?.addEventListener('click', () => runBusy(refreshWizardVerification, 'Pindai LLK Anggota'));
$('#runWizardVerificationBtn')?.addEventListener('click', () => active && runBusy(async () => {
  const message = String($('#wizardVerificationMessage')?.value || '').trim();
  if (!message) throw new Error('Isi pesan verifikasi terlebih dahulu');
  if (!verificationTargets.length || !verificationStageToken) throw new Error('Pindai ulang sebelum verifikasi');
  const result = await api('/api/verification/run', {method: 'POST',body: JSON.stringify({ employeeId: active.id, message, stageToken: verificationStageToken, hllk: verificationTargets.map(item => item.hllk) })});
  verificationTargets = []; verificationStageToken = null;
  const failures=result.results.filter(item=>!item.success);
  log(`Verifikasi anggota selesai: ${result.success}/${result.total} berhasil.`);
  feedback(`${result.success} LLK anggota berhasil diverifikasi${result.failed ? `; ${result.failed} gagal: ${failures.map(item=>`${item.date||item.hllk} (${item.error||`HTTP ${item.status}`})`).join('; ')}` : ''}.`,Boolean(result.failed));
  $('#wizardVerificationCount').textContent=`${result.success}/${result.total} selesai${result.failed?`; ${result.failed} gagal`:''}. Pindai ulang hanya jika ingin melihat sisa target.`;
  $('#wizardVerificationPreview').innerHTML=`<p class="verification-result-summary"><strong>Verifikasi selesai tanpa memindai ulang filter.</strong></p>${verificationList(result.results, 'result')}`;
  $('#runWizardVerificationBtn').disabled=true;
}, 'Verifikasi LLK Anggota'));
async function fetchBootstrapProfile() {
  if (!bootstrapFlow) throw new Error('Sesi bootstrap tidak aktif. Klik Buka ulang SSO untuk membuat sesi login baru.');
  try {
    const out = await api('/api/bootstrap/complete', {
      method: 'POST',
      body: JSON.stringify({ tempId: bootstrapFlow, supervisorNip: String($('#quickSupervisorNip')?.value || '').trim() })
    });
    sessionStorage.removeItem('bootstrapFlow');
    bootstrapFlow = null;
    setNewProfileMode(false);
    selectEmployee(out.employee);
    loginFlows.set(out.employee.id, 'review');
    const loginBadge = $('#loginBadge');
    if (loginBadge) loginBadge.textContent = 'SSO aktif';
    const loginNextBtn = $('#loginNextBtn');
    if (loginNextBtn) loginNextBtn.hidden = false;
    setWizardStep(2);
    await loadEmployees();
    const templateCount = out.history?.candidate?.activities?.length || out.history?.activities?.length || 0;
    log(`Profil ${out.employee.name} (${out.employee.nip}) dibuat dari SSO; ${templateCount} pola kegiatan diimpor.`);
    feedback(`SSO aktif. ${templateCount} pola kegiatan ditemukan.`);
  } catch (error) {
    if (error?.status === 401 || /Login LLK belum terdeteksi|kedaluwarsa|Sesi LLK tidak ditemukan/i.test(error?.message || '')) {
      $('#quickSsoRestartBtn').hidden = false;
      feedback('Login SSO belum selesai atau sesi telah berakhir. Klik Buka ulang SSO, login di Edge, lalu klik Saya sudah login.', true);
    }
    throw error;
  }
}


$('#employeeForm')?.addEventListener('submit', event => {
  event.preventDefault();
  runBusy(async () => {
    const supervisorNip = String($('#quickSupervisorNip')?.value || '').trim();
    if (!/^\d{18}$/.test(supervisorNip)) {
      $('#quickSupervisorNip')?.focus();
      throw new Error('NIP atasan langsung harus tepat 18 digit angka');
    }
    const satker = '';
    log('Membuka Edge untuk login SSO dan mengambil profil…');
    const res = await api('/api/bootstrap/login', {
      method: 'POST',
      body: JSON.stringify({ satker, supervisorNip, department: 'umum_keuangan' })
    });
    bootstrapFlow = res.tempId;
    sessionStorage.setItem('bootstrapFlow', bootstrapFlow);
    $('#quickSsoLoginBtn').hidden = true;
    $('#quickSsoFetchBtn').hidden = false;
    $('#quickSsoRestartBtn').hidden = false;
    log(res.message || 'Silakan selesaikan login SSO di Edge.');
    feedback('Selesaikan login SSO di Edge, lalu klik Saya sudah login. Profil dan kegiatan pada halaman pertama /llk akan dibaca otomatis.');
  }, 'Tambah Profil dari SSO');
});

$('#quickSsoRestartBtn')?.addEventListener('click', () => {
  bootstrapFlow = null;
  sessionStorage.removeItem('bootstrapFlow');
  $('#quickSsoRestartBtn').hidden = true;
  $('#quickSsoFetchBtn').hidden = true;
  $('#quickSsoLoginBtn').hidden = false;
  $('#quickSupervisorNip')?.focus();
  feedback('Masukkan NIP atasan jika perlu, lalu klik Login SSO & buat profil untuk membuka sesi Edge baru.');
});

$('#quickSsoFetchBtn')?.addEventListener('click', () => runBusy(fetchBootstrapProfile, 'Tarik Data Akun'));
$('#profilePicker')?.addEventListener('change', event => {const employee=employees.find(item=>item.id===event.target.value);if(employee)selectEmployee(employee);});


$('#employeeList')?.addEventListener('click', event => {
  const item = event.target.closest('[data-id]');
  const employee = item && employees.find(row => row.id === item.dataset.id);
  if (employee) {
    selectEmployee(employee);
    log(`Beralih ke profil ${employee.name}`);
  }
});

$('#loginBtn')?.addEventListener('click', () => active && runBusy(async () => {
  const employeeId = active.id;
  log('Membuka browser Edge untuk login SSO…');
  const result = await api(`/api/employees/${employeeId}/login`, { method: 'POST', body: '{}' });
  loginFlows.set(employeeId, 'waiting');
  if (active?.id === employeeId) renderLoginFlow();
  pollLogin(employeeId);
  log(result.message || 'Jendela Edge terbuka. Login akan dideteksi otomatis.');
}, 'Buka SSO'));

$('#completeLoginBtn')?.addEventListener('click', () => active && runBusy(async () => {
  const employeeId = active.id;
  stopLoginPolling();
  try {
    await completeLoginFlow(employeeId);
  } catch (error) {
    pollLogin(employeeId);
    if (error.status === 401) error.message = 'Login belum terdeteksi di browser. Pastikan proses SSO di Edge selesai.';
    throw error;
  }
}, 'Verifikasi Login'));

$('#cancelLoginBtn')?.addEventListener('click', () => active && runBusy(async () => {
  const employeeId = active.id;
  stopLoginPolling();
  log('Membatalkan alur login…');
  const result = await api(`/api/employees/${employeeId}/login/cancel`, { method: 'POST', body: '{}' });
  loginFlows.delete(employeeId);
  if (active?.id === employeeId) renderLoginFlow();
  log(result.message || 'Login dibatalkan.');
}, 'Batal Login'));


$('#confirmCheck')?.addEventListener('change', syncControls);

$('#submitBtn')?.addEventListener('click', () => runBusy(async () => {
  if (!active || !currentPreview || !validatePreview(currentPreview) || !$('#confirmCheck')?.checked) throw new Error('Centang konfirmasi sebelum mengirim ke LLK.');
  const policy = $('#duplicatePolicy')?.value || 'skip';
  log(`Mengirim ${currentPreview.length} hari isian ke LLK…`);
  const report = await api(`/api/employees/${active.id}/submit`, {
    method: 'POST',
    body: JSON.stringify({ preview: currentPreview, duplicatePolicy: policy, confirmed: true })
  });
  renderReport(report);
  updatePreviewStatuses(currentPreview, report);
  const results = report.results || report.dates || [];
  results.forEach(row => {
    log(`Hasil ${row.date}: ${statusOf(row)} (${row.message || 'selesai'})`);
  });
  log('Pengiriman selesai.');
}, 'Kirim ke LLK'));

document.querySelectorAll('[data-preset]').forEach(btn => {
  btn.addEventListener('click', () => {
    setDatePreset(btn.dataset.preset);
  });
});

$('#employeeSearch')?.addEventListener('input', () => {
  renderEmployeeList();
});


$('#exportReportBtn')?.addEventListener('click', () => {
  if (currentReport) downloadJson(currentReport, `laporan-llk-${active?.id}.json`);
});

$('#clearLogBtn')?.addEventListener('click', () => {
  const box = $('#logBox');
  if (box) {
    box.dataset.touched = 'true';
    box.textContent = 'Menunggu proses…';
  }
});


$('#deleteEmployeeBtn')?.addEventListener('click', () => {
  if (!active) return;
  const grp = $('#deleteConfirmGroup');
  if (grp) grp.hidden = false;
  const tgt = $('#deleteTargetId');
  if (tgt) tgt.textContent = active.id;
  const input = $('#deleteConfirm');
  if (input) {
    input.value = '';
    input.focus();
  }
  syncControls();
});

$('#deleteConfirm')?.addEventListener('input', syncControls);

$('#deleteConfirmBtn')?.addEventListener('click', () => active && runBusy(async () => {
  if ($('#deleteConfirm')?.value !== active.id) throw new Error(`Ketik ${active.id} untuk konfirmasi.`);
  log(`Menghapus profil ${active.name}…`);
  await api(`/api/profiles/${active.id}`, { method: 'DELETE', body: JSON.stringify({ confirm: active.id }) });
  const deletedId = active.id;
  active = null;
  const workspace = $('#workspace');
  if (workspace) workspace.hidden = true;
  const grp = $('#deleteConfirmGroup');
  if (grp) grp.hidden = true;
  await loadEmployees();
  if (employees[0]) selectEmployee(employees[0]);
  log(`Profil ${deletedId} berhasil dihapus.`);
}, 'Hapus Profil'));


$('#importPersonalTemplateBtn')?.addEventListener('click', () => active && runBusy(async () => {
  log(`Membaca halaman pertama daftar LLK untuk ${active.name}…`);
  const staged = await api(`/api/employees/${active.id}/personal-template/import`, { method: 'POST', body: '{}' });
  if (!staged.available) throw new Error(staged.warning || 'Daftar LLK tidak dapat dibaca');
  renderPersonalDiff(staged);
  log(`${staged.scannedEntries || 0} entri LLK dibaca dari ${staged.pagesScanned || 1} halaman (${staged.sourceUrl || '/llk'}); ${staged.candidate?.activities?.length || 0} pola unik siap ditinjau.`);
}, 'Impor Seluruh LLK'));


document.querySelectorAll('[name="activitySource"]').forEach(input => input.addEventListener('change', () => {
  const general = document.querySelector('[name="activitySource"]:checked')?.value === 'general';
  $('#sourceDepartmentWrap').hidden = !general;
  const srcLabel = $('#sourceSummaryText'); if (srcLabel) srcLabel.textContent = general ? 'Template umum' : 'Halaman terakhir LLK';
  if (general && active?.department) $('#sourceDepartmentSelect').value = active.department;
}));

$('#personalStageConfirm')?.addEventListener('change', syncControls);

$('#cancelPersonalStageBtn')?.addEventListener('click', () => {
  personalStage = null;
  const box = $('#personalStageBox');
  if (box) box.hidden = true;
  const chk = $('#personalStageConfirm');
  if (chk) chk.checked = false;
  syncControls();
  log('Peninjauan daftar kegiatan dibatalkan.');
});

$('#applyPersonalTemplateBtn')?.addEventListener('click', () => active && runBusy(async () => {
  if (!personalStage || !$('#personalStageConfirm')?.checked) {
    throw new Error('Centang konfirmasi peninjauan daftar kegiatan.');
  }
  log(`Menerapkan daftar kegiatan halaman LLK untuk ${active.name}…`);
  const result = await api(`/api/employees/${active.id}/personal-template/apply`, {
    method: 'POST',
    body: JSON.stringify({ stageToken: personalStage.stageToken, confirm: active.id })
  });
  personalStage = null;
  const box = $('#personalStageBox');
  if (box) box.hidden = true;
  const chk = $('#personalStageConfirm');
  if (chk) chk.checked = false;
  renderPersonalTemplate(result);
  log(`Daftar kegiatan halaman LLK untuk ${active.name} aktif.`);
  syncControls();
}, 'Terapkan Daftar Kegiatan'));

$('#loginNextBtn')?.addEventListener('click', () => {
  setWizardStep(2);
  refreshWizardVerification().catch(error => log(`Pemindaian verifikasi belum tersedia: ${error.message}`));
});
document.querySelectorAll('[data-go-step]').forEach(btn => {
  btn.addEventListener('click', () => setWizardStep(Number(btn.dataset.goStep)));
});
$('#wizardVerificationPreview')?.addEventListener('click', event => {
  const button = event.target.closest('[data-go-step]');
  if (button) setWizardStep(Number(button.dataset.goStep));
});

$('#previewCards')?.addEventListener('click', event => {
  const btn = event.target.closest('[data-toggle-edit]');
  if (btn) toggleDayCardEdit(Number(btn.dataset.toggleEdit));
});
$('#previewCards')?.addEventListener('input', syncPreviewFromForm);
$('#previewCards')?.addEventListener('change', syncPreviewFromForm);

$('#newSubmissionBtn')?.addEventListener('click', () => {
  const area = $('#reportArea');
  if (area) area.hidden = true;
  setWizardStep(2);
});

$('#previewBtn')?.addEventListener('click', () => active && runBusy(async () => {
  const start = $('#startDate')?.value;
  const end = $('#endDate')?.value;
  if (!start || !end) throw new Error('Tentukan tanggal mulai dan selesai.');
  const source = document.querySelector('[name="activitySource"]:checked')?.value || 'page';
  const department = source === 'general' ? $('#sourceDepartmentSelect')?.value : undefined;
  log(`Menyiapkan isian LLK dari ${start} sampai ${end}; pola jam kerja dibaca dari LLK sebelumnya; sumber: ${source === 'general' ? 'template umum' : 'halaman terakhir LLK'}…`);
  const preview = await api(`/api/employees/${active.id}/preview`, {
    method: 'POST',
    body: JSON.stringify({ start, end, source, department })
  });
  await loadEmployees();
  const refreshed = employees.find(employee => employee.id === active.id);
  if (refreshed) selectEmployee(refreshed);
  renderPreview(preview);
  setWizardStep(3);
}, 'Menyiapkan isian…'));

$('#resetPersonalTemplateBtn')?.addEventListener('click', () => active && runBusy(async () => {
  log(`Menghapus daftar halaman LLK tersimpan untuk ${active.name}…`);
  const result = await api(`/api/employees/${active.id}/personal-template`, {
    method: 'DELETE',
    body: JSON.stringify({ confirm: active.id })
  });
  personalStage = null;
  const box = $('#personalStageBox');
  if (box) box.hidden = true;
  const chk = $('#personalStageConfirm');
  if (chk) chk.checked = false;
  renderPersonalTemplate(result);
  log(`Daftar halaman LLK ${active.name} dihapus.`);
  syncControls();
}, 'Hapus Daftar Kegiatan'));

document.addEventListener('DOMContentLoaded', () => {
  setDatePreset('today');
  loadApp().catch(error => {
    log(`Gagal inisialisasi: ${error.message}`);
    feedback(error.message, true);
  });
});

// Theme toggle — initial theme is applied pre-CSS by the inline head script
// (localStorage choice, else system preference) so first paint never flashes.
(function initThemeToggle() {
  const STORAGE_KEY = 'llk-theme';
  const root = document.documentElement;
  const meta = document.getElementById('metaThemeColor');
  const META_COLORS = { light: '#f4f5f0', dark: '#182128' };

  let currentTheme = root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';

  function applyTheme(theme) {
    currentTheme = theme;
    root.setAttribute('data-theme', theme);
    try { localStorage.setItem(STORAGE_KEY, theme); } catch (e) { /* private mode */ }
    if (meta) meta.setAttribute('content', META_COLORS[theme]);
    if (btn) {
      const nextLabel = theme === 'dark' ? 'Aktifkan mode terang' : 'Aktifkan mode gelap';
      btn.setAttribute('aria-label', nextLabel);
      btn.setAttribute('title', nextLabel);
      btn.setAttribute('aria-pressed', String(theme === 'dark'));
    }
  }

  const btn = document.getElementById('themeToggleBtn');
  if (!btn) return;
  applyTheme(currentTheme);

  btn.addEventListener('click', function () {
    applyTheme(currentTheme === 'dark' ? 'light' : 'dark');
  });
})();