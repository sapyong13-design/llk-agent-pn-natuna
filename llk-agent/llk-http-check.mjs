import assert from 'node:assert/strict';
import {load} from 'cheerio';
import {LlkHttp} from './llk-http.mjs';
import {readEntries} from './llk-read.mjs';
import {verifyBatch} from './llk-verification.mjs';
const base='https://llk.mahkamahagung.go.id';
const table=date=>`<table><tbody><tr><td><div>Tanggal Kegiatan: <strong>${date}</strong>, Tanggal Entry</div><table><thead><tr><td>No</td><td>Jam</td><td>Waktu(Menit)</td><td>Kegiatan</td><td>Jenis</td><td>Hasil</td></tr></thead><tbody><tr><td>1</td><td>08:00 - 16:30</td><td>510</td><td>Memeriksa berkas</td><td>Utama</td><td>Selesai</td></tr></tbody></table></td></tr></tbody></table>`;
let failSecond=false;
const client=new LlkHttp([],{fetch:async(url)=>{const u=new URL(url);if(u.searchParams.get('page')==='2'){if(failSecond)throw new Error('network');return new Response(table('2 September 2026'));}return new Response(table('1 September 2026')+'<ul class="pagination"><li><a rel="next" href="/llk/index?page=2">Selanjutnya</a></li></ul>');}});
const rows=await readEntries(client);assert.deepEqual(rows.dates,['2026-09-01','2026-09-02']);assert.equal(rows.complete,true);assert.equal(rows.pagesScanned,2);
failSecond=true;await assert.rejects(readEntries(client),/tidak dapat dihubungi/);client.close();
const edit=(_,note)=>`<form method="post" action="/verifikasi/update"><input name="hllk" value="42"><input name="_token" value="fresh"><textarea name="note">${note}</textarea><input type="hidden" name="verified" value="2"></form>`;
for(const mode of ['saved','not-saved','timeout','forbidden']){let posts=0,saved=false;
const c=new LlkHttp([],{fetch:async(url,options)=>{
 if(options.method==='POST'){posts++;const fields=new URLSearchParams(options.body);assert.equal(fields.get('_token'),'fresh');assert.equal(fields.get('hllk'),'42');assert.equal(fields.get('verified'),'2');assert.equal(fields.get('note'),'Diperiksa');if(mode==='timeout')throw new Error('lost response');if(mode==='forbidden')return new Response('',{status:403});saved=mode==='saved';return new Response('',{status:303,headers:{location:'/verifikasi'}});}
 if(new URL(url).pathname==='/verifikasi')return new Response(`<table><tbody><tr><td><a href="/verifikasi/edit?cid=${saved?'rotated-after':'rotated-before'}">Edit</a></td><td>${saved?'Terverifikasi':'Belum Terverifikasi'}</td></tr></tbody></table>`);
 return new Response(edit('2',saved?'Diperiksa':''));
}});
const [result]=await verifyBatch(c,[{hllk:'42',date:'2026-09-01',editUrl:base+'/verifikasi/edit?cid=synthetic'}],'Diperiksa');assert.equal(result.success,mode==='saved');assert.equal(posts,1);if(['timeout','not-saved'].includes(mode))assert.equal(result.uncertain,true);c.close();}
console.log('PASS HTTP: all-page dates; page failure never empty; verification fresh CSRF/target, persisted status+note required; no POST retry on timeout/403.');
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
