// Headless checks for loop-WAV export, hard stop on a new track, and the playhead.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 8765;
const DBG = 9333;
const checks = [];
function check(name, pass, detail){
  checks.push({name, pass:!!pass, detail:detail==null?'':String(detail)});
  console.log(`${pass?'PASS':'FAIL'}  ${name}${detail!=null?'  '+detail:''}`);
}

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {
  cwd: new URL('..', import.meta.url).pathname,
  stdio: ['ignore', 'pipe', 'pipe'],
});
const chrome = spawn('google-chrome', [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  `--remote-debugging-port=${DBG}`,
  '--remote-allow-origins=*',
  '--autoplay-policy=no-user-gesture-required',
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  '--user-data-dir=/tmp/chrome-isynth-verify',
  'about:blank',
], {stdio:['ignore','pipe','pipe']});
let chromeLog = '';
chrome.stderr.on('data', d=>{chromeLog += d.toString();});
chrome.stdout.on('data', d=>{chromeLog += d.toString();});

function shutdown(){
  try{chrome.kill('SIGKILL')}catch{}
  try{server.kill('SIGKILL')}catch{}
}
process.on('exit', shutdown);

async function waitJson(){
  for(let i=0;i<80;i++){
    try{
      const r = await fetch(`http://127.0.0.1:${DBG}/json/version`);
      if(r.ok) return await r.json();
    }catch{}
    await sleep(100);
  }
  throw new Error('Chrome debug port did not open\n'+chromeLog.slice(-2000));
}

function cdpConnect(wsUrl){
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', async ev=>{
    let data = ev.data;
    if(typeof data !== 'string') data = await data.text();
    const m = JSON.parse(data);
    if(m.id && pending.has(m.id)){
      const {resolve, reject} = pending.get(m.id);
      pending.delete(m.id);
      if(m.error) reject(new Error(m.error.message || JSON.stringify(m.error)));
      else resolve(m.result);
    }
  });
  const ready = new Promise((resolve, reject)=>{
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', ()=>reject(new Error('websocket error')));
  });
  function send(method, params={}, sessionId, timeout=180000){
    const msg = {id:++id, method, params};
    if(sessionId) msg.sessionId = sessionId;
    ws.send(JSON.stringify(msg));
    return new Promise((resolve, reject)=>{
      const t = setTimeout(()=>reject(new Error('timeout '+method)), timeout);
      pending.set(msg.id, {resolve:(v)=>{clearTimeout(t);resolve(v)}, reject:(e)=>{clearTimeout(t);reject(e)}});
    });
  }
  return {ready, send, ws};
}

const PAGE = `(async () => {
  const sleep = ms => new Promise(r=>setTimeout(r, ms));
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const out = {checks:[]};
  const check = (name, pass, detail) => out.checks.push({name, pass:!!pass, detail:detail==null?'':String(detail)});
  const S = window.__synth;

  const oscs = [];
  const delays = [];
  const convs = [];
  const origStop = OscillatorNode.prototype.stop;
  const origStart = OscillatorNode.prototype.start;
  OscillatorNode.prototype.start = function(when){
    const rec = {when, stops:0, ended:false, disc:0};
    oscs.push(rec);
    const node = this;
    node.addEventListener('ended', ()=>{rec.ended=true});
    node.stop = function(t){rec.stops++; return origStop.call(node, t)};
    return origStart.call(node, when);
  };
  const origDisc = AudioNode.prototype.disconnect;
  AudioNode.prototype.disconnect = function(...args){
    if(this.__tag==='delay' || this.__tag==='conv') this.__disc=(this.__disc||0)+1;
    return origDisc.apply(this, args);
  };
  const origDelay = BaseAudioContext.prototype.createDelay;
  BaseAudioContext.prototype.createDelay = function(...args){
    const n = origDelay.apply(this, args);
    n.__tag='delay'; n.__disc=0; delays.push(n); return n;
  };
  const origConv = BaseAudioContext.prototype.createConvolver;
  BaseAudioContext.prototype.createConvolver = function(...args){
    const n = origConv.apply(this, args);
    n.__tag='conv'; n.__disc=0; convs.push(n); return n;
  };
  const OrigOff = OfflineAudioContext;
  let lastBuf = null, lastLen = 0;
  window.__stubRender = false;
  window.OfflineAudioContext = function(ch, len, sr){
    lastLen = len;
    const ctx = new OrigOff(ch, len, sr);
    const real = ctx.startRendering.bind(ctx);
    ctx.startRendering = function(){
      if(window.__stubRender) return Promise.resolve(new AudioBuffer({length:len, numberOfChannels:ch, sampleRate:sr}));
      return real().then(buf=>{lastBuf=buf; return buf});
    };
    return ctx;
  };

  const origAnchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function(){
    if(this.hasAttribute('download')){window.__lastDownload=this.download; return;}
    return origAnchorClick.apply(this, arguments);
  };

  function peak(){
    if(!S.analyser) return 0;
    const b = new Float32Array(S.analyser.fftSize||1024);
    S.analyser.getFloatTimeDomainData(b);
    let p=0; for(let i=0;i<b.length;i++) p=Math.max(p, Math.abs(b[i]));
    return p;
  }
  function chordIdx(){return $$('#chords .chord').findIndex(b=>b.classList.contains('now'))}
  function curCol(){
    const cells=$$('#seq .cell');
    const i=cells.findIndex(c=>c.classList.contains('cur'));
    return i<0?-1:i%8;
  }
  function curCount(){return $$('#seq .cell.cur').length}

  $('#ov').classList.add('hide');
  S.ensure();
  S.ui.A.set(0.005);
  S.ui.D.set(0.2);
  S.ui.S.set(0.7);
  S.ui.R.set(0.8);
  S.ui.rMix.set(0.55);
  S.ui.dMix.set(0.35);
  S.ui.dFb.set(0.45);
  S.ui.bpm.set(120);
  S.ui.seqOn.set(true);
  S.ui.progOn.set(true);

  let highlight=false, prePeak=0;
  for(let i=0;i<40;i++){
    await sleep(50);
    if(chordIdx()>=0 && curCount()===8){highlight=true; prePeak=peak(); if(prePeak>0.01 || i>15) break}
  }
  const state = S.ctx?S.ctx.state:'none';
  const tNow = S.ctx?S.ctx.currentTime:0;
  check('audio context is running', state==='running', 'state='+state+' t='+tNow.toFixed(3));
  check('playhead visible once playback starts', highlight, 'chord='+chordIdx()+' curCells='+curCount()+' peak='+prePeak.toFixed(4));

  const lfo = oscs[0];
  const activeBeforeEdit = oscs.filter(o=>o!==lfo && !o.ended);
  const stopsBefore = activeBeforeEdit.map(o=>o.stops);
  const chordBefore = chordIdx();
  const colBefore = curCol();
  check('chord and step playhead indexes are in range', chordBefore>=0 && colBefore>=0, 'chord='+chordBefore+' col='+colBefore);

  $$('#chords .cchg')[1].click();
  S.ui.cutoff.set(1400);
  S.ui.o1w.set('triangle');
  const cell = $$('#seq .cell')[3];
  cell.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true, cancelable:true, pointerId:7, button:0}));
  const chordAfter = chordIdx();
  const colAfter = curCol();
  check('chord highlight stays on the same block through an edit', chordAfter===chordBefore, 'before='+chordBefore+' after='+chordAfter);
  check('step highlight stays on the same column through an edit', colAfter===colBefore && curCount()===8, 'before='+colBefore+' after='+colAfter+' count='+curCount());
  const stopsAfter = activeBeforeEdit.map(o=>o.stops);
  check('editing does not stop voices that are already playing', stopsAfter.every((n,i)=>n===stopsBefore[i]), 'before='+stopsBefore.join(',')+' after='+stopsAfter.join(','));

  $$('.chord.now, .cell.cur').forEach(el=>{el.classList.remove('now'); el.classList.remove('cur')});
  check('classes can be stripped for the repaint check', chordIdx()<0 && curCount()===0, 'chord='+chordIdx()+' cur='+curCount());
  await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  check('playhead is repainted on the next frame after a mid-playback edit', chordIdx()>=0 && curCount()===8, 'chord='+chordIdx()+' cur='+curCount());

  const delaysBefore = delays.length;
  const convsBefore = convs.length;
  const oldDelay = delays[delays.length-1];
  const oldConv = convs[convs.length-1];
  const activeBefore = oscs.filter(o=>o!==lfo && !o.ended);
  activeBefore.forEach(o=>{o.snap=o.stops});
  const pre = peak();
  $('#inspire').click();
  await sleep(30);
  const mid = peak();
  // Notes with a duration already called stop() once when they were scheduled.
  // Generating a new track must call stop() again (the count rises) on every voice still in the graph.
  const stopBumps = activeBefore.filter(o=>o.stops>o.snap);
  check('previous voices are stopped when a new track is generated', activeBefore.length>0 && stopBumps.length===activeBefore.length, 'active='+activeBefore.length+' bumped='+stopBumps.length+' sampleStops='+activeBefore.slice(0,6).map(o=>o.stops).join(','));
  check('the LFO keeps running', lfo && lfo.stops===0 && !lfo.ended, 'stops='+(lfo&&lfo.stops));
  check('delay and reverb tails are dropped (nodes replaced and disconnected)', delays.length===delaysBefore+1 && convs.length===convsBefore+1 && oldDelay.__disc>0 && oldConv.__disc>0, 'delays '+delaysBefore+'->'+delays.length+' convs '+convsBefore+'->'+convs.length+' oldDelayDisc='+oldDelay.__disc+' oldConvDisc='+oldConv.__disc);
  check('old signal is gone before the new track starts', pre>0.01 && mid<pre*0.25, 'pre='+pre.toFixed(4)+' mid='+mid.toFixed(4));
  let newVoices=false, postPeak=0;
  for(let i=0;i<40;i++){
    await sleep(40);
    postPeak=Math.max(postPeak, peak());
    if(oscs.length>activeBefore.length+1) newVoices=true;
    if(newVoices && postPeak>0.01) break;
  }
  check('new playback starts after the old audio is stopped', newVoices && postPeak>0.01, 'oscs='+oscs.length+' peak='+postPeak.toFixed(4));

  // Export
  S.ui.o1w.set('sine');
  S.ui.o2w.set('sine');
  S.ui.R.set(1.6);
  S.ui.rMix.set(0.85);
  S.ui.dMix.set(0.55);
  S.ui.dFb.set(0.55);
  S.ui.bpm.set(180);
  S.ui.A.set(0.005);
  window.__stubRender = false;
  const looped = await S.renderLoop(true, true);
  const plan = looped.plan;
  const sr = 44100;
  const L = Math.round(plan.beats*60/plan.bpm*sr);
  const ab = await looped.blob.arrayBuffer();
  const dv = new DataView(ab);
  const riff = String.fromCharCode(dv.getUint8(0),dv.getUint8(1),dv.getUint8(2),dv.getUint8(3));
  const wave = String.fromCharCode(dv.getUint8(8),dv.getUint8(9),dv.getUint8(10),dv.getUint8(11));
  const channels = dv.getUint16(22, true);
  const fileSr = dv.getUint32(24, true);
  const bits = dv.getUint16(34, true);
  const frames = (ab.byteLength-44)/(channels*2);
  check('loop wav is one exact cycle', frames===L && lastLen===L*3, 'frames='+frames+' L='+L+' offline='+lastLen);
  check('loop wav header', riff==='RIFF' && wave==='WAVE' && channels===2 && fileSr===44100 && bits===16, riff+' '+wave+' ch='+channels+' sr='+fileSr+' bits='+bits);

  function toInt16(v){
    v = Math.max(-1, Math.min(1, v));
    let x = v<0 ? v*32768 : v*32767;
    x = x<0 ? Math.ceil(x) : Math.floor(x);
    return x;
  }
  const midL = lastBuf.getChannelData(0).slice(L, L*2);
  const midR = lastBuf.getChannelData(1).slice(L, L*2);
  let peakAll = 0;
  for(let i=0;i<L;i++) peakAll=Math.max(peakAll, Math.abs(midL[i]), Math.abs(midR[i]));
  const g = peakAll>0 ? 0.89/peakAll : 1;
  let maxErr = 0, mismatches = 0;
  let o = 44;
  for(let i=0;i<L;i++){
    const eL = toInt16(midL[i]*g), eR = toInt16(midR[i]*g);
    const aL = dv.getInt16(o, true); o+=2;
    const aR = dv.getInt16(o, true); o+=2;
    const d = Math.max(Math.abs(aL-eL), Math.abs(aR-eR));
    if(d>maxErr) maxErr=d;
    if(d) mismatches++;
  }
  check('loop wav is the middle repetition, sample for sample', maxErr===0, 'maxInt16Err='+maxErr+' mismatches='+mismatches+' peak='+peakAll.toFixed(4));

  const cmpN = Math.min(L, Math.floor(sr*0.35));
  let diffE=0, firstE=0, midE=0;
  const c0 = lastBuf.getChannelData(0);
  for(let i=0;i<cmpN;i++){
    const d=c0[i]-c0[L+i]; diffE+=d*d; firstE+=c0[i]*c0[i]; midE+=c0[L+i]*c0[L+i];
  }
  const diffRms = Math.sqrt(diffE/cmpN);
  check('middle pass contains spill from the previous pass', diffRms>1e-4, 'diffRms='+diffRms.toFixed(6)+' firstRms='+Math.sqrt(firstE/cmpN).toFixed(4)+' midRms='+Math.sqrt(midE/cmpN).toFixed(4));

  const plain = await S.renderLoop(false, false);
  const plainFrames = (await plain.blob.arrayBuffer()).byteLength;
  const expectBytes = 44 + (L + Math.round(4*sr))*2*2;
  check('non-loop export keeps one pass plus the tail', lastLen===L+Math.round(4*sr) && plainFrames===expectBytes && plain.seconds>L/sr+3, 'offline='+lastLen+' bytes='+plainFrames+' seconds='+plain.seconds.toFixed(3));

  window.__stubRender = true;
  $('#expMel').checked = true;
  $('#expTrim').checked = true;
  $('#expWav').click();
  for(let i=0;i<50 && $('#expWav').disabled;i++) await sleep(20);
  check('loop checkbox asks for three repetitions', lastLen===L*3 && ($('#expMsg').textContent||'').includes('가운데'), 'offline='+lastLen+' msg='+$('#expMsg').textContent);
  $('#expTrim').checked = false;
  $('#expWav').click();
  for(let i=0;i<50 && $('#expWav').disabled;i++) await sleep(20);
  check('non-loop checkbox stays available', lastLen===L+Math.round(4*sr) && ($('#expMsg').textContent||'').includes('꼬리 포함'), 'offline='+lastLen+' msg='+$('#expMsg').textContent);

  window.__stubRender = false;
  const liveBefore = oscs.length;
  S.press('verify', [60, 64, 67]);
  await sleep(80);
  const livePeak = peak();
  S.release('verify', true);
  check('live graph still sounds after an export', oscs.length>liveBefore && livePeak>0.01, 'peak='+livePeak.toFixed(4));

  out.ok = out.checks.every(c=>c.pass);
  return out;
})()`;

try{
  await waitJson();
  const ver = await (await fetch(`http://127.0.0.1:${DBG}/json/version`)).json();
  const {ready, send} = cdpConnect(ver.webSocketDebuggerUrl);
  await ready;
  const {targetId} = await send('Target.createTarget', {url:`http://127.0.0.1:${PORT}/index.html`});
  const {sessionId} = await send('Target.attachToTarget', {targetId, flatten:true});
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  for(let i=0;i<50;i++){
    const r = await send('Runtime.evaluate', {expression:'document.readyState', returnByValue:true}, sessionId);
    if(r.result && r.result.value==='complete') break;
    await sleep(100);
  }
  const evaled = await send('Runtime.evaluate', {
    expression: PAGE,
    awaitPromise: true,
    returnByValue: true,
  }, sessionId, 180000);
  if(evaled.exceptionDetails){
    const d = evaled.exceptionDetails;
    const text = (d.exception && d.exception.description) || d.text || JSON.stringify(d);
    check('page test ran', false, text.slice(0, 2000));
  }else{
    const value = evaled.result && evaled.result.value;
    if(!value || !value.checks) check('page test returned checks', false, JSON.stringify(evaled.result).slice(0, 500));
    else for(const c of value.checks) check(c.name, c.pass, c.detail);
  }
}catch(err){
  check('runner', false, err && err.stack ? err.stack : String(err));
}finally{
  shutdown();
}

const failed = checks.filter(c=>!c.pass);
console.log(`\n${checks.length-failed.length}/${checks.length} passed`);
process.exit(failed.length?1:0);
