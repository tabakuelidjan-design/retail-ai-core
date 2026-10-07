import test from 'node:test';
import assert from 'node:assert/strict';
import {createProductAd,createProductCampaignImage,getRunwayTask,loadRunwayConfig} from '../src/marketing-creative/runway/index.js';

const config=loadRunwayConfig({RUNWAYML_API_SECRET:'secret'});
const policy={classification:'PUBLIC',contains_personal_data:false,contains_face:false};
const response=(payload,status=200)=>({ok:status>=200&&status<300,status,async text(){return JSON.stringify(payload)}});

test('product campaign image pins 2026-06 and exact endpoint',async()=>{
  let call;
  const result=await createProductCampaignImage({
    config,
    productImageUrl:'https://habb.be/product.webp',
    prompt:'premium retail hero',
    dataPolicy:policy,
    fetchImpl:async(url,options)=>{call={url,options};return response({id:'task-image'})},
  });
  assert.match(call.url,/\/v1\/recipes\/product_campaign_image$/);
  const body=JSON.parse(call.options.body);
  assert.equal(body.version,'2026-06');
  assert.equal(result.taskId,'task-image');
});

test('product ad pins 2026-07 and bounded duration',async()=>{
  let body;
  const result=await createProductAd({
    config,
    productImageUrls:['https://habb.be/product.webp'],
    prompt:'natural premium ad',
    duration:10,
    dataPolicy:policy,
    fetchImpl:async(url,options)=>{body=JSON.parse(options.body);return response({id:'task-video'})},
  });
  assert.equal(body.version,'2026-07');
  assert.equal(body.duration,10);
  assert.equal(body.audio,false);
  assert.equal(result.taskId,'task-video');
});

test('private data is blocked before request',async()=>{
  let called=false;
  await assert.rejects(()=>createProductAd({
    config,
    productImageUrls:['https://habb.be/product.webp'],
    prompt:'x',
    dataPolicy:{classification:'LOCAL_ONLY'},
    fetchImpl:async()=>{called=true;return response({})},
  }),/PUBLIC/);
  assert.equal(called,false);
});

test('task polling uses GET',async()=>{
  let method;
  const r=await getRunwayTask({
    config,
    taskId:'abc',
    fetchImpl:async(url,options)=>{method=options.method;return response({status:'SUCCEEDED',output:['https://example.test/out.mp4']})},
  });
  assert.equal(method,'GET');
  assert.equal(r.status,'SUCCEEDED');
});
