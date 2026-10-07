import {createBenchmarkCase} from './benchmark.js';

export function normalizeBenchmarkManifest(input){
  if(!input||typeof input!=='object'||Array.isArray(input)) throw new TypeError('manifest must be an object');
  if(typeof input.benchmark_id!=='string'||!input.benchmark_id) throw new TypeError('benchmark_id is required');
  if(typeof input.merchant_id!=='string'||!input.merchant_id) throw new TypeError('merchant_id is required');
  if(!Array.isArray(input.cases)||input.cases.length===0) throw new TypeError('cases must contain at least one benchmark case');
  const seen=new Set();
  const cases=input.cases.map(raw=>{
    if(seen.has(raw?.id)) throw new Error(`duplicate benchmark case id: ${raw?.id}`);
    const c=createBenchmarkCase(raw);
    seen.add(c.id);
    return c;
  });
  return Object.freeze({benchmark_id:input.benchmark_id,merchant_id:input.merchant_id,created_at:input.created_at??null,cases:Object.freeze(cases)});
}
