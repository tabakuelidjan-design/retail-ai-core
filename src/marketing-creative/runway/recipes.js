import {randomUUID} from 'node:crypto';
import {runwayJsonRequest} from './http.js';
import {assertPublicCreativePolicy,assertPublicProductUrl} from './policy.js';

export async function createProductCampaignImage({
  config,productImageUrl,prompt,dataPolicy,operationId=randomUUID(),fetchImpl,
}){
  assertPublicCreativePolicy(dataPolicy);
  const image=assertPublicProductUrl(productImageUrl);
  if(typeof prompt!=='string'||!prompt.trim()) throw new TypeError('prompt is required');
  const payload=await runwayJsonRequest({
    config,
    path:'/recipes/product_campaign_image',
    fetchImpl,
    body:{version:config.productCampaignVersion,image:{uri:image},prompt:prompt.trim()},
  });
  const taskId=payload?.id||payload?.taskId;
  if(!taskId) throw new Error('Runway Product Campaign Image did not return task id');
  return Object.freeze({operationId,taskId,recipe:'product_campaign_image',version:config.productCampaignVersion});
}

export async function createProductAd({
  config,productImageUrls,prompt,productInfo=null,duration=10,ratio='1280:720',audio=false,
  dataPolicy,operationId=randomUUID(),fetchImpl,
}){
  assertPublicCreativePolicy(dataPolicy);
  if(!Array.isArray(productImageUrls)||productImageUrls.length<1||productImageUrls.length>10) throw new RangeError('productImageUrls must contain 1 to 10 images');
  if(typeof prompt!=='string'||!prompt.trim()) throw new TypeError('prompt is required');
  if(!Number.isInteger(duration)||duration<4||duration>15) throw new RangeError('duration must be 4..15 seconds');
  const productImages=productImageUrls.map(url=>({uri:assertPublicProductUrl(url)}));
  const payload=await runwayJsonRequest({
    config,
    path:'/recipes/product_ad',
    fetchImpl,
    body:{
      version:config.productAdVersion,
      productImages,
      productInfo:productInfo??undefined,
      userConcept:prompt.trim(),
      ratio,
      duration,
      audio,
    },
  });
  const taskId=payload?.id||payload?.taskId;
  if(!taskId) throw new Error('Runway Product Ad did not return task id');
  return Object.freeze({operationId,taskId,recipe:'product_ad',version:config.productAdVersion});
}

export async function getRunwayTask({config,taskId,fetchImpl}){
  if(typeof taskId!=='string'||!taskId) throw new TypeError('taskId is required');
  const payload=await runwayJsonRequest({config,path:`/tasks/${encodeURIComponent(taskId)}`,method:'GET',fetchImpl});
  return Object.freeze({
    taskId,
    status:payload?.status??'UNKNOWN',
    outputs:Object.freeze([...(payload?.output??payload?.outputs??[])]),
    raw:payload,
  });
}
