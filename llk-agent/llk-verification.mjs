import { formFields } from './llk-http.mjs';
import { officialDate,isBreak,pagination } from './llk-read.mjs';
const BASE='https://llk.mahkamahagung.go.id';
const clean=x=>String(x??'').replace(/\s+/g,' ').trim();
const fail=message=>{throw Object.assign(new Error(message),{status:502});};
export async function scanVerification(client,{progress=()=>{}}={}){
 let page=await client.get('/verifikasi?start_date=&end_date=&status=1&by=nip&q='),pages=0;const visited=new Set(),rows=[];
 while(true){if(visited.has(page.url.href)||pages>=500)fail('Paginasi verifikasi belum lengkap.');visited.add(page.url.href);const $=page.$;
 if(!/^\/verifikasi(?:\/index)?\/?$/.test(page.url.pathname)||page.url.searchParams.get('status')!=='1'||page.url.searchParams.get('by')!=='nip')fail('Filter Belum Terverifikasi belum terbukti aktif.');
 if(!$('table').length)fail('Tabel verifikasi tidak ditemukan.');
 $('a[href*="/verifikasi/edit?cid="]').each((_,link)=>{
  const row=$(link).closest('tr'),cell=row.children('td').filter((_,n)=>$(n).find('table').length).first();
  const rawDate=(clean(cell.text()).match(/Tanggal Kegiatan\s*:\s*([^,]+)/i)||[])[1]||'';
  const activities=cell.find('table').first().children('tbody').children('tr').map((_,tr)=>{const cells=$(tr).children('td').map((_,n)=>clean($(n).text())).get(),times=(cells[1]||'').match(/\b(?:[01]\d|2[0-3]):[0-5]\d\b/g)||[];return {start:times[0]||'',end:times[1]||'',description:cells[3]||'',type:cells[4]||'',result:cells[5]||''};}).get();
  const editUrl=new URL($(link).attr('href'),page.url);if(editUrl.origin!==BASE)fail('Tujuan verifikasi tidak valid.');
  rows.push({editUrl:editUrl.href,summary:clean(row.text()).slice(0,500),date:officialDate(rawDate),activities});
 });
 pages++;progress('verification-page',`Membaca halaman verifikasi ${pages}…`,{page:pages,rowsFound:rows.length});const next=pagination(page).next;if(!next)break;page=await client.get(next.url,page.url);
 }
 const unique=[...new Map(rows.map(row=>[row.editUrl,row])).values()],counts=new Map();for(const row of unique)if(row.date)counts.set(row.date,(counts.get(row.date)||0)+1);
 const valid=[],invalid=[];
 for(const row of unique){const issues=[];if(!row.date)issues.push('Tanggal kegiatan tidak terbaca');else if(counts.get(row.date)>1)issues.push(`Tanggal duplikat: ${row.date}`);const dow=row.date?new Date(row.date+'T12:00:00').getDay():null,expected=dow===5?'17:00':dow>=1&&dow<=4?'16:30':null;if(!row.activities.length)issues.push('Rincian kegiatan tidak terbaca');else if(expected&&row.activities.at(-1).end!==expected)issues.push(`Jam akhir seharusnya ${expected}`);const work=row.activities.filter(x=>!isBreak(x.description));if(!work.length)issues.push('Deskripsi hanya istirahat atau kosong');else if(work.some(x=>x.description.length<4))issues.push('Deskripsi kegiatan belum benar');
 if(!issues.length){try{const edit=await client.get(row.editUrl,page.url),hllk=edit.$('input[name="hllk"]').val();if(!/^\d+$/.test(hllk||''))fail('ID LLK tidak terbaca');row.hllk=String(hllk);}catch(error){issues.push(error.message);}}
 row.valid=!issues.length;row.issues=issues;(row.valid?valid:invalid).push(row);
 }
 return Object.assign(valid,{pagesScanned:pages,rowsFound:unique.length,validCount:valid.length,invalidCount:invalid.length,invalidTargets:invalid});
}
async function statusSnapshot(client,targets){
 const wanted=new Set(targets.map(target=>String(target.hllk))),dates=new Set(targets.map(target=>target.date)),found=new Map();
 let page=await client.get('/verifikasi?start_date=&end_date=&status=&by=nip&q=');const visited=new Set();
 while(true){
  if(visited.has(page.url.href)||visited.size>=500)fail('Status target belum dapat dipastikan dari daftar LLK.');visited.add(page.url.href);
  const $=page.$;
  for(const link of $('a[href*="/verifikasi/edit?cid="]').toArray()){
   const row=$(link).closest('tr'),rawDate=(clean(row.text()).match(/Tanggal Kegiatan\s*:\s*([^,]+)/i)||[])[1]||'',date=officialDate(rawDate);
   if(date&&!dates.has(date))continue;
   const editUrl=new URL($(link).attr('href'),page.url),edit=await client.get(editUrl,page.url),hllk=String(edit.$('input[name="hllk"]').val()||'');
   if(!wanted.has(hllk))continue;
   const label=clean(row.children('td').last().text());
   const status=/Belum\s+Terverifikasi/i.test(label)?'pending':/Terverifikasi/i.test(label)?'verified':null;
   if(!status)fail('Label status target tidak dikenali.');
   if(found.has(hllk))fail('Identitas target muncul lebih dari sekali pada daftar status.');
   found.set(hllk,{status,editUrl:editUrl.href,fields:formFields(edit.$,edit.$('form[action*="/verifikasi/update"]').first())});
  }
  if(found.size===wanted.size)break;
  const next=pagination(page).next;if(!next)break;page=await client.get(next.url,page.url);
 }
 return found;
}
export async function verifyBatch(client,targets,message,{progress=()=>{}}={}){
 const before=await statusSnapshot(client,targets),results=[],submitted=[];
 for(const [index,target] of targets.entries()){
  progress('verify-target',`Memverifikasi ${index+1}/${targets.length}…`,{target:index+1,totalTargets:targets.length,hllk:target.hllk,date:target.date});
  let started=false;
  try{
   const current=before.get(String(target.hllk));
   if(!current)fail('Target tidak ditemukan pada daftar status.');
   if(current.status!=='pending')fail('LLK sudah terverifikasi menurut daftar resmi. Tidak dikirim ulang.');
   // Always reload form immediately before POST: snapshot tokens can rotate between targets.
   const page=await client.get(current.editUrl),$=page.$,form=$('form[action*="/verifikasi/update"]').first();if(!form.length)fail('Form verifikasi tidak ditemukan.');
   const fields=formFields($,form);if(fields.get('hllk')!==String(target.hllk))fail('Identitas LLK tidak sesuai target.');
   if(!form.find('[name="note"]').length||!form.find('[name="verified"]').length)fail('Kontrol verifikasi tidak lengkap.');
   fields.set('note',message);fields.set('verified','2');const action=new URL(form.attr('action'),page.url);if(action.origin!==BASE||action.pathname!=='/verifikasi/update')fail('Tujuan form verifikasi tidak valid.');
   started=true;const sent=await client.post(action,fields,page.url);
   const result={hllk:target.hllk,date:target.date,status:sent.response.status,success:false};results.push(result);
   if(sent.response.status>=400)result.error=`HTTP ${sent.response.status}: verifikasi ditolak. Tidak dicoba ulang.`;
   else{submitted.push({target,result});result.uncertain=true;result.error='Hasil verifikasi belum pasti. Pindai ulang sebelum mencoba lagi.';}
  }catch(error){results.push({hllk:target.hllk,date:target.date,status:0,success:false,uncertain:started,notAttempted:!started,error:started?'Hasil verifikasi belum pasti. Pindai ulang sebelum mencoba lagi.':error.message});}
 }
 if(submitted.length){
  progress('verify-confirm','Memeriksa status dan pesan tersimpan untuk seluruh batch…');
  try{
   const after=await statusSnapshot(client,submitted.map(item=>item.target));
   for(const {target,result} of submitted){
    const saved=after.get(String(target.hllk));
    if(saved?.status==='verified'&&saved.fields.get('hllk')===String(target.hllk)&&clean(saved.fields.get('note'))===clean(message)){
     result.success=true;result.status=200;result.uncertain=false;result.url=saved.editUrl;delete result.error;
    }
   }
  }catch{/* Keep each submitted result uncertain; never retry POST. */}
 }
 return results;
}
