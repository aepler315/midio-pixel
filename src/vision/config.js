export const VISION_PROVIDER_KEY = 'smw:visionProvider';
export const VISION_APIKEY_KEY = 'smw:visionApiKey';
export const VISION_MODEL_KEY = 'smw:visionModel';
export const VISION_ENDPOINT_KEY = 'smw:visionEndpoint';

function storageOrGlobal(storage) {
  return storage || globalThis.localStorage;
}

/** Read provider preferences without ever restoring a persisted API key. */
export function readVisionConfig(storage) {
  try {
    const store = storageOrGlobal(storage);
    return {
      provider: store.getItem(VISION_PROVIDER_KEY) || 'ollama',
      apiKey: '',
      model: store.getItem(VISION_MODEL_KEY) || null,
      endpoint: store.getItem(VISION_ENDPOINT_KEY) || null,
    };
  } catch {
    return { provider: 'ollama', apiKey: '', model: null, endpoint: null };
  }
}

/** Persist non-secret provider preferences and remove any legacy key. */
export function persistVisionConfig({ provider, model, endpoint }, storage) {
  try {
    const store = storageOrGlobal(storage);
    store.setItem(VISION_PROVIDER_KEY, provider || 'ollama');
    store.removeItem(VISION_APIKEY_KEY);
    if (model) store.setItem(VISION_MODEL_KEY, model); else store.removeItem(VISION_MODEL_KEY);
    if (endpoint) store.setItem(VISION_ENDPOINT_KEY, endpoint); else store.removeItem(VISION_ENDPOINT_KEY);
  } catch {
    /* no storage */
  }
}
