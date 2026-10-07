const API_ROOT='https://api.dev.runwayml.com/v1';
const API_VERSION='2024-11-06';

export function loadRunwayConfig(env=process.env){
  const apiSecret=env.RUNWAYML_API_SECRET||null;
  return Object.freeze({
    apiSecret,
    apiRoot:API_ROOT,
    apiVersion:API_VERSION,
    productCampaignVersion:env.RUNWAY_PRODUCT_CAMPAIGN_VERSION||'2026-06',
    productAdVersion:env.RUNWAY_PRODUCT_AD_VERSION||'2026-07',
    timeoutMs:Number(env.RUNWAY_TIMEOUT_MS||120000),
  });
}

export function requireRunwayConfig(config){
  if(!config?.apiSecret) throw new Error('RUNWAYML_API_SECRET is not configured');
  if(config.apiRoot!==API_ROOT) throw new Error('Runway API root override is not allowed in V0');
  return config;
}
