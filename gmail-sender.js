const crypto = require('crypto');
const config = require('./config');
const logger = require('./logger');

function generateTrackingId() {
  return crypto.randomBytes(16).toString('hex');
}

function stripFormatting(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')       // **bold**
    .replace(/__(.+?)__/g, '$1')            // __bold__
    .replace(/~~(.+?)~~/g, '$1')            // ~~strikethrough~~
    .replace(/`([^`]+)`/g, '$1')            // `code`
    .replace(/^#{1,6}\s+/gm, '')            // # headings
    .replace(/<[^>]+>/g, '');               // HTML tags
}

function encodeSubject(subject) {
  if (/^[\x20-\x7E]*$/.test(subject)) return subject;
  return '=?UTF-8?B?' + Buffer.from(subject, 'utf-8').toString('base64') + '?=';
}

function buildMimeMessage({ to, subject, body, fromName, fromEmail, attachments, trackingId }) {
  const boundary = 'outreach_boundary_' + Date.now();
  const hasAttachments = attachments && attachments.length > 0;
  const encodedSubject = encodeSubject(subject);

  // Strip any markdown/HTML formatting — emails must be pure plain text
  const textBody = stripFormatting(body);

  if (!hasAttachments) {
    const message = [
      `From: ${fromName} <${fromEmail}>`,
      `To: ${to}`,
      `Subject: ${encodedSubject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      textBody,
    ].join('\r\n');
    return { raw: encodeRaw(message), trackingId };
  }

  // Multipart/mixed: plain text + attachments (no HTML part)
  const parts = [
    `From: ${fromName} <${fromEmail}>`,
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    textBody,
  ];

  for (const att of attachments) {
    parts.push(`--${boundary}`);
    parts.push(`Content-Type: ${att.mimeType}; name="${att.fileName}"`);
    parts.push('Content-Transfer-Encoding: base64');
    parts.push(`Content-Disposition: attachment; filename="${att.fileName}"`);
    parts.push('');
    const b64 = att.base64Data;
    for (let i = 0; i < b64.length; i += 76) {
      parts.push(b64.substring(i, i + 76));
    }
  }

  parts.push(`--${boundary}--`);
  return { raw: encodeRaw(parts.join('\r\n')), trackingId };
}

function encodeRaw(message) {
  return Buffer.from(message)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function sendEmail(gmailClient, { to, subject, body, attachments }) {
  const trackingId = generateTrackingId();
  const { raw } = buildMimeMessage({
    to,
    subject,
    body,
    fromName: config.SENDER_NAME,
    fromEmail: config.SENDER_EMAIL,
    attachments,
    trackingId,
  });

  try {
    const result = await gmailClient.users.messages.send({
      userId: 'me',
      requestBody: { raw },
    });

    logger.incrementSendCount();

    return {
      success: true,
      messageId: result.data.id,
      threadId: result.data.threadId,
      trackingId,
      error: null,
    };
  } catch (err) {
    const status = err.response?.status || err.code;
    const message = err.response?.data?.error?.message || err.message;

    if (status === 429) {
      console.log('  Rate limited by Gmail. Waiting 60 seconds...');
      await new Promise((r) => setTimeout(r, 60000));
      try {
        const retry = await gmailClient.users.messages.send({
          userId: 'me',
          requestBody: { raw },
        });
        logger.incrementSendCount();
        return { success: true, messageId: retry.data.id, threadId: retry.data.threadId, trackingId, error: null };
      } catch (retryErr) {
        return { success: false, messageId: null, threadId: null, trackingId: null, error: `Rate limit retry failed: ${retryErr.message}` };
      }
    }

    if (status === 401 || status === 403) {
      return { success: false, messageId: null, threadId: null, trackingId: null, error: `Auth error (${status}): re-run "node auth.js". ${message}` };
    }

    if (status === 400) {
      return { success: false, messageId: null, threadId: null, trackingId: null, error: `Bad request: ${message}` };
    }

    return { success: false, messageId: null, threadId: null, trackingId: null, error: `Gmail error (${status}): ${message}` };
  }
}

module.exports = { sendEmail };
