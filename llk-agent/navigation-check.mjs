import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
import {browserLaunchOptions} from './browser.mjs';
const source=await readFile(new URL('./server.js',import.meta.url),'utf8');
const base='https://llk.mahkamahagung.go.id';
const open=new Function('LLK_BASE',source.slice(source.indexOf('async function openLlkCreateForm('),source.indexOf('\nasync function resolveLlkSupervisor('))+';return openLlkCreateForm;')(base);
const browser=await chromium.launch({...browserLaunchOptions(),headless:true});
try{
 const page=await browser.newPage();
 await page.route(base+'/**',route=>{const request=route.request(),path=new URL(request.url()).pathname;if(path!=='/'&&!request.headers().referer)return route.fulfill({status:302,headers:{location:base+'/'}});return route.fulfill({contentType:'text/html',body:path==='/llk/create'?'<input id="snip">':`<a style="display:none" href="/llk">LLK</a><a style="display:none" href="/llk/create">Create</a>`});});
 await open(page);
 assert.equal(page.url(),base+'/llk/create');
 assert.equal(await page.locator('#snip').count(),1);
 console.log('PASS: form opens despite unclickable navigation links; no production requests.');
}finally{await browser.close();}
