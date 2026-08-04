const { fetchEmailContent, sendReply } = require('./gmailService');
const { classifyEmail } = require('./classifier');
const { findAvailableSlots } = require('./slotFinder');
const { generateResponse } = require('./responseGenerator');
const { loadThreadState, getSchedulerState } = require('./memory');
const { transitionThread } = require('./stateMachine');
const { checkSlotAvailable, createCalendarEvent } = require('./calendarService');
const { isAutoResponder, isDuplicateEmail, detectInfiniteLoop, isEmergencyPaused, flagThreadForHuman } = require('./safety');
const logger = require('./logger');

/**
 * Core processing pipeline orchestrator
 */
async function processEmail(messageId) {
  try {
    await logger.info('EmailProcessor', `Starting process for message: ${messageId}`);

    // 1. Fetch full email content
    const email = await fetchEmailContent(messageId);
    const { threadId, senderEmail, subject, body, isAutoReply, senderTimezone, messageIdHeader } = email;

    // 2. Check if scheduler is emergency paused
    if (await isEmergencyPaused(subject, body)) {
      await logger.info('EmailProcessor', `Scheduler is paused. Skipping message ${messageId}.`);
      return { status: 'PAUSED' };
    }

    // 3. Skip user's own sent emails
    const ownerEmail = (process.env.USER_EMAIL || '').toLowerCase();
    if (ownerEmail && senderEmail === ownerEmail) {
      await logger.info('EmailProcessor', `Skipping user's own email from ${senderEmail}`);
      return { status: 'SELF_EMAIL_SKIPPED' };
    }

    // 4. Auto-responder detection
    if (isAutoReply || isAutoResponder([], subject, body)) {
      await logger.warn('EmailProcessor', `Auto-responder detected from ${senderEmail}. Halting processing.`);
      await flagThreadForHuman(threadId, 'Auto-responder detected', { senderEmail });
      return { status: 'AUTO_RESPONDER_STOPPED' };
    }

    // 5. Load thread state
    let thread = await loadThreadState(threadId);
    const threadHistory = thread?.history || [];

    // 6. Deduplication check
    if (isDuplicateEmail(messageId, body, threadHistory)) {
      await logger.info('EmailProcessor', `Duplicate email detected for messageId ${messageId}`);
      return { status: 'DUPLICATE_SKIPPED' };
    }

    // 7. Infinite loop check (> 5 exchanges)
    if (detectInfiniteLoop(threadHistory)) {
      await logger.warn('EmailProcessor', `Possible infinite loop in thread ${threadId}`);
      await flagThreadForHuman(threadId, 'Infinite loop safeguard (>5 turns)', { senderEmail });
      return { status: 'INFINITE_LOOP_FLAGGED' };
    }

    // 8. If thread is already FLAGGED or BOOKED, skip or flag note
    if (thread?.state === 'FLAGGED') {
      await logger.info('EmailProcessor', `Thread ${threadId} is already FLAGGED. Updating history without auto-reply.`);
      return { status: 'THREAD_ALREADY_FLAGGED' };
    }

    // 9. Classify intent
    const classification = await classifyEmail({
      subject,
      body,
      senderEmail,
      history: threadHistory
    });

    if (classification.classification === 'NOT_SCHEDULING') {
      await logger.info('EmailProcessor', `Message ${messageId} is NOT_SCHEDULING. Ignoring.`);
      return { status: 'NOT_SCHEDULING_IGNORED' };
    }

    if (classification.classification === 'UNCERTAIN') {
      await logger.warn('EmailProcessor', `Message ${messageId} classified as UNCERTAIN.`);
      await flagThreadForHuman(threadId, `Uncertain intent: ${classification.reasoning}`, { senderEmail });
      return { status: 'UNCERTAIN_FLAGGED' };
    }

    // 10. Process SCHEDULING intent
    const durationMinutes = classification.durationMinutes || 30;

    // Check if recipient is selecting a proposed slot from previous offer
    if (thread?.proposedSlots && thread.proposedSlots.length > 0) {
      let chosenSlot = null;

      // Check choice indexing (e.g. Option 1, 2, 3) or matching text
      if (classification.userChoice) {
        if (typeof classification.userChoice === 'number' && thread.proposedSlots[classification.userChoice - 1]) {
          chosenSlot = thread.proposedSlots[classification.userChoice - 1];
        } else {
          // Check matching slot in array
          chosenSlot = thread.proposedSlots.find(s =>
            (classification.userChoice && typeof classification.userChoice === 'string' && s.formattedSenderTz.toLowerCase().includes(classification.userChoice.toLowerCase()))
          );
        }
      }

      // Default to first slot if explicitly confirmed (e.g. "That time works", "Sounds good")
      if (!chosenSlot && (body.toLowerCase().includes('option 1') || body.toLowerCase().includes('first option'))) {
        chosenSlot = thread.proposedSlots[0];
      } else if (!chosenSlot && body.toLowerCase().includes('option 2')) {
        chosenSlot = thread.proposedSlots[1];
      } else if (!chosenSlot && body.toLowerCase().includes('option 3')) {
        chosenSlot = thread.proposedSlots[2];
      } else if (!chosenSlot && (body.toLowerCase().includes('works') || body.toLowerCase().includes('sounds good') || body.toLowerCase().includes('perfect'))) {
        chosenSlot = thread.proposedSlots[0]; // pick first proposed slot
      }

      if (chosenSlot) {
        // DOUBLE CHECK SLOT AVAILABILITY AT BOOKING TIME
        const isFree = await checkSlotAvailable(chosenSlot.startISO, chosenSlot.endISO);

        if (isFree) {
          // CREATE CALENDAR EVENT
          const eventDetails = await createCalendarEvent({
            summary: subject.replace(/^Re:\s*/i, ''),
            description: `Scheduled autonomously via Autonomous Scheduler.\n\nOriginal Request: ${body}`,
            startISO: chosenSlot.startISO,
            endISO: chosenSlot.endISO,
            attendees: [senderEmail],
            timeZone: senderTimezone || 'UTC'
          });

          // GENERATE CONFIRMATION REPLY
          const replyText = await generateResponse({
            type: 'CONFIRMATION',
            bookedDetails: eventDetails,
            originalSubject: subject,
            senderName: senderEmail.split('@')[0],
            originalEmail: body
          });

          await sendReply({
            threadId,
            to: senderEmail,
            subject,
            body: replyText,
            inReplyToMessageId: messageIdHeader
          });

          await transitionThread(threadId, 'BOOKED', {
            senderEmail,
            bookedEvent: eventDetails,
            finalSlot: chosenSlot
          });

          return { status: 'BOOKED_SUCCESS', event: eventDetails };
        } else {
          // Slot was taken in the meantime! Offer fresh slots
          const newSlots = await findAvailableSlots({ durationMinutes, senderTimezone });
          const apologyReply = await generateResponse({
            type: 'APOLOGY_SLOT_TAKEN',
            proposedSlots: newSlots,
            originalSubject: subject,
            senderName: senderEmail.split('@')[0],
            originalEmail: body
          });

          await sendReply({
            threadId,
            to: senderEmail,
            subject,
            body: apologyReply,
            inReplyToMessageId: messageIdHeader
          });

          await transitionThread(threadId, 'PROPOSED', {
            senderEmail,
            proposedSlots: newSlots
          });

          return { status: 'SLOT_TAKEN_REPROPOSED' };
        }
      }
    }

    // 11. Initial Proposal or Counter-Offer Negotiation
    const availableSlots = await findAvailableSlots({
      durationMinutes,
      senderTimezone: senderTimezone || classification.senderTimezone,
      constraints: classification.constraints
    });

    if (!availableSlots || availableSlots.length === 0) {
      await flagThreadForHuman(threadId, 'No open calendar slots found meeting criteria', { senderEmail });
      return { status: 'NO_SLOTS_FLAGGED' };
    }

    const responseType = thread?.state === 'PROPOSED' ? 'NEGOTIATION' : 'PROPOSAL';
    const replyText = await generateResponse({
      type: responseType,
      proposedSlots: availableSlots,
      originalSubject: subject,
      senderName: senderEmail.split('@')[0],
      originalEmail: body
    });

    await sendReply({
      threadId,
      to: senderEmail,
      subject,
      body: replyText,
      inReplyToMessageId: messageIdHeader
    });

    const targetState = responseType === 'NEGOTIATION' ? 'NEGOTIATING' : 'PROPOSED';
    await transitionThread(threadId, targetState, {
      senderEmail,
      senderTimezone,
      proposedSlots: availableSlots,
      lastMessageId: messageId
    });

    return { status: `${targetState}_SENT`, slots: availableSlots };

  } catch (err) {
    await logger.error('EmailProcessor', `Unhandled error processing message ${messageId}`, err.stack);
    return { status: 'ERROR', error: err.message };
  }
}

module.exports = {
  processEmail
};
