const BASE='https://llk.mahkamahagung.go.id';
const clean=value=>String(value??'').replace(/\s+/g,' ').trim();
const fail=message=>{throw Object.assign(new Error(message),{status:502});};
export function officialDate(value){
 const months={
  januari:1,jan:1,january:1,
  februari:2,feb:2,february:2,
  maret:3,mar:3,march:3,
  april:4,apr:4,
  mei:5,may:5,
  juni:6,jun:6,june:6,
  juli:7,jul:7,july:7,
  agustus:8,ags:8,agu:8,aug:8,august:8,
  september:9,sep:9,sept:9,
  oktober:10,okt:10,oct:10,october:10,
  november:11,nov:11,
  desember:12,des:12,dec:12,december:12
 };
 const text=clean(value).toLowerCase().replace(/^(?:senin|selasa|rabu|kamis|jumat|sabtu|minggu|mon|tue|wed|thu|fri|sat|sun)[,\s]+/i,'');
 // Cek pola dd-mm-yyyy atau dd/mm/yyyy atau dd.mm.yyyy di mana saja dalam teks
 let m=text.match(/\b(\d{1,2})[-/.]([0-1]?\d)[-/.](20\d{2})\b/);
 if(m)return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
 // Cek pola yyyy-mm-dd
 m=text.match(/\b(20\d{2})[-/.]([0-1]?\d)[-/.]([0-3]?\d)\b/);
 if(m)return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
 // Cek pola dd [nama bulan] yyyy (dengan spasi atau tanda hubung)
 m=text.match(/\b(\d{1,2})[\s-]+([a-z]+)[\s-]+(20\d{2})\b/);
 if(m&&months[m[2]])return `${m[3]}-${String(months[m[2]]).padStart(2,'0')}-${m[1].padStart(2,'0')}`;
 return null;
}
export const isBreak=value=>/^(?:istirahat(?:\s+(?:siang|makan|shalat|makan\s+siang))?|ishoma(?:\s+dan\s+shalat)?|istirahat\s*,?\s*shalat(?:\s+dan\s+makan)?)(?:\s*[-–—].*)?$/i.test(clean(value));
export async function readProfile(client){const page=await client.get('/profile'),$=page.$;if(page.url.pathname!=='/profile')fail('Halaman profil LLK tidak tersedia.');const read=label=>{const node=$('th,dt,label,div').filter((_,n)=>clean($(n).text())===label).first();const container=node.closest('tr,dl,.row,.form-group').length?node.closest('tr,dl,.row,.form-group'):node.parent();return container.find('td,dd,[class*="col-"]').map((_,n)=>clean($(n).text())).get().filter(v=>v&&v!==label).at(-1)||'';};const profile={name:read('Nama Lengkap'),nip:read('NIP'),position:read('Jabatan'),satker:read('Satuan Kerja').replace(/^\(\d+\)\s*/,'')};if(!/^\d{18}$/.test(profile.nip)||!profile.name)fail('Identitas akun tidak terbaca dari profil LLK.');return profile;}
export async function openCreate(client){const page=await client.get('/llk/create');if(page.url.pathname!=='/llk/create'||!page.$('[name="supervisor[nip]"]').length)fail('Form buat LLK tidak tersedia.');return page;}
export async function resolveSupervisor(client,nip,createPage){
 if(!/^\d{18}$/.test(nip))fail('NIP atasan harus 18 digit.');
 const page=createPage||await openCreate(client);
 const result=await client.request(`/llk/findPegawai?q=${encodeURIComponent(nip)}`,{headers:{referer:page.url.href,'x-requested-with':'XMLHttpRequest',accept:'application/json'}});
 let rows;try{rows=JSON.parse(result.html);}catch{fail('Respons lookup atasan tidak valid.');}
 const match=Array.isArray(rows)?rows.filter(row=>String(row.text)===nip||String(row.text).includes(nip)||String(row.nip)===nip):[];
 if(!match.length||!match[0].id||!clean(match[0].nama||match[0].text))fail('Atasan tidak ditemukan secara tepat pada lookup LLK.');
 return {id:String(match[0].id),nip,name:clean(match[0].nama||match[0].text),url:page.url.href,resultText:`${clean(match[0].nama||match[0].text)} ${nip}`,control:'http-select2'};
}
export function pagination(page){const $=page.$;const links=$('ul.pagination a[href]').map((_,node)=>({href:$(node).attr('href'),rel:$(node).attr('rel')})).get().filter(link=>/^https?:|^\//.test(link.href));const checked=links.map(link=>{const url=new URL(link.href,page.url);if(url.origin!==BASE)fail('Paginasi LLK keluar domain resmi.');return {...link,url};});return {next:checked.find(link=>link.rel==='next')};}
export function parseEntries(page){const $=page.$,rows=[],dates=[];let recognized=false, unparsedTables=0;
 $('table').each((_,table)=>{
  const headers=$(table).children('thead').find('tr').first().children('th,td').map((_,n)=>clean($(n).text()).toLowerCase()).get();
  const time=headers.findIndex(x=>/^(jam|waktu)$/.test(x)),activity=headers.findIndex(x=>/^(kegiatan|uraian|aktivitas)$/.test(x)),type=headers.findIndex(x=>/^jenis$/.test(x)),result=headers.findIndex(x=>/^hasil(?:\/volume)?$|^output$/.test(x));
  if([time,activity,type,result].some(x=>x<0))return;
  recognized=true;
  const parent=$(table).parent();
  
  let rawDate=(clean(parent.children('div').first().text()).match(/Tanggal Kegiatan\s*:\s*([^,]+)/i)||[])[1]||'';
  if(!rawDate)rawDate=(clean(parent.text()).match(/Tanggal Kegiatan\s*:\s*([^,\n]+)/i)||[])[1]||'';
  if(!rawDate)rawDate=(clean($(table).prevAll('div,p,span,header,h1,h2,h3,h4,h5').first().text()).match(/Tanggal Kegiatan\s*:\s*([^,]+)/i)||[])[1]||'';
  if(!rawDate)rawDate=(clean($(table).closest('.panel,.card,.box,tr,section,div').find('div,p,span').text()).match(/Tanggal Kegiatan\s*:\s*([^,]+)/i)||[])[1]||'';
  if(!rawDate)rawDate=(clean($(table).find('thead,caption').text()).match(/Tanggal Kegiatan\s*:\s*([^,]+)/i)||[])[1]||'';
  
  // Format alternatif: langsung cari pola tanggal jika label 'Tanggal Kegiatan' tidak persis ada
  if(!rawDate){
    $(table).find('tr,caption,th').each((_,elem)=>{
      const t=clean($(elem).text());
      const m=t.match(/Tanggal Kegiatan\s*:\s*([^,]+)/i)||t.match(/\b(\d{1,2}\s+[A-Za-z]+\s+\d{4}|\d{1,2}[-/.]\d{1,2}[-/.]\d{4})\b/);
      if(m&&!rawDate)rawDate=m[1];
    });
  }
  if(!rawDate){
    const dateMatch=clean(parent.children('div').first().text()||$(table).prev().text()||'').match(/\b(\d{1,2}\s+[A-Za-z]+\s+\d{4}|\d{1,2}[-/.]\d{1,2}[-/.]\d{4})\b/);
    if(dateMatch)rawDate=dateMatch[1];
  }

  const date=officialDate(rawDate);
  if(!date){
    unparsedTables++;
    return;
  }
  dates.push(date);
  $(table).children('tbody').children('tr').each((_,tr)=>{
    const cells=$(tr).children('td,th').map((_,n)=>clean($(n).text())).get();
    const times=(cells[time]||'').match(/\b(?:[01]\d|2[0-3]):[0-5]\d\b/g)||[];
    if(times.length<2||!cells[activity])return;
    rows.push({rawDate,date,start:times[0],end:times[1],description:cells[activity],type:/^utama$/i.test(cells[type])?'Utama':'Pendukung',result:cells[result]||'Selesai',isBreak:isBreak(cells[activity])});
  });
 });
 // Jika ada tabel kegiatan dikenali tapi sama sekali tidak ada tanggal yang berhasil diparsing:
 if(recognized && unparsedTables > 0 && !dates.length){
  fail('Tanggal LLK tidak terbaca. Pemindaian tidak lengkap.');
 }
 // Empty list is trustworthy only when official list table and empty-state text exist.
 if(!recognized&&page.$('table').length&&/tidak ada data|data tidak ditemukan|no data|belum ada/i.test(page.$('table').text()))recognized=true;
 if(!recognized)fail('Tabel daftar LLK tidak dikenali. Tanggal kosong belum dapat dipastikan.');
 return {rows,dates:[...new Set(dates)]};
}
export async function readEntries(client,{scope='all',progress=()=>{}}={}){let page=await client.get('/llk'),pages=0,latest=null;const visited=new Set(),entries=[],dates=new Set();
 while(true){if(!/^\/llk(?:\/index)?\/?$/.test(page.url.pathname))fail('Daftar LLK tidak tersedia.');if(visited.has(page.url.href))fail('Paginasi LLK berulang. Pemindaian tidak lengkap.');if(pages>=500)fail('Batas pemindaian LLK tercapai. Pemindaian belum lengkap.');visited.add(page.url.href);const parsed=parseEntries(page),latestDate=parsed.dates.reduce((best,date)=>date>best?date:best,'')||null;if(!latest||(latestDate&&(!latest.latestDate||latestDate>latest.latestDate)))latest={...parsed,latestDate,sourceUrl:page.url.href};if(scope!=='latest')entries.push(...parsed.rows);for(const date of parsed.dates)dates.add(date);pages++;progress('calendar-page',`Membaca halaman LLK ${pages}…`,{page:pages,dates:dates.size});const next=pagination(page).next;if(!next)break;page=await client.get(next.url,page.url);}
 if(!latest)latest={rows:[],dates:[],latestDate:null,sourceUrl:page.url.href};
 if(scope==='latest')return Object.assign(latest.rows,{available:true,complete:true,pagesScanned:pages,dates:latest.dates,sourceUrl:latest.sourceUrl,latestDate:latest.latestDate});
 return Object.assign(entries,{available:true,complete:true,pagesScanned:pages,dates:[...dates].sort(),sourceUrl:page.url.href});}
