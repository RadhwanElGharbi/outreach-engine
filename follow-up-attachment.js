const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');
const { sendEmail } = require('./gmail-sender');
const { getAuthenticatedClient } = require('./auth');

const BROCHURE_PATH = path.join(__dirname, '..', 'brochure', 'Colony Dynamics - Brochure.pdf');
const FOLLOW_UP_BODY = `Forgot to attach this — here's our brochure with the full specs on Trinity and Pathfinder.

Rad`;
const FOLLOW_UP_SUBJECT_PREFIX = 'Re: ';

async function main() {
  // Check brochure exists
  if (!fs.existsSync(BROCHURE_PATH)) {
    console.error('Brochure not found at:', BROCHURE_PATH);
    process.exit(1);
  }

  // Load brochure as base64
  const brochureData = fs.readFileSync(BROCHURE_PATH).toString('base64');
  const attachment = {
    fileName: 'Colony Dynamics - Brochure.pdf',
    mimeType: 'application/pdf',
    base64Data: brochureData,
  };

  // Read all send logs to find successfully sent emails
  const logsDir = config.LOGS_DIR;
  const logFiles = fs.readdirSync(logsDir).filter(f => f.startsWith('outreach-') && f.endsWith('.csv'));
  const sentEmails = new Map(); // email -> { subject, company, contactName }

  for (const file of logFiles) {
    const lines = fs.readFileSync(path.join(logsDir, file), 'utf8').split('\n').slice(1);
    for (const line of lines) {
      if (!line.trim()) continue;
      const fields = [];
      let current = '', inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        if (line[i] === '"') inQuotes = !inQuotes;
        else if (line[i] === ',' && !inQuotes) { fields.push(current); current = ''; }
        else current += line[i];
      }
      fields.push(current);
      const [, email, company, contactName, subject, status] = fields;
      // Skip test emails, manual sends, and already-replied contacts
      const EXCLUDE = [
        'rad@colony.tech',
        'radwan@agrsglobal.com',
        'mark@extremeaerialproductions.com',  // already in active conversation
        'achal@flytbase.com',                 // already replied
      ];
      const emailLower = (email || '').toLowerCase();
      if (email && subject && subject.trim() && subject !== '-' && !subject.startsWith('Re: ') && !EXCLUDE.includes(emailLower)) {
        if (!sentEmails.has(emailLower)) {
          sentEmails.set(emailLower, { subject, company, contactName });
        }
      }
    }
  }

  // Filter out anyone who already received a follow-up (subject starts with "Re:")
  const alreadyFollowedUp = new Set();
  for (const file of logFiles) {
    const lines = fs.readFileSync(path.join(logsDir, file), 'utf8').split('\n').slice(1);
    for (const line of lines) {
      if (!line.trim()) continue;
      const fields = [];
      let cur = '', inQ = false;
      for (let i = 0; i < line.length; i++) {
        if (line[i] === '"') inQ = !inQ;
        else if (line[i] === ',' && !inQ) { fields.push(cur); cur = ''; }
        else cur += line[i];
      }
      fields.push(cur);
      const [, email, , , subject, status] = fields;
      if (status === 'sent' && subject && subject.startsWith('Re: ')) {
        alreadyFollowedUp.add(email?.toLowerCase());
      }
    }
  }

  for (const email of alreadyFollowedUp) {
    sentEmails.delete(email);
  }

  console.log(`Found ${sentEmails.size} emails to follow up (${alreadyFollowedUp.size} already followed up).\n`);

  if (sentEmails.size === 0) {
    console.log('Nothing to follow up on. All done.');
    return;
  }

  // Parse args
  const dryRun = process.argv.includes('--dry-run');
  const batchSize = parseInt(process.argv.find((a, i) => process.argv[i-1] === '--batch-size') || sentEmails.size);
  const delay = parseInt(process.argv.find((a, i) => process.argv[i-1] === '--delay') || '5') * 1000;

  if (dryRun) {
    console.log('DRY RUN — previewing follow-ups:\n');
    let i = 0;
    for (const [email, { subject, company }] of sentEmails) {
      if (i >= batchSize) break;
      console.log(`  ${email} (${company})`);
      console.log(`    Subject: ${FOLLOW_UP_SUBJECT_PREFIX}${subject}`);
      console.log(`    Body: ${FOLLOW_UP_BODY.split('\n')[0]}`);
      console.log(`    Attachment: Colony Dynamics - Brochure.pdf\n`);
      i++;
    }
    console.log(`\nTotal: ${Math.min(sentEmails.size, batchSize)} follow-ups ready.`);
    console.log('Run without --dry-run to send.');
    return;
  }

  // Authenticate
  console.log('Authenticating with Gmail...');
  const gmailClient = await getAuthenticatedClient();
  console.log('Authenticated.\n');

  let sent = 0, failed = 0, i = 0;
  for (const [email, { subject, company, contactName }] of sentEmails) {
    if (i >= batchSize) break;

    const followUpSubject = FOLLOW_UP_SUBJECT_PREFIX + subject;
    console.log(`[${i+1}/${Math.min(sentEmails.size, batchSize)}] ${company} — ${email}`);

    const result = await sendEmail(gmailClient, {
      to: email,
      subject: followUpSubject,
      body: FOLLOW_UP_BODY,
      attachments: [attachment],
    });

    if (result.success) {
      console.log(`  Sent (${result.messageId})`);
      logger.logSend({ email, company, contactName, subject: followUpSubject, status: 'sent', messageId: result.messageId });
      sent++;
    } else {
      console.log(`  Failed: ${result.error}`);
      logger.logSend({ email, company, contactName, subject: followUpSubject, status: 'failed', error: result.error });
      failed++;
    }

    i++;
    if (i < Math.min(sentEmails.size, batchSize)) {
      await new Promise(r => setTimeout(r, delay));
    }
  }

  console.log(`\nDone. Sent: ${sent}, Failed: ${failed}`);
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
