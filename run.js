const path = require('path');
const config = require('./config');
const { readProspectCSV } = require('./csv-reader');
const { scrapeCompanyWebsite } = require('./scraper');
const { generateEmail } = require('./email-generator');
const { sendEmail } = require('./gmail-sender');
const { getAuthenticatedClient } = require('./auth');
const logger = require('./logger');

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    csv: null,
    dryRun: false,
    batchSize: config.DEFAULT_BATCH_SIZE,
    delay: config.DEFAULT_DELAY_MS,
    dailyLimit: config.DAILY_LIMIT,
    vertical: null,
    maxScore: 10,
    minScore: 0,
    skip: 0,
    startFrom: null,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--csv':        opts.csv = args[++i]; break;
      case '--dry-run':    opts.dryRun = true; break;
      case '--batch-size': opts.batchSize = parseInt(args[++i]) || opts.batchSize; break;
      case '--delay':      opts.delay = parseInt(args[++i]) || opts.delay; break;
      case '--daily-limit':opts.dailyLimit = parseInt(args[++i]) || opts.dailyLimit; break;
      case '--vertical':   opts.vertical = args[++i]; break;
      case '--max-score':  opts.maxScore = parseInt(args[++i]) || opts.maxScore; break;
      case '--min-score':  opts.minScore = parseInt(args[++i]) || opts.minScore; break;
      case '--skip':       opts.skip = parseInt(args[++i]) || 0; break;
      case '--start-from': opts.startFrom = args[++i]; break;
      case '--help':       printHelp(); process.exit(0);
      default:
        if (args[i].startsWith('--')) {
          console.error(`Unknown flag: ${args[i]}. Use --help for usage.`);
          process.exit(1);
        }
    }
  }

  if (!opts.csv) {
    console.error('ERROR: --csv <path> is required. Use --help for usage.');
    process.exit(1);
  }

  // Resolve relative paths
  opts.csv = path.resolve(opts.csv);

  return opts;
}

function printHelp() {
  console.log(`
Outreach Engine — Automated Email Outreach

Usage:
  node run.js --csv <path> [options]

Required:
  --csv <path>         Path to input CSV file with prospect emails

Options:
  --dry-run            Preview emails without sending (saved to drafts/)
  --batch-size <n>     Max emails to process (default: ${config.DEFAULT_BATCH_SIZE})
  --delay <ms>         Delay between sends in ms (default: ${config.DEFAULT_DELAY_MS})
  --daily-limit <n>    Daily send limit (default: ${config.DAILY_LIMIT})
  --vertical <name>    Filter to a specific vertical (e.g., Mining, Utility)
  --min-score <n>      Min difficulty score to include (default: 0)
  --max-score <n>      Max difficulty score to include (default: 10)
  --skip <n>           Skip first n rows (for resuming)
  --start-from <email> Resume from a specific email address
  --help               Show this help message

Examples:
  node run.js --csv ../prospects.csv --dry-run
  node run.js --csv ../prospects.csv --batch-size 10 --max-score 4
  node run.js --csv ../prospects.csv --vertical Mining --delay 20000
  `);
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------
async function main() {
  const opts = parseArgs();

  console.log('\n=== Outreach Engine ===\n');
  console.log(`CSV:         ${opts.csv}`);
  console.log(`Mode:        ${opts.dryRun ? 'DRY RUN (no emails sent)' : 'LIVE SEND'}`);
  console.log(`Batch size:  ${opts.batchSize}`);
  console.log(`Delay:       ${opts.delay}ms`);
  console.log(`Daily limit: ${opts.dailyLimit}`);
  if (opts.vertical) console.log(`Vertical:    ${opts.vertical}`);
  if (opts.maxScore < 10) console.log(`Max score:   ${opts.maxScore}`);
  console.log('');

  // 1. Read CSV
  console.log('Reading CSV...');
  let prospects = readProspectCSV(opts.csv);
  console.log(`  ${prospects.length} prospects loaded\n`);

  // 2. Apply filters
  if (opts.vertical) {
    prospects = prospects.filter(p =>
      p.vertical.toLowerCase().includes(opts.vertical.toLowerCase()) ||
      p.tags.toLowerCase().includes(opts.vertical.toLowerCase())
    );
    console.log(`  ${prospects.length} after vertical filter "${opts.vertical}"`);
  }

  if (opts.minScore > 0 || opts.maxScore < 10) {
    prospects = prospects.filter(p =>
      p.difficultyScore >= opts.minScore && p.difficultyScore <= opts.maxScore
    );
    console.log(`  ${prospects.length} after score filter (${opts.minScore}-${opts.maxScore})`);
  }

  // Skip / start-from
  if (opts.startFrom) {
    const idx = prospects.findIndex(p => p.email === opts.startFrom.toLowerCase());
    if (idx >= 0) {
      prospects = prospects.slice(idx);
      console.log(`  Resuming from ${opts.startFrom} (${prospects.length} remaining)`);
    } else {
      console.log(`  WARNING: ${opts.startFrom} not found in CSV, starting from beginning`);
    }
  } else if (opts.skip > 0) {
    prospects = prospects.slice(opts.skip);
    console.log(`  Skipped ${opts.skip} rows, ${prospects.length} remaining`);
  }

  // Apply batch size
  prospects = prospects.slice(0, opts.batchSize);
  console.log(`  Processing ${prospects.length} prospects this run\n`);

  if (prospects.length === 0) {
    console.log('No prospects to process. Check your filters.');
    return;
  }

  // 3. Authenticate Gmail (unless dry run)
  let gmailClient = null;
  if (!opts.dryRun) {
    console.log('Authenticating with Gmail...');
    gmailClient = await getAuthenticatedClient();
    console.log('  Authenticated as ' + config.SENDER_EMAIL + '\n');
  }

  // 4. Get already-sent emails to prevent duplicates
  const alreadySent = opts.dryRun ? new Set() : logger.getAlreadySent();
  if (alreadySent.size > 0) {
    console.log(`  ${alreadySent.size} emails already sent today (will skip duplicates)\n`);
  }

  // 5. Process each prospect
  const results = { sent: 0, failed: 0, skipped: 0 };
  const draftPreviews = [];

  for (let i = 0; i < prospects.length; i++) {
    const prospect = prospects[i];
    const progress = {};

    // Check daily limit
    if (!opts.dryRun && !logger.canSendMore(opts.dailyLimit)) {
      console.log(`\nDaily send limit reached (${opts.dailyLimit}). Stopping.\n`);
      break;
    }

    // Skip duplicates
    if (alreadySent.has(prospect.email)) {
      progress['Status'] = 'SKIPPED (already sent today)';
      logger.progress(i + 1, prospects.length, prospect.companyName, prospect.email, progress);
      results.skipped++;
      continue;
    }

    // 5a. Scrape company website
    const scraped = await scrapeCompanyWebsite(prospect.website);
    progress['Scraped'] = scraped.success
      ? `OK (${scraped.rawText.length} chars)`
      : `Failed (${scraped.error || 'no content'}) — using CSV data`;

    // 5b. Generate email via Claude
    const email = await generateEmail(prospect, scraped);

    if (email.error) {
      progress['Generated'] = `ERROR: ${email.error}`;
      logger.progress(i + 1, prospects.length, prospect.companyName, prospect.email, progress);
      logger.logSend({
        email: prospect.email, company: prospect.companyName,
        contactName: prospect.contactName, subject: '',
        status: 'failed', error: email.error,
      });
      results.failed++;
      continue;
    }

    progress['Generated'] = `"${email.subject}" (${email.tokensUsed} tokens)${email.needsReview ? ' [NEEDS REVIEW]' : ''}`;

    // 5c. Send or preview
    if (opts.dryRun) {
      draftPreviews.push({
        to: prospect.email,
        contactName: prospect.contactName,
        company: prospect.companyName,
        vertical: prospect.vertical,
        subject: email.subject,
        body: email.body,
        fullEmail: email.fullEmail,
        needsReview: email.needsReview,
        issues: email.issues,
        scrapedContext: scraped.success ? scraped.rawText.substring(0, 200) + '...' : 'N/A',
      });
      progress['Status'] = 'PREVIEWED (dry run)';
      results.sent++;
    } else {
      const sendResult = await sendEmail(gmailClient, {
        to: prospect.email,
        subject: email.subject,
        body: email.body,
      });

      if (sendResult.success) {
        progress['Sent'] = `OK (${sendResult.messageId})`;
        logger.logSend({
          email: prospect.email, company: prospect.companyName,
          contactName: prospect.contactName, subject: email.subject,
          status: 'sent', messageId: sendResult.messageId,
        });
        results.sent++;
      } else {
        progress['Sent'] = `FAILED: ${sendResult.error}`;
        logger.logSend({
          email: prospect.email, company: prospect.companyName,
          contactName: prospect.contactName, subject: email.subject,
          status: 'failed', error: sendResult.error,
        });
        results.failed++;
      }
    }

    logger.progress(i + 1, prospects.length, prospect.companyName, prospect.email, progress);

    // Wait between sends (skip delay on last item)
    if (i < prospects.length - 1 && !opts.dryRun) {
      console.log(`  Waiting ${opts.delay / 1000}s...\n`);
      await new Promise((r) => setTimeout(r, opts.delay));
    } else {
      console.log('');
    }
  }

  // 6. Save dry-run previews
  if (opts.dryRun && draftPreviews.length > 0) {
    const draftPath = logger.saveDraftPreview(draftPreviews);
    console.log(`Previews saved to: ${draftPath}`);
  }

  // 7. Print summary
  logger.summary({
    sent: results.sent,
    failed: results.failed,
    skipped: results.skipped,
    dryRun: opts.dryRun,
    total: results.sent + results.failed + results.skipped,
  });
}

main().catch((err) => {
  console.error('\nFATAL ERROR:', err.message);
  console.error(err.stack);
  process.exit(1);
});
