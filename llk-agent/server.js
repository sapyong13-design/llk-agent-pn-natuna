import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { readFile, writeFile, rename, mkdir, appendFile, chmod } from 'node:fs/promises';
import { join, resolve, extname, relative, isAbsolute } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { LlkHttp } from './llk-http.mjs';
import { readProfile, resolveSupervisor, openCreate, readEntries } from './llk-read.mjs';
import { scanVerification, verifyBatch } from './llk-verification.mjs';
import { CasAuth } from './cas-auth.mjs';

const ROOT = resolve(import.meta.dirname);
const PUBLIC = join(ROOT, 'public');
const DATA = join(ROOT, 'data');
const PORT = Number(process.env.PORT || 4545);
const LLK_BASE = 'https://llk.mahkamahagung.go.id';
const sensitiveKeys = /password|cookie|csrf|token|secret|authorization/i;
// Kalender libur SKB 3 Menteri 2026 (17 libur nasional + 8 cuti bersama).
const SKB_2026_DAYS = [
  {date:'2026-01-01',type:'national',label:'Tahun Baru 2026 Masehi'},
  {date:'2026-01-16',type:'national',label:'Isra Mikraj Nabi Muhammad SAW'},
  {date:'2026-02-16',type:'collective',label:'Cuti bersama Tahun Baru Imlek 2577 Kongzili'},
  {date:'2026-02-17',type:'national',label:'Tahun Baru Imlek 2577 Kongzili'},
  {date:'2026-03-18',type:'collective',label:'Cuti bersama Hari Suci Nyepi'},
  {date:'2026-03-19',type:'national',label:'Hari Suci Nyepi, Tahun Baru Saka 1948'},
  {date:'2026-03-20',type:'collective',label:'Cuti bersama Hari Raya Idul Fitri 1447 H'},
  {date:'2026-03-21',type:'national',label:'Hari Raya Idul Fitri 1447 H'},
  {date:'2026-03-22',type:'national',label:'Hari Raya Idul Fitri 1447 H'},
  {date:'2026-03-23',type:'collective',label:'Cuti bersama Hari Raya Idul Fitri 1447 H'},
  {date:'2026-03-24',type:'collective',label:'Cuti bersama Hari Raya Idul Fitri 1447 H'},
  {date:'2026-04-03',type:'national',label:'Wafat Yesus Kristus'},
  {date:'2026-04-05',type:'national',label:'Hari Kebangkitan Yesus Kristus (Paskah)'},
  {date:'2026-05-01',type:'national',label:'Hari Buruh Internasional'},
  {date:'2026-05-14',type:'national',label:'Kenaikan Yesus Kristus'},
  {date:'2026-05-15',type:'collective',label:'Cuti bersama Kenaikan Yesus Kristus'},
  {date:'2026-05-27',type:'national',label:'Hari Raya Idul Adha 1447 H'},
  {date:'2026-05-28',type:'collective',label:'Cuti bersama Idul Adha 1447 H'},
  {date:'2026-05-31',type:'national',label:'Hari Raya Waisak 2570 BE'},
  {date:'2026-06-01',type:'national',label:'Hari Lahir Pancasila'},
  {date:'2026-06-16',type:'national',label:'1 Muharam 1448 H / Tahun Baru Islam'},
  {date:'2026-08-17',type:'national',label:'Hari Proklamasi Kemerdekaan'},
  {date:'2026-08-25',type:'national',label:'Maulid Nabi Muhammad SAW'},
  {date:'2026-12-24',type:'collective',label:'Cuti bersama Kelahiran Yesus Kristus'},
  {date:'2026-12-25',type:'national',label:'Kelahiran Yesus Kristus'}
];
function getHolidays() {
  return new Set(SKB_2026_DAYS.map(day=>day.date));
}

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const bad = message => { throw new HttpError(400, message); };
const json = (res, status, data, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers }); res.end(JSON.stringify(data)); };
const SESSION_COOKIE = 'llk-session';
const VERIFICATION_STAGE_TTL = 10 * 60_000;
const templateFile = app => join(app.dataDir, 'department-templates.json');
const reportFile = (app, id) => join(app.dataDir, `report-${id}.json`);
function sessionCookie(res, token, app) {
  const name = app.publicOrigin ? '__Host-llk-session' : SESSION_COOKIE;
  res.setHeader('Set-Cookie', `${name}=${token}; HttpOnly; SameSite=Strict; Path=/${app.publicOrigin ? '; Secure' : ''}${token ? '' : '; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT'}`);
}
function cookieToken(req, app) {
  const name = app.publicOrigin ? '__Host-llk-session' : SESSION_COOKIE;
  const tokens = String(req.headers.cookie || '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
  if (tokens.length !== 1) return null;
  const token = tokens[0].slice(name.length + 1);
  return /^[a-f0-9]{64}$/.test(token) ? token : null;
}
function assertSession(session) {
  if (session.closed) throw new HttpError(401, 'Sesi pegawai tidak aktif. Login SSO diperlukan.');
}
function disposeSession(session) {
  if (session.closed) return;
  session.closed = true;
  clearTimeout(session.timer);
  session.app.sessions.delete(session.token);
  for (const id of session.stagedVerification.keys()) closeVerificationStage(session, id);
  for (const [id, flow] of session.loginFlows) closeLoginFlow(session, id, flow);
  closeResource(session.client);
  session.client = null;
  session.employee = null;
  session.locks.clear();
  session.personalTemplates.clear();
  session.calendarEntries.clear();
  session.stagedPersonal.clear();
  session.operationProgress.clear();
}
function expireSession(session) {
  session.expiring = true;
  clearTimeout(session.timer);
  if (!session.requests) disposeSession(session);
}
function touchSession(session) {
  clearTimeout(session.timer);
  session.expires = Date.now() + session.app.sessionTtlMs;
  session.timer = setTimeout(() => expireSession(session), session.app.sessionTtlMs);
  session.timer.unref();
}
function closeResource(resource) {
  try { Promise.resolve(resource?.close()).catch(() => console.error('Penutupan sesi HTTP/SSO gagal.')); }
  catch { console.error('Penutupan sesi HTTP/SSO gagal.'); }
}
function requestSession(app, req, res, create = false) {
  let session = app.sessions.get(cookieToken(req, app));
  if (session && (session.closed || session.expiring || session.expires <= Date.now())) {
    expireSession(session);
    session = null;
  }
  if (!session) {
    if (!create) throw new HttpError(401, 'Sesi pegawai tidak aktif. Login SSO diperlukan.');
    if (app.publicOrigin) {
      if (app.sessions.size >= app.limits.maxSessions) throw rateError(app.sessionTtlMs);
      consumeIpBudget(app, req.clientIp, 'sessions', app.limits.newSessionsPerIp);
    }
    session = { app, token: randomBytes(32).toString('hex'), employee: null, client: null, busy: false, requests: 0, closed: false, expiring: false,
      locks: new Set(), stagedPersonal: new Map(), personalTemplates: new Map(), calendarEntries: new Map(), operationProgress: new Map(), loginFlows: new Map(), stagedVerification: new Map() };
    app.sessions.set(session.token, session);
    sessionCookie(res, session.token, app);
  }
  assertSession(session);
  session.requests++;
  touchSession(session);
  return session;
}
function releaseSession(session) {
  session.requests--;
  if (session.expires <= Date.now()) expireSession(session);
  if (session.expiring) {
    if (!session.requests) disposeSession(session);
  } else if (!session.closed) touchSession(session);
}
function rotateSession(session, res) {
  assertSession(session);
  if (session.expiring) throw new HttpError(401, 'Sesi login berakhir.');
  session.app.sessions.delete(session.token);
  session.token = randomBytes(32).toString('hex');
  session.app.sessions.set(session.token, session);
  sessionCookie(res, session.token, session.app);
}
function progress(session,id,stage,message,detail={}){if(session.closed||session.expiring)return;const current=session.operationProgress.get(id)||{sequence:0,events:[]};const event={sequence:++current.sequence,at:new Date().toISOString(),stage,message,...sanitize(detail)};current.events.push(event);if(current.events.length>100)current.events.shift();current.active=!['complete','error'].includes(stage);current.latest=event;session.operationProgress.set(id,current);return event;}
function progressState(session,id,since=0){const current=session.operationProgress.get(id)||{sequence:0,events:[],active:false,latest:null};return {active:current.active,sequence:current.sequence,latest:current.latest,events:current.events.filter(event=>event.sequence>since)};}
function closeVerificationStage(session,id){const stage=session.stagedVerification.get(id);if(!stage)return;clearTimeout(stage.timer);session.stagedVerification.delete(id);}
function stageVerification(session,id,targets,filter){assertSession(session);if(session.expiring)throw new HttpError(401,'Sesi login berakhir.');closeVerificationStage(session,id);const token=randomBytes(16).toString('hex'),stage={token,targets,filter,expires:Date.now()+VERIFICATION_STAGE_TTL};stage.timer=setTimeout(()=>closeVerificationStage(session,id),VERIFICATION_STAGE_TTL);stage.timer.unref();session.stagedVerification.set(id,stage);return stage;}
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
async function saveJson(path, data) {
  const temp = `${path}.${randomBytes(16).toString('hex')}.tmp`;
  await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, path);
}
const bodyJson = req => req.parsedBodyPromise || new Promise((done, reject) => {
  const chunks = [];
  let bytes = 0, settled = false;
  req.on('data', chunk => {
    if (settled) return;
    bytes += chunk.length;
    if (bytes > (req.bodyLimit || 1_000_000)) { settled = true; chunks.length = 0; reject(new HttpError(413, 'Payload terlalu besar')); return; }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (settled) return;
    try { const body = Buffer.concat(chunks, bytes).toString('utf8'); done(body ? JSON.parse(body) : {}); }
    catch { reject(new HttpError(400, 'JSON tidak valid')); }
  });
  req.on('error', reject);
  req.on('aborted', () => reject(new HttpError(400, 'Permintaan terputus')));
});
const employeeId = nip => String(nip || '').replace(/\D/g, '');
const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const isBreakActivity = value => /^(?:istirahat(?:\s+(?:siang|makan|shalat|makan\s+siang))?|ishoma(?:\s+dan\s+shalat)?|istirahat\s*,?\s*shalat(?:\s+dan\s+makan)?)(?:\s*[-–—].*)?$/i.test(clean(value));
function safeId(value) { const id=String(value||''); if(!/^[A-Za-z0-9_-]{1,80}$/.test(id)) bad('ID pegawai tidak valid'); return id; }
function canonical(value) { if(Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; if(value&&typeof value==='object') return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`; return JSON.stringify(value); }
function sanitize(value) { if(Array.isArray(value)) return value.map(sanitize); if(value&&typeof value==='object'){const out={}; for(const [key,item] of Object.entries(value)) if(!sensitiveKeys.test(key)) out[key]=sanitize(item); return out;} return typeof value==='string'?clean(value).slice(0,500):value; }
async function audit(app, event, actor, payload, result={}) { const safe=sanitize(payload), record={timestamp:new Date().toISOString(),event:clean(event),actorProfile:clean(actor||'local'),counts:sanitize(result.counts||{}),result:sanitize(result.result||result),payloadDigest:createHash('sha256').update(canonical(safe)).digest('hex')}; await appendFile(join(app.dataDir,'audit.jsonl'),`${JSON.stringify(record)}\n`,{encoding:'utf8',mode:0o600}); }
const localIso = date => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
function parseDate(value, label = 'Tanggal') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) bad(`${label} tidak valid`);
  const [y, m, d] = value.split('-').map(Number), date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) bad(`${label} tidak valid`);
  return date;
}
function validateRange(start, end) {
  const first = parseDate(start, 'Tanggal mulai'), last = parseDate(end, 'Tanggal akhir'), today = parseDate(localIso(new Date()));
  if (first > last) bad('Tanggal mulai harus sebelum tanggal akhir');
  if (last > today) bad('Tanggal mendatang tidak diizinkan');
  if (Math.round((last - first) / 86400000) + 1 > 31) bad('Rentang maksimum 31 hari kalender');
  return { first, last };
}
async function workdays(start, end) {
  const { first, last } = validateRange(start, end), holidays = getHolidays(), days = [];
  for (const date = new Date(first); date <= last; date.setDate(date.getDate() + 1)) {
    const iso = localIso(date), dow = date.getDay();
    if (dow && dow !== 6 && !holidays.has(iso)) days.push({ iso, dow });
  }
  return days;
}
async function getEmployees(session) { assertSession(session); return session.employee ? [session.employee] : []; }
async function findEmployee(session,id) { assertSession(session); if (!session.employee || session.employee.id !== id) throw new HttpError(401, 'Sesi pegawai tidak aktif. Login SSO diperlukan.'); return session.employee; }
async function withLock(session,id,task) {
  await findEmployee(session,id);
  if (session.busy || session.locks.size) throw new HttpError(409, 'Operasi sesi sedang berjalan');
  session.locks.add(id); try { return await task(); } finally { session.locks.delete(id); }
}
async function employeeClient(session,id) { await findEmployee(session,id); if(!session.client)throw new HttpError(401,'Sesi HTTP tidak aktif. Login ulang.');return session.client; }
function closeLoginFlow(session,id,flow = session.loginFlows.get(id)) {
  if (!flow || flow.closing) return false;
  flow.closing = true; clearTimeout(flow.timer); session.loginFlows.delete(id);
  closeResource(flow.auth);
  closeResource(flow.client);
  return true;
}
function currentSession(session) {
  const pending = [...session.loginFlows.entries()].find(([, flow]) => !flow.closing && !flow.closed);
  return { employee: session.employee, pending: pending ? { tempId: pending[0], stage: pending[1].auth.state.stage, authenticated: pending[1].auth.state.stage === 'authenticated' } : null };
}
const SCHEDULE_PATTERNS = {
  full: { blocks: day => day.dow === 5 ? [['08:00', '17:00']] : [['08:00', '16:30']] },
  split: { blocks: day => day.dow === 5 ? [['08:00', '12:00'], ['13:30', '17:00']] : [['08:00', '12:00'], ['13:00', '16:30']] }
};
function officialSchedule(day, pattern) {
  return SCHEDULE_PATTERNS[pattern].blocks(day);
}
function inferSchedulePattern(day, priorEntries) {
  const patterns = new Set();
  const groups = new Map();
  for (const entry of priorEntries || []) {
    const key = entry.date || entry.rawDate || '';
    if (!key) continue;
    const entries = groups.get(key) || [];
    entries.push(entry);
    groups.set(key, entries);
  }
  for (const [key, entries] of groups) {
    const entryDay = /^\d{4}-\d{2}-\d{2}$/.test(key) ? new Date(`${key}T00:00:00`).getDay() : null;
    if (entryDay !== day.dow) continue;
    const work = entries.filter(entry => !entry.isBreak).map(entry => [entry.start, entry.end]);
    const split = officialSchedule(day, 'split'), full = officialSchedule(day, 'full');
    if (JSON.stringify(work) === JSON.stringify(split)) patterns.add('split');
    if (JSON.stringify(work) === JSON.stringify(full)) patterns.add('full');
  }
  if (patterns.size === 1) return [...patterns][0];
  return 'split';
}
async function generatePreview(app, employee, start, end, source = 'page', department, pageActivities = [], priorEntries = []) {
  if (!employee) throw new HttpError(404, 'Pegawai tidak ditemukan');
  const stored = await readJson(templateFile(app)), templates = stored.departments || stored;
  const selectedDepartment = clean(department) || employee.department;
  if (!templates[selectedDepartment]) bad('Template bagian tidak tersedia');
  const useGeneral = source === 'general';
  const activities = useGeneral ? templates[selectedDepartment].activities : pageActivities;
  if (!activities?.length) bad(useGeneral ? 'Template umum bagian ini belum memiliki kegiatan' : 'Halaman terbaru LLK belum memiliki kegiatan. Pilih Template umum sebagai sumber alternatif.');
  let index = 0;
  return (await workdays(start, end)).map(day => {
    const schedulePattern = inferSchedulePattern(day, priorEntries);
    const activityItem = (activity, start, end) => ({ description: activity.nama || activity.description, type: activity.kategori || activity.type || 'Pendukung', result: 'Selesai', start, end });
    let items;
    if (schedulePattern === 'full') {
      const [[start, end]] = officialSchedule(day, 'full');
      items = [activityItem(activities[index++ % activities.length], start, end)];
    } else {
      const [[morningStart, morningEnd], [afternoonStart, afternoonEnd]] = officialSchedule(day, 'split');
      items = [
        activityItem(activities[index++ % activities.length], morningStart, morningEnd),
        { start: morningEnd, end: afternoonStart, description: 'Istirahat', type: 'Pendukung', result: 'Selesai' },
        activityItem(activities[index++ % activities.length], afternoonStart, afternoonEnd)
      ];
    }
    return { date: day.iso, supervisor: employee.supervisor, activitySource: useGeneral ? 'template-general' : 'llk-latest-page', schedulePattern, items };
  });
}
function minute(value) { if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) bad('Jam kegiatan tidak valid'); const [h,m] = value.split(':').map(Number); return h * 60 + m; }
async function validatePreview(preview) {
  if (!Array.isArray(preview) || !preview.length || preview.length > 31) bad('Preview wajib berisi kegiatan');
  const seen = new Set(), holidays = getHolidays();
  return preview.map((day, dayIndex) => {
    if (!day || typeof day !== 'object' || seen.has(day.date)) bad('Tanggal preview duplikat atau tidak valid'); seen.add(day.date);
    const date = parseDate(day.date), iso = localIso(date), dow = date.getDay();
    if (iso !== day.date || dow === 0 || dow === 6 || holidays.has(iso)) bad(`Tanggal ${day.date} bukan hari kerja`);
    const allowedPatterns = dow === 5
      ? [[['08:00', '17:00']], [['08:00', '12:00'], ['12:00', '13:30'], ['13:30', '17:00']]]
      : [[['08:00', '16:30']], [['08:00', '12:00'], ['12:00', '13:00'], ['13:00', '16:30']]];
    const items = day.items.map((item, itemIndex) => {
      if (!item || typeof item !== 'object') bad(`Baris ${itemIndex + 1} tidak valid`);
      const start = clean(item.start), end = clean(item.end), from = minute(start), to = minute(end);
      const description = clean(item.description), type = clean(item.type), result = clean(item.result);
      if (to <= from || !description || description.length > 2000 || !result || result.length > 500 || !['Utama','Pendukung'].includes(type)) bad(`Susunan waktu/kegiatan ${day.date} tidak valid`);
      return { start, end, description, type, result };
    });
    const actualBlocks = items.map(item => [item.start, item.end]);
    if (!allowedPatterns.some(pattern => JSON.stringify(pattern) === JSON.stringify(actualBlocks))) bad(`Jadwal ${day.date} harus memakai pola kerja resmi`);
    if (items.length === 3 && (items[1].description !== 'Istirahat' || items[1].type !== 'Pendukung')) bad(`Baris tengah ${day.date} harus berupa Istirahat`);
    return { date: iso, items };
  });
}
function cacheCalendarEntries(session,id,entries) {
  const snapshot = { dates: entries.dates || [...new Set(entries.map(entry => entry.date).filter(Boolean))].sort(), scope:'all-pages', available:entries.available === true, complete:entries.complete === true, pagesScanned:entries.pagesScanned, fetchedAt:new Date().toISOString() };
  if(!snapshot.available||!snapshot.complete)throw new HttpError(502,'Pemindaian seluruh LLK belum lengkap. Tanggal kosong belum dapat dipastikan.');
  if(id&&!session.closed&&!session.expiring)session.calendarEntries.set(id,snapshot);return snapshot;
}
async function scrapeEntries(session,client,id=session.employee?.id) {
  try{const entries=await readEntries(client,{scope:'all',progress:(stage,message,detail)=>progress(session,id,stage,message,detail)});cacheCalendarEntries(session,id,entries);return entries;}
  catch(error){if(id)session.calendarEntries.delete(id);throw error;}
}
function submissionResponseInfo(response) {
  const headers=Object.fromEntries(response.headers),mediaType=String(headers['content-type']||'').split(';',1)[0].trim().toLowerCase();
  const info={status:response.status,contentType:['text/html','application/json','text/plain'].includes(mediaType)?mediaType:'other',redirect:'none'};
  if (headers.location) {
    try {
      const target = new URL(headers.location, LLK_BASE);
      info.redirect = target.origin !== LLK_BASE ? 'external' : /^\/llk\/?$/.test(target.pathname) ? 'llk-list' : /^\/llk\/create\/?$/.test(target.pathname) ? 'llk-create' : /\/(?:login|sso|auth)(?:\/|$)/i.test(target.pathname) ? 'authentication' : 'other';
    } catch { info.redirect = 'invalid'; }
  }
  return info;
}
async function submitPreview(session, id, rawPreview, policy) {
  const preview = await validatePreview(rawPreview); if (!['skip','abort'].includes(policy)) bad('duplicatePolicy harus skip atau abort');
  const employee=await findEmployee(session,id),client=await employeeClient(session,id),report={at:new Date().toISOString(),employee:{id:employee.id,name:employee.name},duplicatePolicy:policy,results:[]},path=reportFile(session.app,randomBytes(16).toString('hex'));
    const existingEntries=await scrapeEntries(session,client),existingDates=new Set(existingEntries.dates);
    const duplicateDates=preview.filter(day=>existingDates.has(day.date)).map(day=>day.date);
    if (duplicateDates.length && policy==='abort') {
      report.results=preview.map(day=>({date:day.date,state:duplicateDates.includes(day.date)?'skipped':'ready',status:duplicateDates.includes(day.date)?'duplicate':'ready',statusLabel:duplicateDates.includes(day.date)?'Tanggal sudah ada di LLK':'Belum dikirim',submitted:false,skipped:duplicateDates.includes(day.date),failed:false,verified:duplicateDates.includes(day.date),error:duplicateDates.includes(day.date)?'Tanggal sudah memiliki LLK; pengiriman seluruh rentang dibatalkan':undefined}));
      await saveJson(path,report);
      throw new HttpError(409,`Tanggal sudah ada di LLK: ${duplicateDates.join(', ')}. Tidak ada tanggal yang dikirim.`);
    }
    if (preview.every(day => existingDates.has(day.date))) {
      report.results=preview.map(day=>({date:day.date,state:'skipped',status:'duplicate',statusLabel:'Sudah ada di LLK',message:'Dilewati karena tanggal sudah memiliki LLK',submitted:false,skipped:true,failed:false,verified:true,itemCount:day.items.length}));
      report.success = 0;
      report.skipped = report.results.length;
      report.failed = 0;
      await saveJson(path, report);
      return report;
    }
    const supervisorNip = employeeId(employee.supervisor.nip);
    for (const day of preview) {
      progress(session,id,'send-date', `Memproses ${day.date} (${report.results.length + 1}/${preview.length})…`, { status: 'Berjalan' });
      if (existingDates.has(day.date)) {
        report.results.push({date:day.date,state:'skipped',status:'duplicate',statusLabel:'Sudah ada di LLK',message:'Dilewati karena tanggal sudah memiliki LLK',submitted:false,skipped:true,failed:false,verified:true,itemCount:day.items.length});
        progress(session,id,'send-result',`${day.date}: dilewati karena sudah ada di LLK.`,{status:'Info'});
        continue;
      }
      const result={date:day.date,state:'failed',status:'failed',statusLabel:'Gagal dikirim',submitted:false,skipped:false,failed:true,verified:false,itemCount:day.items.length,payload:{date:day.date,items:day.items}};
      let submissionStarted = false;
      try {
        if (!/^\d{18}$/.test(supervisorNip)) throw new Error('NIP atasan tidak valid. Pengiriman dibatalkan.');
        const page=await openCreate(client);
        const liveSupervisor=await resolveSupervisor(client,supervisorNip,page);
        if (liveSupervisor.nip !== supervisorNip || !liveSupervisor.id || !liveSupervisor.name) throw new Error('Lookup atasan tidak lengkap. Pengiriman dibatalkan.');
        employee.supervisor={id:liveSupervisor.id,nip:liveSupervisor.nip,name:liveSupervisor.name,verified:true,source:'llk-http-select2'};
        const form=page.$('form[action*="/llk/save"]').first();
        const token=page.$('input[name="_token"]').first().val();
        if(!form.length||!token)throw new Error('Form simpan atau token CSRF tidak ditemukan. Tidak dikirim.');
        const [year,month,date]=day.date.split('-');
        const payload=new URLSearchParams({redirect:`${LLK_BASE}/llk`,_token:token,'author[name]':employee.name,'author[nip]':employee.nip,'author[jabatan_text]':employee.position,'supervisor[nip]':liveSupervisor.id,'supervisor[name]':liveSupervisor.name,activity_date:`${date}-${month}-${year}`});
        for (const item of day.items) { payload.append('items[start_time][]',item.start); payload.append('items[end_time][]',item.end); payload.append('items[description][]',item.description); payload.append('items[type][]',item.type==='Utama'?'primary':'support'); payload.append('items[result][]',item.result); payload.append('items[note][]',''); payload.append('items[id][]',''); }
        session.calendarEntries.delete(id);
        submissionStarted = true;
        const saveUrl=new URL(form.attr('action'),page.url);
        if(saveUrl.origin!==LLK_BASE||saveUrl.pathname!=='/llk/save')throw new Error('Tujuan form simpan tidak sesuai.');
        const response=(await client.post(saveUrl,payload,page.url)).response;
        const responseInfo = submissionResponseInfo(response);
        result.httpStatus = responseInfo.status;
        result.submitted = responseInfo.status === 303 && responseInfo.redirect === 'llk-list';
        if(result.submitted){
          const confirmed=await scrapeEntries(session,client);
          const rows=confirmed.filter(entry=>entry.date===day.date);
          const stored=day.items.every(item=>rows.some(row=>row.start===item.start&&row.end===item.end&&clean(row.description)===clean(item.description)&&row.type===item.type&&clean(row.result)===clean(item.result)));
          if(!confirmed.dates.includes(day.date)||!stored){result.submitted=false;throw new Error('Isi LLK belum terbukti tersimpan. Periksa LLK sebelum mencoba lagi.');}
          existingDates.add(day.date);
        }
        if (result.submitted) {
          result.state = 'saved';
          result.status = 'awaiting_supervisor';
          result.statusLabel = 'Tersimpan di LLK · Menunggu verifikasi';
          result.message = 'Berhasil disimpan ke LLK (menunggu verifikasi atasan)';
          result.failed = false;
        } else {
          result.state = 'failed';
          result.status = result.httpStatus === 403 ? 'forbidden' : 'failed';
          result.statusLabel = result.httpStatus === 403 ? 'Ditolak LLK (HTTP 403)' : 'Gagal';
          result.failed = true;
          result.responseInfo = responseInfo;
          result.error = result.httpStatus === 403
            ? 'HTTP 403: LLK menolak pengiriman. Penyebab belum dapat dipastikan (sesi, izin, atau perlindungan permintaan). Form dan CSRF sudah dimuat ulang untuk tanggal ini. Tidak dicoba ulang; periksa LLK sebelum mengirim kembali.'
            : `HTTP ${result.httpStatus}: respons simpan tidak terkonfirmasi. Tidak dicoba ulang; periksa LLK sebelum mengirim kembali.`;
        }
      } catch (error) {
        result.error = clean(error.message).replace(/\x1b\[[0-9;]*m/g, '').slice(0,500);
        result.status = submissionStarted ? 'uncertain' : 'not_attempted';
        result.statusLabel = submissionStarted ? 'Belum pasti' : 'Belum dikirim';
        result.message = submissionStarted ? 'Status pengiriman belum dapat dipastikan. Periksa LLK sebelum mencoba lagi.' : 'Formulir LLK belum berhasil disiapkan. Tidak ada permintaan pengiriman untuk tanggal ini.';
      }
      report.results.push(result);
      progress(session,id,'send-result', `${day.date}: ${result.submitted ? 'tersimpan di LLK, menunggu verifikasi atasan.' : result.status === 'not_attempted' ? 'belum dikirim; formulir gagal disiapkan.' : result.status === 'uncertain' ? 'hasil belum pasti; periksa LLK sebelum mengirim ulang.' : 'gagal dikirim. ' + result.error}`, { status: result.submitted ? 'Selesai' : 'Gagal' });
      await saveJson(path, report);
      if (result.failed) {
        for (const remaining of preview.slice(report.results.length)) report.results.push({ date: remaining.date, state: 'skipped', status: 'not_attempted', statusLabel: 'Belum dikirim', message: 'Pengiriman dihentikan setelah kegagalan sebelumnya; tidak dicoba ulang.', submitted: false, skipped: true, failed: false, verified: false, itemCount: remaining.items.length });
        break;
      }
    }
    report.success = report.results.filter(item => item.submitted && !item.skipped).length;
    report.skipped = report.results.filter(item => item.skipped).length;
    report.failed = report.results.filter(item => item.failed).length;
    await saveJson(path, report);
    return report;
}
async function templateSnapshot(app){const templates=await readJson(templateFile(app));return templates.version&&templates.departments?templates:{version:1,updatedAt:null,departments:templates};}
async function readPersonal(session,id){return session.personalTemplates.get(id)||null;}
function validatePersonal(value,id){if(!value||typeof value!=='object'||value.employeeId!==id||!Array.isArray(value.activities)||value.activities.length>1000)bad('Daftar kegiatan profil tidak valid');const activities=value.activities.map(a=>{const nama=clean(a?.nama),kategori=clean(a?.kategori)||'Pendukung';if(!nama||isBreakActivity(nama)||!['Utama','Pendukung'].includes(kategori))bad('Kegiatan profil tidak valid');return {nama,kategori,result:'Selesai',...(a.start?{start:clean(a.start)}:{}),...(a.end?{end:clean(a.end)}:{})};});return {...value,activities};}
async function personalResponse(session,employee){const personal=await readPersonal(session,employee.id),stored=await readJson(templateFile(session.app)),departments=stored.departments||stored,fallback=departments[employee.department];return {source:personal?.activities?.length?'personal':'department',personal,activities:personal?.activities?.length?personal.activities:(fallback?.activities||[]),fallbackLabel:fallback?.label||employee.department};}
async function importPersonal(session,id,client=session.client) {
    const entries=await readEntries(client,{scope:'latest'}),current=await readPersonal(session,id);
    if(entries.available===false)return {available:false,current,candidate:null,warning:'Riwayat LLK tidak tersedia; template pribadi tidak diubah.'};
    const seen = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
      const nama = clean(entry.description);
      if (!nama || entry.isBreak || isBreakActivity(nama)) continue;
      const activity = { nama, kategori: /^(Utama|Pendukung)$/i.test(entry.type) ? clean(entry.type) : 'Pendukung' };
      const result = clean(entry.result || entry.output); if (result) activity.result = result;
      const key = canonical(activity);
      if (!seen.has(key)) seen.set(key, { ...activity, occurrences: 1, lastSeen: entry.date || null });
      else { const item = seen.get(key); item.occurrences += 1; if (entry.date && (!item.lastSeen || entry.date > item.lastSeen)) item.lastSeen = entry.date; }
    }
    const activities = [...seen.values()].sort((a, b) => b.occurrences - a.occurrences || a.nama.localeCompare(b.nama, 'id-ID')).map(({ occurrences, lastSeen, ...item }) => item);
    if (!activities.length) return { available: false, current, candidate: null, warning: 'Daftar LLK ditemukan, tetapi tidak ada kegiatan yang dapat dibaca. Template personal tidak diubah.' };
    const candidate = { version: 1, updatedAt: new Date().toISOString(), employeeId: id, activities };
    const stageToken = randomBytes(16).toString('hex'), digest = createHash('sha256').update(canonical(candidate)).digest('hex');
    assertSession(session);
    if(session.expiring)throw new HttpError(401,'Sesi login berakhir.');
    session.stagedPersonal.set(id, { stageToken, token: stageToken, digest, candidate, expires: Date.now() + 15 * 60 * 1000 });
    return { available: true, current, candidate, activities, scannedEntries: entries.length, pagesScanned: entries.pagesScanned || 1, sourceUrl: entries.sourceUrl || null, latestDate: entries.latestDate, stageToken, digest, diff: { added: activities.length, modified: 0, removed: current?.activities?.length || 0 } };
}

async function enrichEmployeeFromSso(employee,client) {
  const profile=await readProfile(client),selected=await resolveSupervisor(client,employee.supervisor.nip);
  return {...employee,...profile,accountIdentity:profile,supervisor:{id:selected.id,nip:selected.nip,name:selected.name,verified:true,source:'llk-http-select2'},supervisorLookup:{attempted:true,nip:selected.nip,name:selected.name,control:selected.control,url:selected.url}};
}

async function launchBuiltInBootstrap(session,input) {
  assertSession(session);
  if(session.expiring||session.expires<=Date.now())throw new HttpError(401,'Sesi login berakhir. Login kembali.');
  const tempId = `temp-${randomBytes(12).toString('hex')}`;
  const employee = { id:tempId, nip:'', name:'Pegawai Baru', position:'Pegawai / Pelaksana', department:input.department || 'umum_keuangan', satker:clean(input.satker)||'Satker Lain', supervisor:{id:input.supervisorNip,nip:input.supervisorNip,name:''} };
  const auth = session.app.authFactory(),flow = { employee, auth, closing: false, expires: Date.now() + 10 * 60_000 };
  session.loginFlows.set(tempId,flow);
  flow.timer=setTimeout(()=>closeLoginFlow(session,tempId,flow),10*60_000);flow.timer.unref();
  try { await auth.login(input.username, input.password); assertLoginFlow(session,tempId,flow); }
  catch (error) { closeLoginFlow(session,tempId,flow); throw error; }
  finally { input.password = ''; }
  return {auth,tempId};
}

function assertLoginFlow(session,tempId,flow) {
  assertSession(session);
  if(!flow||flow.closing||flow.expires<=Date.now()||session.loginFlows.get(tempId)!==flow||session.expiring||session.expires<=Date.now()){closeLoginFlow(session,tempId,flow);throw new HttpError(401,'Sesi login berakhir. Login kembali.');}
}

async function completeBootstrap(session,tempId,flow) {
  assertLoginFlow(session,tempId,flow);
  const client=flow.client ||= session.app.clientFactory(flow.auth.cookies());
  const enriched=await enrichEmployeeFromSso(flow.employee,client),actualNip=enriched.nip;
  assertLoginFlow(session,tempId,flow);
  if(!/^\d{18}$/.test(actualNip)||!enriched.name)throw new HttpError(401,'Identitas LLK tidak terbaca.');
  enriched.id=actualNip;
  const history=await importPersonal(session,actualNip,client);
  await scrapeEntries(session,client,actualNip);
  assertLoginFlow(session,tempId,flow);
  if(history.candidate)session.personalTemplates.set(actualNip,validatePersonal(history.candidate,actualNip));
  session.stagedPersonal.delete(actualNip);session.employee=enriched;session.client=client;flow.client=null;
  closeLoginFlow(session,tempId,flow);
  return {employee:enriched,history,verifier:{available:false,warning:null},sessionActive:true,tempId};
}


const verificationListUrl=()=>`${LLK_BASE}/verifikasi?start_date=&end_date=&status=1&by=nip&q=`;
async function runAutomaticVerification(session,id,input) {
  const message=clean(input.message),stage=session.stagedVerification.get(id);
  if(!message)bad('Pesan verifikasi wajib diisi');
  if(!stage||stage.expires<Date.now()||stage.token!==clean(input.stageToken))throw new HttpError(409,'Hasil pemindaian sudah kedaluwarsa. Pindai ulang sebelum verifikasi.');
  const selected=new Set(Array.isArray(input.hllk)?input.hllk.map(String):[]),targets=selected.size?stage.targets.filter(item=>selected.has(item.hllk)):stage.targets;
  if(!targets.length)bad('Tidak ada LLK berstatus Belum Diverifikasi');
  clearTimeout(stage.timer);
  try {
    const results=await verifyBatch(await employeeClient(session,id),targets,message,{progress:(stage,message,detail)=>progress(session,id,stage,message,detail)});
    await audit(session.app,'verification.auto',id,{message,targetIds:targets.map(item=>item.hllk),filter:stage.filter},{counts:{total:results.length,success:results.filter(item=>item.success).length},result:'completed'});
    return {total:results.length,success:results.filter(item=>item.success).length,failed:results.filter(item=>!item.success).length,results,filter:stage.filter};
  } finally { closeVerificationStage(session,id); }
}

async function applyPersonal(session,id,input){await findEmployee(session,id);const stage=session.stagedPersonal.get(id);if(!stage||stage.expires<Date.now()||input.stageToken!==stage.token||input.confirm!==id)throw new HttpError(409,'Stage token atau konfirmasi tidak cocok');if(session.expiring)throw new HttpError(401,'Sesi login berakhir.');session.personalTemplates.set(id,validatePersonal(stage.candidate,id));session.stagedPersonal.delete(id);await audit(session.app,'personal-template.apply',id,{employeeId:id,digest:stage.digest},{counts:{activities:stage.candidate.activities.length},result:'applied'});return personalResponse(session,await findEmployee(session,id));}
async function resetPersonal(session,id,input){if(input.confirm!==id)bad('Konfirmasi ID pegawai wajib sama');await findEmployee(session,id);session.personalTemplates.delete(id);session.stagedPersonal.delete(id);await audit(session.app,'personal-template.reset',id,{employeeId:id},{result:'reset'});return personalResponse(session,await findEmployee(session,id));}

async function api(session,req,res,url) {
  const path=url.pathname;
  if(req.method==='GET'&&path==='/api/session')return json(res,200,currentSession(session));
  if(req.method==='POST'&&path==='/api/session/end'){
    if(session.busy||session.locks.size||session.requests>1)throw new HttpError(409,'Operasi sesi sedang berjalan. Tunggu hingga selesai.');
    disposeSession(session);
    sessionCookie(res,'',session.app);
    return json(res,200,{employee:null,pending:null});
  }
  if(req.method==='GET'&&path==='/api/progress'){const id=safeId(url.searchParams.get('employeeId')),since=Math.max(0,Number(url.searchParams.get('since'))||0);await findEmployee(session,id);return json(res,200,progressState(session,id,since));}
  if(req.method==='GET'&&path==='/api/employees')return json(res,200,await getEmployees(session));
  if(req.method==='POST'&&path==='/api/verification/run'){const input=await bodyJson(req),id=safeId(input.employeeId);return json(res,200,await withLock(session,id,()=>runAutomaticVerification(session,id,input)));}
  if(req.method==='GET'&&path==='/api/verification/preview'){const id=safeId(url.searchParams.get('employeeId'));return json(res,200,await withLock(session,id,async()=>{const targets=await scanVerification(await employeeClient(session,id),{progress:(stage,message,detail)=>progress(session,id,stage,message,detail)}),stage=stageVerification(session,id,targets,{status:'1',by:'nip',url:verificationListUrl(),pagesScanned:targets.pagesScanned,rowsFound:targets.rowsFound});return {stageToken:stage.token,targets,total:targets.length,pagesScanned:targets.pagesScanned,rowsFound:targets.rowsFound,validCount:targets.validCount,invalidCount:targets.invalidCount,invalidTargets:targets.invalidTargets,filter:stage.filter};}));}
  if(req.method==='POST'&&path==='/api/bootstrap/login'){
    const input=await bodyJson(req);
    if(typeof input.supervisorNip!=='string'||!/^\d{18}$/.test(input.supervisorNip))bad('NIP atasan wajib tepat 18 digit');
    if(typeof input.username!=='string'||!input.username.trim()||input.username.length>200||typeof input.password!=='string'||!input.password||input.password.length>2000)bad('Nama pengguna dan password SSO wajib diisi.');
    if(session.busy||session.locks.size||session.employee||session.loginFlows.size)throw new HttpError(409,'Akhiri sesi sebelumnya sebelum login kembali.');
    session.busy=true;
    try{
      const {auth,tempId}=await launchBuiltInBootstrap(session,input);
      return json(res,200,{tempId,...auth.state});
    }finally{input.password='';session.busy=false;}
  }
  if(req.method==='POST'&&path==='/api/bootstrap/authenticator'){
    const input=await bodyJson(req),tempId=safeId(input.tempId),flow=session.loginFlows.get(tempId);
    assertLoginFlow(session,tempId,flow);
    if(typeof input.code!=='string'||!/^\d{6,8}$/.test(input.code))bad('Kode authenticator harus 6–8 digit.');
    if(session.busy||session.locks.size)throw new HttpError(409,'Operasi sesi sedang berjalan');
    session.busy=true;
    try{const state=await flow.auth.verify(input.code);assertLoginFlow(session,tempId,flow);return json(res,200,{tempId,...state});}
    finally{input.code='';session.busy=false;}
  }
  if(req.method==='POST'&&path==='/api/bootstrap/complete'){
    const input=await bodyJson(req),tempId=safeId(input.tempId),flow=session.loginFlows.get(tempId);
    assertLoginFlow(session,tempId,flow);
    if(flow.auth.state.stage!=='authenticated')throw new HttpError(409,'Selesaikan kode authenticator terlebih dahulu.');
    if(session.busy||session.locks.size)throw new HttpError(409,'Operasi sesi sedang berjalan');
    session.busy=true;
    try{const result=await completeBootstrap(session,tempId,flow);rotateSession(session,res);return json(res,200,result);
    }finally{session.busy=false;}
  }
  const employeeRoute = path.match(/^\/api\/employees\/([^/]+)\/(.+)$/);
  if (!employeeRoute) return json(res,404,{error:'Endpoint tidak ditemukan'});
  const id = safeId(decodeURIComponent(employeeRoute[1]));
  const action = employeeRoute[2];
  await findEmployee(session,id);
  if(action==='personal-template'&&req.method==='GET')return json(res,200,await personalResponse(session,await findEmployee(session,id)));
  if (action === 'calendar-entries' && req.method === 'GET') return json(res, 200, await withLock(session,id, async () => {
    if (url.searchParams.get('refresh') !== '1' && session.calendarEntries.has(id)) return session.calendarEntries.get(id);
    session.calendarEntries.delete(id);
    const entries=await scrapeEntries(session,await employeeClient(session,id),id);
    return session.calendarEntries.get(id)||cacheCalendarEntries(session,id,entries);
  }));
  if (action === 'preview' && req.method === 'POST') {
    const input = await bodyJson(req);
    return json(res, 200, await withLock(session,id, async () => {
      const employee=await findEmployee(session,id),client=await employeeClient(session,id);
        const source=input.source==='general'?'general':'page';
        progress(session,id,'preview-start',`Menyiapkan isian ${input.start} sampai ${input.end}…`);
        const entries=await readEntries(client,{scope:'latest'});
        const pageActivities = source === 'page'
          ? [...new Map(entries.filter(entry => !entry.isBreak).map(item => [canonical({ description: item.description, type: item.type }), item])).values()]
          : [];
        progress(session,id,'preview-llk-done', `Halaman terbaru LLK terbaca: ${entries.length} baris.`);
        return generatePreview(session.app, employee, input.start, input.end, source, input.department, pageActivities, entries);
    }));
  }
  if (action === 'personal-template/apply' && req.method === 'POST') { const input=await bodyJson(req); return json(res,200,await withLock(session,id,()=>applyPersonal(session,id,input))); }
  if (action === 'personal-template' && req.method === 'DELETE') { const input=await bodyJson(req); return json(res,200,await withLock(session,id,()=>resetPersonal(session,id,input))); }
  if (action === 'personal-template/import' && req.method === 'POST') return json(res, 200, await withLock(session,id, () => importPersonal(session,id)));
  if (action === 'session/status' && req.method === 'GET') return json(res,200,await withLock(session,id,async()=>{
    const profile=await readProfile(await employeeClient(session,id));
    return {authenticated:profile.nip===id,source:'http-session'};
  }));
  if (action === 'submit' && req.method === 'POST') {
    const input = await bodyJson(req);
    const report = await withLock(session,id, () => submitPreview(session,id, input.preview, input.duplicatePolicy));
    await audit(session.app,'submit', id, input.preview, { counts: { submitted: report.success, failed: report.failed }, result: 'completed' });
    return json(res, 200, sanitize(report));
  }
  return json(res,405,{error:'Metode tidak didukung'});
}

const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json'};
const DEFAULT_PUBLIC_LIMITS = Object.freeze({maxSessions:200,newSessionsPerIp:20,ipAttempts:20,sessionAttempts:8,ipWindowMs:15*60_000,sessionWindowMs:5*60_000,maxIpBuckets:1024,bodyBytes:1_000_000});
const THEME_SCRIPT = "(function(){try{var t=localStorage.getItem('llk-theme');if(t!=='dark'&&t!=='light')t=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';document.documentElement.setAttribute('data-theme',t)}catch(e){}})();";
const CSP = `default-src 'self'; script-src 'self' 'sha256-${createHash('sha256').update(THEME_SCRIPT).digest('base64')}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`;
function hostingOrigin(value) {
  if (value === '') return null;
  let origin;
  try { origin = new URL(value); } catch { throw new TypeError('LLK_PUBLIC_ORIGIN tidak valid'); }
  if (typeof value !== 'string' || value !== origin.origin || origin.protocol !== 'https:' || origin.username || origin.password || isIP(origin.hostname) || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(origin.hostname)) throw new TypeError('LLK_PUBLIC_ORIGIN wajib origin HTTPS domain tanpa path');
  return origin;
}
function proxyConfig(value) {
  if (value === false) return null;
  if (!value || typeof value !== 'object' || !/^[a-z][a-z0-9-]*$/.test(value.protocolHeader || '') || typeof value.protocolValue !== 'string' || !value.protocolValue || /[\r\n,]/.test(value.protocolValue) || (value.clientIpHeader !== undefined && (!/^[a-z][a-z0-9-]*$/.test(value.clientIpHeader) || !['single','last'].includes(value.clientIpMode)))) throw new TypeError('Konfigurasi proxy tidak valid');
  if (value.transport !== undefined && !['unix','loopback'].includes(value.transport)) throw new TypeError('Transport proxy tidak valid');
  if (value.transport === 'loopback' && (!/^[a-z][a-z0-9-]*$/.test(value.secretHeader || '') || typeof value.secretValue !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(value.secretValue))) throw new TypeError('Proxy loopback wajib marker rahasia');
  return {...value};
}
function rateError(ms) {
  const error = new HttpError(429, 'Terlalu banyak permintaan. Coba lagi nanti.');
  error.retryAfter = Math.max(1, Math.ceil(ms / 1000));
  return error;
}
function pruneIpBudgets(app, now = Date.now()) {
  for (const [ip, budget] of app.ipBudgets) if (budget.expires <= now) app.ipBudgets.delete(ip);
}
function consumeIpBudget(app, ip, kind, limit) {
  const now = Date.now();
  let budget = app.ipBudgets.get(ip);
  if (budget?.expires <= now) { app.ipBudgets.delete(ip); budget = null; }
  if (!budget) {
    if (app.ipBudgets.size >= app.limits.maxIpBuckets) pruneIpBudgets(app, now);
    if (app.ipBudgets.size >= app.limits.maxIpBuckets) throw rateError(app.limits.ipWindowMs);
    budget = {expires:now + app.limits.ipWindowMs,sessions:0,attempts:0};
    app.ipBudgets.set(ip, budget);
  }
  if (budget[kind] >= limit) throw rateError(budget.expires - now);
  budget[kind]++;
}
function consumeSessionAttempt(session) {
  const now = Date.now(), {limits} = session.app;
  if (!session.authBudget || session.authBudget.expires <= now) session.authBudget = {expires:now + limits.sessionWindowMs,count:0};
  if (session.authBudget.count >= limits.sessionAttempts) throw rateError(session.authBudget.expires - now);
  session.authBudget.count++;
}
function proxyClientIp(req, proxy) {
  if (!proxy?.clientIpHeader) return 'unknown-proxy';
  const raw = req.headers[proxy.clientIpHeader];
  if (typeof raw !== 'string' || raw.length > 1024) return 'unknown-proxy';
  const parts = raw.split(',').map(part => part.trim());
  if (proxy.clientIpMode === 'single' && parts.length !== 1) return 'unknown-proxy';
  const ip = parts.at(-1);
  const version = isIP(ip);
  if (!version || ip.includes('%')) return 'unknown-proxy';
  return version === 6 ? new URL(`http://[${ip}]/`).hostname : ip;
}
export async function createAppServer({authFactory=()=>new CasAuth(),clientFactory=cookies=>new LlkHttp(cookies),dataDir=DATA,sessionTtlMs=30*60_000,publicOrigin=process.env.LLK_PUBLIC_ORIGIN || '',trustedProxy=false,publicLimits={}} = {}) {
  if(typeof authFactory!=='function'||typeof clientFactory!=='function'||!Number.isFinite(sessionTtlMs)||sessionTtlMs<=0||sessionTtlMs>2_147_483_647)throw new TypeError('Konfigurasi sesi tidak valid');
  const origin = hostingOrigin(publicOrigin), proxy = proxyConfig(trustedProxy), limits = {...DEFAULT_PUBLIC_LIMITS,...publicLimits};
  if (Object.keys(limits).some(key => !(key in DEFAULT_PUBLIC_LIMITS) || !Number.isSafeInteger(limits[key]) || limits[key] <= 0 || limits[key] > 2_147_483_647)) throw new TypeError('Konfigurasi batas publik tidak valid');
  if (proxy && !origin) throw new TypeError('Proxy wajib memakai LLK_PUBLIC_ORIGIN');
  // ponytail: sessions live in one process; passenger.cjs holds native flock; use shared state before scaling workers.
  const app={authFactory,clientFactory,dataDir:resolve(dataDir),sessionTtlMs,publicOrigin:origin?.origin || '',limits,sessions:new Map(),ipBudgets:new Map(),stopping:false};
  await mkdir(app.dataDir,{recursive:true,mode:0o700});
  if(process.platform!=='win32')await chmod(app.dataDir,0o700);
  const server = createServer((req, res) => {
    void (async () => {
      let session;
      try {
        res.setHeader('Cache-Control','no-store');
        res.setHeader('X-Content-Type-Options','nosniff');
        res.setHeader('X-Frame-Options','DENY');
        res.setHeader('Referrer-Policy','no-referrer');
        res.setHeader('Content-Security-Policy',CSP);
        const expectedHost=origin ? origin.host : `127.0.0.1:${server.address()?.port}`;
        const expectedOrigin=origin ? origin.origin : `http://${expectedHost}`;
        const address = server.address();
        const privateListener = typeof address === 'string' || (address && ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address.address));
        const trustedTransport = !!proxy && (proxy.transport === 'loopback'
          ? privateListener && ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && req.headers[proxy.secretHeader] === proxy.secretValue
          : typeof server.address() === 'string' && !req.socket.remoteAddress);
        if (origin) {
          if (req.headers.host !== expectedHost || !(req.socket.encrypted || (trustedTransport && req.headers[proxy.protocolHeader] === proxy.protocolValue))) throw new HttpError(403,'Host atau HTTPS aplikasi tidak valid.');
          req.clientIp = trustedTransport ? proxyClientIp(req, proxy) : req.socket.remoteAddress || 'unknown-direct';
          req.bodyLimit = limits.bodyBytes;
          if (req.headers['content-length'] && (!/^\d+$/.test(req.headers['content-length']) || Number(req.headers['content-length']) > limits.bodyBytes)) throw new HttpError(413,'Payload terlalu besar');
        } else if(req.headers.host!==expectedHost||!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))throw new HttpError(403,'Host aplikasi lokal tidak valid. Gunakan 127.0.0.1.');
        if(req.headers['sec-fetch-site']==='cross-site')throw new HttpError(403,'Permintaan harus berasal dari aplikasi.');
        if(!['GET','HEAD','OPTIONS'].includes(req.method)&&(req.headers.origin!==expectedOrigin||!/^application\/json(?:;|$)/i.test(req.headers['content-type']||'')))throw new HttpError(403,'Permintaan harus berasal dari aplikasi.');
        if (!req.url.startsWith('/') || req.url.startsWith('//')) bad('Path tidak valid');
        const url = new URL(req.url, expectedOrigin);
        if (url.pathname.startsWith('/api/')) {
          if(req.method==='GET'&&url.pathname==='/api/calendar/2026')return json(res,200,{year:2026,source:'SKB 3 Menteri',days:SKB_2026_DAYS});
          if(req.method==='GET'&&url.pathname==='/api/templates')return json(res,200,await templateSnapshot(app));
          if(app.stopping)throw new HttpError(503,'Aplikasi sedang dihentikan.');
          const authAttempt = !!origin && req.method === 'POST' && ['/api/bootstrap/login','/api/bootstrap/authenticator','/api/bootstrap/complete'].includes(url.pathname);
          if (authAttempt) consumeIpBudget(app, req.clientIp, 'attempts', limits.ipAttempts);
          if (origin && !['GET','HEAD','OPTIONS'].includes(req.method)) {
            req.parsedBodyPromise = bodyJson(req);
            await req.parsedBodyPromise;
          }
          session=requestSession(app,req,res,req.method==='GET'&&url.pathname==='/api/session');
          if (authAttempt) consumeSessionAttempt(session);
          return await api(session,req,res,url);
        }
        if (!['GET','HEAD'].includes(req.method)) throw new HttpError(405,'Metode tidak didukung');
        let decoded;
        try { decoded = decodeURIComponent(url.pathname); } catch { bad('Path tidak valid'); }
        const file = resolve(PUBLIC, decoded === '/' ? 'index.html' : decoded.slice(1)), rel = relative(PUBLIC, file);
        if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').some(part => part.startsWith('.')) || rel.startsWith('..') || isAbsolute(rel)) throw new HttpError(403, 'Akses ditolak');
        let content;
        try { content = await readFile(file); } catch (error) { if (['ENOENT','ENOTDIR','EISDIR'].includes(error.code)) throw new HttpError(404,'File tidak ditemukan'); throw error; }
        res.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream' });
        res.end(req.method === 'HEAD' ? undefined : content);
      } catch (error) {
        if (!res.headersSent) json(res, error.status || 500, { error: app.publicOrigin && (!error.status || error.status >= 500) ? 'Permintaan gagal diproses' : error.message || 'Permintaan gagal' }, error.retryAfter ? {'Retry-After':String(error.retryAfter)} : {});
        else if (!res.writableEnded) res.end();
      } finally {
        if(session)releaseSession(session);
      }
    })().catch(() => {
      console.error('Pemrosesan permintaan gagal.');
      if (!res.headersSent) json(res, 500, { error: 'Permintaan gagal diproses' });
      else if (!res.writableEnded) res.end();
    });
  });
  const budgetTimer = origin ? setInterval(() => pruneIpBudgets(app), Math.min(limits.ipWindowMs, 60_000)) : null;
  budgetTimer?.unref();
  server.on('close',()=>{app.stopping=true;clearInterval(budgetTimer);app.ipBudgets.clear();for(const session of app.sessions.values())expireSession(session);});
  return server;
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const server=await createAppServer();
  server.listen(PORT,'127.0.0.1',()=>console.log(`LLK Agent PN Natuna: http://127.0.0.1:${PORT}`));
  let stopping=false;
  const shutdown=()=>{if(stopping)return;stopping=true;setTimeout(()=>process.exit(1),10_000).unref();server.close(()=>process.exit(0));};
  process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
}
