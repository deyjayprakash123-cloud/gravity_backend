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
  console.log('=========================================');
  console.log('📨 NEW EMAIL RECEIVED');
  console.log('Message ID:', messageId);
  console.log('Timestamp:', new Date().toISOString());

  try {
    // Step 1: Fetch email
    console.log('Step 1: Fetching email...');
    const email = await fetchEmailContent(messageId);
    const { threadId, senderEmail, subject, body, isAutoReply, senderTimezone, messageIdHeader, from } = email;
    console.log('From:', from);
    console.log('Subject:', subject);
    console.log('Thread ID:', threadId);

    // Step 2: Check if from self
    console.log('Step 2: Checking if from self...');
    const ownerEmail = (process.env.USER_EMAIL || '').toLowerCase();
    if (ownerEmail && senderEmail === ownerEmail) {
      console.log('❌ Email is from self - skipping');
      console.log('=========================================');
      return { status: 'SELF_EMAIL_SKIPPED' };
    }

    // Step 3: Check if already processed / duplicate
    console.log('Step 3: Checking duplicates...');
    let thread = await loadThreadState(threadId);
    const threadHistory = thread?.history || [];
    if (isDuplicateEmail(messageId, body, threadHistory)) {
      console.log('❌ Already processed - skipping');
      console.log('=========================================');
      return { status: 'DUPLICATE_SKIPPED' };
    }

    // Step 4: Check auto-responder
    console.log('Step 4: Checking auto-responder...');
    if (isAutoReply || isAutoResponder([], subject, body)) {
      console.log('❌ Auto-responder detected - stopping');
      await flagThreadForHuman(threadId, 'Auto-responder detected', { senderEmail });
      console.log('=========================================');
      return { status: 'AUTO_RESPONDER_STOPPED' };
    }

    // Check emergency pause & infinite loop
    if (await isEmergencyPaused(subject, body)) {
      console.log('❌ Scheduler is emergency paused - skipping');
      console.log('=========================================');
      return { status: 'PAUSED' };
    }

    if (detectInfiniteLoop(threadHistory)) {
      console.log('❌ Infinite loop safeguard triggered (>5 turns)');
      await flagThreadForHuman(threadId, 'Infinite loop safeguard (>5 turns)', { senderEmail });
      console.log('=========================================');
      return { status: 'INFINITE_LOOP_FLAGGED' };
    }

    if (thread?.state === 'FLAGGED') {
      console.log('❌ Thread is already FLAGGED - skipping auto-reply');
      console.log('=========================================');
      return { status: 'THREAD_ALREADY_FLAGGED' };
    }

    // Step 5: Classify intent
    console.log('Step 5: Classifying intent...');
    const classification = await classifyEmail({
      subject,
      body,
      senderEmail,
      history: threadHistory
    });
    console.log('Classification:', classification);

    if (classification.classification === 'NOT_SCHEDULING') {
      console.log('❌ Intent is NOT_SCHEDULING - ignoring');
      console.log('=========================================');
      return { status: 'NOT_SCHEDULING_IGNORED' };
    }

    if (classification.classification === 'UNCERTAIN') {
      console.log('⚠️ Intent is UNCERTAIN - flagging for human review');
      await flagThreadForHuman(threadId, `Uncertain intent: ${classification.reasoning}`, { senderEmail });
      console.log('=========================================');
      return { status: 'UNCERTAIN_FLAGGED' };
    }

    // Step 6: Processing SCHEDULING intent
    console.log('Step 6: Processing scheduling request...');
    const durationMinutes = classification.durationMinutes || 30;

    // Check if recipient is selecting a proposed slot from previous offer
    if (thread?.proposedSlots && thread.proposedSlots.length > 0) {
      let chosenSlot = null;

      if (classification.userChoice) {
        if (typeof classification.userChoice === 'number' && thread.proposedSlots[classification.userChoice - 1]) {
          chosenSlot = thread.proposedSlots[classification.userChoice - 1];
        } else {
          chosenSlot = thread.proposedSlots.find(s =>
            (classification.userChoice && typeof classification.userChoice === 'string' && s.formattedSenderTz.toLowerCase().includes(classification.userChoice.toLowerCase()))
          );
        }
      }

      if (!chosenSlot && (body.toLowerCase().includes('option 1') || body.toLowerCase().includes('first option'))) {
        chosenSlot = thread.proposedSlots[0];
      } else if (!chosenSlot && body.toLowerCase().includes('option 2')) {
        chosenSlot = thread.proposedSlots[1];
      } else if (!chosenSlot && body.toLowerCase().includes('option 3')) {
        chosenSlot = thread.proposedSlots[2];
      } else if (!chosenSlot && (body.toLowerCase().includes('works') || body.toLowerCase().includes('sounds good') || body.toLowerCase().includes('perfect'))) {
        chosenSlot = thread.proposedSlots[0];
      }

      if (chosenSlot) {
        console.log('User chosen slot identified:', chosenSlot);
        const isFree = await checkSlotAvailable(chosenSlot.startISO, chosenSlot.endISO);

        if (isFree) {
          console.log('Booking confirmed calendar event...');
          const eventDetails = await createCalendarEvent({
            summary: subject.replace(/^Re:\s*/i, ''),
            description: `Scheduled autonomously via Autonomous Scheduler.\n\nOriginal Request: ${body}`,
            startISO: chosenSlot.startISO,
            endISO: chosenSlot.endISO,
            attendees: [senderEmail],
            timeZone: senderTimezone || 'UTC'
          });

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

          console.log('✅ Email processed successfully: BOOKED');
          console.log('=========================================');
          return { status: 'BOOKED_SUCCESS', event: eventDetails };
        } else {
          console.log('Chosen slot unavailable; re-proposing new slots...');
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

          console.log('✅ Email processed successfully: REPROPOSED');
          console.log('=========================================');
          return { status: 'SLOT_TAKEN_REPROPOSED' };
        }
      }
    }

    // Initial proposal or negotiation
    console.log('Finding open calendar slots...');
    const availableSlots = await findAvailableSlots({
      durationMinutes,
      senderTimezone: senderTimezone || classification.senderTimezone,
      constraints: classification.constraints
    });

    if (!availableSlots || availableSlots.length === 0) {
      console.log('❌ No open slots found - flagging thread');
      await flagThreadForHuman(threadId, 'No open calendar slots found meeting criteria', { senderEmail });
      console.log('=========================================');
      return { status: 'NO_SLOTS_FLAGGED' };
    }

    const responseType = thread?.state === 'PROPOSED' ? 'NEGOTIATION' : 'PROPOSAL';
    console.log(`Generating ${responseType} response text...`);
    const replyText = await generateResponse({
      type: responseType,
      proposedSlots: availableSlots,
      originalSubject: subject,
      senderName: senderEmail.split('@')[0],
      originalEmail: body
    });

    console.log('Sending reply via Gmail API...');
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

    console.log(`✅ Email processed successfully: ${targetState}`);
    console.log('=========================================');
    return { status: `${targetState}_SENT`, slots: availableSlots };

  } catch (err) {
    console.error('❌ Unhandled error processing email:', err);
    await logger.error('EmailProcessor', `Unhandled error processing message ${messageId}`, err.stack);
    console.log('=========================================');
    return { status: 'ERROR', error: err.message };
  }
}

module.exports = {
  processEmail
};
