import assert from 'node:assert/strict';
import {load} from 'cheerio';
import {LlkHttp} from './llk-http.mjs';
import {readEntries} from './llk-read.mjs';
import {verifyBatch} from './llk-verification.mjs';
const base='https://llk.mahkamahagung.go.id';
const table=(date,description='Memeriksa berkas')=>`<table><tbody><tr><td><div>Tanggal Kegiatan: <strong>${date}</strong>, Tanggal Entry</div><table><thead><tr><td>No</td><td>Jam</td><td>Waktu(Menit)</td><td>Kegiatan</td><td>Jenis</td><td>Hasil</td></tr></thead><tbody><tr><td>1</td><td>08:00 - 16:30</td><td>510</td><td>${description}</td><td>Utama</td><td>Selesai</td></tr></tbody></table></td></tr></tbody></table>`;
let failSecond=false;
const client=new LlkHttp([],{fetch:async(url)=>{const u=new URL(url);if(u.searchParams.get('page')==='2'){if(failSecond)throw new Error('network');return new Response(table('2 September 2026'));}return new Response(table('1 September 2026')+'<ul class="pagination"><li><a rel="next" href="/llk/index?page=2">Selanjutnya</a></li></ul>');}});
const rows=await readEntries(client);assert.deepEqual(rows.dates,['2026-09-01','2026-09-02']);assert.equal(rows.complete,true);assert.equal(rows.pagesScanned,2);
failSecond=true;await assert.rejects(readEntries(client),/tidak dapat dihubungi/);client.close();
for(const order of [[1,3,5],[5,3,1],[1,5,3]]){
 const requests=[],c=new LlkHttp([],{fetch:async(url)=>{const u=new URL(url),page=Number(u.searchParams.get('page')||1);requests.push(page);return new Response(table(`${order[page-1]} September 2026`,`Halaman ${page} awal`)+table(`${order[page-1]+1} September 2026`,`Halaman ${page} akhir`)+`<ul class="pagination">${page<order.length?`<li><a rel="next" href="/llk/index?page=${page+1}">Selanjutnya</a></li>`:''}<li><a data-ci-pagination-page="3" href="/llk/index?page=3">Akhir</a></li></ul>`);}});
 const selected=order.indexOf(5)+1,latest=await readEntries(c,{scope:'latest'});
 assert.deepEqual(requests,[1,2,3]);assert.equal(latest.available,true);assert.equal(latest.complete,true);assert.equal(latest.pagesScanned,3);assert.equal(latest.latestDate,'2026-09-06');assert.equal(latest.sourceUrl,selected===1?`${base}/llk`:`${base}/llk/index?page=${selected}`);
 assert.deepEqual(latest.dates,['2026-09-05','2026-09-06']);assert.deepEqual(latest.map(row=>row.description),[`Halaman ${selected} awal`,`Halaman ${selected} akhir`]);
 const all=await readEntries(c);assert.equal(all.length,6);assert.deepEqual(all.dates,['2026-09-01','2026-09-02','2026-09-03','2026-09-04','2026-09-05','2026-09-06']);assert.equal(all.pagesScanned,3);c.close();
}
for(const failure of ['network','unrecognized','bad-date','loop','wrong-path']){
 const c=new LlkHttp([],{fetch:async(url)=>{const u=new URL(url);if(u.searchParams.has('page')){if(failure==='network')throw new Error('network');if(failure==='unrecognized')return new Response('<p>Unreadable list</p>');if(failure==='bad-date')return new Response(table('not a date'));if(failure==='wrong-path')return new Response('',{status:302,headers:{location:'/profile'}});return new Response(table('1 September 2026')+'<ul class="pagination"><li><a rel="next" href="/llk">Selanjutnya</a></li></ul>');}return new Response(table('6 September 2026','Newest before failure')+'<ul class="pagination"><li><a rel="next" href="/llk/index?page=2">Selanjutnya</a></li></ul>');}});
 await assert.rejects(readEntries(c,{scope:'latest'}),/tidak dapat dihubungi|tidak dikenali|tidak terbaca|berulang|tidak tersedia/);c.close();
}
const emptyClient=new LlkHttp([],{fetch:async()=>new Response('<table><tbody><tr><td>Tidak ada data</td></tr></tbody></table>')});
const emptyLatest=await readEntries(emptyClient,{scope:'latest'});assert.equal(emptyLatest.length,0);assert.deepEqual(emptyLatest.dates,[]);assert.equal(emptyLatest.latestDate,null);assert.equal(emptyLatest.sourceUrl,`${base}/llk`);assert.equal(emptyLatest.available,true);assert.equal(emptyLatest.complete,true);assert.equal(emptyLatest.pagesScanned,1);emptyClient.close();
const edit=(_,note)=>`<form method="post" action="/verifikasi/update"><input name="hllk" value="42"><input name="_token" value="fresh"><textarea name="note">${note}</textarea><input type="hidden" name="verified" value="2"></form>`;
for(const mode of ['saved','not-saved','timeout','forbidden']){let posts=0,saved=false;
const c=new LlkHttp([],{fetch:async(url,options)=>{
 if(options.method==='POST'){posts++;const fields=new URLSearchParams(options.body);assert.equal(fields.get('_token'),'fresh');assert.equal(fields.get('hllk'),'42');assert.equal(fields.get('verified'),'2');assert.equal(fields.get('note'),'Diperiksa');if(mode==='timeout')throw new Error('lost response');if(mode==='forbidden')return new Response('',{status:403});saved=mode==='saved';return new Response('',{status:303,headers:{location:'/verifikasi'}});}
 if(new URL(url).pathname==='/verifikasi')return new Response(`<table><tbody><tr><td><a href="/verifikasi/edit?cid=${saved?'rotated-after':'rotated-before'}">Edit</a></td><td>${saved?'Terverifikasi':'Belum Terverifikasi'}</td></tr></tbody></table>`);
 return new Response(edit('2',saved?'Diperiksa':''));
}});
const [result]=await verifyBatch(c,[{hllk:'42',date:'2026-09-01',editUrl:base+'/verifikasi/edit?cid=synthetic'}],'Diperiksa');assert.equal(result.success,mode==='saved');assert.equal(posts,1);if(['timeout','not-saved'].includes(mode))assert.equal(result.uncertain,true);c.close();}
console.log('PASS HTTP: all-page dates; latest page by actual dates in ascending/descending/middle order; whole selected page only; later failures reject; empty list preserved; verification fresh CSRF/target, persisted status+note required; no POST retry on timeout/403.');
let lists=0,edits=0,posts=0,token=0;const savedIds=new Set();
const batchClient=new LlkHttp([],{fetch:async(url,options)=>{
 const path=new URL(url);
 if(options.method==='POST'){posts++;const fields=new URLSearchParams(options.body);assert.equal(fields.get('_token'),String(token));savedIds.add(fields.get('hllk'));return new Response('',{status:303});}
 if(path.pathname==='/verifikasi'){lists++;return new Response('<table><tbody>'+['41','42','43'].map(id=>`<tr><td><a href="/verifikasi/edit?cid=${lists}-${id}">Edit</a></td><td>${savedIds.has(id)?'Terverifikasi':'Belum Terverifikasi'}</td></tr>`).join('')+'</tbody></table>');}
 edits++;const id=path.searchParams.get('cid').split('-').at(-1);return new Response(`<form action="/verifikasi/update"><input name="hllk" value="${id}"><input name="_token" value="${++token}"><input name="verified" value="2"><textarea name="note">${savedIds.has(id)?'Diperiksa':''}</textarea></form>`);
}});
const batch=await verifyBatch(batchClient,['41','42','43'].map(hllk=>({hllk,date:'2026-09-01'})),'Diperiksa');
assert.equal(batch.every(x=>x.success),true);assert.equal(lists,2);assert.equal(edits,9);assert.equal(posts,3);batchClient.close();
console.log('PASS batch: 3 targets use 2 status scans, 9 edit reads, 3 sequential POSTs with fresh CSRF; all stored notes confirmed.');
