const fetch = require('node-fetch');

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Primary: openrouter/free auto-picks whatever free model is available right now
// Fallbacks tried in order if primary fails
const MODELS = [
  'openrouter/free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'google/gemma-3-12b-it:free',
];

const SYSTEM_PROMPT = `You are Study-Hub AI, a smart study assistant integrated into a personal knowledge management system.

You have access to the user's notes and uploaded PDF documents. You can:
1. Answer questions based on stored notes and PDFs
2. Summarize notes or PDF content
3. Generate structured study notes from PDFs
4. Help organize and understand study materials
5. Answer general knowledge questions

When the user asks you to CREATE or SAVE notes, generate the note content between special tags:
[[CREATE_NOTE]]
# Note Title

Note content in markdown format...
[[/CREATE_NOTE]]

The system will automatically detect this and save the note to their library.

Always be concise, helpful, and academic in tone. Format responses with markdown when appropriate.
Use headings, bullet points, and code blocks where they aid clarity.

If you reference a PDF or note, mention it by name for transparency.`;

const callOpenRouter = async (apiKey, model, messages) => {
  const response = await fetch(OPENROUTER_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'http://localhost:3000',
      'X-Title': 'Study-Hub',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.7,
      max_tokens: 2048,
    }),
    timeout: 30000,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    let errorMsg;
    try {
      errorMsg = JSON.parse(errorBody).error?.message || `HTTP ${response.status}`;
    } catch {
      errorMsg = `HTTP ${response.status}: ${errorBody.slice(0, 200)}`;
    }
    throw new Error(errorMsg);
  }

  const data = await response.json();
  if (!data.choices || data.choices.length === 0) {
    throw new Error('No response generated');
  }
  return data.choices[0].message?.content || '';
};

const chat = async (history, context, user) => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || apiKey === 'your_openrouter_api_key_here') {
    throw new Error('OpenRouter API key not configured. Please set OPENROUTER_API_KEY in your .env file.');
  }

  // Build context string
  let contextStr = '';

  if (context.notes && context.notes.length > 0) {
    if (context.notes.length === 1) {
      contextStr += `\n\n--- ATTACHED NOTE: "${context.notes[0].title || 'Untitled'}" ---\n`;
      contextStr += context.notes[0].content;
      contextStr += '\n--- END OF NOTE ---\n';
    } else {
      contextStr += "\n\n--- USER'S ATTACHED NOTES ---\n";
      context.notes.forEach(n => {
        contextStr += `\n**${n.title || 'Untitled'}:**\n${n.content.slice(0, 3000)}\n---\n`;
      });
    }
  }

  if (context.pdfs && context.pdfs.length > 0) {
    if (context.pdfs.length === 1) {
      const p = context.pdfs[0];
      contextStr += `\n\n--- ATTACHED PDF: "${p.original_name}" (${p.page_count} pages) ---\n`;
      contextStr += p.extracted_text ? p.extracted_text.slice(0, 15000) : '[No text extracted]';
      contextStr += '\n--- END OF PDF ---\n';
    } else {
      contextStr += "\n\n--- USER'S ATTACHED PDFs ---\n";
      context.pdfs.forEach(p => {
        contextStr += `\n**${p.original_name}** (${p.page_count} pages):\n`;
        if (p.extracted_text) contextStr += p.extracted_text.slice(0, 5000) + '\n---\n';
      });
    }
  }

  const systemWithContext = SYSTEM_PROMPT + (contextStr ? `\n\nCONTEXT FROM USER'S LIBRARY:${contextStr}` : '');
  const messages = [{ role: 'system', content: systemWithContext }];
  for (const msg of history) {
    if (msg.role === 'system') continue;
    messages.push({ role: msg.role, content: msg.content });
  }

  // Try each model in order until one works
  let lastError;
  for (const model of MODELS) {
    try {
      console.log(`[LLM] Trying OpenRouter model: ${model}`);
      const text = await callOpenRouter(apiKey, model, messages);
      console.log(`[LLM] Success with ${model}`);
      return text;
    } catch (err) {
      console.warn(`[LLM] Failed with ${model}: ${err.message}`);
      lastError = err;
    }
  }
  throw new Error(`All models failed. Last error: ${lastError?.message}`);
};

module.exports = { chat };
