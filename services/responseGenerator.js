const axios = require('axios');
const { loadToneProfile } = require('./memory');
const logger = require('./logger');

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL_NAME = process.env.OPENROUTER_MODEL || 'meta-llama/llama-3-8b-instruct:free';

/**
 * Generate customized AI email response using OpenRouter API
 */
async function generateResponse({ type, proposedSlots = [], bookedDetails = null, originalSubject, senderName = 'there', originalEmail = '' }) {
  const toneProfile = (await loadToneProfile()) || {
    greeting: 'Hi',
    signOff: 'Best',
    formality: 5,
    samplePhrase: ''
  };

  const userEmail = process.env.USER_EMAIL || 'me';

  // Format slots text
  const slotListText = proposedSlots.map((s, idx) => {
    const formatted = s.formattedSenderTz || s.formattedUserTz || s.startISO;
    return `Option ${idx + 1}: ${formatted}`;
  }).join('\n');

  let prompt = '';

  if (type === 'PROPOSAL') {
    prompt = `
Write a short, professional, and friendly email proposing meeting times.

TONE CONSTRAINTS:
- Greeting style: "${toneProfile.greeting} ${senderName},"
- Sign-off style: "${toneProfile.signOff},"
- Formality level (1=casual, 10=formal): ${toneProfile.formality}
- Length limit: 3-4 sentences total. Do NOT be overly wordy.

CONTEXT:
Original Subject: "${originalSubject}"
Original Request: "${originalEmail}"

AVAILABLE TIME SLOTS TO OFFER:
${slotListText}

INSTRUCTIONS:
1. Greet the recipient warmly.
2. Direct them to pick one of the options above or suggest an alternative if none work.
3. Conclude with the specified sign-off.
`;
  } else if (type === 'CONFIRMATION') {
    prompt = `
Write a short meeting confirmation email.

TONE CONSTRAINTS:
- Greeting style: "${toneProfile.greeting} ${senderName},"
- Sign-off style: "${toneProfile.signOff},"
- Formality level: ${toneProfile.formality}
- Length limit: 2-3 sentences.

MEETING DETAILS:
- Subject: ${bookedDetails?.summary || originalSubject}
- Time: ${bookedDetails?.start ? new Date(bookedDetails.start).toLocaleString() : 'Confirmed time'}
- Google Meet Link: ${bookedDetails?.meetLink || 'Google Meet link attached to calendar invitation'}

INSTRUCTIONS:
Confirm that the meeting has been scheduled and the calendar invitation has been sent with the video link.
`;
  } else if (type === 'APOLOGY_SLOT_TAKEN') {
    prompt = `
Write a brief apology email explaining that the chosen time slot was just booked by someone else.

TONE CONSTRAINTS:
- Greeting style: "${toneProfile.greeting} ${senderName},"
- Sign-off style: "${toneProfile.signOff},"
- Formality level: ${toneProfile.formality}
- Length limit: 3 sentences.

NEW TIME SLOTS OFFERED:
${slotListText}

INSTRUCTIONS:
Apologize concisely for the chosen slot becoming unavailable and offer the new proposed time slots above.
`;
  } else if (type === 'NEGOTIATION') {
    prompt = `
Write a concise email responding to a counter-proposal for meeting times.

TONE CONSTRAINTS:
- Greeting style: "${toneProfile.greeting} ${senderName},"
- Sign-off style: "${toneProfile.signOff},"
- Formality level: ${toneProfile.formality}

SLOTS AVAILABLE:
${slotListText}

INSTRUCTIONS:
Acknowledge their response and offer the updated time options above.
`;
  }

  if (OPENROUTER_API_KEY) {
    try {
      const response = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model: MODEL_NAME,
          messages: [
            { role: 'system', content: 'You write clean email body copy only. Do NOT include Subject line header prefixes.' },
            { role: 'user', content: prompt }
          ],
          temperature: 0.3
        },
        {
          headers: {
            'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json'
          },
          timeout: 15000
        }
      );

      const generated = response.data.choices?.[0]?.message?.content?.trim();
      if (generated) return generated;
    } catch (err) {
      await logger.error('ResponseGenerator', 'OpenRouter API failed, using template fallback', err.message);
    }
  }

  // Template Fallback
  return fallbackTemplate({ type, toneProfile, senderName, slotListText, bookedDetails });
}

function fallbackTemplate({ type, toneProfile, senderName, slotListText, bookedDetails }) {
  const greeting = `${toneProfile.greeting} ${senderName},`;
  const signOff = `${toneProfile.signOff},`;

  if (type === 'PROPOSAL') {
    return `${greeting}\n\nThanks for reaching out! I would be happy to connect. Here are a few times that work well for me:\n\n${slotListText}\n\nPlease let me know which of these options works best for you, or if you prefer a different time.\n\n${signOff}`;
  } else if (type === 'CONFIRMATION') {
    return `${greeting}\n\nGreat! I have confirmed our meeting for ${bookedDetails?.start ? new Date(bookedDetails.start).toLocaleString() : 'our agreed time'}. A Google Calendar invite with the meeting link (${bookedDetails?.meetLink || 'Google Meet'}) has been sent to your inbox.\n\nLooking forward to speaking.\n\n${signOff}`;
  } else if (type === 'APOLOGY_SLOT_TAKEN') {
    return `${greeting}\n\nApologies, but that specific time slot was just taken. Here are a few alternative times that are available:\n\n${slotListText}\n\nPlease let me know if any of these work for you.\n\n${signOff}`;
  }

  return `${greeting}\n\nThanks for your note. Here are available times for our meeting:\n\n${slotListText}\n\n${signOff}`;
}

module.exports = {
  generateResponse
};
