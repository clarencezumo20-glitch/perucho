'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const WORLD = { width: 1800, height: 1200, walls: [
  {x:300,y:210,w:220,h:70},{x:760,y:150,w:80,h:240},
  {x:1120,y:210,w:300,h:70},{x:240,y:550,w:100,h:240},
  {x:590,y:540,w:250,h:80},{x:1010,y:530,w:80,h:240},
  {x:1370,y:510,w:190,h:80},{x:490,y:930,w:250,h:70},
  {x:1160,y:940,w:250,h:70}
]};
const COLORS=['#ff615e','#5bc8fa','#f4ca62','#86df9a','#c69bff','#ff9fce','#62e0d5','#ffad66','#a3bfff','#d4e875'];
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
const token=()=>crypto.randomBytes(24).toString('hex');
function circleRect(x,y,r,w) { return Math.hypot(x-clamp(x,w.x,w.x+w.w),y-clamp(y,w.y,w.y+w.h)) < r; }
function blocked(x,y,r=18) { return x<r||y<r||x>WORLD.width-r||y>WORLD.height-r||WORLD.walls.some(w=>circleRect(x,y,r,w)); }
function fail(status,message){throw Object.assign(new Error(message),{status})}

function createApp({matchMs=180000,clock=Date.now,autoTick=true}={}) {
  const rooms=new Map(),sessions=new Map(),limits=new Map();
  const html=fs.readFileSync(path.join(__dirname,'public/index.html'));
  let previous=clock(),frame=0;
  function place(room,p,now){
    let candidates=[];
    for(let i=0;i<80;i++){
      const x=50+Math.random()*(WORLD.width-100),y=50+Math.random()*(WORLD.height-100);
      if(blocked(x,y,28))continue;
      let gap=10000;
      for(const other of room.players.values())if(other.id!==p.id&&other.hp>0)gap=Math.min(gap,Math.hypot(x-other.x,y-other.y));
      candidates.push({x,y,gap});
    }
    candidates.sort((a,b)=>b.gap-a.gap);
    Object.assign(p,candidates[0]||{x:80,y:80},{hp:100,respawnAt:0,shieldUntil:now+1800});
    p.input={mx:0,my:0,angle:0,fire:false};
  }
  function addPlayer(room,name){
    if(room.players.size>=10)fail(409,'La sala está llena: máximo 10 jugadores.');
    if(room.state==='playing')fail(409,'La partida ya comenzó. Espera a que termine.');
    const id=crypto.randomUUID(),key=token(),used=new Set([...room.players.values()].map(p=>p.color));
    const p={id,key,name,color:COLORS.find(c=>!used.has(c)),kills:0,deaths:0,hp:100,x:80,y:80,angle:0,lastShot:0,lastSeen:clock(),lastInput:0,stream:null};
    place(room,p,clock());room.players.set(id,p);sessions.set(key,{room,p});
    if(!room.host)room.host=id;
    return {token:key,id,code:room.code,world:WORLD};
  }
  function remove(room,p){
    if(p.stream)p.stream.end();sessions.delete(p.key);room.players.delete(p.id);
    if(room.host===p.id)room.host=room.players.keys().next().value||null;
    if(!room.players.size)rooms.delete(room.code);
  }
  function snapshot(room,now){
    return {code:room.code,host:room.host,state:room.state,timeLeft:Math.max(0,room.state==='playing'?room.endAt-now:room.state==='finished'?0:matchMs),
      players:[...room.players.values()].map(p=>({id:p.id,name:p.name,color:p.color,x:p.x,y:p.y,angle:p.angle,hp:p.hp,kills:p.kills,deaths:p.deaths,shield:now<p.shieldUntil,respawn:Math.max(0,p.respawnAt-now)})),
      bullets:room.bullets.map(b=>({x:b.x,y:b.y,color:b.color})),feed:room.feed};
  }
  function broadcast(room,now){
    const data='data: '+JSON.stringify(snapshot(room,now))+'\n\n';
    for(const p of room.players.values())if(p.stream&&!p.stream.destroyed){
      // A slow phone must not build an unbounded queue on the server.
      if(p.stream.writableLength>128*1024)p.stream.destroy();else p.stream.write(data);
    }
  }
  function tick(){
    const now=clock(),dt=clamp((now-previous)/1000,0,.06);previous=now;frame++;
    for(const room of rooms.values()){
      for(const p of room.players.values())if(now-p.lastSeen>40000)remove(room,p);
      if(!room.players.size)continue;
      if(room.state==='playing'&&now>=room.endAt){room.state='finished';room.bullets=[];for(const p of room.players.values())p.input.fire=false;}
      if(room.state==='playing'){
        for(const p of room.players.values()){
          if(p.hp<=0){if(now>=p.respawnAt)place(room,p,now);else continue;}
          const input=now-p.lastInput<500?p.input:{mx:0,my:0,angle:p.angle,fire:false};
          const dx=input.mx*245*dt,dy=input.my*245*dt;
          if(!blocked(p.x+dx,p.y))p.x+=dx;
          if(!blocked(p.x,p.y+dy))p.y+=dy;
          p.angle=input.angle;
          if(input.fire&&now-p.lastShot>=230){
            p.lastShot=now;p.shieldUntil=0;
            const vx=Math.cos(p.angle),vy=Math.sin(p.angle);
            const x=p.x+vx*26,y=p.y+vy*26;
            if(!blocked(x,y,4))room.bullets.push({owner:p.id,color:p.color,x,y,vx:vx*850,vy:vy*850,until:now+1250});
          }
        }
        const keep=[];
        for(const b of room.bullets){
          let hit=now>=b.until;
          // Substeps keep fast bullets from passing through players or walls.
          const steps=Math.max(1,Math.ceil(850*dt/8));
          for(let i=0;i<steps&&!hit;i++){
            b.x+=b.vx*dt/steps;b.y+=b.vy*dt/steps;
            if(blocked(b.x,b.y,4)){hit=true;break;}
            for(const p of room.players.values()){
              if(p.id===b.owner||p.hp<=0||p.shieldUntil>now)continue;
              if(Math.hypot(p.x-b.x,p.y-b.y)<21){
                hit=true;p.hp=Math.max(0,p.hp-25);
                if(p.hp===0){
                  p.deaths++;p.respawnAt=now+2200;p.input.fire=false;
                  const killer=room.players.get(b.owner);if(killer)killer.kills++;
                  room.feed.unshift({by:killer?.name||'Jugador',victim:p.name});room.feed=room.feed.slice(0,3);
                }break;
              }
            }
          }
          if(!hit)keep.push(b);
        }
        room.bullets=keep;
      }
      if(frame%2===0)broadcast(room,now);
    }
    if(frame%300===0)for(const [ip,item] of limits)if(now-item.since>60000)limits.delete(ip);
  }
  const interval=autoTick?setInterval(tick,1000/30):null;
  function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
  async function body(req){
    let chunks=[],length=0;
    for await(const chunk of req){length+=chunk.length;if(length>2048)fail(413,'Mensaje demasiado grande.');chunks.push(chunk);}
    try {const value=JSON.parse(Buffer.concat(chunks).toString());if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value;}catch{fail(400,'Mensaje inválido.');}
  }
  function authorize(data){const session=sessions.get(data.token);if(!session)fail(401,'Tu sesión terminó. Vuelve a entrar a la sala.');return session;}
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
    try{
      const url=new URL(req.url,'http://localhost');
      if(req.method==='GET'&&url.pathname==='/'){
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache'});return res.end(html);
      }
      if(req.method==='GET'&&url.pathname==='/health')return json(res,200,{ok:true});
      if(req.method==='GET'&&url.pathname==='/api/events'){
        const {room,p}=authorize({token:url.searchParams.get('token')});
        if(p.stream)p.stream.end();
        res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
        res.flushHeaders();res.write('retry: 1200\n\n');p.stream=res;p.lastSeen=clock();
        res.write('data: '+JSON.stringify(snapshot(room,clock()))+'\n\n');
        res.on('close',()=>{if(p.stream===res)p.stream=null});return;
      }
      if(req.method!=='POST'||!url.pathname.startsWith('/api/'))return json(res,404,{error:'No encontrado.'});
      // Browser requests must originate at this service; no wildcard CORS.
      if(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)fail(403,'Origen no permitido.');
      const data=await body(req);
      if(['/api/create','/api/join'].includes(url.pathname)){
        const ip=req.socket.remoteAddress||'unknown',now=clock();let limit=limits.get(ip);
        if(!limit||now-limit.since>60000){limit={since:now,count:0};limits.set(ip,limit)}
        if(++limit.count>80)fail(429,'Demasiados intentos. Espera un minuto.');
        const name=String(data.name||'').replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,16);
        if(!name)fail(400,'Escribe tu nombre.');
        let room;
        if(url.pathname==='/api/create'){
          if(rooms.size>=100)fail(503,'Servidor lleno. Inténtalo luego.');
          let code;do{code=crypto.randomBytes(4).toString('hex').slice(0,6).toUpperCase()}while(rooms.has(code));
          room={code,host:null,state:'lobby',players:new Map(),bullets:[],feed:[],endAt:0};rooms.set(code,room);
        }else{room=rooms.get(String(data.code||'').trim().toUpperCase());if(!room)fail(404,'No existe esa sala. Revisa el código.');}
        return json(res,200,addPlayer(room,name));
      }
      const {room,p}=authorize(data);p.lastSeen=clock();
      if(url.pathname==='/api/input'){
        if(clock()-p.lastInput<12)return json(res,200,{ok:true});
        let mx=Number(data.mx),my=Number(data.my),angle=Number(data.angle);
        if(!Number.isFinite(mx)||!Number.isFinite(my)||!Number.isFinite(angle))fail(400,'Controles inválidos.');
        mx=clamp(mx,-1,1);my=clamp(my,-1,1);const length=Math.hypot(mx,my);if(length>1){mx/=length;my/=length;}
        p.input={mx,my,angle:angle%(Math.PI*2),fire:data.fire===true};p.lastInput=clock();return json(res,200,{ok:true});
      }
      if(url.pathname==='/api/start'){
        if(room.host!==p.id)fail(403,'Solo el creador de la sala puede iniciar.');
        if(room.state==='playing')fail(409,'La partida ya comenzó.');
        if(room.players.size<2)fail(409,'Espera al menos a un amigo.');
        room.state='playing';room.endAt=clock()+matchMs;room.bullets=[];room.feed=[];
        for(const player of room.players.values()){player.kills=0;player.deaths=0;player.lastShot=0;place(room,player,clock());}
        broadcast(room,clock());return json(res,200,{ok:true});
      }
      if(url.pathname==='/api/leave'){remove(room,p);return json(res,200,{ok:true});}
      return json(res,404,{error:'No encontrado.'});
    }catch(error){if(!res.headersSent)json(res,error.status||500,{error:error.status?error.message:'Ocurrió un error en el servidor.'});else res.end();}
  });
  server.requestTimeout=15000;
  function close(){if(interval)clearInterval(interval);for(const {p} of sessions.values())p.stream?.end();server.closeAllConnections();return new Promise(resolve=>server.close(resolve));}
  return {server,rooms,sessions,tick,snapshot,close};
}
if(require.main===module){
  const app=createApp(),port=Number(process.env.PORT)||3000;
  app.server.listen(port,'0.0.0.0',()=>console.log(`PERÚ ARENA listo. Abre http://localhost:${port}`));
  process.on('SIGTERM',()=>app.close().then(()=>process.exit(0)));
}
module.exports={createApp,WORLD,blocked};
