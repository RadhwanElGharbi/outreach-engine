const { loadSettings } = require('./config');

// =========================================================================
// Multi-LLM abstraction — supports Claude, OpenAI, and Gemini
// =========================================================================

const DEFAULT_MODELS = {
  claude: 'claude-sonnet-4-20250514',
  openai: 'gpt-4o',
  gemini: 'gemini-2.0-flash',
};

async function generate({ system, user, temperature = 0.7, maxTokens = 1024 }) {
  const settings = loadSettings();
  const provider = settings.llmProvider || 'claude';
  const apiKey = settings.llmApiKey;
  const model = settings.llmModel || DEFAULT_MODELS[provider] || DEFAULT_MODELS.claude;

  if (!apiKey) throw new Error(`No API key configured. Go to Settings and add your ${provider} API key.`);

  switch (provider) {
    case 'claude': return generateClaude({ system, user, temperature, maxTokens, apiKey, model });
    case 'openai': return generateOpenAI({ system, user, temperature, maxTokens, apiKey, model });
    case 'gemini': return generateGemini({ system, user, temperature, maxTokens, apiKey, model });
    default: throw new Error(`Unknown LLM provider: ${provider}. Supported: claude, openai, gemini`);
  }
}

// ---- Claude (Anthropic) ----
async function generateClaude({ system, user, temperature, maxTokens, apiKey, model }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`Claude: ${data.error.message}`);
  const text = data.content?.[0]?.text || '';
  const tokens = (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0);
  return { text, tokens };
}

// ---- OpenAI (GPT) ----
async function generateOpenAI({ system, user, temperature, maxTokens, apiKey, model }) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`OpenAI: ${data.error.message}`);
  const text = data.choices?.[0]?.message?.content || '';
  const tokens = (data.usage?.prompt_tokens || 0) + (data.usage?.completion_tokens || 0);
  return { text, tokens };
}

// ---- Gemini (Google) ----
async function generateGemini({ system, user, temperature, maxTokens, apiKey, model }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ parts: [{ text: user }] }],
      generationConfig: { temperature, maxOutputTokens: maxTokens },
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`Gemini: ${data.error.message}`);
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const tokens = (data.usageMetadata?.promptTokenCount || 0) + (data.usageMetadata?.candidatesTokenCount || 0);
  return { text, tokens };
}

module.exports = { generate, DEFAULT_MODELS };
