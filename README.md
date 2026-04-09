# Outreach Engine

Open-source AI-powered cold email outreach platform. Scrapes company websites for personalization, generates tailored emails via any LLM (Claude, GPT, Gemini), sends via Gmail or Outlook, and tracks opens and replies.

![License](https://img.shields.io/badge/license-MIT-blue)

## What it does

1. **Upload a CSV** of prospects (company name, domain, contact name, email)
2. **Scrapes each company's website** to extract personalization context
3. **Generates a personalized cold email** using your LLM of choice (Claude, GPT-4, Gemini)
4. **Sends via Gmail or Outlook** with optional file attachments
5. **Tracks delivery, opens, and replies** in a built-in analytics dashboard

One operator. Hundreds of personalized emails. Zero copy-paste.

## Quick Start

```bash
git clone https://github.com/radwaneth/outreach-engine.git
cd outreach-engine
npm install
node server.js
```

Open `http://localhost:3456` in your browser. Go to the **Settings** tab to configure.

## Setup

### 1. AI Model (required)

Go to **Settings > AI Model** and select your provider:

| Provider | Get API Key | Model |
|----------|------------|-------|
| **Claude** (Anthropic) | [console.anthropic.com](https://console.anthropic.com/) | claude-sonnet-4-20250514 |
| **GPT** (OpenAI) | [platform.openai.com](https://platform.openai.com/api-keys) | gpt-4o |
| **Gemini** (Google) | [aistudio.google.com](https://aistudio.google.com/apikey) | gemini-2.0-flash |

Paste your API key in Settings and click **Test Connection** to verify.

### 2. Email Account (required)

#### Gmail (Google Workspace or personal)

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project
3. Enable the **Gmail API** (APIs & Services > Library > search "Gmail API")
4. Go to **APIs & Services > Credentials > Create Credentials > OAuth client ID**
5. Select **Desktop app**, name it anything
6. Download the JSON file
7. Rename it to `credentials.json` and place it in the `outreach-engine/` directory
8. Run:
   ```bash
   node auth.js
   ```
9. Browser opens — sign in with your Google account and grant permission
10. Paste the authorization code back into the terminal

#### Outlook (Microsoft 365 or personal)

1. Go to [Azure Portal > App registrations](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade)
2. Click **New registration**
3. Name: "Outreach Engine", Supported account types: **Personal Microsoft accounts + organizational**
4. No redirect URI needed
5. After creation, go to **API permissions > Add permission > Microsoft Graph > Delegated > Mail.Send**
6. Go to **Authentication > Advanced settings > Allow public client flows > Yes**
7. Copy the **Application (client) ID**
8. Create `outlook-credentials.json` in the `outreach-engine/` directory:
   ```json
   { "client_id": "YOUR_APPLICATION_ID" }
   ```
9. Run:
   ```bash
   node auth.js outlook
   ```
10. Follow the device code flow — open the URL, enter the code, sign in

### 3. Company Context (recommended)

Go to **Settings** and fill in:
- **Your name, title, company name, website, email**
- **Company Context** — describe what you sell, your value proposition, key differentiators. This gets injected into the AI prompt when generating emails.
- **Calendly/meeting link** — automatically appended to emails
- **Email Instructions** — optionally override the auto-generated prompt with your own

### 4. Hunter.io (optional)

For automatic lead enrichment (finding decision-maker emails from company domains):
1. Sign up at [hunter.io](https://hunter.io)
2. Paste your API key in **Settings > Hunter.io**
3. Use the **Find Leads** tab to search domains and discover contacts

## Features

### Outreach Tab
- Upload CSV of prospects
- Attach files (brochures, one-pagers) to every email
- Save and load email instruction presets
- Preview emails before sending — edit, regenerate, or send individually
- Batch send with configurable delay and rate limits
- Progress tracking with stop button

### Find Leads Tab
- Paste company domains or upload a CSV
- Hunter.io searches each domain for decision-maker emails
- One-click transfer to Outreach tab for sending

### Analytics Tab
- Total sent, delivered, failed
- Open tracking (how many recipients opened your email)
- Reply detection (scans your inbox for responses)
- Daily activity chart
- Per-email tracking table with open counts and timestamps
- Company breakdown

### Settings Tab
- Company profile and context
- LLM provider selection (Claude / GPT / Gemini) with API key and test button
- Email provider setup instructions
- Hunter.io API key
- Rate limits and batch size configuration
- Custom email instructions override

## CSV Format

Your prospect CSV needs at minimum these columns:

```csv
email,company_name,website
jane@acme.com,Acme Corp,acme.com
```

Optional columns (improve personalization):

```csv
email,company_name,website,contact_name,contact_title,vertical,pain_point,region
jane@acme.com,Acme Corp,acme.com,Jane Smith,VP Operations,Construction,Needs aerial survey for large sites,Denver CO
```

Column names are flexible — the engine normalizes `Company Name`, `company_name`, `Company`, etc. automatically.

## CLI Usage

The GUI covers most use cases, but you can also run from the command line:

```bash
# Preview emails (no sending)
node run.js --csv prospects.csv --dry-run

# Send first 20 emails
node run.js --csv prospects.csv --batch-size 20

# Send with 20s delay between each
node run.js --csv prospects.csv --delay 20000

# Filter by vertical
node run.js --csv prospects.csv --vertical Mining

# Enrich a list of domains with Hunter.io emails
node lead-finder.js --input domains.csv --output enriched.csv
```

## Architecture

```
outreach-engine/
├── server.js           # HTTP server + API endpoints
├── ui.html             # Single-file GUI (all tabs)
├── config.js           # Settings management (settings.json)
├── llm.js              # Multi-LLM abstraction (Claude, GPT, Gemini)
├── email-generator.js  # Prompt construction + email generation
├── mail-sender.js      # Gmail + Outlook send (MIME construction)
├── auth.js             # OAuth2 for Gmail, device code for Outlook
├── scraper.js          # Website scraping via cheerio
├── csv-reader.js       # CSV parsing with column normalization
├── lead-finder.js      # Hunter.io enrichment (CLI)
├── logger.js           # Send logs, tracking, analytics
├── run.js              # CLI entry point
├── settings.json       # Your configuration (gitignored)
├── credentials.json    # Gmail OAuth creds (gitignored)
├── token.json          # Gmail token (gitignored)
└── logs/               # Send logs (gitignored)
```

## Rate Limits

| Provider | Daily Limit |
|----------|------------|
| Gmail (personal) | 100 emails/day |
| Gmail (Google Workspace) | 2,000 emails/day |
| Outlook (personal) | 300 emails/day |
| Outlook (Microsoft 365) | 10,000 emails/day |

Configure your limit in **Settings > Rate Limits**. The engine tracks sends per day and stops automatically when the limit is reached.

## Tips

- **Start with 100-200 emails/day** from a new domain to build sender reputation
- **Always preview** before sending a batch — check the first 5-10 emails
- **Attach a one-pager or brochure** — it increases reply rates
- **Follow up** after 3-5 days with people who didn't respond
- **Use the Find Leads tab** to discover decision-maker emails before sending
- **Small companies respond faster** — target operators under 200 employees first

## License

MIT
