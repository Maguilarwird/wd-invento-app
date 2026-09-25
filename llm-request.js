// gpt-5.* (5.2, 5.6-luna) rechaza max_tokens y temperature.
// claude-sonnet-5 rechaza temperature. El resto de Claude sigue igual.
export function isGpt5Family(model) {
  return /^gpt-5/i.test(String(model || ''));
}

export function isClaudeSonnet5(model) {
  return /sonnet-5/i.test(String(model || ''));
}

export function normalizeOpenAiChatBody(body = {}) {
  const out = { ...body };
  if (!isGpt5Family(out.model)) return out;
  if (out.max_tokens != null && out.max_completion_tokens == null) {
    out.max_completion_tokens = out.max_tokens;
  }
  delete out.max_tokens;
  delete out.temperature;
  return out;
}

export function normalizeAnthropicBody({
  model,
  max_tokens,
  temperature,
  messages,
  system,
  thinking,
} = {}) {
  const resolved = model || '';
  const out = {
    model: resolved,
    max_tokens: max_tokens || 4096,
    messages,
  };
  if (system) out.system = system;
  if (!isClaudeSonnet5(resolved)) {
    out.temperature = temperature ?? 0;
    return out;
  }
  // Sonnet 5 enciende thinking adaptativo por defecto: se come max_tokens
  // y el primer batch de etiquetado parece trabado en 0%. Para JSON corto
  // lo apagamos, igual que clustering en 4.6 corría sin thinking.
  out.thinking = thinking && thinking.type ? thinking : { type: 'disabled' };
  return out;
}
