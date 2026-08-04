const axios = require('axios');
const logger = require('./logger');

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL_NAME = process.env.OPENROUTER_MODEL || 'meta-llama/llama-3-8b-instruct:free';

/**
 * Classifies an inbound email using OpenRouter AI API
 */
async function classifyEmail({ subject, body, senderEmail, history = [] }) {
  if (!OPENROUTER_API_KEY) {
    await logger.warn('Classifier', 'OPENROUTER_API_KEY is not set. Falling back to heuristic classifier.');
    return fallbackHeuristicClassifier(subject, body);
  }

  const prompt = `
You are an expert AI email classifier for an automated meeting scheduling system.
Analyze the following email and determine if the sender is requesting, confirming, negotiating, or discussing a meeting schedule.

EMAIL DETAILS:
From: ${senderEmail}
Subject: ${subject}
Body:
"""
${body}
"""

CONVERSATION HISTORY (if any):
${JSON.stringify(history.slice(-3), null, 2)}

INSTRUCTIONS:
Classify into exactly ONE of the following three categories:
1. "SCHEDULING": The email is asking to schedule a meeting, proposing time slots, confirming a proposed time, asking to reschedule, or providing availability.
2. "NOT_SCHEDULING": The email is unrelated to scheduling a meeting (e.g., general inquiry, newsletter, notification, thank you, marketing).
3. "UNCERTAIN": Ambiguous request, complex request beyond basic meeting scheduling, non-English text, or conflicting instructions.

If category is "SCHEDULING", extract:
- durationMinutes: Extracted duration in minutes (default 30 if unspecified)
- timeframe: Mentioned timeframe (e.g. "this week", "tomorrow", "next Monday", "August 10")
- senderTimezone: Any explicitly mentioned timezone (e.g. "EST", "PST", "UTC+2", "Europe/London", null if not mentioned)
- userChoice: If sender is picking one of our previously proposed slots (e.g., "Option 1", "2pm works", "Tuesday at 3pm"), extract the chosen time or index.
- constraints: Any constraints like "mornings only", "after 2pm", "not Friday".

Return ONLY a valid JSON object in this exact format:
{
  "classification": "SCHEDULING" | "NOT_SCHEDULING" | "UNCERTAIN",
  "confidence": 0.95,
  "durationMinutes": 30,
  "timeframe": "this week",
  "senderTimezone": null,
  "userChoice": null,
  "constraints": [],
  "reasoning": "Short explanation of classification"
}
`;

  try {
    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: MODEL_NAME,
        messages: [
          { role: 'system', content: 'You reply ONLY with valid raw JSON without markdown codeblock syntax.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.1
      },
      {
        headers: {
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://render.com',
          'X-Title': 'Autonomous Meeting Scheduler'
        },
        timeout: 15000
      }
    );

    const rawContent = response.data.choices?.[0]?.message?.content || '';
    const cleanJson = rawContent.replace(/```json/g, '').replace(/```/g, '').trim();
    const result = JSON.parse(cleanJson);

    // Enforce confidence threshold
    if (result.confidence < 0.70 && result.classification === 'SCHEDULING') {
      await logger.info('Classifier', `Low confidence (${result.confidence}) for scheduling email. Lowering to UNCERTAIN.`);
      result.classification = 'UNCERTAIN';
    }

    await logger.info('Classifier', `Classified email as ${result.classification}`, result);
    return result;
  } catch (err) {
    await logger.error('Classifier', 'OpenRouter classification failed, using heuristic fallback', err.message);
    return fallbackHeuristicClassifier(subject, body);
  }
}

/**
 * Heuristic fallback classifier when OpenRouter is unreachable or fails
 */
function fallbackHeuristicClassifier(subject, body) {
  const text = `${subject} ${body}`.toLowerCase();
  const keywords = ['meet', 'schedule', 'calendar', 'availability', 'call', 'zoom', 'google meet', 'time slot', 'reschedule', 'free to chat', 'discuss'];

  const matchCount = keywords.filter(kw => text.includes(kw)).length;

  if (matchCount >= 2) {
    return {
      classification: 'SCHEDULING',
      confidence: 0.75,
      durationMinutes: text.includes('15 min') || text.includes('15-min') ? 15 : (text.includes('1 hour') || text.includes('60 min') ? 60 : 30),
      timeframe: 'upcoming',
      senderTimezone: null,
      userChoice: null,
      constraints: [],
      reasoning: 'Heuristic keyword match'
    };
  } else if (matchCount === 1) {
    return {
      classification: 'UNCERTAIN',
      confidence: 0.50,
      durationMinutes: 30,
      timeframe: null,
      senderTimezone: null,
      userChoice: null,
      constraints: [],
      reasoning: 'Ambiguous keyword count'
    };
  }

  return {
    classification: 'NOT_SCHEDULING',
    confidence: 0.90,
    durationMinutes: 30,
    timeframe: null,
    senderTimezone: null,
    userChoice: null,
    constraints: [],
    reasoning: 'No scheduling keywords found'
  };
}

module.exports = {
  classifyEmail
};
