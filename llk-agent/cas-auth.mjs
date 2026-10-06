const LLK = 'https://llk.mahkamahagung.go.id/';
const HOSTS = new Set(['llk.mahkamahagung.go.id', 'sso.mahkamahagung.go.id']);
const decode = text => text.replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(+n));
const attributes = tag => Object.fromEntries([...tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(x=>[x[1].toLowerCase(),decode(x[2]??x[3])]));
function failure(status,message){return Object.assign(new Error(message),{status});}
function target(value){const url=new URL(value);if(url.protocol!=='https:'||!HOSTS.has(url.hostname)||(url.port&&url.port!=='443'))throw failure(502,'SSO mengarahkan ke tujuan tidak didukung. Login dihentikan.');return url;}
function forms(html){return (html.match(/<form\b[\s\S]*?<\/form>/gi)||[]).map(form=>{
 const inputs=(form.match(/<input\b[^>]*>/gi)||[]).map(attributes);
 const account=inputs.find(input=>input.name==='accountId'&&input.type==='hidden');
 if(account&&!account.value){
  // CAS assigns this hidden field in inline JavaScript. Read only its numeric literal; never execute upstream code.
  const id=form.match(/\b(?:var|let|const)\s+accountId\s*=\s*(\d+)\s*;/)?.[1];
  if(id&&/getElementById\(['"]accountId['"]\)/.test(form)&&/el\.value\s*=\s*accountId/.test(form))account.value=id;
 }
 return {attributes:attributes(form.match(/<form\b[^>]*>/i)[0]),inputs};
});}
function identify(html){
 const all=forms(html);
 const password=all.find(form=>form.inputs.some(input=>input.name==='password'));
 if(password)return {kind:'password',form:password};
 const challenge=all.find(form=>form.inputs.some(input=>['token','otp','code','totp','verificationCode','authenticatorCode'].includes(input.name)&&input.type!=='hidden'));
 if(challenge&&/authenticator|google authenticator|one.time|one time|verification code|kode|totp/i.test(html.replace(/<script\b[\s\S]*?<\/script>/gi,'')))return {kind:'authenticator',form:challenge};
 return {kind:'unsupported'};
}
export class CasAuth {
 constructor({fetch:transport=globalThis.fetch}={}){this.transport=transport;this.jar=new Map();this.state={stage:'initial',message:''};this.closed=false;this.expires=Date.now()+10*60_000;this.controller=new AbortController();}
 close(){this.closed=true;this.controller.abort();this.jar.clear();this.page=null;this.state={stage:'closed',message:'Sesi login berakhir.'};}
 assertOpen(){if(this.closed||Date.now()>this.expires){this.close();throw failure(401,'Sesi login berakhir. Login kembali.');}}
 cookies(){this.assertOpen();return [...this.jar.values()].filter(c=>c.expires===-1||c.expires>Date.now()/1000).map(({hostOnly,...cookie})=>({...cookie,domain:hostOnly?cookie.domain:'.'+cookie.domain}));}
 header(url){return [...this.jar.values()].filter(c=>(c.expires===-1||c.expires>Date.now()/1000)&&(url.hostname===c.domain||(!c.hostOnly&&url.hostname.endsWith('.'+c.domain)))&&(url.pathname===c.path||url.pathname.startsWith(c.path.endsWith('/')?c.path:c.path+'/'))).map(c=>`${c.name}=${c.value}`).join('; ');}
 store(response,url){
  for(const raw of response.headers.getSetCookie()){
   const [pair,...parts]=raw.split(';'),split=pair.indexOf('=');if(split<1)continue;
   const cookie={name:pair.slice(0,split),value:pair.slice(split+1),domain:url.hostname,hostOnly:true,path:url.pathname.slice(0,url.pathname.lastIndexOf('/')+1)||'/',expires:-1,httpOnly:false,secure:false,sameSite:'Lax'};
   for(const part of parts){const pos=part.indexOf('='),key=(pos<0?part:part.slice(0,pos)).trim().toLowerCase(),value=pos<0?'':part.slice(pos+1).trim();
    if(key==='domain'){cookie.domain=value.replace(/^\./,'').toLowerCase();cookie.hostOnly=false;}
    if(key==='path'&&value.startsWith('/'))cookie.path=value;
    if(key==='expires'&&Number.isFinite(Date.parse(value)))cookie.expires=Date.parse(value)/1000;
    if(key==='httponly')cookie.httpOnly=true;if(key==='secure')cookie.secure=true;
    if(key==='samesite'&&/^(lax|strict|none)$/i.test(value))cookie.sameSite=value[0].toUpperCase()+value.slice(1).toLowerCase();
   }
   const age=parts.find(part=>/^\s*max-age=/i.test(part));if(age&&/^-?\d+$/.test(age.split('=')[1]))cookie.expires=Date.now()/1000+Number(age.split('=')[1]);
   // Only official exact-host cookie domains; never accept parent-domain cookies from either site.
   if(!HOSTS.has(cookie.domain)||(url.hostname!==cookie.domain&&!url.hostname.endsWith('.'+cookie.domain)))continue;
   const key=`${cookie.domain}|${cookie.path}|${cookie.name}`;
   if(cookie.expires!==-1&&cookie.expires<=Date.now()/1000)this.jar.delete(key);else this.jar.set(key,cookie);
  }
 }
 async request(value,options={}){
  this.assertOpen();const url=target(value),cookie=this.header(url);
  try{const response=await this.transport(url,{...options,headers:{...options.headers,...(cookie?{cookie}:{})},redirect:'manual',signal:AbortSignal.any([this.controller.signal,AbortSignal.timeout(30_000)])});this.assertOpen();this.store(response,url);const html=await response.text();if(html.length>2_000_000)throw failure(502,'Respons SSO terlalu besar.');if(response.status>=400)throw failure(502,`Layanan SSO/LLK merespons HTTP ${response.status}. Coba lagi nanti.`);return {url,response,html};}
  catch(error){if(error.status)throw error;throw failure(this.closed?401:502,this.closed?'Sesi login berakhir. Login kembali.':'SSO/LLK tidak dapat dihubungi. Coba lagi.');}
 }
 async follow(value,options={}){
  for(let i=0;i<12;i++){
   const page=await this.request(value,options);if(![301,302,303,307,308].includes(page.response.status))return page;
   const location=page.response.headers.get('location');if(!location)throw failure(502,'Redirect SSO tidak valid.');
   const next=target(new URL(location,page.url));
   if([307,308].includes(page.response.status)&&options.method==='POST'&&next.origin!==page.url.origin)throw failure(502,'SSO mencoba meneruskan formulir ke domain lain. Login dihentikan.');
   if([301,302,303].includes(page.response.status))options={};value=next;
  }throw failure(502,'Redirect SSO terlalu banyak.');
 }
 async submit(form,values){
  const url=new URL(form.attributes.action||this.page.url.href,this.page.url);
  if(form.attributes.action&&!form.attributes.action.includes('?'))url.search=this.page.url.search;
  target(url);if(url.hostname!=='sso.mahkamahagung.go.id'||url.pathname!=='/cas/login'||(form.attributes.method||'get').toLowerCase()!=='post')throw failure(502,'Form SSO tidak didukung.');
  const fields=new URLSearchParams();for(const input of form.inputs)if(input.type==='hidden'&&input.name)fields.set(input.name,input.value||'');
  if(!fields.get('execution'))throw failure(502,'Token login SSO tidak ditemukan.');
  for(const [name,value]of Object.entries(values))fields.set(name,value);
  const body=fields.toString();fields.delete('password');fields.delete('token');
  return this.follow(url,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',origin:this.page.url.origin,referer:this.page.url.href},body});
 }
 async classify(page,{mfa=false}={}){
  this.page=page;
  if(page.url.hostname==='llk.mahkamahagung.go.id'&&page.response.status===200&&!/\/(sso|login)(?:\/|$)/.test(page.url.pathname)){
   const profile=await this.follow(new URL('/profile',LLK));
   if(profile.url.hostname==='llk.mahkamahagung.go.id'&&profile.url.pathname.replace(/\/$/,'')==='/profile'&&profile.response.status===200&&/\b\d{18}\b/.test(profile.html)&&/profil|profile/i.test(profile.html)&&identify(profile.html).kind!=='password'){
    this.page=null;this.state={stage:'authenticated',message:'Sesi LLK terverifikasi.'};return this.state;
   }
   this.page=profile;
  }
  const next=identify(this.page.html);
  if(next.kind==='authenticator'){
   this.state={stage:'authenticator',message:'Masukkan kode authenticator terbaru.'};
   if(mfa)throw failure(422,'Kode authenticator belum diterima. Masukkan kode terbaru.');
   return this.state;
  }
  if(next.kind==='password'){this.close();throw failure(401,'Login SSO belum diterima. Periksa nama pengguna dan password.');}
  this.close();throw failure(422,'SSO meminta tahap yang belum didukung (misalnya pendaftaran MFA atau pilihan metode). Gunakan situs SSO resmi untuk menyelesaikannya.');
 }
 async login(username,password){
  this.assertOpen();if(this.state.stage!=='initial')throw failure(409,'Login sudah dimulai.');
  if(typeof username!=='string'||!username.trim()||typeof password!=='string'||!password)throw failure(400,'Nama pengguna dan password wajib diisi.');
  this.page=await this.follow(LLK);if(this.page.url.hostname==='llk.mahkamahagung.go.id')this.page=await this.follow(LLK);
  const next=identify(this.page.html);if(next.kind!=='password')throw failure(502,'Form login SSO tidak ditemukan.');
  try{return await this.classify(await this.submit(next.form,{username:username.trim(),password}));}finally{password='';}
 }
 async verify(code){
  this.assertOpen();if(this.state.stage!=='authenticator')throw failure(409,'SSO tidak sedang meminta authenticator.');
  if(typeof code!=='string'||!/^\d{6,8}$/.test(code))throw failure(400,'Kode authenticator harus 6–8 digit.');
  const next=identify(this.page.html);if(next.kind!=='authenticator')throw failure(502,'Form authenticator SSO tidak ditemukan.');
  const field=next.form.inputs.find(input=>['token','otp','code','totp','verificationCode','authenticatorCode'].includes(input.name)&&input.type!=='hidden');
  try{return await this.classify(await this.submit(next.form,{[field.name]:code}),{mfa:true});}finally{code='';}
 }
}
