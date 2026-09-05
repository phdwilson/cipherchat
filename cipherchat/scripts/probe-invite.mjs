const BASE='http://127.0.0.1:3100'
import { webcrypto as crypto } from 'node:crypto'
const enc=new TextEncoder()
function toHex(b){return Array.from(b).map(x=>x.toString(16).padStart(2,'0')).join('')}
async function pbkdf2(p,s,i){const b=await crypto.subtle.importKey('raw',enc.encode(p),'PBKDF2',false,['deriveBits']);return new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:enc.encode(s),iterations:i},b,256))}
const auth=toHex(await pbkdf2('ProbePw#1','cipherchat:auth:probech1',120000))
const s=await fetch(BASE+'/api/chat/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({channelId:'probech1',authHash:auth,pubId:'probepubid00001'})})
console.log('session',s.status)
const {token}=await s.json()
const r=await fetch(BASE+'/api/chat/invite',{method:'POST',headers:{'content-type':'application/json','x-session-token':token},body:JSON.stringify({channelId:'probech1',password:'',ttlMs:3600000,maxUses:3})})
console.log('invite',r.status)
console.log(JSON.stringify(r.headers).slice(0,200))
const t=await r.text(); console.log('body:',t.slice(0,300))
