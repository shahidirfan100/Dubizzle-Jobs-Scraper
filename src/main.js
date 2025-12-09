// Dubizzle Jobs Scraper - Hybrid approach with API interception + HTML parsing
import { Actor, log } from 'apify';
import { PlaywrightCrawler, Dataset } from 'crawlee';
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
        const capturedApiData = new Map(); // Store intercepted API responses

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
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        ];

        const getRandomUserAgent = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

        // Parse embedded JSON from page (Next.js data, window state, etc.)
        function parseEmbeddedJson($) {
            // Try __NEXT_DATA__
            const nextData = $('#__NEXT_DATA__').html();
            if (nextData) {
                try {
                    const json = JSON.parse(nextData);
                    if (json?.props?.pageProps) return json.props.pageProps;
                } catch (e) { /* ignore */ }
            }

            // Try inline scripts with window.__INITIAL_STATE__ or similar
            $('script:not([src])').each((_, el) => {
                const content = $(el).html() || '';
                if (/window\.__INITIAL_STATE__|window\.__APP_STATE__/i.test(content)) {
                    try {
                        const match = content.match(/window\.__(?:INITIAL|APP)_STATE__\s*=\s*(\{.+?\});/s);
                        if (match) return JSON.parse(match[1]);
                    } catch (e) { /* ignore */ }
                }
            });

            return null;
        }

        // Extract from JSON-LD structured data
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

            // Look for job listing links - common patterns
            $('a[href*="/jobs/"]').each((_, el) => {
                const href = $(el).attr('href');
                if (!href || href.includes('/search') || href.includes('?page=')) return;

                // Skip category/filter links, only get actual job postings
                if (/\/jobs\/[^/]+\/\d+/.test(href) || /\/jobs\/\d+/.test(href)) {
                    const abs = toAbs(href, baseUrl);
                    if (abs) links.add(abs);
                }
            });

            // Check data-testid or data-href attributes (common in React apps)
            $('[data-testid*="listing"], [data-testid*="job"], [data-href]').each((_, el) => {
                const href = $(el).attr('data-href') || $(el).find('a').first().attr('href');
                if (href && /\/jobs\//.test(href)) {
                    const abs = toAbs(href, baseUrl);
                    if (abs && !abs.includes('/search')) links.add(abs);
                }
            });

            // Check article/card containers
            $('article, [class*="listing"], [class*="card"], [class*="item"]').each((_, el) => {
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

        // Find next page URL
        function findNextPage($, currentUrl, currentPage) {
            // Try pagination links
            let nextUrl = $('a[rel="next"]').attr('href');
            if (nextUrl) return toAbs(nextUrl, currentUrl);

            // Try page links with text like "Next", "›", "»"
            $('a').each((_, el) => {
                const text = $(el).text().trim();
                const href = $(el).attr('href');
                if (href && /next|›|»|>/i.test(text)) {
                    nextUrl = href;
                    return false; // break
                }
            });
            if (nextUrl) return toAbs(nextUrl, currentUrl);

            // Construct URL with page parameter
            const url = new URL(currentUrl);
            url.searchParams.set('page', (currentPage + 1).toString());
            return url.href;
        }

        // Try to fetch detail page with got-scraping first (faster)
        async function fetchDetailWithGot(jobUrl) {
            try {
                const response = await gotScraping({
                    url: jobUrl,
                    responseType: 'text',
                    headers: {
                        'User-Agent': getRandomUserAgent(),
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.9',
                        'Accept-Encoding': 'gzip, deflate, br',
                        'DNT': '1',
                        'Connection': 'keep-alive',
                        'Upgrade-Insecure-Requests': '1'
                    },
                    proxyUrl: proxyConf ? await proxyConf.newUrl() : undefined,
                    timeout: { request: 15000 }
                });

                // Check if we got blocked
                if (response.body.includes('Incapsula') || response.body.includes('_Incapsula_Resource')) {
                    return null; // Blocked, need Playwright
                }

                return response.body;
            } catch (err) {
                log.debug(`got-scraping failed for ${jobUrl}: ${err.message}`);
                return null;
            }
        }

        // Extract job details from HTML
        function extractJobDetails($, jobUrl, categoryInput) {
            // Try JSON-LD first
            let data = extractFromJsonLd($) || {};

            // Fallback to HTML selectors
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
                    || $('[itemprop="hiringOrganization"]').text().trim()
                    || null;
            }

            if (!data.description_html) {
                const desc = $('[class*="description"]').first();
                if (desc.length) {
                    data.description_html = desc.html();
                } else {
                    // Try other common selectors
                    const fallback = $('article').first().html() || $('[class*="content"]').first().html();
                    data.description_html = fallback || null;
                }
            }

            if (!data.location) {
                data.location = $('[class*="location"]').first().text().trim()
                    || $('[class*="breadcrumb"]').find('a').last().text().trim()
                    || $('[itemprop="jobLocation"]').text().trim()
                    || emirate
                    || null;
            }

            if (!data.salary) {
                data.salary = $('[class*="salary"]').first().text().trim()
                    || $('[class*="price"]').first().text().trim()
                    || $('[itemprop="baseSalary"]').text().trim()
                    || null;
            }

            if (!data.job_type) {
                data.job_type = $('[class*="employment"]').first().text().trim()
                    || $('[class*="job-type"]').first().text().trim()
                    || $('[itemprop="employmentType"]').text().trim()
                    || null;
            }

            if (!data.date_posted) {
                data.date_posted = $('[class*="date"]').first().text().trim()
                    || $('time').first().attr('datetime')
                    || $('[itemprop="datePosted"]').attr('content')
                    || null;
            }

            return {
                job_title: data.title,
                company: data.company,
                category: categoryInput || null,
                location: data.location,
                salary: data.salary,
                job_type: data.job_type,
                date_posted: data.date_posted,
                description_html: data.description_html,
                description_text: data.description_html ? cleanText(data.description_html) : null,
                url: jobUrl
            };
        }

        // Main crawler
        const crawler = new PlaywrightCrawler({
            proxyConfiguration: proxyConf,
            maxRequestRetries: 2,
            requestHandlerTimeoutSecs: 45, // Reduced from 90s
            maxConcurrency: 5,
            useSessionPool: true,

            // Stealth browser settings
            launchContext: {
                launchOptions: {
                    headless: true,
                    args: [
                        '--disable-blink-features=AutomationControlled',
                        '--disable-features=IsolateOrigins,site-per-process',
                        '--disable-web-security'
                    ]
                }
            },

            preNavigationHooks: [
                async ({ page, request }) => {
                    // Intercept API requests to capture JSON data
                    await page.route('**/*', async (route, routeRequest) => {
                        const url = routeRequest.url();
                        const resourceType = routeRequest.resourceType();

                        // Intercept XHR/Fetch API calls
                        if (resourceType === 'xhr' || resourceType === 'fetch') {
                            try {
                                const response = await route.fetch();
                                const contentType = response.headers()['content-type'] || '';

                                if (contentType.includes('application/json')) {
                                    const body = await response.text();
                                    try {
                                        const json = JSON.parse(body);

                                        // Store for processing
                                        capturedApiData.set(request.url, {
                                            apiUrl: url,
                                            data: json,
                                            timestamp: Date.now()
                                        });

                                        log.debug(`Captured API: ${url}`);
                                    } catch (e) { /* not valid JSON */ }
                                }

                                await route.fulfill({ response });
                            } catch (err) {
                                await route.continue();
                            }
                        } else {
                            // Block unnecessary resources for speed
                            if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
                                await route.abort();
                            } else {
                                await route.continue();
                            }
                        }
                    });

                    // Set realistic viewport
                    await page.setViewportSize({
                        width: 1920,
                        height: 1080
                    });
                }
            ],

            async requestHandler({ request, page, enqueueLinks, log: crawlerLog }) {
                const label = request.userData?.label || 'LIST';
                const pageNo = request.userData?.pageNo || 1;

                // Random delay for stealth
                await new Promise(r => setTimeout(r, 300 + Math.floor(Math.random() * 700)));

                // Wait for page load (faster than networkidle)
                await page.waitForLoadState('domcontentloaded');

                // Small additional wait for dynamic content
                await page.waitForTimeout(1500);

                const html = await page.content();
                const $ = cheerioLoad(html);

                if (label === 'LIST') {
                    crawlerLog.info(`Processing listing page ${pageNo}: ${request.url}`);

                    let jobUrls = [];

                    // Check if we captured API data for this page
                    const apiData = capturedApiData.get(request.url);
                    if (apiData && apiData.data) {
                        crawlerLog.info(`Using intercepted API data from ${apiData.apiUrl}`);

                        // Try to extract job listings from API response
                        const data = apiData.data;

                        // Handle various API response structures
                        const listings = data.listings || data.results || data.data?.listings || data.props?.pageProps?.listings || [];

                        if (Array.isArray(listings) && listings.length > 0) {
                            crawlerLog.info(`Found ${listings.length} jobs from API`);

                            for (const listing of listings) {
                                if (saved >= RESULTS_WANTED) break;

                                // Construct job URL from listing data
                                const jobId = listing.id || listing.externalID || listing.listing_id;
                                const categorySlug = listing.categorySlug || listing.category || 'jobs';

                                if (jobId) {
                                    const jobUrl = toAbs(`/jobs/${categorySlug}/${jobId}`, request.url);
                                    if (jobUrl) jobUrls.push(jobUrl);
                                }
                            }
                        }
                    }

                    // If no API data, fallback to HTML parsing
                    if (jobUrls.length === 0) {
                        crawlerLog.info('No API data found, using HTML parsing');

                        // Try embedded JSON in page
                        const embedded = parseEmbeddedJson($);
                        if (embedded?.listings) {
                            crawlerLog.info(`Found ${embedded.listings.length} jobs from embedded JSON`);

                            for (const listing of embedded.listings) {
                                if (saved >= RESULTS_WANTED) break;
                                const jobId = listing.id || listing.externalID;
                                const categorySlug = listing.categorySlug || 'jobs';
                                if (jobId) {
                                    const jobUrl = toAbs(`/jobs/${categorySlug}/${jobId}`, request.url);
                                    if (jobUrl) jobUrls.push(jobUrl);
                                }
                            }
                        } else {
                            // Final fallback: extract links from HTML
                            jobUrls = findJobLinks($, request.url);
                            crawlerLog.info(`Found ${jobUrls.length} job links from HTML`);
                        }
                    }

                    // Process found jobs
                    if (jobUrls.length > 0) {
                        const remaining = RESULTS_WANTED - saved;
                        const toProcess = jobUrls.slice(0, Math.max(0, remaining));

                        if (collectDetails) {
                            await enqueueLinks({
                                urls: toProcess,
                                userData: { label: 'DETAIL' }
                            });
                            crawlerLog.info(`Enqueued ${toProcess.length} jobs for detail extraction`);
                        } else {
                            // Save basic data without details
                            const items = toProcess.map(url => ({ url }));
                            await Dataset.pushData(items);
                            saved += items.length;
                            crawlerLog.info(`Saved ${items.length} jobs (no details)`);
                        }
                    } else {
                        crawlerLog.warning(`No jobs found on page ${pageNo}`);
                    }

                    // Handle pagination
                    if (saved < RESULTS_WANTED && pageNo < MAX_PAGES) {
                        const nextUrl = findNextPage($, request.url, pageNo);
                        if (nextUrl && nextUrl !== request.url) {
                            await enqueueLinks({
                                urls: [nextUrl],
                                userData: { label: 'LIST', pageNo: pageNo + 1 }
                            });
                            crawlerLog.info(`Enqueued next page ${pageNo + 1}`);
                        } else {
                            crawlerLog.info('No more pages found');
                        }
                    }
                }

                if (label === 'DETAIL') {
                    if (saved >= RESULTS_WANTED) return;

                    crawlerLog.info(`Extracting details: ${request.url}`);

                    // Try got-scraping first for speed
                    let detailHtml = await fetchDetailWithGot(request.url);
                    let $ = detailHtml ? cheerioLoad(detailHtml) : cheerioLoad(html);

                    if (!detailHtml) {
                        crawlerLog.debug('Using Playwright HTML (got-scraping blocked or failed)');
                    }

                    const job = extractJobDetails($, request.url, category);

                    if (job.job_title) {
                        await Dataset.pushData(job);
                        saved++;
                        crawlerLog.info(`Saved job: ${job.job_title}`);
                    } else {
                        crawlerLog.warning(`Could not extract job title from ${request.url}`);
                    }
                }
            },

            failedRequestHandler: async ({ request, error }) => {
                log.warning(`Request failed: ${request.url} - ${error?.message}`);
            }
        });

        log.info(`Starting scraper for: ${initial[0]}`);
        log.info(`Target: ${RESULTS_WANTED} jobs, Max pages: ${MAX_PAGES}`);

        await crawler.run(initial.map(u => ({ url: u, userData: { label: 'LIST', pageNo: 1 } })));

        log.info(`✅ Scraping complete! Saved ${saved} jobs`);

    } finally {
        await Actor.exit();
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
