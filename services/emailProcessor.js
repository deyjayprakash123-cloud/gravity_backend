const { fetchEmailContent, sendReply } = require('./gmailService');
const { getUserThread, saveUserThread, getUserRules, getUserTone, getUserState } = require('./userManager');
const { classifyEmail, generateProposalEmail, analyzeReply, generateConfirmation } = require('./aiEngine');
const { findAvailableSlots } = require('./slotFinder');
const { createCalendarEvent, checkSlotAvailable } = require('./calendarService');
const { transitionThread, STATES } = require('./stateMachine');
const { recordEmailHandled, recordMeetingBooked, recordThreadFlagged, recordActivity } = require('./statsTracker');
const logger = require('./logger');

async function processEmail(userEmail, messageId) {
  await logger.info('EmailProcessor', `Processing email message ${messageId} for user ${userEmail}`);

  // 1. Check if user is paused
  const userState = await getUserState(userEmail);
  if (userState.paused) {
    await logger.info('EmailProcessor', `User ${userEmail} is PAUSED. Skipping email ${messageId}`);
    return { status: 'SKIPPED_PAUSED' };
  }

  // 2. Fetch email details
  const email = await fetchEmailContent(userEmail, messageId);

  // 3. Skip if sent by user self
  if (email.senderEmail === userEmail.toLowerCase()) {
    await logger.info('EmailProcessor', `Skipping self-sent email ${messageId} for ${userEmail}`);
    return { status: 'SKIPPED_SELF' };
  }

  // 4. Skip auto-responders
  if (email.isAutoReply) {
    await logger.info('EmailProcessor', `Skipping auto-reply email ${messageId} for ${userEmail}`);
    return { status: 'SKIPPED_AUTOREPLY' };
  }

  // 5. Load thread state
  let thread = (await getUserThread(userEmail, email.threadId)) || {
    threadId: email.threadId,
    userEmail,
    senderEmail: email.senderEmail,
    subject: email.subject,
    state: STATES.UNCLASSIFIED,
    processedMessages: [],
    history: []
  };

  // Skip duplicate processing
  if ((thread.processedMessages || []).includes(messageId)) {
    return { status: 'ALREADY_PROCESSED' };
  }
  thread.processedMessages = [...(thread.processedMessages || []), messageId];

  // Record initial stats
  await recordEmailHandled(userEmail, {
    icon: 'Mail',
    description: `Received email from ${email.from}: "${email.subject}"`,
    sender: email.from,
    subject: email.subject,
    threadId: email.threadId
  });

  const rules = (await getUserRules(userEmail)) || {};
  const tone = (await getUserTone(userEmail)) || {};

  // 6. If thread is brand new or UNCLASSIFIED, run classifier
  if (!thread.state || thread.state === STATES.UNCLASSIFIED) {
    const classification = await classifyEmail(email.body, email.subject, thread.history || []);

    if (classification.intent === 'NOT_SCHEDULING') {
      await saveUserThread(userEmail, email.threadId, { ...thread, state: STATES.COMPLETED });
      return { status: 'NOT_SCHEDULING' };
    }

    if (classification.intent === 'UNCERTAIN') {
      await transitionThread(userEmail, email.threadId, STATES.FLAGGED, {
        reason: 'Low AI classification confidence'
      });
      await recordThreadFlagged(userEmail, {
        icon: 'AlertTriangle',
        description: `Flagged thread from ${email.from} (Uncertain intent)`,
        sender: email.from,
        threadId: email.threadId
      });
      return { status: 'FLAGGED' };
    }

    // Scheduling intent detected -> Find available slots
    const slots = await findAvailableSlots({
      userEmail,
      durationMinutes: classification.extracted?.duration || rules.preferredDuration || 30
    });

    if (!slots || slots.length === 0) {
      await transitionThread(userEmail, email.threadId, STATES.FLAGGED, {
        reason: 'No open slots found in user calendar'
      });
      return { status: 'FLAGGED_NO_SLOTS' };
    }

    // Generate proposal email
    const proposalText = await generateProposalEmail(userEmail, email.from.split('<')[0].trim(), slots, classification.extracted, tone);

    // Send reply
    await sendReply({
      userEmail,
      threadId: email.threadId,
      to: email.from,
      subject: email.subject,
      body: proposalText,
      inReplyToMessageId: email.messageIdHeader || email.id
    });

    // Update thread state to PROPOSED
    thread.proposedSlots = slots;
    thread.classification = classification;
    await transitionThread(userEmail, email.threadId, STATES.PROPOSED, {
      action: 'Sent meeting slot proposals',
      slots
    });

    await recordActivity(userEmail, {
      icon: 'Send',
      description: `Sent meeting slot options to ${email.from}`,
      sender: email.from,
      threadId: email.threadId
    });

    return { status: 'PROPOSED' };
  }

  // 7. If thread is in PROPOSED or NEGOTIATING, evaluate reply
  if ([STATES.PROPOSED, STATES.NEGOTIATING].includes(thread.state)) {
    const analysis = await analyzeReply(email.body, thread);

    if (analysis.type === 'ACCEPTED' && analysis.chosenSlotIndex !== null) {
      const chosenSlot = thread.proposedSlots[analysis.chosenSlotIndex] || thread.proposedSlots[0];

      // Double-check slot availability
      const isStillAvailable = await checkSlotAvailable(userEmail, chosenSlot.startISO, chosenSlot.endISO);
      if (!isStillAvailable) {
        // Re-find slots
        const newSlots = await findAvailableSlots({ userEmail, durationMinutes: 30 });
        const apologyText = `Hi ${email.from.split('<')[0]},\n\nThat slot was just booked. Here are updated options:\n\n${newSlots.map(s => s.formattedText).join('\n')}\n\nBest,`;
        await sendReply({
          userEmail,
          threadId: email.threadId,
          to: email.from,
          subject: email.subject,
          body: apologyText,
          inReplyToMessageId: email.messageIdHeader || email.id
        });
        thread.proposedSlots = newSlots;
        await transitionThread(userEmail, email.threadId, STATES.NEGOTIATING, { action: 'Re-proposed slots due to conflict' });
        return { status: 'RE_PROPOSED' };
      }

      // Create Calendar Event
      const eventDetails = await createCalendarEvent({
        userEmail,
        summary: `Meeting: ${thread.subject || 'Discussion'}`,
        description: `Autonomous meeting scheduled between ${userEmail} and ${email.senderEmail}`,
        startISO: chosenSlot.startISO,
        endISO: chosenSlot.endISO,
        attendees: [email.senderEmail]
      });

      // Send confirmation email
      const confirmationText = await generateConfirmation(email.from.split('<')[0].trim(), eventDetails, tone);
      await sendReply({
        userEmail,
        threadId: email.threadId,
        to: email.from,
        subject: email.subject,
        body: confirmationText,
        inReplyToMessageId: email.messageIdHeader || email.id
      });

      thread.bookedDetails = eventDetails;
      await transitionThread(userEmail, email.threadId, STATES.BOOKED, {
        action: 'Booked meeting and sent invite',
        eventDetails
      });

      await recordMeetingBooked(userEmail, {
        icon: 'CalendarCheck',
        description: `Booked meeting with ${email.from} for ${chosenSlot.formattedText}`,
        sender: email.from,
        threadId: email.threadId
      });

      return { status: 'BOOKED' };
    }

    // UNCLEAR reply -> Flag thread for human review
    await transitionThread(userEmail, email.threadId, STATES.FLAGGED, {
      reason: 'Unclear recipient reply during negotiation'
    });

    await recordThreadFlagged(userEmail, {
      icon: 'AlertTriangle',
      description: `Flagged thread from ${email.from} (Unclear reply)`,
      sender: email.from,
      threadId: email.threadId
    });

    return { status: 'FLAGGED' };
  }

  return { status: 'NO_ACTION' };
}

module.exports = {
  processEmail
};
