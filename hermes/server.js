'use strict';
// Hermes server: accounts, journals, trades, MT5 ingest and the web app. No dependencies.
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const PORT=+process.env.PORT||3000,ADMIN=(process.env.ADMIN_EMAIL||'').toLowerCase();
const FILE=process.env.DATA_FILE||path.join(__dirname,'data','hermes.json');
fs.mkdirSync(path.dirname(FILE),{recursive:true});
let db={secret:'',users:{},journals:{},feedback:[],resets:{}};
// Storage: Upstash Redis (REST, free tier) when configured, otherwise a local JSON file.
const UR=(process.env.UPSTASH_REDIS_REST_URL||'').replace(/\/$/,''),UT=process.env.UPSTASH_REDIS_REST_TOKEN||'',zlib=require('zlib');
const useRedis=!!(UR&&UT);let written={};
async function redis(cmds){const r=await fetch(UR+'/pipeline',{method:'POST',headers:{Authorization:'Bearer '+UT,'Content-Type':'application/json'},body:JSON.stringify(cmds)});if(!r.ok)throw new Error('Redis '+r.status);const o=await r.json();for(const x of o)if(x.error)throw new Error(x.error);return o}
const pack=o=>zlib.gzipSync(o).toString('base64'),unpack=s=>zlib.gunzipSync(Buffer.from(s,'base64')).toString();
function parts(){const m={'hermes:meta':{secret:db.secret,feedback:db.feedback,resets:db.resets}};for(const[e,u]of Object.entries(db.users))m['hermes:u:'+e]=u;for(const[i,j]of Object.entries(db.journals))m['hermes:j:'+i]=j;return m}
async function loadAll(){
 if(!useRedis){try{db=Object.assign(db,JSON.parse(fs.readFileSync(FILE,'utf8')))}catch(e){}db.resets=db.resets||{};return}
 let cur='0';const keys=[];
 do{const r=await redis([['SCAN',cur,'MATCH','hermes:*','COUNT','500']]);cur=String(r[0].result[0]);keys.push(...r[0].result[1])}while(cur!=='0');
 for(let i=0;i<keys.length;i+=50){const ks=keys.slice(i,i+50),rs=await redis(ks.map(k=>['GET',k]));
  rs.forEach((x,n)=>{if(!x.result)return;const k=ks[n],raw=unpack(x.result),o=JSON.parse(raw);written[k]=raw;
   if(k==='hermes:meta'){db.secret=o.secret||'';db.feedback=o.feedback||[];db.resets=o.resets||{}}
   else if(k.startsWith('hermes:u:'))db.users[k.slice(9)]=o;else if(k.startsWith('hermes:j:'))db.journals[k.slice(9)]=o})}
}
async function doFlush(){
 if(!useRedis){const t=FILE+'.tmp';fs.writeFileSync(t,JSON.stringify(db));fs.renameSync(t,FILE);return}
 const m=parts(),cmds=[],nw={};
 for(const k in m){const raw=JSON.stringify(m[k]);if(written[k]!==raw){cmds.push(['SET',k,pack(raw)]);nw[k]=raw}}
 const del=Object.keys(written).filter(k=>!(k in m));del.forEach(k=>cmds.push(['DEL',k]));
 for(let i=0;i<cmds.length;i+=50)await redis(cmds.slice(i,i+50));
 Object.assign(written,nw);del.forEach(k=>delete written[k]);
}
let chain=Promise.resolve(),timer=null;
const flush=()=>chain=chain.then(doFlush).catch(e=>console.error('Save failed:',e.message));
const save=()=>{clearTimeout(timer);timer=setTimeout(flush,200)};
['SIGINT','SIGTERM'].forEach(s=>process.on(s,async()=>{await flush();process.exit(0)}));

function normEmail(e){e=String(e).trim().toLowerCase();let[l,d]=e.split('@');if(d==='googlemail.com')d='gmail.com';if(d==='gmail.com')l=l.split('+')[0].replace(/\./g,'');return l+'@'+d}
const uid=()=>crypto.randomBytes(8).toString('hex');
const hmac=b=>crypto.createHmac('sha256',db.secret).update(b).digest('base64url');
const sign=p=>{const b=Buffer.from(JSON.stringify(p)).toString('base64url');return b+'.'+hmac(b)};
function verify(tok){const[b,s]=String(tok||'').split('.');if(!b||!s)return null;const e=hmac(b);
 if(e.length!==s.length||!crypto.timingSafeEqual(Buffer.from(e),Buffer.from(s)))return null;
 try{const p=JSON.parse(Buffer.from(b,'base64url'));return p.exp>Date.now()?p:null}catch{return null}}
const hashPw=(pw,salt)=>crypto.scryptSync(pw,salt,64).toString('hex');
const hits=new Map();
function limited(ip){const n=Date.now(),h=hits.get(ip)||{c:0,r:n+9e5};if(n>h.r){h.c=0;h.r=n+9e5}h.c++;hits.set(ip,h);return h.c>20}

const tls=require('tls');
// Minimal SMTP client (implicit TLS, port 465). Without SMTP_HOST the message is printed to the console instead.
function sendMail(to,subject,text){
 const E=process.env;
 if(E.BREVO_API_KEY){const from=E.BREVO_SENDER||E.MAIL_FROM||E.SUPPORT_EMAIL||E.ADMIN_EMAIL;
  return fetch(E.BREVO_URL||'https://api.brevo.com/v3/smtp/email',{method:'POST',headers:{'api-key':E.BREVO_API_KEY,'content-type':'application/json',accept:'application/json'},body:JSON.stringify({sender:{name:'Hermes',email:from},to:[{email:to}],subject,textContent:text})}).then(async r=>{if(!r.ok)throw new Error('Brevo '+r.status+' '+(await r.text()).slice(0,150))})}
 if(!E.SMTP_HOST){console.log('[Hermes mail not configured] To: '+to+' | '+text);return Promise.resolve()}
 const from=E.MAIL_FROM||E.SMTP_USER,b64=x=>Buffer.from(x).toString('base64');
 const msg='From: Hermes <'+from+'>\r\nTo: '+to+'\r\nSubject: '+subject+'\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n'+text.replace(/\r?\n/g,'\r\n');
 const cmds=['EHLO hermes','AUTH LOGIN',b64(E.SMTP_USER),b64(E.SMTP_PASS),'MAIL FROM:<'+from+'>','RCPT TO:<'+to.replace(/[<>\r\n]/g,'')+'>','DATA',msg+'\r\n.','QUIT'];
 const want=[220,250,334,334,235,250,250,354,250,221];
 return new Promise((ok,no)=>{
  const s=tls.connect({host:E.SMTP_HOST,port:+(E.SMTP_PORT||465),servername:E.SMTP_HOST});
  let buf='',i=0,t;const end=e=>{clearTimeout(t);s.destroy();e?no(e):ok()};
  t=setTimeout(()=>end(new Error('SMTP timeout')),15000);
  s.on('error',end);
  s.on('data',d=>{buf+=d;if(!buf.endsWith('\r\n'))return;const ls=buf.trim().split('\r\n'),last=ls[ls.length-1];if(!/^\d{3} /.test(last))return;buf='';
   if(+last.slice(0,3)!==want[i])return end(new Error('SMTP '+last));
   if(i===want.length-1)return end();
   s.write(cmds[i]+'\r\n');i++});
 });
}
const mailText=c=>'Your Hermes verification code is '+c+'.\nIt expires in 10 minutes. If you did not ask for it, ignore this email and your account stays safe.';
function issueCode(email){const code=String(crypto.randomInt(0,1e6)).padStart(6,'0');db.resets[email]={h:hmac(email+':'+code),exp:Date.now()+6e5,tries:0,last:Date.now()};save();return code}
function checkCode(email,code){const r=db.resets[email];
 if(!r||Date.now()>r.exp)throw fail(400,'That code has expired. Request a new one.');
 if(++r.tries>5){delete db.resets[email];save();throw fail(429,'Too many wrong attempts. Request a new code.')}
 const a=Buffer.from(hmac(email+':'+String(code==null?'':code).trim())),b=Buffer.from(r.h);
 if(a.length!==b.length||!crypto.timingSafeEqual(a,b)){save();throw fail(400,'That code is not correct.')}
 delete db.resets[email];save()}
function setPw(u,pw){if(pw.length<8)throw fail(400,'Password must be at least 8 characters');u.salt=crypto.randomBytes(16).toString('hex');u.hash=hashPw(pw,u.salt);u.pwv=(u.pwv||0)+1;save()}
const tokenFor=e=>sign({u:e,v:db.users[e].pwv||0,exp:Date.now()+30*864e5});
const CATS=['Forex','Indices','Metals','Crypto','Commodities','Stocks','Other'];
function guess(sym){const s=sym.toUpperCase().replace(/[^A-Z0-9]/g,'');
 if(/^(XAU|XAG|XPT|XPD)/.test(s))return'Metals';
 if(/(BTC|ETH|LTC|XRP|SOL|DOGE|ADA|BNB)/.test(s))return'Crypto';
 if(/(US30|US500|US100|NAS|SPX|NDX|DJ|GER|DAX|UK100|FTSE|JP225|NIK|HK50|FRA40|AUS200|USTEC|DE40|DE30|EU50|VIX)/.test(s))return'Indices';
 if(/(OIL|WTI|BRENT|UKO|USO|NGAS|NATGAS|COPPER|COFFEE|COCOA|SUGAR|WHEAT|CORN)/.test(s))return'Commodities';
 const cur='USD EUR GBP JPY CHF CAD AUD NZD SEK NOK DKK PLN MXN ZAR TRY SGD HKD CNH HUF CZK'.split(' ');
 if(s.length>=6&&cur.includes(s.slice(0,3))&&cur.includes(s.slice(3,6)))return'Forex';
 return /^[A-Z]{1,5}$/.test(s)?'Stocks':'Other'}
const num=v=>{const n=parseFloat(v);return Number.isFinite(n)?n:0};
const str=(v,n=60)=>String(v==null?'':v).slice(0,n);
function norm(x){const symbol=str(x.symbol,20).toUpperCase();
 if(!symbol||!Number.isFinite(parseFloat(x.pnl)))return null;
 return{id:uid(),ticket:str(x.ticket,30),symbol,cat:CATS.includes(x.cat)?x.cat:guess(symbol),side:x.side==='sell'?'sell':'buy',vol:num(x.vol),po:str(x.po,20),pc:str(x.pc,20),opened:str(x.opened,25),closed:str(x.closed,25),pnl:num(x.pnl),notes:str(x.notes,500)}}
function addTrades(j,list){const have=new Set(j.trades.filter(t=>t.ticket).map(t=>t.ticket));let added=0,skipped=0;
 for(const x of (Array.isArray(list)?list:[]).slice(0,5000)){const t=norm(x||{});if(!t)continue;
  if(t.ticket&&have.has(t.ticket)){skipped++;continue}if(t.ticket)have.add(t.ticket);j.trades.push(t);added++}
 if(added)save();return{added,skipped}}

const readBody=req=>new Promise((ok,no)=>{let b='';req.on('data',c=>{b+=c;if(b.length>2e6){no(new Error('Too large'));req.destroy()}});
 req.on('end',()=>{try{ok(b?JSON.parse(b):{})}catch{no(new Error('Bad JSON'))}})});
const send=(res,c,o)=>{res.writeHead(c,{'Content-Type':'application/json'});res.end(JSON.stringify(o))};
const fail=(c,m)=>Object.assign(new Error(m),{code:c});

const server=http.createServer(async(req,res)=>{
 try{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  const p=new URL(req.url,'http://x').pathname,m=req.method,ip=req.socket.remoteAddress;
  if(p==='/healthz'){res.writeHead(200);return res.end('ok')}
  if(!p.startsWith('/api/')){
   if(m==='GET'&&(p==='/'||p==='/index.html')){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end(fs.readFileSync(path.join(__dirname,'public','index.html')))}
   res.writeHead(404);return res.end('Not found')}
  const b=m==='GET'?{}:await readBody(req);
  const user=()=>{const v=verify((req.headers.authorization||'').replace('Bearer ',''));return v&&db.users[v.u]&&(db.users[v.u].pwv||0)===(v.v||0)?db.users[v.u]:null};
  const need=()=>user()||(()=>{throw fail(401,'Please log in')})();
  const jr=id=>{const u=need(),j=db.journals[id];if(!j||j.owner!==u.email)throw fail(404,'Journal not found');return j};

  if(p==='/api/register'||p==='/api/login'){
   if(limited(ip))throw fail(429,'Too many attempts. Try again in a few minutes.');
   const raw=str(b.email,120).trim(),pw=str(b.password,200);
   if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw))throw fail(400,'Enter a valid email address');
   const email=normEmail(raw);
   if(p==='/api/register'){
    if(pw.length<8)throw fail(400,'Password must be at least 8 characters');
    if(db.users[email])throw fail(409,'This email already has an account. Please log in instead.');
    const salt=crypto.randomBytes(16).toString('hex');db.users[email]={email,salt,hash:hashPw(pw,salt),created:Date.now()};save();
   }else{
    const u=db.users[email];
    if(!u||!crypto.timingSafeEqual(Buffer.from(hashPw(pw,u.salt)),Buffer.from(u.hash)))throw fail(401,'Wrong email or password');
   }
   return send(res,200,{token:tokenFor(email),email});
  }
  if(p==='/api/forgot'&&m==='POST'){
   if(limited(ip))throw fail(429,'Too many attempts. Try again in a few minutes.');
   const raw=str(b.email,120).trim();if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw))throw fail(400,'Enter a valid email address');
   const email=normEmail(raw),r0=db.resets[email];
   if(db.users[email]&&!(r0&&Date.now()-r0.last<45e3)){const c=issueCode(email);sendMail(raw,'Your Hermes verification code',mailText(c)).catch(e=>console.error('Mail failed:',e.message))}
   return send(res,200,{ok:true});
  }
  if(p==='/api/reset'&&m==='POST'){
   if(limited(ip))throw fail(429,'Too many attempts. Try again in a few minutes.');
   const email=normEmail(str(b.email,120)),u=db.users[email];
   if(!u)throw fail(400,'That code is not correct.');
   checkCode(email,b.code);setPw(u,str(b.password,200));return send(res,200,{token:tokenFor(email),email});
  }
  if(p==='/api/password/code'&&m==='POST'){const u=need(),r0=db.resets[u.email];
   if(r0&&Date.now()-r0.last<45e3)throw fail(429,'Please wait a minute before asking for another code.');
   const c=issueCode(u.email);try{await sendMail(u.email,'Your Hermes verification code',mailText(c))}catch(e){console.error('Mail failed:',e.message);throw fail(502,'Could not send the email. Try again later.')}
   return send(res,200,{ok:true});
  }
  if(p==='/api/password/change'&&m==='POST'){const u=need();checkCode(u.email,b.code);setPw(u,str(b.password,200));return send(res,200,{token:tokenFor(u.email)})}
  if(p==='/api/journals'&&m==='GET'){const u=need();return send(res,200,{journals:Object.values(db.journals).filter(j=>j.owner===u.email)})}
  if(p==='/api/journals'&&m==='POST'){const u=need(),name=str(b.name,80).trim();if(!name)throw fail(400,'Journal name is required');
   const j={id:uid(),owner:u.email,name,account:str(b.account,20).trim(),broker:str(b.broker,60),balance:num(b.balance),currency:str(b.currency,6).toUpperCase(),apiKey:crypto.randomBytes(24).toString('hex'),trades:[]};
   db.journals[j.id]=j;save();return send(res,200,j)}
  let r=p.match(/^\/api\/journals\/(\w+)$/);
  if(r&&m==='DELETE'){jr(r[1]);delete db.journals[r[1]];save();return send(res,200,{ok:true})}
  r=p.match(/^\/api\/journals\/(\w+)\/trades$/);
  if(r&&m==='POST')return send(res,200,addTrades(jr(r[1]),b.trades));
  r=p.match(/^\/api\/journals\/(\w+)\/trades\/(\w+)$/);
  if(r&&m==='DELETE'){const j=jr(r[1]);j.trades=j.trades.filter(t=>t.id!==r[2]);save();return send(res,200,{ok:true})}
  if(p==='/api/ea/trades'&&m==='POST'){
   if(limited('ea'+ip))throw fail(429,'Slow down');
   const key=str(req.headers['x-hermes-key'],80),j=Object.values(db.journals).find(x=>x.apiKey===key);
   if(!key||!j)throw fail(401,'Unknown journal key');
   const acc=str(b.account,20);
   if(j.account&&acc&&j.account!==acc)throw fail(409,'This key belongs to MT5 account '+j.account+', not '+acc);
   if(!j.account&&acc){j.account=acc;save()}
   return send(res,200,addTrades(j,b.trades));
  }
  if(p==='/api/feedback'&&m==='POST'){const u=user(),msg=str(b.msg,2000).trim();if(!msg)throw fail(400,'Write a message first');
   const fb={type:str(b.type,20).replace(/[\r\n]/g,' '),msg,contact:str(b.contact,80),email:u?u.email:'',ts:Date.now()};db.feedback.push(fb);save();
   const to=process.env.SUPPORT_EMAIL||process.env.ADMIN_EMAIL;
   if(to)sendMail(to,'Hermes feedback: '+fb.type,'Type: '+fb.type+'\nFrom account: '+(fb.email||'not logged in')+'\nContact: '+(fb.contact||'none given')+'\n\n'+fb.msg).catch(e=>console.error('Feedback mail failed:',e.message));
   return send(res,200,{ok:true})}
  if(p==='/api/feedback'&&m==='GET'){const u=need();if(!ADMIN||u.email!==normEmail(ADMIN))throw fail(403,'Not allowed');return send(res,200,{feedback:db.feedback})}
  throw fail(404,'Not found');
 }catch(e){send(res,e.code||500,{error:e.code?e.message:'Server error'});if(!e.code)console.error(e)}
});
async function boot(){
 try{await loadAll()}catch(e){console.error('Could not load data:',e.message);process.exit(1)}
 if(!db.secret)db.secret=crypto.randomBytes(32).toString('hex');
 await flush();
 server.listen(PORT,()=>console.log('Hermes running on port '+PORT+' ('+(useRedis?'Upstash storage':'file storage')+')'));
}
boot();
