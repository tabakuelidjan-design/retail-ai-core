export function assertPublicProductUrl(value){
  if(typeof value!=='string'||!value) throw new TypeError('product image URL is required');
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password) throw new Error('product image must use credential-free HTTPS');
  return url.toString();
}

export function assertPublicCreativePolicy(policy){
  if(!policy||policy.classification!=='PUBLIC') throw new Error('Runway V0 only accepts PUBLIC data');
  if(policy.contains_personal_data===true||policy.contains_face===true) throw new Error('Runway V0 rejects personal data and faces');
  return policy;
}
