/**
 * Registrable-domain normalisation.
 *
 * This function is the deduplication key for the whole system. If it is loose,
 * the same company arrives twice under two spellings and burns two Apify items
 * and two Firecrawl credits before anyone notices.
 */

/** Public suffixes that are two labels long. Not exhaustive; it covers the
 *  geographies the ICP guide suggests plus the common commercial ones. */
const MULTI_LABEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'net.uk', 'sch.uk', 'ltd.uk', 'plc.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'co.nz', 'net.nz', 'org.nz',
  'co.za', 'com.br', 'com.mx', 'com.ar', 'com.co', 'co.jp', 'or.jp', 'ne.jp',
  'co.in', 'com.sg', 'com.hk', 'co.kr', 'com.tr', 'com.ua', 'com.pl', 'co.il',
  'com.cn', 'com.tw', 'com.my', 'co.id', 'com.ph', 'com.vn', 'co.th',
  'com.ng', 'co.ke', 'com.gh', 'com.es', 'com.pt', 'co.at',
]);

/**
 * Directories, aggregators and social networks. These rank well for exactly
 * the searches discovery runs, and every one that reaches the candidate table
 * spends a scrape on a page that says nothing about a company.
 */
const AGGREGATOR_LABELS = new Set([
  'linkedin', 'facebook', 'twitter', 'instagram', 'tiktok', 'pinterest', 'reddit',
  'crunchbase', 'g2', 'capterra', 'clutch', 'glassdoor', 'indeed', 'ziprecruiter',
  'wikipedia', 'medium', 'youtube', 'yelp', 'trustpilot', 'zoominfo', 'apollo',
  'producthunt', 'angel', 'wellfound', 'owler', 'dnb', 'bloomberg', 'substack',
  'github', 'gitlab', 'notion', 'wordpress', 'blogspot', 'wixsite', 'squarespace',

  /**
   * Booking pages, forms and link-in-bio hosts.
   *
   * These are not search results; they are what a small company types into
   * LinkedIn's own `website` field instead of a website. Discovery returned
   * "NorthHarbor Growth Solutions" with `website` set to a Calendly link,
   * which parsed to the candidate domain `calendly.com`.
   *
   * Rejecting a registrable domain also rejects the company that owns it, so
   * this list costs us Typeform, Eventbrite and Google as leads. None of them
   * is a plausible lead for this ICP and every one of them is a plausible
   * booking link, which is the trade being made deliberately.
   */
  'calendly', 'typeform', 'jotform', 'hsforms', 'eventbrite', 'google',
  'linktree', 'beacons', 'carrd', 'mailchi', 'myshopify',

  // Publishing hosts, found the same way: the smoke run of 2026-09-24 returned
  // "SaaS Growth Strategies" whose website was its beehiiv newsletter.
  'beehiiv', 'buttondown',
]);

const EXACT_AGGREGATORS = new Set([
  'x.com', 't.co', 'fb.com', 'lnkd.in', 'bit.ly',

  // Same reason as above, but matched whole so the vendor's own company
  // domain survives: webflow.io is a customer's site, webflow.com is Webflow.
  'linktr.ee', 'bio.link', 'cal.com', 'lu.ma', 'forms.gle',
  'wa.me', 'm.me', 'youtu.be', 'goo.gl', 'tinyurl.com',

  // Deploy targets. Every customer of these shares one registrable domain, so
  // accepting them would deduplicate unrelated companies onto the same key.
  'webflow.io', 'vercel.app', 'netlify.app', 'pages.dev', 'framer.website',
  'ghost.io',
  'github.io', 'onrender.com', 'herokuapp.com',
]);

const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

export function normaliseDomain(input: string): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;

  let host: string;
  try {
    host = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).hostname;
  } catch {
    return null;
  }

  if (host.startsWith('www.')) host = host.slice(4);
  if (!HOSTNAME_RE.test(host) || IPV4_RE.test(host)) return null;

  const labels = host.split('.');
  const lastTwo = labels.slice(-2).join('.');
  const take = MULTI_LABEL_SUFFIXES.has(lastTwo) ? 3 : 2;
  if (labels.length < take) return null;

  const registrable = labels.slice(-take).join('.');
  if (EXACT_AGGREGATORS.has(registrable)) return null;
  if (AGGREGATOR_LABELS.has(labels[labels.length - take])) return null;

  return registrable;
}
