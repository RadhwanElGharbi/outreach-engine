const crypto = require('crypto');
const { loadSettings, CREDENTIALS_PATH, TOKEN_PATH, GMAIL_SCOPES } = require('./config');
const logger = require('./logger');

// =========================================================================
// Unified mail sender — supports Gmail and Outlook
// =========================================================================

function generateTrackingId() {
  return crypto.randomBytes(16).toString('hex');
}

function stripFormatting(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/<[^>]+>/g, '');
}

function encodeSubject(subject) {
  if (/^[\x20-\x7E]*$/.test(subject)) return subject;
  return '=?UTF-8?B?' + Buffer.from(subject, 'utf-8').toString('base64') + '?=';
}

// ---- Gmail ----
function buildMimeMessage({ to, subject, body, fromName, fromEmail, attachments }) {
  const boundary = 'outreach_boundary_' + Date.now();
  const hasAttachments = attachments && attachments.length > 0;
  const textBody = stripFormatting(body);
  const encodedSubject = encodeSubject(subject);

  if (!hasAttachments) {
    const message = [
      `From: ${fromName} <${fromEmail}>`,
      `To: ${to}`,
      `Subject: ${encodedSubject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '', textBody,
    ].join('\r\n');
    return Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  const parts = [
    `From: ${fromName} <${fromEmail}>`, `To: ${to}`, `Subject: ${encodedSubject}`,
    'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '', textBody,
  ];
  for (const att of attachments) {
    parts.push(`--${boundary}`, `Content-Type: ${att.mimeType}; name="${att.fileName}"`,
      'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="${att.fileName}"`, '');
    for (let i = 0; i < att.base64Data.length; i += 76) parts.push(att.base64Data.substring(i, i + 76));
  }
  parts.push(`--${boundary}--`);
  return Buffer.from(parts.join('\r\n')).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sendViaGmail(client, { to, subject, body, attachments, fromName, fromEmail }) {
  const raw = buildMimeMessage({ to, subject, body, fromName, fromEmail, attachments });
  const result = await client.users.messages.send({ userId: 'me', requestBody: { raw } });
  return { messageId: result.data.id, threadId: result.data.threadId };
}

// ---- Outlook (Microsoft Graph) ----
async function sendViaOutlook(accessToken, { to, subject, body, attachments, fromName }) {
  const message = {
    subject,
    body: { contentType: 'Text', content: stripFormatting(body) },
    toRecipients: [{ emailAddress: { address: to } }],
    from: fromName ? { emailAddress: { name: fromName } } : undefined,
  };

  if (attachments && attachments.length > 0) {
    message.attachments = attachments.map(att => ({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: att.fileName,
      contentType: att.mimeType,
      contentBytes: att.base64Data,
    }));
  }

  const res = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, saveToSentItems: true }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Outlook ${res.status}: ${err.error?.message || res.statusText}`);
  }

  return { messageId: 'outlook-' + Date.now(), threadId: null };
}

// ---- Unified send ----
async function sendEmail(emailClient, { to, subject, body, attachments }) {
  const settings = loadSettings();
  const trackingId = generateTrackingId();
  const fromName = settings.senderName || '';
  const fromEmail = settings.senderEmail || '';

  try {
    let result;
    if (emailClient._outlookToken) {
      result = await sendViaOutlook(emailClient._outlookToken, { to, subject, body, attachments, fromName });
    } else {
      result = await sendViaGmail(emailClient, { to, subject, body, attachments, fromName, fromEmail });
    }

    logger.incrementSendCount();
    return { success: true, messageId: result.messageId, threadId: result.threadId, trackingId, error: null };
  } catch (err) {
    const status = err.response?.status || err.code;
    const message = err.response?.data?.error?.message || err.message;

    if (status === 429) {
      console.log('  Rate limited. Waiting 60 seconds...');
      await new Promise(r => setTimeout(r, 60000));
      try {
        let retry;
        if (emailClient._outlookToken) {
          retry = await sendViaOutlook(emailClient._outlookToken, { to, subject, body, attachments, fromName });
        } else {
          retry = await sendViaGmail(emailClient, { to, subject, body, attachments, fromName, fromEmail });
        }
        logger.incrementSendCount();
        return { success: true, messageId: retry.messageId, threadId: retry.threadId, trackingId, error: null };
      } catch (retryErr) {
        return { success: false, messageId: null, threadId: null, trackingId: null, error: `Rate limit retry failed: ${retryErr.message}` };
      }
    }

    if (status === 401 || status === 403) {
      return { success: false, messageId: null, threadId: null, trackingId: null, error: `Auth error (${status}): ${message}` };
    }

    return { success: false, messageId: null, threadId: null, trackingId: null, error: `Send error (${status || 'unknown'}): ${message}` };
  }
}

module.exports = { sendEmail };
