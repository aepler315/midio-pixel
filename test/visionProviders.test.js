import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VISION_PROVIDERS, buildVisionRequest, extractVisionContent } from '../src/vision/providers.js';

const BASE = {
  apiKey: 'sk-test',
  endpoint: null,
  model: null,
  systemPrompt: 'SYS',
  telemetry: 'TELE',
  frames: ['aaaa', 'bbbb'],
};

test('buildVisionRequest: ollama uses the chat endpoint with images on the user message', () => {
  const { url, options } = buildVisionRequest('ollama', BASE);
  assert.equal(url, VISION_PROVIDERS.ollama.endpoint);
  const body = JSON.parse(options.body);
  assert.equal(body.model, VISION_PROVIDERS.ollama.model);
  assert.equal(body.messages[1].content, 'TELE');
  assert.deepEqual(body.messages[1].images, BASE.frames);
  assert.equal(options.headers['Content-Type'], 'application/json');
});

test('buildVisionRequest: anthropic sends the key header and a content-block image array', () => {
  const { url, options } = buildVisionRequest('anthropic', BASE);
  assert.equal(url, VISION_PROVIDERS.anthropic.endpoint);
  assert.equal(options.headers['x-api-key'], 'sk-test');
  assert.equal(options.headers['anthropic-version'], '2023-06-01');
  const body = JSON.parse(options.body);
  assert.equal(body.system, 'SYS');
  const content = body.messages[0].content;
  assert.equal(content[0].type, 'text');
  assert.equal(content.length, 1 + BASE.frames.length);
  assert.equal(content[1].source.data, 'aaaa');
});

test('buildVisionRequest: openai and openrouter share the chat-completions shape', () => {
  for (const provider of ['openai', 'openrouter']) {
    const { url, options } = buildVisionRequest(provider, BASE);
    assert.equal(url, VISION_PROVIDERS[provider].endpoint);
    assert.equal(options.headers.Authorization, 'Bearer sk-test');
    const body = JSON.parse(options.body);
    assert.equal(body.messages[0].role, 'system');
    const userContent = body.messages[1].content;
    assert.equal(userContent[0].text, 'TELE');
    assert.ok(userContent[1].image_url.url.startsWith('data:image/jpeg;base64,aaaa'));
  }
});

test('buildVisionRequest: gemini keeps the API key out of the URL', () => {
  const { url, options } = buildVisionRequest('gemini', BASE);
  assert.ok(url.includes(`${VISION_PROVIDERS.gemini.model}:generateContent`));
  assert.ok(!url.includes('key=sk-test'));
  assert.equal(options.headers['x-goog-api-key'], 'sk-test');
  const body = JSON.parse(options.body);
  const parts = body.contents[0].parts;
  assert.ok(parts[0].text.includes('SYS'));
  assert.equal(parts[1].inlineData.data, 'aaaa');
});

test('buildVisionRequest: explicit endpoint/model override the provider default', () => {
  const { url, options } = buildVisionRequest('ollama', { ...BASE, endpoint: 'http://box:1234/api/chat', model: 'custom:1b' });
  assert.equal(url, 'http://box:1234/api/chat');
  assert.equal(JSON.parse(options.body).model, 'custom:1b');
});

test('buildVisionRequest: unknown provider falls back to the ollama shape', () => {
  const a = buildVisionRequest('nonsense', BASE);
  const b = buildVisionRequest('ollama', BASE);
  assert.equal(a.url, b.url);
});

test('extractVisionContent: pulls text out of each provider envelope', () => {
  assert.equal(extractVisionContent('ollama', { message: { content: 'x' } }), 'x');
  assert.equal(extractVisionContent('anthropic', { content: [{ type: 'text', text: 'x' }] }), 'x');
  assert.equal(extractVisionContent('openai', { choices: [{ message: { content: 'x' } }] }), 'x');
  assert.equal(extractVisionContent('openrouter', { choices: [{ message: { content: 'x' } }] }), 'x');
  assert.equal(extractVisionContent('gemini', { candidates: [{ content: { parts: [{ text: 'x' }] } }] }), 'x');
});

test('extractVisionContent: missing fields return empty string rather than throwing', () => {
  assert.equal(extractVisionContent('anthropic', {}), '');
  assert.equal(extractVisionContent('openai', { choices: [] }), '');
  assert.equal(extractVisionContent('gemini', null), '');
});
