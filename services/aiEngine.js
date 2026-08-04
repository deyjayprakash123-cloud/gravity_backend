const axios = require('axios');
const logger = require('./logger');

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL_NAME = process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free';
const CREDIT_EXHAUSTION_MESSAGE = "Not enough credits. Contact deyjayprakash123@gmail.com";

async function classifyEmail(body, subject, history = []) {
  if (!OPENROUTER_API_KEY) {
    return fallbackHeuristicClassifier(subject, body);
  }

  const prompt = `
You are an expert AI email classifier for an automated meeting scheduling SaaS.
Analyze the email and determine if the sender wants to schedule, confirm, reschedule, or discuss a meeting.

Subject: ${subject}
Body: ${body}

CONVERSATION HISTORY:
${JSON.stringify(history.slice(-3), null, 2)}

Return ONLY a raw JSON object matching this structure with no markdown backticks:
{
  "intent": "SCHEDULING" | "NOT_SCHEDULING" | "UNCERTAIN",
  "confidence": 0.95,
  "extracted": {
    "duration": 30,
    "timeframe": "this week",
    "constraints": [],
    "topic": "discussion",
    "timezone": null
  },
  "userChoice": null,
  "reasoning": "Explanation"
}
`;

  try {
    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: MODEL_NAME,
        messages: [
          { role: 'system', content: 'You respond ONLY with valid raw JSON.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.1,
        max_tokens: 300
      },
      {
        headers: {
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    const rawContent = response.data.choices?.[0]?.message?.content || '';
    const cleanJson = rawContent.replace(/```json/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleanJson);

    if (parsed.confidence < 0.70 && parsed.intent === 'SCHEDULING') {
      parsed.intent = 'UNCERTAIN';
    }

    return parsed;
  } catch (err) {
    if (err.response && (err.response.status === 402 || err.response.status === 429)) {
      await logger.error('AIEngine', CREDIT_EXHAUSTION_MESSAGE, err.message);
    } else {
      await logger.warn('AIEngine', 'Classification fallback triggered', err.message);
    }
    return fallbackHeuristicClassifier(subject, body);
  }
}

function fallbackHeuristicClassifier(subject, body) {
  const text = `${subject} ${body}`.toLowerCase();
  const keywords = ['meet', 'schedule', 'calendar', 'availability', 'call', 'zoom', 'google meet', 'time slot', 'reschedule', 'free to chat', 'discuss'];
  const count = keywords.filter(k => text.includes(k)).length;

  if (count >= 2) {
    return {
      intent: 'SCHEDULING',
      confidence: 0.80,
      extracted: {
        duration: text.includes('15 min') ? 15 : (text.includes('1 hour') ? 60 : 30),
        timeframe: 'upcoming',
        constraints: [],
        topic: 'meeting'
      },
      reasoning: 'Heuristic keyword match'
    };
  }

  return {
    intent: 'NOT_SCHEDULING',
    confidence: 0.90,
    extracted: {},
    reasoning: 'No scheduling keywords'
  };
}

async function generateProposalEmail(userEmail, senderName, slots, requestDetails, toneProfile = {}) {
  const greeting = toneProfile.greeting || 'Hi';
  const signOff = toneProfile.signOff || 'Best';

  const slotListText = slots.map((s, idx) => {
    return `Option ${idx + 1}: ${s.day}, ${s.date} at ${s.startTime} - ${s.endTime} IST`;
  }).join('\n');

  if (OPENROUTER_API_KEY) {
    try {
      const response = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model: 'mistralai/mistral-7b-instruct',
          messages: [
            {
              role: 'system',
              content: 'You write short, warm, and professional email body copy in Indian English. Do NOT include Subject headers.'
            },
            {
              role: 'user',
              content: `Write a brief email reply to ${senderName} proposing these meeting slots in IST:\n${slotListText}\n\nGreeting: "${greeting} ${senderName},"\nSign-off: "${signOff},"`
            }
          ],
          temperature: 0.5,
          max_tokens: 250
        },
        {
          headers: {
            'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json'
          },
          timeout: 15000
        }
      );

      const text = response.data.choices?.[0]?.message?.content?.trim();
      if (text) return text;
    } catch (err) {
      if (err.response && (err.response.status === 402 || err.response.status === 429)) {
        await logger.error('AIEngine', CREDIT_EXHAUSTION_MESSAGE, err.message);
      }
    }
  }

  return `${greeting} ${senderName},\n\nThanks for reaching out! Here are a few meeting times that work for me in IST:\n\n${slotListText}\n\nPlease let me know which option suits you best.\n\n${signOff},`;
}

async function analyzeReply(body, threadState) {
  if (OPENROUTER_API_KEY) {
    try {
      const response = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model: MODEL_NAME,
          messages: [
            {
              role: 'system',
              content: `Analyze this email reply to a meeting proposal. Return ONLY JSON: {"type": "ACCEPTED"|"COUNTER"|"DECLINED"|"UNCLEAR", "chosenSlotIndex": number or null}`
            },
            {
              role: 'user',
              content: `Proposed Slots: ${JSON.stringify(threadState.proposedSlots)}\n\nReply Body: ${body}`
            }
          ],
          max_tokens: 150,
          temperature: 0.1
        },
        {
          headers: {
            'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json'
          },
          timeout: 15000
        }
      );

      const cleanJson = response.data.choices[0].message.content.replace(/```json/g, '').replace(/```/g, '').trim();
      return JSON.parse(cleanJson);
    } catch (err) {
      if (err.response && (err.response.status === 402 || err.response.status === 429)) {
        await logger.error('AIEngine', CREDIT_EXHAUSTION_MESSAGE, err.message);
      }
    }
  }

  const lower = body.toLowerCase();
  if (lower.includes('option 1') || lower.includes('first option') || lower.includes('sounds good') || lower.includes('works for me')) {
    return { type: 'ACCEPTED', chosenSlotIndex: 0 };
  } else if (lower.includes('option 2')) {
    return { type: 'ACCEPTED', chosenSlotIndex: 1 };
  } else if (lower.includes('option 3')) {
    return { type: 'ACCEPTED', chosenSlotIndex: 2 };
  }

  return { type: 'UNCLEAR', chosenSlotIndex: null };
}

async function generateConfirmation(senderName, bookedDetails, toneProfile = {}) {
  const greeting = toneProfile.greeting || 'Hi';
  const signOff = toneProfile.signOff || 'Best';

  const startTime = bookedDetails?.start ? new Date(bookedDetails.start).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : 'our agreed time';
  const meetLink = bookedDetails?.meetLink || 'Google Meet link attached to calendar invitation';

  return `${greeting} ${senderName},\n\nGreat! I have confirmed our meeting for ${startTime} IST. A Google Calendar invite with the meeting link (${meetLink}) has been sent to your inbox.\n\nLooking forward to speaking.\n\n${signOff},`;
}

module.exports = {
  CREDIT_EXHAUSTION_MESSAGE,
  classifyEmail,
  generateProposalEmail,
  analyzeReply,
  generateConfirmation
};
