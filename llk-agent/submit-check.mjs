import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {load} from 'cheerio';
import {randomBytes} from 'node:crypto';
const source=await readFile(new URL('./server.js',import.meta.url),'utf8');
for(const mode of ['saved','forbidden','unconfirmed']){
 let token=0;const sent=[],persisted=[];
 const employee={id:'test',name:'Test',nip:'199001012020011001',position:'Test',supervisor:{nip:'198001012010011001'}};
 const client={post:async(url,fields)=>{assert.equal(fields.get('_token'),String(token));sent.push(fields.get('activity_date'));if(mode==='forbidden'&&sent.length===2)return {response:new Response('',{status:403})};if(mode!=='unconfirmed'){const [d,m,y]=fields.get('activity_date').split('-');persisted.push({date:`${y}-${m}-${d}`,start:'08:00',end:'16:30',description:'Local check',type:'Utama',result:'Selesai'});}return {response:new Response('',{status:303,headers:{location:'/llk'}})};}};
 const deps={validatePreview:async x=>x,bad:m=>{throw Error(m)},findEmployee:async()=>employee,employeeClient:async()=>client,scrapeEntries:async()=>Object.assign([...persisted],{dates:persisted.map(x=>x.date)}),saveJson:async()=>{},reportFile:()=>'',HttpError:Error,employeeId:String,openCreate:async()=>({url:new URL('https://llk.mahkamahagung.go.id/llk/create'),$:load(`<form action="/llk/save"><input name="_token" value="${++token}"></form>`)}),resolveSupervisor:async()=>({id:'one',nip:employee.supervisor.nip,name:'Examiner'}),LLK_BASE:'https://llk.mahkamahagung.go.id',randomBytes,clean:String,progress:()=>{}};
 const code=source.slice(source.indexOf('function submissionResponseInfo('),source.indexOf('\nasync function templateSnapshot('));
 const run=new Function(...Object.keys(deps),code+';return submitPreview;')(...Object.values(deps));
 const result=await run({app:{},calendarEntries:new Map()},'test',['14','15','16'].map(d=>({date:`2026-09-${d}`,items:[{start:'08:00',end:'16:30',description:'Local check',type:'Utama',result:'Selesai'}]})),'skip');
 assert.equal(result.success,mode==='saved'?3:mode==='forbidden'?1:0);assert.equal(sent.length,mode==='saved'?3:mode==='forbidden'?2:1);
 if(mode==='forbidden'){assert.equal(result.results[1].httpStatus,403);assert.equal(result.results[2].status,'not_attempted');}
 if(mode==='unconfirmed'){assert.equal(result.results[0].status,'uncertain');assert.equal(result.results[0].submitted,false);}
}
console.log('PASS HTTP submit: fresh CSRF per date; persisted content required; 403/uncertain stop without retry; later dates not submitted.');
