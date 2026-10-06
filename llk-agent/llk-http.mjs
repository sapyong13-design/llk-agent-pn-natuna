import { load } from 'cheerio';
import { CasAuth } from './cas-auth.mjs';
const BASE='https://llk.mahkamahagung.go.id/';
function error(status,message){return Object.assign(new Error(message),{status});}
export class LlkHttp {
 constructor(cookies,{fetch:transport=globalThis.fetch}={}){
  this.auth=new CasAuth({fetch:transport});this.auth.expires=Infinity;this.transport=transport;
  for(const cookie of cookies||[]){const domain=cookie.domain.replace(/^\./,'');if(domain!=='llk.mahkamahagung.go.id')continue;this.auth.jar.set(`${domain}|${cookie.path}|${cookie.name}`,{...cookie,domain,hostOnly:!cookie.domain.startsWith('.')});}
 }
 close(){this.auth.close();}
 cookies(){return this.auth.cookies();}
 target(path){const url=new URL(path,BASE);if(url.origin!==new URL(BASE).origin)throw error(400,'Tujuan HTTP LLK tidak valid.');return url;}
 async request(path,options={}){
  this.auth.assertOpen();const url=this.target(path);let response;
  try{response=await this.transport(url,{...options,headers:{accept:'text/html,application/json','user-agent':'Mozilla/5.0',referer:BASE,...options.headers,cookie:this.auth.header(url)},redirect:'manual',signal:AbortSignal.any([this.auth.controller.signal,AbortSignal.timeout(60_000)])});this.auth.assertOpen();this.auth.store(response,url);}
  catch(cause){if(cause.status)throw cause;throw error(502,options.method==='POST'?'Respons kirim LLK belum pasti. Periksa status sebelum mencoba lagi.':'LLK tidak dapat dihubungi. Coba lagi.');}
  const html=await response.text();if(html.length>10_000_000)throw error(502,'Respons LLK terlalu besar.');
  return {url,response,html,$:load(html)};
 }
 async get(path,referer=BASE){
  let url=this.target(path);const visited=new Set();
  for(let count=0;count<10;count++){
   if(visited.has(url.href))throw error(502,'Redirect LLK berulang.');visited.add(url.href);
   const page=await this.request(url,{headers:{referer:this.target(referer).href}});
   if([301,302,303,307,308].includes(page.response.status)){
    const location=page.response.headers.get('location');if(!location)throw error(502,'Redirect LLK tanpa tujuan.');const next=new URL(location,url);
    if(next.origin!==new URL(BASE).origin||/^\/(?:sso|login)(?:\/|$)/i.test(next.pathname))throw error(401,'Sesi LLK kedaluwarsa. Login ulang diperlukan.');url=next;continue;
   }
   if(page.response.status!==200)throw error(page.response.status===403?403:502,`Pembacaan LLK gagal: HTTP ${page.response.status}.`);
   if(page.$('input[name="password"]').length)throw error(401,'Sesi LLK kedaluwarsa. Login ulang diperlukan.');return page;
  }throw error(502,'Redirect LLK terlalu banyak.');
 }
 async post(path,fields,referer){
  if(!(fields instanceof URLSearchParams))throw error(400,'Form LLK tidak valid.');
  return this.request(path,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',origin:new URL(BASE).origin,referer:this.target(referer).href},body:fields.toString()});
 }
}
export function formFields($,form){
 const fields=new URLSearchParams();
 $(form).find('input[name],select[name],textarea[name]').each((_,node)=>{const el=$(node),name=el.attr('name'),type=(el.attr('type')||'').toLowerCase();if(el.is('[disabled]')||['submit','button','reset','file'].includes(type)||(['checkbox','radio'].includes(type)&&!el.is('[checked]')))return;if(node.tagName==='select'){const selected=el.find('option[selected]');const options=selected.length?selected:el.find('option').first();options.each((_,option)=>fields.append(name,$(option).attr('value')??$(option).text()));}else fields.append(name,el.val()??'');});return fields;
}
