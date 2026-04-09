const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');
const { sendEmail } = require('./gmail-sender');
const { getAuthenticatedClient } = require('./auth');

const BROCHURE_PATH = path.join(__dirname, '..', 'brochure', 'brochure.pdf');
const CLEAN_LIST_PATH = path.join(__dirname, 'clean-followup-list.json');
const SENT_TRACKER_PATH = path.join(__dirname, 'followup-sent.json');

const FOLLOW_UP_BODY = `Forgot to attach this — here's our brochure with the full specs on Trinity and Pathfinder.

Rad`;

function loadSentTracker() {
  if (!fs.existsSync(SENT_TRACKER_PATH)) return new Set();
  try { return new Set(JSON.parse(fs.readFileSync(SENT_TRACKER_PATH, 'utf8'))); } catch { return new Set(); }
}

function saveSentTracker(set) {
  fs.writeFileSync(SENT_TRACKER_PATH, JSON.stringify([...set], null, 2));
}

async function main() {
  // Validate files exist
  if (!fs.existsSync(BROCHURE_PATH)) { console.error('Brochure not found at:', BROCHURE_PATH); process.exit(1); }
  if (!fs.existsSync(CLEAN_LIST_PATH)) { console.error('Clean list not found. Run the list builder first.'); process.exit(1); }

  // Load brochure
  const brochureData = fs.readFileSync(BROCHURE_PATH).toString('base64');
  const attachment = { fileName: 'brochure.pdf', mimeType: 'application/pdf', base64Data: brochureData };

  // Load clean list
  const fullList = JSON.parse(fs.readFileSync(CLEAN_LIST_PATH, 'utf8'));

  // Load tracker of who already got this follow-up
  const alreadySent = loadSentTracker();

  // Filter out already sent
  const remaining = fullList.filter(r => !alreadySent.has(r.email));

  console.log(`\n=== Follow-Up (Clean) ===`);
  console.log(`Clean list:        ${fullList.length}`);
  console.log(`Already sent:      ${alreadySent.size}`);
  console.log(`Remaining:         ${remaining.length}`);

  if (remaining.length === 0) { console.log('\nAll follow-ups sent. Nothing to do.'); return; }

  // Parse args
  const dryRun = process.argv.includes('--dry-run');
  const batchSize = parseInt(process.argv.find((a, i) => process.argv[i - 1] === '--batch-size') || '200');
  const delay = parseInt(process.argv.find((a, i) => process.argv[i - 1] === '--delay') || '5') * 1000;

  const batch = remaining.slice(0, batchSize);
  console.log(`Batch size:        ${batch.length}`);
  console.log(`Delay:             ${delay / 1000}s`);
  console.log(`Mode:              ${dryRun ? 'DRY RUN' : 'LIVE SEND'}\n`);

  if (dryRun) {
    console.log('Preview (first 10):\n');
    batch.slice(0, 10).forEach((r, i) => {
      console.log(`  ${i + 1}. ${r.email} (${r.company})`);
      console.log(`     Subject: Re: ${r.originalSubject}`);
    });
    console.log(`\n  ... and ${Math.max(0, batch.length - 10)} more`);
    console.log('\nRun without --dry-run to send.');
    return;
  }

  // Authenticate
  console.log('Authenticating with Gmail...');
  const gmailClient = await getAuthenticatedClient();
  console.log('Authenticated.\n');

  let sent = 0, failed = 0;

  for (let i = 0; i < batch.length; i++) {
    const r = batch[i];
    const followUpSubject = 'Re: ' + r.originalSubject;

    process.stdout.write(`[${i + 1}/${batch.length}] ${r.company} — ${r.email} ... `);

    const result = await sendEmail(gmailClient, {
      to: r.email,
      subject: followUpSubject,
      body: FOLLOW_UP_BODY,
      attachments: [attachment],
    });

    if (result.success) {
      console.log('SENT');
      logger.logSend({ email: r.email, company: r.company, contactName: r.contactName, subject: followUpSubject, status: 'sent', messageId: result.messageId });
      alreadySent.add(r.email);
      saveSentTracker(alreadySent);
      sent++;
    } else {
      console.log('FAILED: ' + result.error);
      logger.logSend({ email: r.email, company: r.company, contactName: r.contactName, subject: followUpSubject, status: 'failed', error: result.error });
      // If rate limited, stop the batch
      if (result.error && result.error.includes('Rate limit')) {
        console.log('\nRate limited. Stopping. Run again tomorrow.');
        break;
      }
      failed++;
    }

    if (i < batch.length - 1) await new Promise(resolve => setTimeout(resolve, delay));
  }

  console.log(`\nDone. Sent: ${sent}, Failed: ${failed}, Remaining: ${remaining.length - sent - failed}`);
  console.log(`Run again to continue with the next batch.`);
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
