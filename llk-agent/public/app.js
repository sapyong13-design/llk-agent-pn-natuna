let templates = {}, active = null, currentPreview = null, currentReport = null, personalStage = null, verificationStageToken = null, busy = false;
let bootstrapFlow = null, onboardingState = 'checking', sessionPollGeneration = 0;
let verificationTargets = [];
let sessionPollTimer = null;
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


function log(message, status = 'Info') {
  const box = $('#logBox');
  if (!box) return;
  const follow = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
  const safe = String(message).replace(/([?&](?:token|_token|access_token|code|state|secret|password)=)[^&\s]*/gi, '$1[disembunyikan]').replace(/((?:cookie|authorization|password|secret|csrf|token)\s*[:=]\s*)[^\r\n]+/gi, '$1[disembunyikan]');
  const stamp = new Date().toLocaleTimeString('id-ID', { hour12: false });
  if (!box.dataset.touched) { box.textContent = ''; box.dataset.touched = 'true'; }
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  for (const [className, text] of [['log-time', stamp], [`log-status log-status--${String(status).toLowerCase()}`, status], ['log-message', safe]]) {
    const cell = document.createElement('span');
    cell.className = className;
    cell.textContent = text;
    entry.append(cell, document.createTextNode(' '));
  }
  box.append(entry);
  $('#logLatest').textContent = safe;
  if (follow) box.scrollTop = box.scrollHeight;
}

function setBusy(value) {
  busy = value;
  document.body.classList.toggle('is-busy', value);
  $('#operationStatus').hidden = !value;
  if (value) $('#operationStatus').textContent = 'Proses berjalan. Tunggu sampai selesai.';
  syncControls();
}

function syncControls() {
  document.querySelectorAll('#application button, #application input, #application select, #application textarea').forEach(control => {
    control.disabled = busy;
  });

  const submitBtn = $('#submitBtn');
  const applyPersonalTemplateBtn = $('#applyPersonalTemplateBtn');

  if (submitBtn) submitBtn.disabled = busy || !currentPreview || !$('#confirmCheck')?.checked;
  const readiness = $('#sendReadiness');
  if (readiness) readiness.textContent = busy ? 'Sedang memproses. Jangan tutup aplikasi.' : !currentPreview ? 'Siapkan isian terlebih dahulu.' : $('#confirmCheck')?.checked ? 'Siap dikirim ke LLK.' : 'Centang konfirmasi untuk mengirim.';
  if (applyPersonalTemplateBtn) applyPersonalTemplateBtn.disabled = busy || !personalStage || !$('#personalStageConfirm')?.checked;
  if ($('#runWizardVerificationBtn')) $('#runWizardVerificationBtn').disabled = busy || !verificationTargets.length || !verificationStageToken;
  document.querySelectorAll('[data-calendar-date]').forEach(control => {
    const date = parseIsoDate(control.dataset.calendarDate);
    control.disabled = busy || control.dataset.calendarDate > isoDate(new Date()) || [0, 6].includes(date.getDay()) || calendarDays.has(control.dataset.calendarDate);
  });
  const onboardingLocked = busy || ['checking', 'waiting', 'completing', 'error'].includes(onboardingState);
  $('#quickSupervisorNip').disabled = onboardingLocked;
  $('#quickSsoLoginBtn').disabled = onboardingLocked;
  $('#quickSsoRetryBtn').disabled = busy || onboardingState !== 'error';
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

function recoveryMessage(error) {
  const message = String(error?.message || '');
  if (error?.status === 401 || /sesi.*(?:berakhir|kedaluwarsa)|login.*belum/i.test(message)) return 'Login SSO perlu diperbarui. Akhiri sesi, lalu login SSO lagi.';
  if (error?.status === 409 || /jadwal|pola|duplikat/i.test(message)) return 'Data LLK perlu diperiksa. Kembali ke langkah sebelumnya, periksa tanggal atau isian, lalu coba lagi.';
  if (/failed to fetch|networkerror|fetch failed/i.test(message)) return 'Aplikasi lokal tidak merespons. Pastikan LLK Agent masih terbuka, lalu muat ulang halaman.';
  return 'Coba ulangi langkah ini. Bila tetap gagal, buka Log teknis dan kirim pesan terakhirnya.';
}

const progressCursors = new Map();
async function pollOperationProgress(employeeId,signal){
  if(!employeeId)return;
  let since=progressCursors.get(employeeId)||0;
  while(!signal.aborted){
    try{
      const state=await api(`/api/progress?employeeId=${encodeURIComponent(employeeId)}&since=${since}`);
      progressCursors.set(employeeId, Math.max(since, state.sequence || 0));
      for(const event of state.events||[]){since=Math.max(since,event.sequence||0);log(`${event.message}${event.page?` (halaman ${event.page})`:''}${event.rowsFound!=null?` · ${event.rowsFound} target`:''}${event.validCount!=null?` · ${event.validCount} siap`:''}${event.invalidCount?` · ${event.invalidCount} ditahan`:''}`);}
    }catch{}
    await new Promise(resolve=>setTimeout(resolve,750));
  }
}

async function runBusy(action, operationName = 'Operasi') {
  if (busy) return;
  setBusy(true);
  feedback();
  log(operationName, 'Berjalan');
  const controller=new AbortController();
  const polling=pollOperationProgress(active?.id,controller.signal);
  try {
    const result = await action();
    log(`${operationName}: proses selesai. Periksa rincian hasil untuk status tiap LLK.`, 'Selesai');
    return result;
  } catch (error) {
    const msg = `${operationName} gagal: ${error.message}`;
    log(msg, 'Gagal');
    feedback(`${msg} ${recoveryMessage(error)}`, true);
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


async function loadApp() {
  log('Memulai LLK Agent…');
  onboardingState = 'checking';
  renderOnboarding();
  try {
    await Promise.all([loadTemplates(), loadCalendar()]);
    await resumeSession();
  } catch (error) {
    failOnboarding(error);
  }
}
function renderSessionIdentity() {
  const satker = String(active?.satker || '').trim();
  $('#satkerSelect').textContent = satker;
  $('#satkerSelect').hidden = !satker || /^satker lain(?:nya)?$/i.test(satker);
  $('#loginBadge').textContent = active ? 'Sesi aktif' : 'Belum masuk';
}
function setWizardStep(step) {
  const signedIn = Boolean(active);
  if (signedIn && !$('[name="workflowMode"]:checked')) $('[name="workflowMode"][value="create"]').checked = true;
  const verify = $('[name="workflowMode"]:checked')?.value === 'verify';
  $('#workChoices').hidden = !signedIn;
  $('#createLlkMode').hidden = verify || Boolean(currentReport);
  $('#verifyLlkMode').hidden = !verify;
  $('#workTitle').textContent = verify ? 'Verifikasi LLK Anggota' : 'Buat LLK';
  $('#workHint').textContent = verify ? 'Cari LLK anggota, periksa daftar, lalu verifikasi.' : 'Pilih tanggal, siapkan isian, lalu periksa dan kirim di halaman ini.';
  $('#stepDates').classList.toggle('is-active', signedIn && (verify || !currentReport));
  $('#reviewStep').classList.toggle('is-active', signedIn && !verify && Boolean(currentPreview || currentReport));
  syncControls();
}


function selectEmployee(employee) {
  stopSessionPolling();
  bootstrapFlow = null;
  onboardingState = 'active';
  active = employee;
  renderOnboarding();
  document.querySelectorAll('[name="workflowMode"]').forEach(input => { input.checked = false; });
  currentPreview = null;
  currentReport = null;
  personalStage = null;
  verificationTargets = []; verificationStageToken = null;
  $('#wizardVerificationPreview').innerHTML = '<p>Belum ada pemindaian untuk akun ini.</p>';
  $('#refreshWizardVerificationBtn').textContent = 'Cari LLK anggota';
  $('#refreshWizardVerificationBtn').classList.add('btn-primary');
  $('#refreshWizardVerificationBtn').classList.remove('btn-outline');
  $('#runWizardVerificationBtn').hidden = true;
  $('#wizardVerificationMessage').closest('.form-group').hidden = true;
  $('#wizardVerificationCount').textContent = 'Periksa LLK anggota dari sesi aktif.';

  const workspace = $('#workspace');
  if (workspace) workspace.hidden = false;

  const titleNode = $('#workspaceTitle');
  if (titleNode) titleNode.textContent = employee.name;

  const positionNode = $('#profilePosition');
  if (positionNode) positionNode.textContent = [employee.position, employee.nip && `NIP ${employee.nip}`].filter(Boolean).join(' · ');



  const previewArea = $('#previewArea');
  if (previewArea) previewArea.hidden = true;

  const reviewStep = $('#reviewStep');
  if (reviewStep) reviewStep.classList.add('is-pending');

  const reportArea = $('#reportArea');
  if (reportArea) reportArea.hidden = true;

  const confirmCheck = $('#confirmCheck');
  if (confirmCheck) confirmCheck.checked = false;



  renderSessionIdentity();
  loadPersonalTemplate(employee.id).catch(() => {});
  syncControls();
  setWizardStep(2);
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
  currentReport = null;
  $('#reportArea').hidden = true;
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
            <details class="day-details"${preview.length === 1 ? ' open' : ''}>
            <summary>${day.items.length} kegiatan · Lihat rincian isian</summary>
            <ul class="day-summary-list">
              ${day.items.map(item => `
                <li class="day-summary-item">
                  <span class="day-time">${escapeHtml(item.start)} – ${escapeHtml(item.end)}</span>
                  <span class="day-desc">${escapeHtml(item.description)}</span>
                  <span class="day-type-tag">${escapeHtml(item.type)}</span>
                </li>
              `).join('')}
            </ul>
            </details>
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
  setWizardStep(2);
  const reportArea = $('#reportArea');
  if (!reportArea) return;
  reportArea.hidden = false;
  $('#previewArea').hidden = true;
  const results = report.results || report.dates || [];
  const counts = results.reduce((acc, row) => {
    const state = row.status === 'awaiting_supervisor' || row.submitted || row.verified ? 'saved' : row.skipped ? 'skipped' : 'failed';
    acc[state] = (acc[state] || 0) + 1;
    return acc;
  }, {});
  const summary = $('#reportSummary');
  if (summary) summary.innerHTML = `<strong>Ringkasan:</strong> ${counts.saved || 0} tanggal tersimpan di LLK · ${counts.skipped || 0} dilewati · ${counts.failed || 0} perlu ditindaklanjuti`;
  const meta = $('#reportMeta');
  if (meta) meta.innerHTML = `<dl><div><dt>Waktu</dt><dd>${escapeHtml(report.at || '—')}</dd></div><div><dt>Profil</dt><dd>${escapeHtml(report.employee?.name || active?.name || '—')}</dd></div><div><dt>Kebijakan</dt><dd>${escapeHtml(report.duplicatePolicy || '—')}</dd></div></dl>`;
  const resultsNode = $('#reportResults');
  if (resultsNode) {
    resultsNode.innerHTML = results.length ? results.map(row => `
      <div class="result-card status-${escapeHtml(row.status === 'awaiting_supervisor' || row.submitted || row.verified ? 'verified' : row.skipped ? 'skipped' : 'failed')}">
        <div class="result-header">
          <strong>${escapeHtml(row.date)}</strong>
          <span class="tag-badge">${escapeHtml(row.statusLabel || (row.submitted || row.verified ? 'Tersimpan di LLK' : row.skipped ? 'Sudah ada' : 'Gagal'))}</span>
        </div>
        ${row.error ? `<p class="result-message">Pengiriman belum berhasil. Periksa detail sebelum mencoba kembali.</p><details class="error-details"><summary>Detail teknis</summary><pre>${escapeHtml(row.error)}</pre></details>` : `<p class="result-message">${escapeHtml(row.message || 'Tersimpan ke sistem LLK (menunggu verifikasi atasan).')}</p>`}
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
  try {
    const info = await api(`/api/employees/${employeeId}/personal-template`);
    if (active?.id === employeeId) renderPersonalTemplate(info);
  }
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
  if (currentPreview && (start !== calendarSelection.start || end !== calendarSelection.end)) {
    currentPreview = null; currentReport = null; editDayState.clear();
    $('#previewArea').hidden = true; $('#reportArea').hidden = true; $('#confirmCheck').checked = false;
    setWizardStep(2);
  }
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
  let excluded = 0, workdays = 0;
  if (calendarSelection.start) {
    const end = calendarSelection.end || calendarSelection.start;
    for (let date = parseIsoDate(calendarSelection.start); isoDate(date) <= end; date.setDate(date.getDate() + 1)) {
      if ([0, 6].includes(date.getDay()) || calendarDays.has(isoDate(date)) || isoDate(date) > today) excluded++;
      else workdays++;
    }
  }
  for (let day=1; day<=lastDay; day++) {
    const date = new Date(year,month,day), iso = isoDate(date), weekday = date.getDay();
    const official = calendarDays.get(iso), weekend = weekday===0 || weekday===6;
    const disabled = iso > today || weekend || Boolean(official);
    const selected = calendarSelection.start && iso>=calendarSelection.start && iso<=(calendarSelection.end||calendarSelection.start);
    const type = official?.type || (weekend ? 'weekend' : 'workday');
    const title = official?.label || (weekend ? (weekday===6?'Sabtu':'Minggu') : 'Hari kerja');
    cells.push(`<button type="button" class="calendar-day is-${type}${selected?' is-selected':''}${iso===calendarSelection.start?' is-start':''}${iso===calendarSelection.end?' is-end':''}" data-calendar-date="${iso}" ${disabled?'disabled':''} aria-label="${escapeHtml(`${day} ${title}${selected?', dipilih':''}`)}"><strong>${day}</strong>${official?`<small>${official.type==='collective'?'Cuti':'Libur'}</small>`:weekend?'<small>Libur</small>':''}</button>`);
  }
  grid.innerHTML = cells.join('');
  const summary = $('#calendarSummary');
  if (summary) summary.textContent = calendarSelection.start ? `${workdays} hari kerja dipilih · ${excluded} hari dilewati (nonkerja atau belum lewat). Periksa rincian pada pratinjau sebelum kirim.` : 'Pilih tanggal mulai, lalu tanggal selesai.';
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

function verificationList(items, state = 'ready') {
  if (!items.length) return '';
  const ordered = state === 'ready' ? items : [...items].sort((a, b) => Number(Boolean(a.success)) - Number(Boolean(b.success)));
  return `<ol class="verification-list">${ordered.map((item, index) => {
    const ready = state === 'ready' ? item.valid !== false : item.success;
    const label = state === 'ready' ? (ready ? 'Siap' : 'Ditahan') : (ready ? 'Berhasil' : 'Gagal');
    const fallback = state === 'ready' ? (item.issues?.join('; ') || item.summary) : (item.error || (ready ? 'Berhasil diproses.' : `HTTP ${item.status || '—'}`));
    const summary = String(item.summary || '');
    const employee = String(item.employeeName || (summary.match(/^\s*\d+\s+(.+?),\s*Tanggal Kegiatan\s*:/i) || [])[1] || '').trim();
    const activities = Array.isArray(item.activities) ? item.activities.filter(activity => activity.start || activity.end || activity.description) : [];
    const schedule = activities.length ? `<ul class="verification-schedule">${activities.map(activity => `<li><time>${escapeHtml(`${activity.start || '—'}–${activity.end || '—'}`)}</time><span>${escapeHtml(activity.description || 'Kegiatan tidak terbaca')}</span><small>${escapeHtml(activity.type || '')}</small></li>`).join('')}</ul>` : `<p class="verification-detail">${escapeHtml(fallback || 'Rincian LLK tidak tersedia.')}</p>`;
    const detail = state === 'ready'
      ? `<details class="verification-details"><summary>${activities.length ? `${activities.length} kegiatan · Lihat rincian` : 'Lihat rincian LLK'}</summary>${item.hllk ? `<code class="verification-id">ID LLK ${escapeHtml(item.hllk)}</code>` : ''}${schedule}</details>${!ready ? `<p>${escapeHtml(item.issues?.join('; ') || 'Data belum lengkap. Periksa rincian LLK.')}</p>` : ''}`
      : ready ? '<p class="verification-detail">Status Terverifikasi sudah dikonfirmasi dari LLK.</p>' : `<p class="verification-detail">Verifikasi belum berhasil dikonfirmasi. Pindai ulang untuk memeriksa status terbaru.</p><details class="error-details"><summary>Detail teknis</summary><pre>${escapeHtml(fallback)}</pre></details>`;
    return `<li class="verification-item verification-item--${ready ? 'ready' : 'failed'}"><span class="verification-number">${index + 1}</span><div class="verification-item-body"><div class="verification-item-head"><div><strong>${escapeHtml(item.date || item.hllk || 'Target tanpa tanggal')}</strong>${employee ? `<span class="verification-employee">${escapeHtml(employee)}</span>` : ''}</div><span class="verification-status">${label}</span></div>${detail}</div></li>`;
  }).join('')}</ol>`;
}
function verificationRecovery(error) {
  const loginRequired = error?.status === 401 || /kedaluwarsa|login ulang|sesi .*tidak/i.test(String(error?.message || ''));
  const title = loginRequired ? 'Sesi LLK perlu diperbarui' : 'Pemindaian belum selesai';
  const instruction = loginRequired ? 'Klik Akhiri sesi, lalu masukkan NIP atasan langsung dan login SSO kembali.' : 'Klik Pindai Ulang. Jika tetap gagal, periksa Log aktivitas.';
  return `<section class="verification-recovery verification-recovery--${loginRequired ? 'login' : 'retry'}" role="alert"><div class="verification-recovery-mark" aria-hidden="true">!</div><div><strong>${title}</strong><p>${escapeHtml(instruction)}</p></div></section>`;
}

async function refreshWizardVerification() {
  if (!active) return;
  try {
    $('#wizardVerificationMessage').closest('.form-group').hidden = false;
    $('#runWizardVerificationBtn').hidden = false;
    $('#refreshWizardVerificationBtn').textContent = 'Pindai Ulang';
    $('#wizardVerificationCount').textContent = 'Memindai LLK anggota…';
    const result = await api(`/api/verification/preview?employeeId=${encodeURIComponent(active.id)}`);
    verificationTargets = (result.targets || []).filter(item => item.valid !== false); verificationStageToken = result.stageToken || null;
    const count = $('#wizardVerificationCount');
    if (count) count.textContent = `${result.validCount ?? verificationTargets.length} LLK siap diverifikasi · filter Belum Terverifikasi berdasarkan NIP terbukti aktif`;
    const preview = $('#wizardVerificationPreview');
    const held = Array.isArray(result.invalidTargets) ? result.invalidTargets : [];
    if (preview) preview.innerHTML = `<section class="verification-command"><div class="verification-filter verification-filter--active"><span>Filter aktif</span><strong>Belum Terverifikasi</strong><span>berdasarkan NIP</span></div>${verificationTargets.length ? `<div class="verification-summary"><strong>${verificationTargets.length}</strong><span>LLK siap diverifikasi</span></div>${verificationList(verificationTargets)}` : '<p class="verification-empty">Tidak ada LLK anggota berstatus Belum Terverifikasi.</p>'}${held.length ? `<div class="verification-held"><strong>${held.length} LLK ditahan</strong><span>Belum lolos pemeriksaan sebelum verifikasi.</span></div>${verificationList(held)}` : ''}</section>`;
    $('#runWizardVerificationBtn').disabled = !verificationTargets.length;
    $('#runWizardVerificationBtn').hidden = !verificationTargets.length;
    $('#wizardVerificationMessage').closest('.form-group').hidden = !verificationTargets.length;
    $('#runWizardVerificationBtn').textContent = `Verifikasi ${verificationTargets.length} LLK`;
    $('#refreshWizardVerificationBtn').classList.toggle('btn-primary', !verificationTargets.length);
    $('#refreshWizardVerificationBtn').classList.toggle('btn-outline', Boolean(verificationTargets.length));
  } catch (error) {
    verificationTargets = []; verificationStageToken = null;
    $('#runWizardVerificationBtn').disabled = true;
    $('#runWizardVerificationBtn').hidden = true;
    $('#wizardVerificationMessage').closest('.form-group').hidden = true;
    const count = $('#wizardVerificationCount'); if (count) count.textContent = 'Verifikasi belum dapat dimulai';
    const preview = $('#wizardVerificationPreview'); if (preview) preview.innerHTML = verificationRecovery(error);
    throw error;
  }
}

document.querySelectorAll('[name="workflowMode"]').forEach(input => input.addEventListener('change', () => setWizardStep(2)));
$('#refreshWizardVerificationBtn')?.addEventListener('click', () => runBusy(refreshWizardVerification, 'Pindai LLK Anggota'));
$('#runWizardVerificationBtn')?.addEventListener('click', () => active && runBusy(async () => {
  const message = String($('#wizardVerificationMessage')?.value || '').trim();
  if (!message) throw new Error('Isi pesan verifikasi terlebih dahulu');
  if (!verificationTargets.length || !verificationStageToken) throw new Error('Pindai ulang sebelum verifikasi');
  const targets = verificationTargets;
  const result = await api('/api/verification/run', {method: 'POST',body: JSON.stringify({ employeeId: active.id, message, stageToken: verificationStageToken, hllk: targets.map(item => item.hllk) })});
  verificationTargets = []; verificationStageToken = null;
  log(`Verifikasi anggota selesai: ${result.success}/${result.total} berhasil.`);
  feedback(`${result.success} LLK berhasil diverifikasi · ${result.failed || 0} gagal.${result.failed ? ' Periksa detail hasil, lalu pindai ulang sisa target.' : ''}`, Boolean(result.failed));
  $('#wizardVerificationCount').textContent=`${result.success}/${result.total} selesai${result.failed?`; ${result.failed} gagal`:''}. Pindai ulang hanya jika ingin melihat sisa target.`;
  $('#wizardVerificationPreview').innerHTML=`<p class="verification-result-summary"><strong>${result.success} berhasil · ${result.failed || 0} gagal</strong><br>Pindai ulang untuk memeriksa status terbaru. Tidak ada pengiriman ulang otomatis.</p>${verificationList(result.results.map(row => ({...targets.find(target => target.hllk === row.hllk), ...row})), 'result')}`;
  $('#runWizardVerificationBtn').disabled=true;
  $('#wizardVerificationMessage').closest('.form-group').hidden = true;
  $('#runWizardVerificationBtn').hidden = true;
  $('#refreshWizardVerificationBtn').textContent = 'Periksa sisa LLK';
  $('#refreshWizardVerificationBtn').classList.add('btn-primary');
  $('#refreshWizardVerificationBtn').classList.remove('btn-outline');
}, 'Verifikasi LLK Anggota'));
function renderOnboarding() {
  $('#employeeForm').hidden = Boolean(active);
  $('#workspace').hidden = !active;
  $('#endSessionBtn').hidden = !active && !bootstrapFlow && onboardingState !== 'error';
  $('#quickSsoLoginBtn').hidden = onboardingState !== 'idle';
  $('#quickSsoRetryBtn').hidden = onboardingState !== 'error';
  $('#onboardingStatus').textContent = onboardingState === 'waiting'
    ? 'Selesaikan login SSO di Edge. Identitas dan kegiatan LLK akan dibaca otomatis.'
    : onboardingState === 'completing' ? 'Login terdeteksi. Memeriksa identitas, atasan langsung, dan kegiatan LLK…'
    : onboardingState === 'checking' ? 'Memeriksa sesi…'
    : onboardingState === 'error' ? 'Proses berhenti. Klik Coba lagi untuk melanjutkan, atau Akhiri sesi untuk login ulang.'
    : 'Masukkan NIP atasan langsung, lalu klik Login SSO.';
  if (!active) $('#loginBadge').textContent = onboardingState === 'waiting' ? 'Menunggu SSO' : onboardingState === 'completing' ? 'Memverifikasi' : 'Belum masuk';
  syncControls();
}

function stopSessionPolling() {
  clearTimeout(sessionPollTimer);
  sessionPollTimer = null;
  sessionPollGeneration++;
}

function failOnboarding(error) {
  stopSessionPolling();
  onboardingState = 'error';
  renderOnboarding();
  log(`Login berhenti: ${error.message}`, 'Gagal');
  feedback(`${error.message} Klik Coba lagi untuk melanjutkan pemeriksaan. Untuk login ulang, klik Akhiri sesi.`, true);
}

async function fetchBootstrapProfile() {
  if (!bootstrapFlow || onboardingState === 'completing') return;
  stopSessionPolling();
  onboardingState = 'completing';
  renderOnboarding();
  await runBusy(async () => {
    try {
      const out = await api('/api/bootstrap/complete', {
        method: 'POST', body: JSON.stringify({ tempId: bootstrapFlow })
      });
      selectEmployee(out.employee);
      const templateCount = out.history?.candidate?.activities?.length || out.history?.activities?.length || 0;
      log(`Sesi ${out.employee.name} (${out.employee.nip}) aktif; ${templateCount} pola kegiatan dibaca.`);
      feedback(`SSO aktif. ${templateCount} pola kegiatan ditemukan.`);
    } catch (error) {
      failOnboarding(error);
    }
  }, 'Membaca data LLK');
}

async function resumeSession() {
  stopSessionPolling();
  const generation = sessionPollGeneration;
  const status = await api('/api/session');
  if (generation !== sessionPollGeneration) return;
  if (status.employee) { selectEmployee(status.employee); return; }
  bootstrapFlow = status.pending?.tempId || null;
  onboardingState = bootstrapFlow ? 'waiting' : 'idle';
  renderOnboarding();
  if (!bootstrapFlow) return;
  if (status.pending.authenticated) { await fetchBootstrapProfile(); return; }
  const poll = async () => {
    if (generation !== sessionPollGeneration) return;
    if (busy) { sessionPollTimer = setTimeout(poll, 1500); return; }
    try {
      const next = await api('/api/session');
      if (generation !== sessionPollGeneration) return;
      if (next.employee) { selectEmployee(next.employee); return; }
      if (next.pending?.tempId !== bootstrapFlow) throw new Error('Sesi login telah berakhir. Akhiri sesi, lalu login SSO kembali.');
      if (next.pending.authenticated) { await fetchBootstrapProfile(); return; }
      sessionPollTimer = setTimeout(poll, 1500);
    } catch (error) {
      if (generation === sessionPollGeneration) failOnboarding(error);
    }
  };
  sessionPollTimer = setTimeout(poll, 1500);
}

$('#employeeForm').addEventListener('submit', event => {
  event.preventDefault();
  if (onboardingState !== 'idle') return;
  runBusy(async () => {
    const supervisorNip = $('#quickSupervisorNip').value.trim();
    if (!/^\d{18}$/.test(supervisorNip)) throw new Error('NIP atasan langsung harus tepat 18 digit angka');
    try {
      const result = await api('/api/bootstrap/login', {
        method: 'POST', body: JSON.stringify({ supervisorNip, department: 'umum_keuangan' })
      });
      bootstrapFlow = result.tempId;
      onboardingState = 'waiting';
      renderOnboarding();
      log(result.message || 'Selesaikan login SSO di Edge.');
    } catch (error) {
      failOnboarding(error);
    }
  }, 'Login SSO').then(() => {
    if (onboardingState === 'waiting') resumeSession().catch(failOnboarding);
  });
});

$('#quickSsoRetryBtn').addEventListener('click', () => {
  if (!busy && onboardingState === 'error') loadApp();
});

$('#endSessionBtn').addEventListener('click', () => {
  if (busy) return;
  if ((currentPreview && !currentReport || calendarSelection.start && active || $('#wizardVerificationMessage').value.trim())
    && !window.confirm('Akhiri sesi akan menghapus draf tanggal, isian, dan pesan yang belum dikirim. Lanjutkan?')) return;
  runBusy(async () => {
    stopSessionPolling();
    try {
      await api('/api/session/end', { method: 'POST', body: '{}' });
    } catch (error) {
      if (!active) failOnboarding(error);
      else throw error;
      return;
    }
    active = null;
    bootstrapFlow = null;
    currentPreview = null;
    currentReport = null;
    personalStage = null;
    verificationTargets = [];
    verificationStageToken = null;
    progressCursors.clear();
    editDayState.clear();
    updateCalendarSelection(null, null);
    $('#employeeForm').reset();
    $('#wizardVerificationMessage').value = '';
    $('#previewCards').textContent = '';
    $('#reportResults').textContent = '';
    $('#personalStageDiffBody').textContent = '';
    $('#personalStageBox').hidden = true;
    $('#personalStageConfirm').checked = false;
    renderPersonalTemplate({});
    $('#workspaceTitle').textContent = 'Belum ada sesi';
    $('#profilePosition').textContent = 'Masuk dengan akun SSO untuk mulai';
    $('#satkerSelect').textContent = '';
    $('#satkerSelect').hidden = true;
    onboardingState = 'idle';
    renderOnboarding();
    feedback('Sesi diakhiri. Masukkan NIP atasan langsung untuk login kembali.');
  }, 'Akhiri sesi').then(() => { if (!active && onboardingState === 'idle') $('#quickSupervisorNip').focus(); });
});



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

$('#previewCards')?.addEventListener('click', event => {
  const btn = event.target.closest('[data-toggle-edit]');
  if (btn) toggleDayCardEdit(Number(btn.dataset.toggleEdit));
});
$('#previewCards')?.addEventListener('input', syncPreviewFromForm);
$('#previewCards')?.addEventListener('change', syncPreviewFromForm);

$('#newSubmissionBtn')?.addEventListener('click', () => {
  const area = $('#reportArea');
  if (area) area.hidden = true;
  currentPreview = null; currentReport = null; editDayState.clear();
  $('#previewArea').hidden = true;
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
  renderPreview(preview);
  setWizardStep(3);
  $('#previewArea').scrollIntoView({ block: 'start', behavior: 'smooth' });
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
      const isDark = theme === 'dark';
      const nextLabel = isDark ? 'Aktifkan mode terang' : 'Aktifkan mode gelap';
      btn.setAttribute('aria-label', nextLabel);
      btn.setAttribute('title', nextLabel);
      btn.setAttribute('aria-pressed', String(isDark));
      const visibleLabel = btn.querySelector('.theme-toggle-label');
      if (visibleLabel) visibleLabel.textContent = isDark ? 'Terang' : 'Gelap';
    }
  }

  const btn = document.getElementById('themeToggleBtn');
  if (!btn) return;
  applyTheme(currentTheme);

  btn.addEventListener('click', function () {
    applyTheme(currentTheme === 'dark' ? 'light' : 'dark');
  });
})();