import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import fs from 'node:fs';
import '../public/event-utils.js';
function harness({delayedMic=false}={}) {
 const timers=new Map(),sockets=[];let timerId=0,micCalls=0,stops=0,resolveMic;
 const stream={getTracks:()=>[{stop:()=>stops++}]};
 class Socket {static OPEN=1;static CONNECTING=0;constructor(){this.readyState=0;this.events={};this.sent=[];sockets.push(this);}addEventListener(name,fn){this.events[name]=fn;}send(raw){this.sent.push(JSON.parse(raw));}close(){this.readyState=3;this.events.close?.({code:1000});}}
 class AudioContext {constructor(){this.state='running';this.sampleRate=48000;}createOscillator(){return{frequency:{},connect(){},start(){},stop(){}};}createGain(){return{gain:{setValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){},disconnect(){}};}createMediaStreamSource(){return{connect(){},disconnect(){}};}createScriptProcessor(){return{connect(){},disconnect(){}};}}
 const context={console,FireWatchData:globalThis.FireWatchData,WebSocket:Socket,window:{location:{protocol:'http:',host:'127.0.0.1'},AudioContext},navigator:{mediaDevices:{getUserMedia:()=>{micCalls++;return delayedMic?new Promise(r=>resolveMic=r):Promise.resolve(stream);}}},localStorage:{getItem:()=>null,setItem(){}},document:{readyState:'loading',addEventListener(){}},Audio:class{play(){return Promise.resolve();}},setTimeout:(fn,delay)=>{timers.set(++timerId,{fn,delay});return timerId;},clearTimeout:id=>timers.delete(id),setInterval:()=>++timerId,clearInterval(){},URL,Uint8Array,Int16Array,Float32Array,ArrayBuffer,DataView};
 vm.createContext(context);let code=fs.readFileSync(new URL('../public/radio.js',import.meta.url),'utf8');const init=code.lastIndexOf('  if (document.readyState');code=code.slice(0,init)+`  window.auditRadio={connectRadio,scheduleReconnect,requestPtt,releasePtt,handleControlMessage,closeRadio,setVisible:()=>visible=true,setAuthenticated:()=>authenticated=true,getState:()=>({pttHeld,pttActive,reconnectAttempts,hasMic:!!localStream})};\n})();`;
 vm.runInContext(code,context);const radio=context.window.auditRadio;radio.setVisible();
 return{radio,timers,sockets,get micCalls(){return micCalls;},get stops(){return stops;},resolveMic:()=>resolveMic(stream)};
}
test('actual radio client connects without opening microphone and stops after six retries',async()=>{
 const h=harness();await h.radio.connectRadio();const socket=h.sockets[0];socket.readyState=1;socket.events.open();assert.equal(h.micCalls,0);
 for(let i=0;i<7;i++)h.radio.scheduleReconnect(1006);assert.equal(h.radio.getState().reconnectAttempts,6);assert.equal(h.timers.size,0);
});
test('actual PTT client releases microphone on button release and ignores delayed self grant',async()=>{
 const h=harness();await h.radio.connectRadio();const socket=h.sockets[0];socket.readyState=1;h.radio.setAuthenticated();await h.radio.requestPtt();assert.equal(h.micCalls,1);assert.equal(socket.sent.at(-1).type,'ptt_request');
 h.radio.handleControlMessage(JSON.stringify({type:'ptt_granted',self:true}));assert.equal(h.radio.getState().pttActive,true);h.radio.releasePtt();assert.equal(h.stops,1);assert.equal(h.radio.getState().hasMic,false);assert.equal(socket.sent.at(-1).type,'ptt_release');
 h.radio.handleControlMessage(JSON.stringify({type:'ptt_granted',self:true}));assert.equal(h.radio.getState().pttActive,false);
});
test('microphone permission resolved after release never starts transmission',async()=>{
 const h=harness({delayedMic:true});await h.radio.connectRadio();h.sockets[0].readyState=1;h.radio.setAuthenticated();const pending=h.radio.requestPtt();await Promise.resolve();await Promise.resolve();h.radio.releasePtt();h.resolveMic();await pending;assert.equal(h.stops,1);assert.equal(h.sockets[0].sent.filter(x=>x.type==='ptt_request').length,0);
});
test('permission close codes and manual disconnect do not reconnect',async()=>{const h=harness();h.radio.scheduleReconnect(1008);assert.equal(h.timers.size,0);await h.radio.connectRadio();h.radio.closeRadio();assert.equal(h.timers.size,0);});
