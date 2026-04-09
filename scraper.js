const cheerio = require('cheerio');
const { SCRAPE_TIMEOUT_MS, SCRAPE_MAX_CHARS, SCRAPE_USER_AGENT } = require('./config');

const config = { SCRAPE_TIMEOUT_MS, SCRAPE_MAX_CHARS, SCRAPE_USER_AGENT };

async function scrapeCompanyWebsite(websiteUrl) {
  if (!websiteUrl) return { rawText: '', success: false, error: 'no URL provided' };

  // Ensure URL has protocol
  let url = websiteUrl.trim();
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.SCRAPE_TIMEOUT_MS);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': config.SCRAPE_USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return { rawText: '', success: false, error: `HTTP ${response.status}` };
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Remove noise elements
    $('script, style, nav, footer, header, iframe, noscript, svg, form').remove();
    $('[role="navigation"], [role="banner"], [role="contentinfo"]').remove();
    $('.nav, .navbar, .footer, .header, .menu, .sidebar, .cookie').remove();

    // Extract structured data
    const title = $('title').first().text().trim();
    const metaDesc = $('meta[name="description"]').attr('content') || '';
    const ogDesc = $('meta[property="og:description"]').attr('content') || '';

    const headings = [];
    $('h1, h2, h3').each((_, el) => {
      const text = $(el).text().trim();
      if (text && text.length < 200) headings.push(text);
    });

    const paragraphs = [];
    $('p').each((_, el) => {
      const text = $(el).text().trim();
      if (text && text.length > 30 && text.length < 500) {
        paragraphs.push(text);
      }
    });

    // Assemble context text
    const parts = [];
    if (title) parts.push(`Company: ${title}`);
    if (metaDesc) parts.push(`About: ${metaDesc}`);
    else if (ogDesc) parts.push(`About: ${ogDesc}`);
    if (headings.length) parts.push(`Key areas: ${headings.slice(0, 8).join('. ')}`);
    if (paragraphs.length) parts.push(`Details: ${paragraphs.slice(0, 5).join(' ')}`);

    let rawText = parts.join('\n\n');

    // Truncate to max chars
    if (rawText.length > config.SCRAPE_MAX_CHARS) {
      rawText = rawText.substring(0, config.SCRAPE_MAX_CHARS) + '...';
    }

    return {
      title,
      description: metaDesc || ogDesc,
      headings: headings.slice(0, 8),
      rawText,
      success: rawText.length > 50,
    };
  } catch (err) {
    const errorMsg = err.name === 'AbortError' ? 'timeout' : err.message;
    return { rawText: '', success: false, error: errorMsg };
  }
}

module.exports = { scrapeCompanyWebsite };
