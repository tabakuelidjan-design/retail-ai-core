import {requireRunwayConfig} from './config.js';

export async function runwayJsonRequest({config,path,method='POST',body,fetchImpl=globalThis.fetch}){
  requireRunwayConfig(config);
  if(typeof fetchImpl!=='function') throw new TypeError('fetch implementation is required');
  if(typeof path!=='string'||!path.startsWith('/')) throw new TypeError('path must start with /');
  const url=new URL(path,config.apiRoot);
  if(url.origin!=='https://api.dev.runwayml.com') throw new Error('Unexpected Runway host');
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),config.timeoutMs);
  try{
    const response=await fetchImpl(url.toString(),{
      method,
      headers:{
        Authorization:`Bearer ${config.apiSecret}`,
        'Content-Type':'application/json',
        'X-Runway-Version':config.apiVersion,
      },
      body:body==null?undefined:JSON.stringify(body),
      signal:controller.signal,
      redirect:'error',
    });
    const raw=await response.text();
    let payload={};
    try{payload=raw?JSON.parse(raw):{}}catch{}
    if(!response.ok){
      const code=payload?.error||payload?.code||`HTTP_${response.status}`;
      const e=new Error(`Runway request failed: ${code}`);
      e.status=response.status;
      throw e;
    }
    return payload;
  }finally{clearTimeout(timer)}
}
