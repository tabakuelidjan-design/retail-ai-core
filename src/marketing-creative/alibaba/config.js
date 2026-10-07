const REGION_HOSTS = Object.freeze({
  'eu-central-1': 'eu-central-1.maas.aliyuncs.com',
});

const ALLOWED_MODELS = Object.freeze({
  text: new Set(['qwen3.8-max']),
  image: new Set(['qwen-image-3.0-pro']),
  video: new Set(['wan3.0-video']),
});

const WORKSPACE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;

function assertAllowedModel(kind, model) {
  if (!ALLOWED_MODELS[kind].has(model)) {
    throw new Error(`Unsupported Alibaba ${kind} model for Nordla V0: ${model}`);
  }
  return model;
}

export function loadAlibabaCreativeConfig(env = process.env) {
  const apiKey = env.ALIBABA_MODEL_STUDIO_API_KEY || null;
  const workspaceId = env.ALIBABA_MODEL_STUDIO_WORKSPACE_ID || null;
  const region = env.ALIBABA_MODEL_STUDIO_REGION || 'eu-central-1';

  if (!REGION_HOSTS[region]) {
    throw new Error(`Unsupported Alibaba Model Studio region for Nordla V0: ${region}`);
  }
  if (workspaceId != null && !WORKSPACE_ID_RE.test(workspaceId)) {
    throw new Error('Invalid Alibaba Model Studio workspace ID');
  }

  const textModel = assertAllowedModel('text', env.ALIBABA_QWEN_TEXT_MODEL || 'qwen3.8-max');
  const imageModel = assertAllowedModel('image', env.ALIBABA_QWEN_IMAGE_MODEL || 'qwen-image-3.0-pro');
  const videoModel = assertAllowedModel('video', env.ALIBABA_WAN_VIDEO_MODEL || 'wan3.0-video');

  return Object.freeze({
    apiKey,
    workspaceId,
    region,
    textModel,
    imageModel,
    videoModel,
    requestTimeoutMs: Number(env.ALIBABA_MODEL_STUDIO_TIMEOUT_MS || 120000),
  });
}

export function requireAlibabaCreativeConfig(config) {
  if (!config?.apiKey) throw new Error('Alibaba Model Studio API key is not configured');
  if (!config?.workspaceId || !WORKSPACE_ID_RE.test(config.workspaceId)) {
    throw new Error('Alibaba Model Studio workspace ID is not configured or invalid');
  }
  if (!REGION_HOSTS[config.region]) throw new Error('Alibaba Model Studio region is invalid');
  assertAllowedModel('text', config.textModel);
  assertAllowedModel('image', config.imageModel);
  assertAllowedModel('video', config.videoModel);
  return config;
}

function verifiedProviderUrl(config, pathname) {
  requireAlibabaCreativeConfig(config);
  const expectedHost = `${config.workspaceId}.${REGION_HOSTS[config.region]}`;
  const url = new URL(`https://${expectedHost}${pathname}`);

  if (
    url.protocol !== 'https:'
    || url.hostname !== expectedHost
    || url.username
    || url.password
  ) {
    throw new Error('Alibaba Model Studio endpoint validation failed');
  }

  return url.toString();
}

export function alibabaCreativeEndpoints(config) {
  return Object.freeze({
    chatCompletions: verifiedProviderUrl(config, '/compatible-mode/v1/chat/completions'),
    imageGenerations: verifiedProviderUrl(config, '/compatible-mode/v1/images/generations'),
    imageDashScope: verifiedProviderUrl(
      config,
      '/api/v1/services/aigc/multimodal-generation/generation',
    ),
    videoSynthesis: verifiedProviderUrl(
      config,
      '/api/v1/services/aigc/video-generation/video-synthesis',
    ),
    task: (taskId) => verifiedProviderUrl(
      config,
      `/api/v1/tasks/${encodeURIComponent(taskId)}`,
    ),
  });
}
