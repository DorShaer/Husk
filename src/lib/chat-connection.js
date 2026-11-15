'use strict';

function resolveChatConnection({ config = {}, connection, command } = {}) {
  if (connection !== undefined && connection !== 'cli' && connection !== 'endpoint') return { ok: false, error: 'Choose a CLI or endpoint connection for this chat.' };
  const endpoint = connection === 'endpoint' || (connection === undefined && !command && config.agentVendor === 'openai');
  if (!endpoint) return { ok: true, connection: 'cli', openai: null };
  const baseUrl = String(config.agentBaseUrl || '').trim();
  const model = String(config.agentModel || '').trim();
  if (!baseUrl || !model) return { ok: false, error: 'Configure an endpoint URL and model before starting this chat.' };
  return { ok: true, connection: 'endpoint', openai: { baseUrl, model, apiKey: String(config.agentApiKey || '').trim() } };
}

function applyCliEndpoint(env, config = {}, command) {
  if (config.agentVendor !== 'claude' || !command || require('./agent-oneshot').agentBaseName(command) !== 'claude') return env;
  const baseUrl = typeof config.agentBaseUrl === 'string' ? config.agentBaseUrl.trim() : '';
  const apiKey = typeof config.agentApiKey === 'string' ? config.agentApiKey.trim() : '';
  if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;
  if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
  return env;
}

module.exports = { resolveChatConnection, applyCliEndpoint };
