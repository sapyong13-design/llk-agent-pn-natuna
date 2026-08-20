let employees = [], templates = {}, active = null, currentPreview = null, currentReport = null, templateStage = null, personalStage = null, busy = false;
const loginFlows = new Map();
let bootstrapFlow = sessionStorage.getItem('bootstrapFlow');
let supervisorLookupToken=null;
let verificationRecordingActive = false;
let verificationTargets = [];
let loginPollTimer = null;
const FARIS_ID = '199412162025061006';
let currentStep = 1;
let holidayStore = {};
const editDayState = new Set();
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
  const templateApplyBtn = $('#templateApplyBtn');
  const applyPersonalTemplateBtn = $('#applyPersonalTemplateBtn');
  const startVerificationRecordingBtn = $('#startVerificationRecordingBtn');
  const finishVerificationRecordingBtn = $('#finishVerificationRecordingBtn');
  const deleteConfirmBtn = $('#deleteConfirmBtn');

  if (loginBtn) loginBtn.disabled = busy || flow === 'waiting' || flow === 'completing';
  if (completeLoginBtn) completeLoginBtn.disabled = busy || flow !== 'waiting';
  if (cancelLoginBtn) cancelLoginBtn.disabled = busy || (flow !== 'waiting' && flow !== 'completing');
  if (submitBtn) {const supervisor=previewSupervisor(currentPreview);submitBtn.disabled = busy || !currentPreview || !$('#confirmCheck')?.checked || !supervisor.name || !supervisor.nip;}
  if (templateApplyBtn) templateApplyBtn.disabled = busy || !templateStage || !$('#templateConfirm')?.checked;
  if (applyPersonalTemplateBtn) applyPersonalTemplateBtn.disabled = busy || !personalStage || !$('#personalStageConfirm')?.checked;
  if (startVerificationRecordingBtn) startVerificationRecordingBtn.disabled = busy || verificationRecordingActive;
  if (finishVerificationRecordingBtn) finishVerificationRecordingBtn.disabled = busy || !verificationRecordingActive;
  const runAutomaticVerificationBtn = $('#runAutomaticVerificationBtn');
  if (runAutomaticVerificationBtn) runAutomaticVerificationBtn.disabled = busy || !verificationTargets.length;
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
  for (const select of [$('#departmentSelect'), $('#workTemplateSelect'), $('#generalTemplateSelect')]) {
    if (!select) continue;
    select.innerHTML = Object.entries(groups)
      .filter(([, value]) => value && typeof value === 'object' && Array.isArray(value.activities))
      .map(([key, value]) => `<option value="${escapeHtml(key)}">${escapeHtml(value.label)}</option>`)
      .join('');
  }
  renderGeneralTemplate($('#generalTemplateSelect')?.value);
  const versionNode = $('#templateVersion');
  if (versionNode) versionNode.textContent = templates.version || templates.meta?.version || 'standar';
}

function renderGeneralTemplate(key) {
  const groups = templates.departments || templates.templates || templates;
  const group = groups?.[key];
  const tbody = $('#generalTemplateBody');
  if (!tbody) return;
  tbody.innerHTML = group?.activities?.length ? group.activities.map(activity => `
    <tr>
      <td><strong>${escapeHtml(activity.nama)}</strong></td>
      <td>${escapeHtml(activity.kategori || 'Pendukung')}</td>
      <td>${escapeHtml(activity.output || activity.keterangan || '—')}</td>
    </tr>
  `).join('') : '<tr><td colspan="3" class="emp-pos">Belum ada kegiatan standar.</td></tr>';
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

function resolveDefaultEmployee(list) {
  if (!Array.isArray(list) || !list.length) return null;
  return list.find(emp => String(emp.id) === FARIS_ID || String(emp.nip) === FARIS_ID) || list[0];
}

async function loadApp() {
  log('Memulai LLK Agent…');
  const [settings] = await Promise.all([api('/api/settings'), loadTemplates(), loadEmployees()]);
  const satker = settings.satker || 'Pengadilan Negeri Natuna';
  const known = satker === 'Pengadilan Negeri Natuna';
  $('#satkerSelect').value = known ? satker : 'other';
  $('#customSatker').hidden = known;
  $('#customSatker').value = known ? '' : satker;
  const initial = resolveDefaultEmployee(employees);
  if (initial) selectEmployee(initial);
  if ($('#workTemplateSelect') && initial?.department) $('#workTemplateSelect').value = initial.department;
  log(`Sistem siap. Satker: ${satker}. Profil aktif: ${initial?.name || 'Belum dipilih'}`);
  const bootstrapStatus = await api('/api/bootstrap/status').catch(() => ({ active: [] }));
  const pendingBootstrap = bootstrapStatus.active?.[0];
  if (pendingBootstrap) {
    bootstrapFlow = pendingBootstrap.tempId;
    sessionStorage.setItem('bootstrapFlow', bootstrapFlow);
    $('#employeeForm').hidden = false;
    $('#quickSsoLoginBtn').hidden = true;
    $('#quickSsoFetchBtn').hidden = false;
    feedback(pendingBootstrap.fetchedAt ? 'Sesi Edge tetap aktif. Klik Saya sudah login untuk mengambil ulang daftar LLK.' : 'Sesi login Edge masih aktif. Selesaikan login lalu klik Saya sudah login.');
  }
  if (initial) {
    const recordingStatus = await api('/api/navigation-recording/status').catch(() => ({active:false}));
    const dialog = $('#navigationRecorderDialog');
    if (recordingStatus.active) {
      if (dialog && !dialog.open) dialog.showModal();
      $('#startNavigationRecordingBtn').disabled = true;
    } else if (!recordingStatus.recorded?.llk && !sessionStorage.getItem('navigationRecorderPrompted')) {
      sessionStorage.setItem('navigationRecorderPrompted','1');
      if (dialog && !dialog.open) dialog.showModal();
      $('#navigationRecorderStatus').textContent = 'Pilih Daftar LLK atau Daftar Verifikasi. Edge akan dibuka otomatis; Anda cukup login dan membuka daftar yang benar.';
      setTimeout(() => $('#startNavigationRecordingBtn')?.click(), 0);
    }
  }
}

function renderLoginFlow() {
  const state = (active && loginFlows.get(active.id)) || 'idle';
  const waiting = state === 'waiting' || state === 'completing';
  const loginFlow = $('#loginFlow');
  const loginBtn = $('#loginBtn');
  const completeLoginBtn = $('#completeLoginBtn');
  const cancelLoginBtn = $('#cancelLoginBtn');
  const detail = $('#loginFlowDetail');
  const stateBadge = $('#authStepState');

  if (loginBtn) loginBtn.hidden = waiting;
  if (completeLoginBtn) completeLoginBtn.hidden = !waiting;
  if (cancelLoginBtn) cancelLoginBtn.hidden = !waiting;
  if (loginFlow) loginFlow.dataset.state = state;

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
  currentStep = step;
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
  const account = result.identity || result.accountIdentity || result.account || result.verifier?.verifier || {};
  const relationships = result.verifier?.employees || result.employees || result.verifiableEmployees || result.relationships || result.verifierRelationships || [];
  const staged = result.history || result.personalTemplateStage || result.personalTemplate || result.stagedPersonalTemplate || result.stage;
  const accountText = `${account.name || 'Akun LLK'}${account.nip ? ` · ${account.nip}` : ''}`;

  const accountIdNode = $('#accountIdentity');
  if (accountIdNode) accountIdNode.textContent = accountText;

  const verifierReview = $('#verifierReview');
  if (verifierReview) {
    verifierReview.hidden = false;
    verifierReview.innerHTML = `<p><strong>Akun terautentikasi:</strong> ${escapeHtml(accountText)}</p><p class="field-help">Relasi verifikasi:</p>${relationships.length ? `<ul>${relationships.map(person => `<li>${escapeHtml(person.name || '—')} · ${escapeHtml(person.nip || '—')} <small>ID rute: ${escapeHtml(person.routeId || person.rowId || person.id || '—')}</small></li>`).join('')}</ul>` : '<p>Tak ada relasi pegawai ditemukan.</p>'}`;
    if (result.warning) verifierReview.innerHTML += `<p class="validation-feedback">${escapeHtml(result.warning)}</p>`;
  }

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
  const satker = employee?.satker || 'Pengadilan Negeri Natuna';
  const known = satker === 'Pengadilan Negeri Natuna';
  const select = $('#satkerSelect');
  const custom = $('#customSatker');
  if (select) select.value = known ? satker : 'other';
  if (custom) {
    custom.hidden = known;
    custom.value = known ? '' : satker;
  }
  const stageBox = $('#personalStageBox');
  if (stageBox) stageBox.hidden = true;
  const stageConfirm = $('#personalStageConfirm');
  if (stageConfirm) stageConfirm.checked = false;

  renderEmployeeList();

  const workspace = $('#workspace');
  if (workspace) workspace.hidden = false;

  const titleNode = $('#workspaceTitle');
  if (titleNode) titleNode.textContent = employee.name;

  const positionNode = $('#profilePosition');
  if (positionNode) positionNode.textContent = employee.position;
  const workTemplateSelect = $('#workTemplateSelect');
  if (workTemplateSelect && employee.department) workTemplateSelect.value = employee.department;

  const activeNameNode = $('#activeProfileName');
  if (activeNameNode) activeNameNode.textContent = `${employee.name} (${employee.nip || employee.id})`;

  const loginBadge = $('#loginBadge');
  if (loginBadge) loginBadge.textContent = 'Belum masuk';

  const auditStats = $('#auditStats');
  if (auditStats) auditStats.hidden = true;

  const previewArea = $('#previewArea');
  if (previewArea) previewArea.hidden = true;

  const reviewStep = $('#reviewStep');
  if (reviewStep) reviewStep.classList.add('is-pending');

  const reportArea = $('#reportArea');
  if (reportArea) reportArea.hidden = true;

  const confirmCheck = $('#confirmCheck');
  if (confirmCheck) confirmCheck.checked = false;

  const accountId = $('#accountIdentity');
  if (accountId) accountId.textContent = employee.accountIdentity?.name || 'Belum diverifikasi';

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

function validatePreview(preview) {
  const errors = [];
  preview.forEach(day => {
    let previousEnd = null;
    day.items.forEach((item, index) => {
      const label = `${day.date}, baris ${index + 1}`;
      if (!/^\d{2}:\d{2}$/.test(item.start) || !/^\d{2}:\d{2}$/.test(item.end) || minutes(item.start) >= minutes(item.end)) {
        errors.push(`${label}: rentang waktu tidak valid.`);
      }
      if (previousEnd !== null && minutes(item.start) !== previousEnd) {
        errors.push(`${label}: waktu harus berurutan.`);
      }
      if (!item.description.trim() || !item.result.trim()) {
        errors.push(`${label}: kegiatan dan hasil wajib diisi.`);
      }
      if (!['Utama', 'Pendukung'].includes(item.type)) {
        errors.push(`${label}: jenis tidak valid.`);
      }
      previousEnd = minutes(item.end);
    });
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
      let previousEnd = null;
      day.items.forEach(item => {
        if (!/^\d{2}:\d{2}$/.test(item.start) || !/^\d{2}:\d{2}$/.test(item.end) || minutes(item.start) >= minutes(item.end) || (previousEnd !== null && minutes(item.start) !== previousEnd) || !item.description.trim() || !item.result.trim() || !['Utama','Pendukung'].includes(item.type)) dayErrors.push(true);
        previousEnd = minutes(item.end);
      });
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

function previewSupervisor(preview){
  const day=preview?.[0]||{};
  const supervisor=day.verifier||day.supervisor||active?.verifier||active?.supervisor||{};
  return {name:String(supervisor.name||'').trim(),nip:String(supervisor.nip||supervisor.id||supervisor.routeId||'').trim()};
}

function renderPreview(preview) {
  currentPreview = preview;
  const previewArea = $('#previewArea');
  if (previewArea) previewArea.hidden = false;

  const reviewStep = $('#reviewStep');
  if (reviewStep) reviewStep.classList.remove('is-pending');

  const countNode = $('#previewCount');
  if (countNode) countNode.textContent = `${preview.length} hari`;
  const supervisor=previewSupervisor(preview);
  const supervisorBox=$('#supervisorConfirmation');
  if(supervisorBox)supervisorBox.innerHTML=supervisor.name&&supervisor.nip
    ? `<p><strong>Atasan yang akan menerima LLK:</strong><br>${escapeHtml(supervisor.name)} · NIP ${escapeHtml(supervisor.nip)}</p>`
    : '<p class="validation-feedback"><strong>Identitas atasan belum lengkap.</strong> Perbaiki profil sebelum mengirim LLK.</p>';

  const container = $('#previewCards');
  if (container) {
    container.innerHTML = preview.map((day, di) => {
      const isEditing = editDayState.has(di);
      const verifier = day.verifier || day.supervisor || active?.verifier || active?.supervisor || {};
      return `
        <article class="day-card" data-day="${di}">
          <header class="day-card-header">
            <div>
              <div class="day-title-row">
                <strong class="day-date">${escapeHtml(day.date)}</strong>
                <span class="preview-status status-ready" data-day-status="${di}">Siap</span>
              </div>
              <small class="day-meta">Atasan: ${escapeHtml(verifier.name || 'Belum diketahui')} · NIP ${escapeHtml(verifier.nip || verifier.id || verifier.routeId || '—')}</small>
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
  const isPersonal = info.source === 'personal';
  const badge = $('#personalTemplateSourceBadge');
  if (badge) {
    badge.textContent = isPersonal ? 'Personal' : 'Bagian';
    badge.className = `court-badge ${isPersonal ? 'tag-badge' : 'tag-support'}`;
  }

  const sourceText = $('#personalTemplateSourceText');
  if (sourceText) sourceText.textContent = isPersonal ? 'Riwayat LLK' : `Template Bagian (${info.fallbackLabel || active?.department || 'Default'})`;

  const fallbackText = $('#personalTemplateFallbackText');
  if (fallbackText) fallbackText.textContent = info.fallbackLabel || active?.department || '—';

  const activities = isPersonal ? (info.activities || []) : [];
  const countNode = $('#personalTemplateCount');
  if (countNode) countNode.textContent = `${activities.length} kegiatan`;

  const authAlert = $('#personalTemplateAuthAlert');
  if (authAlert) authAlert.hidden = true;

  const tbody = $('#personalTemplateBody');
  if (tbody) {
    tbody.innerHTML = activities.length ? activities.map(act => `
      <tr>
        <td><strong>${escapeHtml(act.description || act.nama)}</strong></td>
        <td>${escapeHtml(act.start || '—')} – ${escapeHtml(act.end || '—')}</td>
        <td>${escapeHtml(act.type || act.kategori || 'Utama')}</td>
        <td>${escapeHtml(act.result || act.output || '—')}</td>
        <td><small>${act.count ? `${act.count}x` : 'riwayat LLK'}</small></td>
      </tr>
    `).join('') : '<tr><td colspan="5" class="emp-pos">Belum ada template personal. Login SSO lalu impor daftar LLK.</td></tr>';
  }
}

async function loadPersonalTemplate(employeeId) {
  if (!employeeId) return;
  try {
    const info = await api(`/api/employees/${employeeId}/personal-template`);
    renderPersonalTemplate(info);
  } catch (error) {
    log(`Gagal memuat template personal: ${error.message}`);
  }
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

function setDatePreset(type) {
  const now = new Date();
  const formatDate = d => {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  let start = new Date(now);
  let end = new Date(now);

  if (type === 'today') {
    // default single day
  } else if (type === 'week') {
    const day = now.getDay();
    const diffToMonday = (day === 0 ? -6 : 1) - day;
    start.setDate(now.getDate() + diffToMonday);
    end = new Date(start);
    end.setDate(start.getDate() + 4);
  } else if (type === 'month') {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
    end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  }

  const startInput = $('#startDate');
  const endInput = $('#endDate');
  if (startInput) startInput.value = formatDate(start);
  if (endInput) endInput.value = formatDate(end);
}

// Event Listeners
function openEmployeeForm() {
  const form = $('#employeeForm');
  if (!form) return;
  form.hidden = !form.hidden;
  if (!form.hidden) {
    form.reset();
    $('#quickSsoFetchBtn').hidden = true;
    form.elements.supervisorNip?.focus();
  }
}

$('#newEmployee')?.addEventListener('click', openEmployeeForm);
$('#openVerificationScanRecorderBtn')?.addEventListener('click', () => {
  if (!active) return feedback('Pilih profil verifikator terlebih dahulu.', true);
  $('#verificationScanRecorderDialog')?.showModal();
  $('#startVerificationScanRecordingBtn').disabled = false;
  $('#finishVerificationScanRecordingBtn').disabled = true;
});

$('#startVerificationScanRecordingBtn')?.addEventListener('click', () => active && runBusy(async () => {
  const result = await api('/api/verification-scan-recording/start', {method:'POST',body:JSON.stringify({employeeId:active.id})});
  $('#startVerificationScanRecordingBtn').disabled = true;
  $('#finishVerificationScanRecordingBtn').disabled = false;
  $('#verificationScanRecorderStatus').textContent = `Merekam ${result.url}. Pilih Belum Terverifikasi dan klik Cari di Edge.`;
}, 'Mulai Rekam Pemindaian'));

$('#finishVerificationScanRecordingBtn')?.addEventListener('click', () => runBusy(async () => {
  const result = await api('/api/verification-scan-recording/finish', {method:'POST',body:'{}'});
  $('#startVerificationScanRecordingBtn').disabled = false;
  $('#finishVerificationScanRecordingBtn').disabled = true;
  $('#verificationScanRecorderStatus').textContent = `Terekam: ${result.rows} baris, ${result.requests} request.`;
  log(`Pemindaian verifikasi direkam: ${result.rows} baris.`);
}, 'Selesai Rekam Pemindaian'));


$('#openVerificationRecorderBtn')?.addEventListener('click', () => {
  if (!active) {
    feedback('Pilih profil atasan/verifikator terlebih dahulu.', true);
    return;
  }
  $('#verificationRecorderDialog')?.showModal();
});

$('#startVerificationRecordingBtn')?.addEventListener('click', () => runBusy(async () => {
  if (!active) throw new Error('Pilih profil atasan/verifikator terlebih dahulu');
  const result = await api('/api/verification-recording/start', {
    method: 'POST',
    body: JSON.stringify({ employeeId: active.id, customMessage: $('#verificationCustomMessage')?.value || '' })
  });
  verificationRecordingActive = true;
  syncControls();
  $('#verificationRecorderStatus').textContent = `Merekam sejak ${new Date(result.startedAt).toLocaleTimeString('id-ID')}. Lakukan satu verifikasi di Edge, lalu klik Selesai Rekam.`;
}, 'Mulai Rekam Verifikasi'));

$('#finishVerificationRecordingBtn')?.addEventListener('click', () => runBusy(async () => {
  const result = await api('/api/verification-recording/finish', { method: 'POST', body: '{}' });
  verificationRecordingActive = false;
  syncControls();
  $('#verificationRecorderStatus').textContent = `Rekaman selesai: ${result.url}`;
  log('Alur verifikasi LLK selesai direkam.');
}, 'Selesai Rekam Verifikasi'));
$('#previewAutomaticVerificationBtn')?.addEventListener('click', () => active && runBusy(async () => {
  const result = await api(`/api/verification/preview?employeeId=${encodeURIComponent(active.id)}`);
  verificationTargets = (result.targets || []).filter(item => item.valid !== false);
  $('#verificationTargetCount').textContent = `${result.validCount ?? verificationTargets.length} siap · ${result.invalidCount || 0} belum benar`;
  const preview = $('#verificationTargetPreview');
  preview.hidden = false;
  const allTargets = [...(result.targets || []), ...(result.invalidTargets || [])];
  preview.innerHTML = allTargets.length
    ? `<ul>${allTargets.map(item => `<li><strong>${item.valid === false ? 'BELUM BENAR' : 'SIAP'}</strong> ${escapeHtml(item.date || 'Tanggal tidak terbaca')} — ${escapeHtml(item.summary)}${item.issues?.length ? `<br><small>${escapeHtml(item.issues.join('; '))}</small>` : ''}</li>`).join('')}</ul>`
    : '<p>Tidak ada LLK dengan tag Belum Diverifikasi.</p>';
  syncControls();
}, 'Pindai Verifikasi'));

$('#runAutomaticVerificationBtn')?.addEventListener('click', () => active && runBusy(async () => {
  const message = String($('#verificationCustomMessage')?.value || '').trim();
  if (!message) throw new Error('Isi pesan custom terlebih dahulu');
  if (!verificationTargets.length) throw new Error('Pindai target terlebih dahulu');
  const result = await api('/api/verification/run', {
    method: 'POST',
    body: JSON.stringify({ employeeId: active.id, message, hllk: verificationTargets.map(item => item.hllk) })
  });
  verificationTargets = [];
  $('#verificationTargetCount').textContent = `${result.success}/${result.total} berhasil`;
  $('#verificationTargetPreview').innerHTML = `<p>${result.success} LLK berhasil diverifikasi${result.failed ? `; ${result.failed} gagal` : ''}.</p>`;
  syncControls();
  log(`Verifikasi otomatis selesai: ${result.success}/${result.total} berhasil.`);
}, 'Verifikasi Otomatis'));


async function refreshWizardVerification() {
  if (!active) return;
  const result = await api(`/api/verification/preview?employeeId=${encodeURIComponent(active.id)}`);
  verificationTargets = result.targets || [];
  const count = $('#wizardVerificationCount');
  if (count) count.textContent = `${result.total} LLK belum terverifikasi di halaman 1`;
  const preview = $('#wizardVerificationPreview');
  if (preview) preview.innerHTML = verificationTargets.length
    ? `<p><strong>${result.total} LLK anggota pada halaman 1 siap diverifikasi.</strong></p><ul>${verificationTargets.map(item => `<li><code>${escapeHtml(item.hllk)}</code> ${escapeHtml(item.summary)}</li>`).join('')}</ul>`
    : '<p>Tidak ada LLK anggota berstatus Belum Terverifikasi pada halaman 1.</p>';
  const run = $('#runWizardVerificationBtn');
  if (run) run.disabled = !verificationTargets.length;
}

document.querySelectorAll('[name="workflowMode"]').forEach(input => input.addEventListener('change', () => {
  const verify = document.querySelector('[name="workflowMode"]:checked')?.value === 'verify';
  $('#createLlkMode').hidden = verify;
  $('#verifyLlkMode').hidden = !verify;
  if (verify) runBusy(refreshWizardVerification, 'Pindai LLK Anggota');
}));

$('#refreshWizardVerificationBtn')?.addEventListener('click', () => runBusy(refreshWizardVerification, 'Pindai LLK Anggota'));

$('#runWizardVerificationBtn')?.addEventListener('click', () => active && runBusy(async () => {
  const message = String($('#wizardVerificationMessage')?.value || '').trim();
  if (!message) throw new Error('Isi pesan verifikasi terlebih dahulu');
  if (!verificationTargets.length) throw new Error('Tidak ada LLK belum diverifikasi');
  const result = await api('/api/verification/run', {
    method: 'POST',
    body: JSON.stringify({ employeeId: active.id, message, hllk: verificationTargets.map(item => item.hllk) })
  });
  log(`Verifikasi anggota selesai: ${result.success}/${result.total} berhasil.`);
  feedback(`${result.success} LLK anggota berhasil diverifikasi${result.failed ? `; ${result.failed} gagal` : ''}.`);
  await refreshWizardVerification();
}, 'Verifikasi LLK Anggota'));

function updateSatkerUi() {
  const select = $('#satkerSelect');
  const custom = $('#customSatker');
  const isOther = select?.value === 'other';
  if (custom) custom.hidden = !isOther;
}

$('#satkerSelect')?.addEventListener('change', () => {
  updateSatkerUi();
  if ($('#satkerSelect').value === 'other') $('#customSatker')?.focus();
});

async function fetchBootstrapProfile() {
  if (!bootstrapFlow) throw new Error('Buka SSO terlebih dahulu');
  const out = await api('/api/bootstrap/complete', {
    method: 'POST',
    body: JSON.stringify({ tempId: bootstrapFlow })
  });
  sessionStorage.setItem('bootstrapFlow', bootstrapFlow);
  $('#quickSsoFetchBtn').hidden = false;
  selectEmployee(out.employee);
  loginFlows.set(out.employee.id, 'review');
  const loginBadge = $('#loginBadge');
  if (loginBadge) loginBadge.textContent = 'SSO aktif';
  const loginNextBtn = $('#loginNextBtn');
  if (loginNextBtn) loginNextBtn.hidden = false;
  setWizardStep(2);
  await loadEmployees();
  const templateCount = out.history?.candidate?.activities?.length || out.history?.activities?.length || 0;
  log(`Profil ${out.employee.name} (${out.employee.nip}) dibuat dari SSO; ${templateCount} pola kegiatan diimpor. Edge tetap terbuka.`);
  feedback(`Sesi Edge tetap aktif. ${templateCount} pola kegiatan ditemukan; klik Saya sudah login untuk mengambil ulang.`);
}

$('#quickSupervisorNip')?.addEventListener('input',()=>{supervisorLookupToken=null;$('#supervisorLookupConfirm').checked=false;$('#supervisorLookupResult').hidden=true;$('#supervisorLookupConfirmRow').hidden=true;});
$('#lookupSupervisorBtn')?.addEventListener('click',()=>runBusy(async()=>{
  const nip=String($('#quickSupervisorNip')?.value||'').trim();if(!/^\d{18}$/.test(nip))throw new Error('NIP atasan langsung harus tepat 18 digit angka');
  log(`Mencari NIP ${nip} di Google Search…`);const result=await api(`/api/supervisor-lookup?nip=${encodeURIComponent(nip)}`);supervisorLookupToken=result.token;
  const box=$('#supervisorLookupResult');box.hidden=false;box.innerHTML=result.results?.length
    ? `<p><strong>5 halaman teratas Google untuk NIP ${escapeHtml(nip)}</strong></p>${result.results.map((item,index)=>`<article class="result-card"><strong>${index+1}. ${escapeHtml(item.title)}</strong><p>Nama: <strong>${escapeHtml(item.name||'tidak teridentifikasi')}</strong><br>Jabatan: <strong>${escapeHtml(item.position||'tidak teridentifikasi')}</strong><br>Satker: <strong>${escapeHtml(item.satker||'tidak teridentifikasi')}</strong></p><small>${escapeHtml(item.snippet||'Tidak ada cuplikan.')}</small><p><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">Buka sumber</a></p></article>`).join('')}<p><a href="${escapeHtml(result.sourceUrl)}" target="_blank" rel="noopener">Buka semua hasil Google</a></p>`
    : `<p><strong>NIP ${escapeHtml(nip)} tidak ditemukan pada hasil publik Google.</strong></p><p><a href="${escapeHtml(result.sourceUrl)}" target="_blank" rel="noopener">Periksa langsung di Google</a>. Jangan lanjut jika nama dan satker tidak dapat dipastikan.</p>`;
  $('#supervisorLookupConfirmRow').hidden=false;$('#supervisorLookupConfirm').checked=false;
},'Pencarian NIP Atasan'));

$('#employeeForm')?.addEventListener('submit', event => {
  event.preventDefault();
  runBusy(async () => {
    const supervisorNip = String($('#quickSupervisorNip')?.value || '').trim();
    if (!/^\d{18}$/.test(supervisorNip)) {
      $('#quickSupervisorNip')?.focus();
      throw new Error('NIP atasan langsung harus tepat 18 digit angka');
    }
    const selectedSatker = $('#satkerSelect')?.value;
    const satker = selectedSatker === 'other'
      ? $('#customSatker')?.value.trim()
      : selectedSatker;
    if (!satker) throw new Error('Masukkan satuan kerja terlebih dahulu');
    log('Membuka Edge untuk login SSO dan mengambil profil…');
    const res = await api('/api/bootstrap/login', {
      method: 'POST',
      body: JSON.stringify({ satker, supervisorNip, department: 'umum_keuangan', supervisorLookupToken, supervisorConfirmed:$('#supervisorLookupConfirm')?.checked===true })
    });
    bootstrapFlow = res.tempId;
    sessionStorage.setItem('bootstrapFlow', bootstrapFlow);
    $('#quickSsoLoginBtn').hidden = true;
    $('#quickSsoFetchBtn').hidden = false;
    log(res.message || 'Silakan selesaikan login SSO di Edge.');
    feedback('Selesaikan login SSO di Edge, lalu klik Saya sudah login. Profil dan kegiatan pada halaman pertama /llk akan dibaca otomatis.');
  }, 'Tambah Profil dari SSO');
});

$('#quickSsoFetchBtn')?.addEventListener('click', () => runBusy(fetchBootstrapProfile, 'Tarik Data Akun'));

updateSatkerUi();

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

$('#verifyBtn')?.addEventListener('click', () => active && runBusy(async () => {
  log('Memeriksa status sesi LLK…');
  const result = await api(`/api/employees/${active.id}/verify`);
  const badge = $('#loginBadge');
  if (badge) badge.textContent = result.loggedIn ? 'Login aktif' : 'Belum masuk';
  if (result.accountIdentity) {
    const accountNode = $('#accountIdentity');
    if (accountNode) accountNode.textContent = `${result.accountIdentity.name}${result.accountIdentity.nip ? ` · ${result.accountIdentity.nip}` : ''}`;
  }
  log(result.loggedIn ? 'Sesi LLK terkonfirmasi aktif.' : 'Sesi LLK belum aktif.');
}, 'Periksa Sesi'));

$('#importVerifierBtn')?.addEventListener('click', () => active && runBusy(async () => {
  log('Mengimpor relasi verifikator dari sistem LLK…');
  const verified = await api('/api/verifier');
  const result = await api('/api/verifier/import', { method: 'POST', body: JSON.stringify({ employeeId: active.id }) });
  const account = result.accountIdentity || verified.accountIdentity || verified.account || {};
  const accountNode = $('#accountIdentity');
  if (accountNode) accountNode.textContent = `${account.name || 'Akun LLK'}${account.nip ? ` · ${account.nip}` : ''}`;
  const people = result.employees || result.verifiableEmployees || verified.employees || verified.verifiableEmployees || [];
  const review = $('#verifierReview');
  if (review) {
    review.hidden = false;
    review.innerHTML = `<p><strong>Akun:</strong> ${escapeHtml(account.name || '—')}</p><p class="field-help">Pegawai terverifikasi:</p><ul>${people.map(p => `<li>${escapeHtml(p.name)} · ${escapeHtml(p.nip || '—')}</li>`).join('')}</ul>`;
  }
  await loadEmployees();
  log('Data relasi verifikator diperbarui.');
}, 'Impor Verifikator'));

$('#auditBtn')?.addEventListener('click', () => active && runBusy(async () => {
  log('Menjalankan audit riwayat LLK…');
  const r = await api(`/api/employees/${active.id}/audit`);
  const stats = $('#auditStats');
  if (stats) stats.hidden = false;
  const statTotal = $('#statTotal');
  const statUnique = $('#statUnique');
  const statDup = $('#statDup');
  if (statTotal) statTotal.textContent = r.total;
  if (statUnique) statUnique.textContent = r.unique;
  if (statDup) statDup.textContent = (r.duplicates || []).length;
  log(`Audit selesai: ${r.total} total, ${r.unique} unik, ${(r.duplicates || []).length} duplikat.`);
}, 'Audit'));

$('#confirmCheck')?.addEventListener('change', syncControls);

$('#submitBtn')?.addEventListener('click', () => runBusy(async () => {
  if (!active || !currentPreview || !validatePreview(currentPreview) || !$('#confirmCheck')?.checked) throw new Error('Centang konfirmasi sebelum mengirim ke LLK.');
  const supervisor=previewSupervisor(currentPreview);
  if(!supervisor.name||!supervisor.nip)throw new Error('Identitas nama dan NIP atasan belum lengkap. Perbaiki profil sebelum mengirim LLK.');
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

$('#reportBtn')?.addEventListener('click', () => active && runBusy(async () => {
  log('Memuat laporan pengiriman terakhir…');
  const rep = await api(`/api/employees/${active.id}/report`);
  renderReport(rep);
  log('Laporan pengiriman berhasil dimuat.');
}, 'Laporan'));

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

$('#templateDiffBtn')?.addEventListener('click', () => runBusy(async () => {
  log('Memeriksa riwayat versi template…');
  const historyResponse = await api('/api/templates/history');
  const history = Array.isArray(historyResponse) ? historyResponse : historyResponse.history || historyResponse.versions || [];
  const candidate = history.find(entry => entry.version !== templates.version && entry.departments) || history[0];
  if (!candidate?.departments) throw new Error('Tidak ada versi template lain untuk ditinjau.');
  templateStage = await api('/api/templates/diff', { method: 'POST', body: JSON.stringify({ departments: candidate.departments }) });
  templateStage.departments = candidate.departments;
  templateStage.toVersion ||= candidate.version;
  const diffBox = $('#templateDiff');
  if (diffBox) {
    diffBox.hidden = false;
    diffBox.innerHTML = `<p><strong>${escapeHtml(templateStage.fromVersion || templates.version || 'current')} → ${escapeHtml(templateStage.toVersion || 'new')}</strong></p><pre>${escapeHtml(JSON.stringify(templateStage.changes || templateStage.diff || [], null, 2))}</pre>`;
  }
  const wrap = $('#templateConfirmWrap');
  if (wrap) wrap.hidden = false;
  const chk = $('#templateConfirm');
  if (chk) chk.checked = false;
  syncControls();
  log('Diff template siap ditinjau.');
}, 'Tinjau Template'));

$('#templateConfirm')?.addEventListener('change', syncControls);

$('#templateApplyBtn')?.addEventListener('click', () => runBusy(async () => {
  if (!templateStage || !$('#templateConfirm')?.checked) throw new Error('Tinjau diff template terlebih dahulu.');
  log('Menerapkan template baru…');
  await api('/api/templates/apply', { method: 'POST', body: JSON.stringify({ departments: templateStage.departments || templates.departments || templates }) });
  templateStage = null;
  const diffBox = $('#templateDiff');
  if (diffBox) diffBox.hidden = true;
  const wrap = $('#templateConfirmWrap');
  if (wrap) wrap.hidden = true;
  await loadTemplates();
  log('Template berhasil diterapkan.');
}, 'Terapkan Template'));

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
  const initial = resolveDefaultEmployee(employees);
  if (initial) selectEmployee(initial);
  log(`Profil ${deletedId} berhasil dihapus.`);
}, 'Hapus Profil'));

$('#personalTemplateLoginBtn')?.addEventListener('click', () => $('#loginBtn')?.click());

$('#importPersonalTemplateBtn')?.addEventListener('click', () => active && runBusy(async () => {
  log(`Membaca halaman pertama daftar LLK untuk ${active.name}…`);
  const staged = await api(`/api/employees/${active.id}/personal-template/import`, { method: 'POST', body: '{}' });
  if (!staged.available) throw new Error(staged.warning || 'Daftar LLK tidak dapat dibaca');
  renderPersonalDiff(staged);
  log(`${staged.scannedEntries || 0} entri LLK dibaca dari ${staged.pagesScanned || 1} halaman (${staged.sourceUrl || '/llk'}); ${staged.candidate?.activities?.length || 0} pola unik siap ditinjau.`);
}, 'Impor Seluruh LLK'));

$('#openNavigationRecorderBtn')?.addEventListener('click', () => {
  if (!active) return feedback('Pilih profil aktif terlebih dahulu.', true);
  $('#startNavigationRecordingBtn').disabled = false;
  $('#finishNavigationRecordingBtn').disabled = true;
  $('#navigationRecorderStatus').textContent = 'Siap merekam.';
  $('#navigationRecorderDialog')?.showModal();
});

$('#startNavigationRecordingBtn')?.addEventListener('click', () => active && runBusy(async () => {
  const mode = document.querySelector('[name="navigationRecordMode"]:checked')?.value || 'llk';
  const result = await api('/api/navigation-recording/start', {method:'POST',body:JSON.stringify({employeeId:active.id,mode})});
  $('#startNavigationRecordingBtn').disabled = true;
  $('#finishNavigationRecordingBtn').disabled = false;
  $('#navigationRecorderStatus').textContent = result.message;
  log(`Perekaman navigasi ${mode} dimulai di ${result.url}.`);
}, 'Mulai Rekam Navigasi'));

$('#finishNavigationRecordingBtn')?.addEventListener('click', () => runBusy(async () => {
  const result = await api('/api/navigation-recording/finish', {method:'POST',body:'{}'});
  $('#startNavigationRecordingBtn').disabled = false;
  $('#finishNavigationRecordingBtn').disabled = true;
  $('#navigationRecorderStatus').textContent = `Terekam: ${result.clicks} klik, ${result.requests} request, ${result.tables} tabel. URL akhir: ${result.url}`;
  log(`Navigasi ${result.mode} terekam dari ${result.clicks} klik dan ${result.tables} tabel.`);
}, 'Selesai Rekam Navigasi'));

$('#personalStageConfirm')?.addEventListener('change', syncControls);

$('#cancelPersonalStageBtn')?.addEventListener('click', () => {
  personalStage = null;
  const box = $('#personalStageBox');
  if (box) box.hidden = true;
  const chk = $('#personalStageConfirm');
  if (chk) chk.checked = false;
  syncControls();
  log('Peninjauan template personal dibatalkan.');
});

$('#applyPersonalTemplateBtn')?.addEventListener('click', () => active && runBusy(async () => {
  if (!personalStage || !$('#personalStageConfirm')?.checked) {
    throw new Error('Centang konfirmasi peninjauan template personal.');
  }
  log(`Menerapkan template personal untuk ${active.name}…`);
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
  log(`Template personal untuk ${active.name} aktif.`);
  syncControls();
}, 'Terapkan Template Personal'));

async function loadHolidays() {
  try {
    holidayStore = await api('/api/holidays');
    renderHolidays();
  } catch (error) {
    log(`Gagal memuat hari libur: ${error.message}`);
  }
}

function renderHolidays() {
  const container = $('#holidayList');
  const countNode = $('#holidayCount');
  const list = Object.entries(holidayStore).flatMap(([yr, dates]) => (Array.isArray(dates) ? dates : []).map(d => ({ yr, date: d }))).sort((a,b) => a.date.localeCompare(b.date));
  if (countNode) countNode.textContent = `${list.length} hari`;
  if (!container) return;
  container.innerHTML = list.length ? list.map(item => `
    <div class="holiday-item">
      <span><strong>${escapeHtml(item.date)}</strong> <small>(${escapeHtml(item.yr)})</small></span>
      <button class="btn btn-sm btn-outline" type="button" data-del-holiday="${escapeHtml(item.date)}" data-del-year="${escapeHtml(item.yr)}">Hapus</button>
    </div>
  `).join('') : '<p class="field-help">Belum ada daftar libur.</p>';
}

async function saveHolidays(updated) {
  holidayStore = await api('/api/holidays', { method: 'POST', body: JSON.stringify(updated) });
  renderHolidays();
  log('Daftar hari libur diperbarui.');
}

$('#loginNextBtn')?.addEventListener('click', () => {
  setWizardStep(2);
  refreshWizardVerification().catch(error => log(`Pemindaian verifikasi belum tersedia: ${error.message}`));
});
document.querySelectorAll('[data-go-step]').forEach(btn => {
  btn.addEventListener('click', () => setWizardStep(Number(btn.dataset.goStep)));
});

$('#previewCards')?.addEventListener('click', event => {
  const btn = event.target.closest('[data-toggle-edit]');
  if (btn) toggleDayCardEdit(Number(btn.dataset.toggleEdit));
});
$('#previewCards')?.addEventListener('input', syncPreviewFromForm);
$('#previewCards')?.addEventListener('change', syncPreviewFromForm);

$('#holidayForm')?.addEventListener('submit', event => runBusy(async () => {
  event.preventDefault();
  const date = $('#holidayDate')?.value;
  if (!date) return;
  const year = date.slice(0, 4);
  const next = { ...holidayStore };
  next[year] = Array.from(new Set([...(next[year] || []), date])).sort();
  await saveHolidays(next);
  $('#holidayDate').value = '';
}, 'Tambah Libur'));

$('#holidayList')?.addEventListener('click', event => {
  const btn = event.target.closest('[data-del-holiday]');
  if (!btn) return;
  const date = btn.dataset.delHoliday, year = btn.dataset.delYear;
  runBusy(async () => {
    const next = { ...holidayStore };
    if (next[year]) {
      next[year] = next[year].filter(d => d !== date);
      await saveHolidays(next);
    }
  }, 'Hapus Libur');
});

$('#holidayImport')?.addEventListener('change', event => {
  const file = event.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => runBusy(async () => {
    const data = JSON.parse(reader.result);
    const next = Array.isArray(data) ? { "2026": data } : data;
    await saveHolidays(next);
  }, 'Impor Libur');
  reader.readAsText(file);
});

$('#holidayExport')?.addEventListener('click', () => downloadJson(holidayStore, 'hari-libur.json'));
$('#newSubmissionBtn')?.addEventListener('click', () => {
  const area = $('#reportArea');
  if (area) area.hidden = true;
  setWizardStep(2);
});

$('#previewBtn')?.addEventListener('click', () => active && runBusy(async () => {
  const start = $('#startDate')?.value;
  const end = $('#endDate')?.value;
  if (!start || !end) throw new Error('Tentukan tanggal mulai dan selesai.');
  const department = $('#workTemplateSelect')?.value;
  log(`Menyiapkan isian LLK dari ${start} sampai ${end} dengan template ${$('#workTemplateSelect')?.selectedOptions?.[0]?.textContent || department}…`);
  const preview = await api(`/api/employees/${active.id}/preview`, {
    method: 'POST',
    body: JSON.stringify({ start, end, department })
  });
  renderPreview(preview);
  setWizardStep(3);
  log(`Pratinjau siap: ${preview.length} hari isian.`);
}, 'Siapkan LLK'));

const origLoadApp = loadApp;
loadApp = async function() {
  await origLoadApp();
  loadHolidays().catch(() => {});
};


$('#resetPersonalTemplateBtn')?.addEventListener('click', () => active && runBusy(async () => {
  log(`Mengembalikan template ${active.name} ke default…`);
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
  log(`Template ${active.name} dikembalikan ke default.`);
  syncControls();
}, 'Reset Template Personal'));

document.addEventListener('DOMContentLoaded', () => {
  setDatePreset('today');
  loadApp().catch(error => {
    log(`Gagal inisialisasi: ${error.message}`);
    feedback(error.message, true);
  });
});
