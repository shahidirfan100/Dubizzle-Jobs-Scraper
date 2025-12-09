// Dubizzle Jobs Scraper - Ultra-fast hybrid: got-scraping first, minimal Playwright
import { Actor, log } from 'apify';
import { CheerioCrawler, PlaywrightCrawler, Dataset } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';
import { gotScraping } from 'got-scraping';

async function main() {
    await Actor.init();

    try {
        const input = (await Actor.getInput()) || {};
        const {
            keyword = '',
            category = '',
            emirate = 'dubai',
            results_wanted: RESULTS_WANTED_RAW = 100,
            max_pages: MAX_PAGES_RAW = 20,
            collectDetails = true,
            startUrl,
            startUrls,
            url,
            proxyConfiguration,
        } = input;

        const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW) ? Math.max(1, +RESULTS_WANTED_RAW) : Number.MAX_SAFE_INTEGER;
        const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(1, +MAX_PAGES_RAW) : 20;

        const proxyConf = proxyConfiguration ? await Actor.createProxyConfiguration({ ...proxyConfiguration }) : undefined;

        let saved = 0;
        const jobUrlsQueue = []; // Store job URLs extracted from listing pages

        // Helper functions
        const toAbs = (href, base = `https://${emirate}.dubizzle.com`) => {
            try { return new URL(href, base).href; } catch { return null; }
        };

        const cleanText = (html) => {
            if (!html) return '';
            const $ = cheerioLoad(html);
            $('script, style, noscript, iframe').remove();
            return $.root().text().replace(/\s+/g, ' ').trim();
        };

        const buildStartUrl = (kw, cat, em = 'dubai') => {
            let path = `/jobs/`;
            if (cat) path += `${cat.toLowerCase().replace(/\s+/g, '-')}/`;
            const u = new URL(path, `https://${em}.dubizzle.com`);
            if (kw) u.searchParams.set('keywords', String(kw).trim());
            return u.href;
        };

        const initial = [];
        if (Array.isArray(startUrls) && startUrls.length) initial.push(...startUrls);
        if (startUrl) initial.push(startUrl);
        if (url) initial.push(url);
        if (!initial.length) initial.push(buildStartUrl(keyword, category, emirate));

        // Stealth User-Agent rotation
        const USER_AGENTS = [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
        ];

        const getRandomUserAgent = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

        // Extract from JSON-LD
        function extractFromJsonLd($, firstOnly = true) {
            const scripts = $('script[type="application/ld+json"]');
            const found = [];

            for (let i = 0; i < scripts.length; i++) {
                try {
                    const parsed = JSON.parse($(scripts[i]).html() || '');
                    const arr = Array.isArray(parsed) ? parsed : [parsed];

                    for (const e of arr) {
                        if (!e) continue;
                        const type = e['@type'] || e.type;

                        if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) {
                            const job = {
                                title: e.title || e.name || null,
                                company: e.hiringOrganization?.name || null,
                                date_posted: e.datePosted || null,
                                description_html: e.description || null,
                                location: (e.jobLocation?.address?.addressLocality || e.jobLocation?.address?.addressRegion) || null,
                                salary: e.baseSalary?.value || e.baseSalary?.minValue || null,
                                job_type: e.employmentType || null,
                            };

                            if (firstOnly) return job;
                            found.push(job);
                        }
                    }
                } catch (e) { /* ignore */ }
            }

            return found.length ? found : null;
        }

        // Find job links from HTML
        function findJobLinks($, baseUrl) {
            const links = new Set();

            // Look for job listing links
            $('a[href*="/jobs/"]').each((_, el) => {
                const href = $(el).attr('href');
                if (!href || href.includes('/search') || href.includes('?page=')) return;

                // Only get actual job postings with IDs
                if (/\/jobs\/[^/]+\/\d+/.test(href) || /\/jobs\/\d+/.test(href)) {
                    const abs = toAbs(href, baseUrl);
                    if (abs) links.add(abs);
                }
            });

            // Check data attributes
            $('[data-testid*="listing"], [data-testid*="job"], [data-href]').each((_, el) => {
                const href = $(el).attr('data-href') || $(el).find('a').first().attr('href');
                if (href && /\/jobs\//.test(href)) {
                    const abs = toAbs(href, baseUrl);
                    if (abs && !abs.includes('/search')) links.add(abs);
                }
            });

            // Check card containers
            $('article, [class*="listing"], [class*="card"]').each((_, el) => {
                const link = $(el).find('a[href*="/jobs/"]').first();
                if (link.length) {
                    const href = link.attr('href');
                    if (href && /\/jobs\/[^/]+\/\d+|\/jobs\/\d+/.test(href)) {
                        const abs = toAbs(href, baseUrl);
                        if (abs) links.add(abs);
                    }
                }
            });

            return [...links];
        }

        // Extract job details from HTML
        function extractJobDetails($, jobUrl) {
            let data = extractFromJsonLd($) || {};

            // Fallback selectors
            if (!data.title) {
                data.title = $('h1').first().text().trim()
                    || $('[class*="title"]').first().text().trim()
                    || $('title').text().split('|')[0].trim()
                    || null;
            }

            if (!data.company) {
                data.company = $('[class*="contact"]').first().text().trim()
                    || $('[class*="company"]').first().text().trim()
                    || $('[class*="agent"]').first().text().trim()
                    || null;
            }

            if (!data.description_html) {
                const desc = $('[class*="description"]').first();
                data.description_html = desc.length ? desc.html() : null;
            }

            if (!data.location) {
                data.location = $('[class*="location"]').first().text().trim()
                    || $('[class*="breadcrumb"]').find('a').last().text().trim()
                    || emirate || null;
            }

            if (!data.salary) {
                data.salary = $('[class*="salary"]').first().text().trim()
                    || $('[class*="price"]').first().text().trim() || null;
            }

            if (!data.job_type) {
                data.job_type = $('[class*="employment"]').first().text().trim()
                    || $('[class*="job-type"]').first().text().trim() || null;
            }

            if (!data.date_posted) {
                data.date_posted = $('[class*="date"]').first().text().trim()
                    || $('time').first().attr('datetime') || null;
            }

            return {
                job_title: data.title,
                company: data.company,
                category: category || null,
                location: data.location,
                salary: data.salary,
                job_type: data.job_type,
                date_posted: data.date_posted,
                description_html: data.description_html,
                description_text: data.description_html ? cleanText(data.description_html) : null,
                url: jobUrl
            };
        }

        log.info(`Starting scraper for: ${initial[0]}`);
        log.info(`Strategy: Playwright for listing pages ONLY, got-scraping for all detail pages`);
        log.info(`Target: ${RESULTS_WANTED} jobs, Max pages: ${MAX_PAGES}`);

        // STEP 1: Use Playwright ONLY for listing pages (to bypass Imperva)
        const playwrightCrawler = new PlaywrightCrawler({
            proxyConfiguration: proxyConf,
            maxRequestRetries: 2,
            requestHandlerTimeoutSecs: 30,
            maxConcurrency: 2, // Keep low for Playwright

            launchContext: {
                launchOptions: {
                    headless: true,
                    args: ['--disable-blink-features=AutomationControlled']
                }
            },

            preNavigationHooks: [
                async ({ page }) => {
                    // Block unnecessary resources
                    await page.route('**/*', async (route) => {
                        const resourceType = route.request().resourceType();
                        if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
                            await route.abort();
                        } else {
                            await route.continue();
                        }
                    });
                }
            ],

            async requestHandler({ request, page, log: crawlerLog }) {
                const pageNo = request.userData?.pageNo || 1;

                crawlerLog.info(`Loading listing page ${pageNo} with Playwright: ${request.url}`);

                // Wait for content to load
                await page.waitForLoadState('domcontentloaded');
                await page.waitForTimeout(2000); // Wait for dynamic content

                const html = await page.content();
                const $ = cheerioLoad(html);

                // Extract all job URLs
                const jobUrls = findJobLinks($, request.url);
                crawlerLog.info(`✓ Found ${jobUrls.length} job URLs from page ${pageNo}`);

                // Add to queue for CheerioCrawler
                const remaining = RESULTS_WANTED - saved;
                const toAdd = jobUrls.slice(0, Math.max(0, remaining));
                jobUrlsQueue.push(...toAdd);

                // Check pagination
                if (saved < RESULTS_WANTED && pageNo < MAX_PAGES && jobUrls.length > 0) {
                    const nextUrl = new URL(request.url);
                    nextUrl.searchParams.set('page', (pageNo + 1).toString());

                    // Check if next page exists in HTML
                    const hasNext = $('a[rel="next"]').length > 0
                        || $('a[aria-label*="next" i]').length > 0
                        || pageNo < 3; // Assume at least 3 pages exist

                    if (hasNext) {
                        await page.goto(nextUrl.href, { waitUntil: 'domcontentloaded' });
                        request.userData.pageNo = pageNo + 1;
                        // Recursively process next page in same browser session
                        const nextHtml = await page.content();
                        const next$ = cheerioLoad(nextHtml);
                        const nextJobs = findJobLinks(next$, nextUrl.href);

                        if (nextJobs.length > 0) {
                            crawlerLog.info(`✓ Found ${nextJobs.length} jobs from page ${pageNo + 1}`);
                            const nextRemaining = RESULTS_WANTED - saved - toAdd.length;
                            const nextToAdd = nextJobs.slice(0, Math.max(0, nextRemaining));
                            jobUrlsQueue.push(...nextToAdd);
                        }
                    }
                }
            },

            failedRequestHandler: async ({ request, error }) => {
                log.warning(`Playwright listing failed: ${request.url} - ${error?.message}`);
            }
        });

        // STEP 2: Use CheerioCrawler (got-scraping) for ALL detail pages
        const cheerioCrawler = new CheerioCrawler({
            proxyConfiguration: proxyConf,
            maxRequestRetries: 2,
            requestHandlerTimeoutSecs: 20,
            maxConcurrency: 20, // HIGH concurrency for fast scraping

            async requestHandler({ request, $, log: crawlerLog }) {
                if (saved >= RESULTS_WANTED) return;

                crawlerLog.info(`Details (got-scraping): ${request.url}`);

                const job = extractJobDetails($, request.url);

                if (job.job_title) {
                    await Dataset.pushData(job);
                    saved++;
                    crawlerLog.info(`✅ [${saved}/${RESULTS_WANTED}] ${job.job_title}`);
                } else {
                    crawlerLog.warning(`⚠️  No title found: ${request.url}`);
                }
            },

            failedRequestHandler: async ({ request, error }) => {
                log.debug(`got-scraping failed (likely blocked): ${request.url}`);
            }
        });

        // STEP 3: Run crawlers sequentially
        // First: Get all job URLs with Playwright
        await playwrightCrawler.run(initial.map(u => ({
            url: u,
            userData: { pageNo: 1 }
        })));

        log.info(`📋 Collected ${jobUrlsQueue.length} job URLs total`);

        // Second: If collecting details, scrape them with got-scraping
        if (collectDetails && jobUrlsQueue.length > 0) {
            log.info(`🚀 Starting fast detail extraction with got-scraping (concurrency: 20)`);

            await cheerioCrawler.run(jobUrlsQueue.map(url => ({
                url,
                userData: { label: 'DETAIL' }
            })));
        } else if (!collectDetails) {
            // Just save URLs
            const items = jobUrlsQueue.map(url => ({ url }));
            await Dataset.pushData(items);
            saved = items.length;
            log.info(`💾 Saved ${saved} job URLs (no details)`);
        }

        log.info(`✅ Scraping complete! Saved ${saved} jobs`);

    } finally {
        await Actor.exit();
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
