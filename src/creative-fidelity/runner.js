import {LICENSE_STATUS,MODEL_STATUS} from './constants.js';
import {executeBenchmarkAdapter} from './adapters.js';

function eligibility(model){
  if(!model) return {allowed:false,reason:'MODEL_NOT_REGISTERED'};
  if(model.status===MODEL_STATUS.REJECT) return {allowed:false,reason:'MODEL_REJECTED'};
  if(model.license_status!==LICENSE_STATUS.VERIFIED) return {allowed:false,reason:'LICENSE_NOT_VERIFIED'};
  if(model.commercial_use!==true) return {allowed:false,reason:'COMMERCIAL_USE_NOT_ALLOWED'};
  if(model.eu_allowed!==true) return {allowed:false,reason:'EU_USE_NOT_ALLOWED'};
  return {allowed:true};
}

export async function runBenchmarkMatrix({manifest,registry,adapters,ledger}){
  const rows=[];
  const adapterMap=new Map(adapters.map(a=>[a.model_id,a]));
  for(const model of registry.list()){
    const gate=eligibility(model);
    const adapter=adapterMap.get(model.id)??null;
    for(const benchmarkCase of manifest.cases){
      if(!gate.allowed){
        rows.push(Object.freeze({benchmark_case_id:benchmarkCase.id,model_id:model.id,status:'SKIPPED',reason:gate.reason}));
        continue;
      }
      if(!adapter){
        rows.push(Object.freeze({benchmark_case_id:benchmarkCase.id,model_id:model.id,status:'SKIPPED',reason:'ADAPTER_NOT_CONFIGURED'}));
        continue;
      }
      const request=Object.freeze({benchmark_id:manifest.benchmark_id,merchant_id:manifest.merchant_id,case:benchmarkCase,model});
      const result=await executeBenchmarkAdapter(adapter,request);
      const row=Object.freeze({benchmark_case_id:benchmarkCase.id,model_id:model.id,...result});
      rows.push(row);
      if(ledger&&result.status==='SUCCEEDED'){
        ledger.appendRun({benchmark_case_id:benchmarkCase.id,merchant_id:manifest.merchant_id,model_id:model.id,model_version:model.version,model_version_hash:model.version_hash,source_refs:benchmarkCase.source_refs,output_ref:result.output_ref,duration_ms:result.duration_ms,direct_cost_eur:result.direct_cost_eur,compute_seconds:result.compute_seconds,metadata:{benchmark_id:manifest.benchmark_id,adapter_id:adapter.id,...result.metadata}});
      }
    }
  }
  return Object.freeze(rows);
}
