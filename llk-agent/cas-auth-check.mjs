import assert from 'node:assert/strict';
import { CasAuth } from './cas-auth.mjs';
const form=(field,execution)=>`<p>${field==='password'?'Login':'Google Authenticator'}</p><form method="post" action="login"><input type="hidden" name="execution" value="${execution}"><input type="hidden" name="_eventId" value="submit">${field==='token'?'<input type="hidden" id="accountId" name="accountId" value=""><script>var accountId = 12345; var el = document.getElementById(\'accountId\'); if (el && accountId) el.value = accountId;</script>':''}<input name="${field}" type="${field==='password'?'password':'text'}"></form>`;
let submissions=0;
const auth=new CasAuth({fetch:async(url,options)=>{
 const u=new URL(url);
 if(u.hostname.startsWith('llk')&&u.pathname==='/profile')return new Response('<h1>Profil</h1><p>NIP 199001012020011001</p>');
 if(u.hostname.startsWith('llk')&&u.searchParams.has('ticket'))return new Response('',{status:302,headers:{location:'/', 'set-cookie':'PHPSESSID=authenticated; Path=/; Secure; HttpOnly'}});
 if(u.hostname.startsWith('llk'))return options.headers.cookie?.includes('authenticated')?new Response('<p>LLK</p>'):new Response('',{status:302,headers:{location:'https://sso.mahkamahagung.go.id/cas/login?service=https%3A%2F%2Fllk.mahkamahagung.go.id%2F'}});
 if(options.method==='POST'){
  assert.equal(u.searchParams.get('service'),'https://llk.mahkamahagung.go.id/');
  const fields=new URLSearchParams(options.body);submissions++;
  if(submissions===1){assert.equal(fields.get('execution'),'first');return new Response(form('token','second'),{headers:{'set-cookie':'MFA=pending; Path=/cas; Secure; HttpOnly'}});}
  assert.match(options.headers.cookie,/MFA=pending/);
  assert.equal(fields.get('accountId'),'12345','CAS MFA account selected by inline script must be submitted');
  if(submissions===2){assert.equal(fields.get('execution'),'second');return new Response(form('token','third'));}
  assert.equal(fields.get('execution'),'third');return new Response('',{status:303,headers:{location:'https://llk.mahkamahagung.go.id/?ticket=ST-synthetic'}});
 }
 return new Response(form('password','first'));
}});
assert.equal((await auth.login('synthetic','not-real')).stage,'authenticator');
await assert.rejects(auth.verify('123456'),error=>error.status===422);
assert.equal(auth.state.stage,'authenticator');
assert.equal((await auth.verify('654321')).stage,'authenticated');
assert.equal(auth.cookies().find(c=>c.name==='PHPSESSID').httpOnly,true);
assert.equal(auth.cookies().find(c=>c.name==='PHPSESSID').domain,'llk.mahkamahagung.go.id');
auth.close();await assert.rejects(auth.verify('123456'),error=>error.status===401);
let postSeen=false;
const blocked=new CasAuth({fetch:async(url,options)=>{if(options.method==='POST'){postSeen=true;return new Response('',{status:307,headers:{location:'https://llk.mahkamahagung.go.id/'}});}if(new URL(url).hostname.startsWith('llk'))return new Response('',{status:302,headers:{location:'https://sso.mahkamahagung.go.id/cas/login?service=llk'}});return new Response(form('password','first'));}});
await assert.rejects(blocked.login('synthetic','not-real'),error=>error.status===502&&/domain lain/.test(error.message));assert.equal(postSeen,true);blocked.close();
console.log('PASS CAS: MFA retry rotates execution; service ticket creates protected LLK session; cookie attributes retained; cancellation; credential redirect blocked. Synthetic upstream, no real credentials.');
