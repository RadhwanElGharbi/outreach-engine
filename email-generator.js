const { loadSettings } = require('./config');
const { generate } = require('./llm');

// =========================================================================
// Builds system prompt from user's settings + company context
// =========================================================================
function buildSystemPrompt(settings, customInstructions) {
  // Use custom instructions if provided (from GUI), otherwise use saved email instructions
  if (customInstructions) return customInstructions;
  if (settings.emailInstructions) return settings.emailInstructions;

  // Default generic prompt — built from settings
  const name = settings.senderName || 'the sender';
  const title = settings.senderTitle || '';
  const company = settings.companyName || 'our company';
  const website = settings.companyWebsite || '';
  const calendly = settings.calendlyLink || '';
  const location = settings.location || '';
  const context = settings.companyContext || '';

  return `You are a cold email ghostwriter for ${name}${title ? ', ' + title : ''} at ${company}${website ? ' (' + website + ')' : ''}${location ? ', based in ' + location : ''}.

${context ? 'About the company:\n' + context + '\n' : ''}
RULES:
1. 4-6 sentences maximum.
2. Sentence 1: Reference something SPECIFIC about THEIR company — a real fact, number, project, or capability.
3. Sentence 2: Their specific constraint or pain point.
4. Sentence 3: What ${company} does — ONE sentence, lead with the outcome.
5. Sentence 4: The ask — 15 minutes.${calendly ? ' Include: ' + calendly : ''}
6. Sign off with just "${settings.senderName?.split(' ')[0] || 'Best'}"

TONE: Direct, peer-to-peer, professional but human. No filler.
NEVER USE: "excited," "thrilled," "game-changer," "cutting-edge," "revolutionary," "I hope this finds you well"
NEVER START WITH: "I hope" or "My name is"
SUBJECT LINE: Short (under 8 words), specific, no clickbait. Prefix with "Subject: "

OUTPUT MUST BE PLAIN TEXT. No markdown, no HTML tags. Just words.

OUTPUT FORMAT:
Subject: [subject line]

[email body]
${calendly ? '\n' + calendly : ''}

${settings.senderName?.split(' ')[0] || ''}`;
}

function parseEmailResponse(rawText) {
  const text = rawText.trim();
  let subject = '', bodyLines = [], pastSubject = false;

  const lines = text.split('\n');
  for (const line of lines) {
    const stripped = line.replace(/\*\*/g, '').replace(/`/g, '').trim();
    if (/^subject\s*:/i.test(stripped)) {
      subject = stripped.replace(/^subject\s*:\s*/i, '').trim();
      pastSubject = true;
    } else if (pastSubject) {
      bodyLines.push(line);
    }
  }

  // Fallback: if no Subject: line found, use first line as subject
  if (!subject && lines.length > 1) {
    subject = lines[0].trim();
    bodyLines = lines.slice(1);
  }

  while (bodyLines.length && !bodyLines[0].trim()) bodyLines.shift();
  const body = bodyLines.join('\n').trim();
  return { subject, body };
}

async function generateEmail(prospect, scrapedData, customInstructions) {
  const settings = loadSettings();
  const systemPrompt = buildSystemPrompt(settings, customInstructions);

  const websiteContext = scrapedData?.success ? `\nCompany website info:\n${scrapedData.rawText}` : '';

  const userPrompt = `Write a cold email to ${prospect.contactName || 'the decision maker'}, ${prospect.contactTitle || 'senior leader'} at ${prospect.companyName}.
${websiteContext}
Industry/vertical: ${prospect.vertical || 'Not specified'}
Known pain point: ${prospect.painPoint || 'Not specified'}
Company region: ${prospect.region || prospect.country || 'Not specified'}
Company size: ${prospect.size || 'Not specified'}

Remember: Follow the instructions exactly. 4-6 sentences only. Reference a SPECIFIC fact about their company in sentence 1.`;

  try {
    const result = await generate({ system: systemPrompt, user: userPrompt, temperature: 0.7, maxTokens: 1024 });
    const { subject, body } = parseEmailResponse(result.text);

    // Retry if empty
    if (!subject || !body) {
      const retry = await generate({
        system: systemPrompt,
        user: userPrompt + '\n\nYour output MUST start with "Subject: " on the first line, then a blank line, then the email body. Try again.',
        temperature: 0.7,
        maxTokens: 1024,
      });
      const retryParsed = parseEmailResponse(retry.text);
      return {
        subject: retryParsed.subject,
        body: retryParsed.body,
        fullEmail: retry.text,
        tokensUsed: result.tokens + retry.tokens,
        error: (!retryParsed.subject || !retryParsed.body) ? 'Failed to generate valid email after retry' : null,
      };
    }

    return { subject, body, fullEmail: result.text, tokensUsed: result.tokens, error: null };
  } catch (err) {
    return { subject: '', body: '', fullEmail: '', tokensUsed: 0, error: err.message };
  }
}

module.exports = { generateEmail, buildSystemPrompt };
