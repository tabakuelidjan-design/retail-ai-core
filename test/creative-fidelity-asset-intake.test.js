import test from 'node:test';import assert from 'node:assert/strict';
import {buildManifestFromAssets,createStandardCasesForAsset,normalizeBenchmarkAsset} from '../src/creative-fidelity/index.js';

const asset=(o={})=>({id:'p1',product_id:'product-1',source_ref:'private://p1',kind:'REAL_PRODUCT_PHOTO',model_generated:false,screenshot:false,rights_confirmed:true,contains_face_artwork:false,contains_logo:true,contains_text:true,...o});

test('generated source is rejected',()=>assert.throws(()=>normalizeBenchmarkAsset(asset({model_generated:true})),/generated images/));
test('screenshot source is rejected',()=>assert.throws(()=>normalizeBenchmarkAsset(asset({screenshot:true})),/screenshots/));
test('rights must be confirmed',()=>assert.throws(()=>normalizeBenchmarkAsset(asset({rights_confirmed:false})),/rights_confirmed/));
test('one real product creates exactly five standard cases',()=>{const cases=createStandardCasesForAsset(asset());assert.equal(cases.length,5);assert.equal(new Set(cases.map(x=>x.task)).size,5)});
test('face artwork creates exact face invariant',()=>{const cases=createStandardCasesForAsset(asset({contains_face_artwork:true}));assert.ok(cases.every(x=>x.expected_invariants.includes('PRESERVE_FACE_PIXELS_EXACTLY')))});
test('ten products create fifty comparable cases',()=>{const assets=Array.from({length:10},(_,i)=>asset({id:`p${i}`,product_id:`product-${i}`,source_ref:`private://p${i}`}));const m=buildManifestFromAssets({benchmark_id:'b',merchant_id:'habb',assets});assert.equal(m.cases.length,50)});
