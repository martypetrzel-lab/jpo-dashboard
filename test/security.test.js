import test from 'node:test';import assert from 'node:assert/strict';import {createRateLimiter} from '../security.js';
test('sensitive endpoint rate limiter expires entries, ignores spoofed XFF and bounds memory',()=>{
 let now=0;const limiter=createRateLimiter({max:2,windowMs:1000,maxKeys:2,now:()=>now});let nextCalls=0;const invoke=(ip,forwarded='')=>{const result={status:200,headers:{}};const response={setHeader:(key,value)=>result.headers[key]=value,status:code=>{result.status=code;return response;},json:body=>{result.body=body;return response;}};limiter({ip,headers:{'x-forwarded-for':forwarded}},response,()=>nextCalls++);return result;};
 assert.equal(invoke('client-a').status,200);assert.equal(invoke('client-a','different').status,200);assert.equal(invoke('client-a','another').status,429);assert.equal(invoke('client-b').status,200);assert.equal(invoke('client-c').status,429);assert.equal(nextCalls,3);now=1001;assert.equal(invoke('client-c').status,200);
});
