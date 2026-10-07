const REGION_HOSTS = Object.freeze({
  'eu-central-1': 'eu-central-1.maas.aliyuncs.com',
});

export function loadAlibabaCreativeConfig(env = process.env) {
  const apiKey = env.ALIBABA_MODEL_STUDIO_API_KEY || env.DASHSCOPE_API_KEY || null;
  const workspaceId = env.ALIBABA_MODEL_STUDIO_WORKSPACE_ID || null;
  const region = env.ALIBABA_MODEL_STUDIO_REGION || 'eu-central-1';

  if (!REGION_HOSTS[region]) {
    throw new Error(`Unsupported Alibaba Model Studio region for Nordla V0: ${region}`);
  }

  return Object.freeze({
    apiKey,
    workspaceId,
    region,
    textModel: env.ALIBABA_QWEN_TEXT_MODEL || 'qwen3.8-max',
    imageModel: env.ALIBABA_QWEN_IMAGE_MODEL || 'qwen-image-3.0-pro',
    videoModel: env.ALIBABA_WAN_VIDEO_MODEL || 'wan3.0-video',
    requestTimeoutMs: Number(env.ALIBABA_MODEL_STUDIO_TIMEOUT_MS || 120000),
  });
}

export function requireAlibabaCreativeConfig(config) {
  if (!config?.apiKey) throw new Error('Alibaba Model Studio API key is not configured');
  if (!config?.workspaceId) throw new Error('Alibaba Model Studio workspace ID is not configured');
  return config;
}

export function alibabaCreativeEndpoints(config) {
  requireAlibabaCreativeConfig(config);
  const root = `https://${config.workspaceId}.${REGION_HOSTS[config.region]}`;

  return Object.freeze({
    root,
    chatCompletions: `${root}/compatible-mode/v1/chat/completions`,
    imageGenerations: `${root}/compatible-mode/v1/images/generations`,
    imageDashScope: `${root}/api/v1/services/aigc/multimodal-generation/generation`,
    videoSynthesis: `${root}/api/v1/services/aigc/video-generation/video-synthesis`,
    task: (taskId) => `${root}/api/v1/tasks/${encodeURIComponent(taskId)}`,
  });
}
