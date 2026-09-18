import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {chromium} from 'playwright-core';
import {browserLaunchOptions} from './browser.mjs';
const source=await readFile(new URL('./server.js',import.meta.url),'utf8');
let token=0, reject=false; const sent=[];
const server=createServer(async(req,res)=>{
 if(req.method==='POST'){let body='';for await(const chunk of req)body+=chunk;const fields=new URLSearchParams(body);sent.push(fields.get('activity_date'));if(fields.get('_token')!==String(token)||(reject&&sent.length===2)){res.writeHead(403);res.end();return;}token++;res.writeHead(303,{Location:'/llk'});res.end();return;}
 res.setHeader('Content-Type','text/html');res.end(`<input name="_token" value="${token}">`);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({...browserLaunchOptions(),headless:true});
try{for(const rejection of [false,true]){
 reject=rejection;token=1;sent.length=0;const context=await browser.newContext();
 const deps={validatePreview:async v=>v,bad:m=>{throw Error(m)},launchEmployee:async()=>({employee:{id:'test',name:'Test',nip:'199001012020011001',position:'Test',supervisor:{nip:'198001012010011001'}},context}),scrapeEntries:async()=>[],saveJson:async()=>{},reportFile:()=>'',HttpError:Error,employeeId:String,openLlkCreateForm:p=>p.goto(base),resolveLlkSupervisor:async()=>({id:'one',nip:'198001012010011001',name:'Examiner'}),extractCsrfToken:p=>p.locator('[name=_token]').inputValue(),LLK_BASE:base,calendarEntries:new Map(),clean:String,storeSessionCookies:()=>{}};
 const events=[];deps.progress=(id,stage,message,detail)=>events.push({stage,message,...detail});
 const code=source.slice(source.indexOf('function submissionResponseInfo('),source.indexOf('\nfunction slug('));
 const run=new Function(...Object.keys(deps),code+';return submitPreview;')(...Object.values(deps));
 const result=await run('test',['14','15','16'].map(d=>({date:`2026-09-${d}`,items:[{start:'08:00',end:'16:30',description:'Local check',type:'Utama',result:'Selesai'}]})),'skip');
 assert.equal(result.success,rejection?1:3);assert.equal(sent.length,rejection?2:3);
 assert.equal(events.filter(event=>event.stage==='send-result'&&event.status==='Selesai').length,result.success);
 assert.equal(events.filter(event=>event.stage==='send-result'&&event.status==='Gagal').length,rejection?1:0);
 if(rejection){assert.equal(result.results[1].httpStatus,403);assert.equal(result.results[2].status,'not_attempted');}
}console.log('PASS: rotating CSRF permits consecutive dates; 403 stops without retry and leaves later dates unsubmitted.');}
finally{await browser.close();await new Promise(r=>server.close(r));}
