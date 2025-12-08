// Dubizzle Jobs scraper - JSON API + HTML fallback implementation
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

        // Hardcoded to prioritize JSON API for faster and more reliable scraping
        const useApiFirst = true;        const toAbs = (href, base = 'https://dubai.dubizzle.com') => {
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

        const proxyConf = proxyConfiguration ? await Actor.createProxyConfiguration({ ...proxyConfiguration }) : undefined;

        let saved = 0;

        // If user didn't provide start URLs, try discovering sitemap entries for the site to seed the crawler
        if (initial.length === 1 && initial[0] && /dubizzle\.com/.test(initial[0])) {
            try {
                const sitemapUrls = await fetchSitemapUrls(new URL(initial[0]).origin);
                // add discovered sitemap urls at the front so they are processed first
                if (sitemapUrls && sitemapUrls.length) {
                    // only include unique ones that look like jobs search pages
                    for (const s of sitemapUrls) if (!initial.includes(s)) initial.unshift(s);
                }
            } catch (e) { log.debug('Sitemap discovery failed, continuing with default start URL'); }
        }

        // Try to fetch jobs from Dubizzle API first (robust)
        async function fetchJobsFromAPI(searchUrl, page = 1) {
            try {
                const apiUrl = new URL(searchUrl);
                apiUrl.searchParams.set('page', page.toString());

                // Request as text first — some endpoints return HTML wrapped React data
                const userAgent = getRandomUserAgent();
                const response = await gotScraping({
                    url: apiUrl.href,
                    responseType: 'text',
                    headers: {
                        'Accept': 'application/json',
                        'User-Agent': userAgent,
                        'Accept-Language': 'en-US,en;q=0.9',
                    },
                    proxyUrl: proxyConf ? await proxyConf.newUrl() : undefined,
                });

                // Try to parse JSON straight from response, or fall back to extracting embedded JSON
                let body = response.body;
                if (typeof body === 'string') {
                    try { body = JSON.parse(body); } catch (e) { /* not plain JSON, continue */ }
                }

                // Return the parsed JSON object or raw text — caller will handle multiple shapes
                return body;
            } catch (err) {
                log.warning(`API fetch failed: ${err.message}`);
                return null;
            }
        }

        // Try to find embedded JSON data from HTML (Next.js / window.__NEXT_DATA__ / inline data)
        function parseEmbeddedJsonFromHtml($) {
            // Look for Next.js data
            const nextDataScript = $('#__NEXT_DATA__, script#__NEXT_DATA__, script[type="application/json"]').filter((_, el) => ($(el).html() || '').includes('searchResult') || ($(el).html() || '').includes('listings')).first();
            if (nextDataScript && nextDataScript.length) {
                try {
                    const json = JSON.parse(nextDataScript.html());
                    // Try several common paths
                    return json?.props?.pageProps || json?.props || json || null;
                } catch (err) { /* ignore */ }
            }

            // Search for any inline scripts containing "listings" or "searchResult"
            const scripts = $('script');
            for (let i = 0; i < scripts.length; i++) {
                const content = $(scripts[i]).html() || '';
                if (/listings|searchResult|window\.__INITIAL_STATE__/i.test(content)) {
                    try {
                        // attempt to extract JSON object inside the script
                        const m = content.match(/(\{\s*"?searchResult"?[\s\S]*\})/i) || content.match(/(\{[\s\S]*"?listings"?[\s\S]*\})/i);
                        if (m && m[0]) {
                            const parsed = JSON.parse(m[0]);
                            return parsed;
                        }
                    } catch (e) { /* ignore */ }
                }
            }

            return null;
        }

        // Normalize various possible API shapes into a simple array of job objects
        function normalizeListings(apiBody) {
            if (!apiBody) return [];

            // Common variants we handle:
            // - { props: { pageProps: { searchResult: { listings: [...] } } } }
            // - { searchResult: { listings: [...] } }
            // - { data: { listings: [...] } }
            // - { hits: [...] }, { results: [...] }

            if (apiBody.props?.pageProps?.searchResult?.listings) return apiBody.props.pageProps.searchResult.listings;
            if (apiBody.searchResult?.listings) return apiBody.searchResult.listings;
            if (apiBody.data?.listings) return apiBody.data.listings;
            if (Array.isArray(apiBody.listings)) return apiBody.listings;
            if (Array.isArray(apiBody.hits)) return apiBody.hits;
            if (Array.isArray(apiBody.results)) return apiBody.results;

            // If the object itself contains objects with a common 'id' or 'title', extract those
            if (apiBody.items && Array.isArray(apiBody.items)) return apiBody.items;

            return [];
        }

        function extractFromJsonLd($, firstOnly = true) {
            const scripts = $('script[type="application/ld+json"]');
            const found = [];
            for (let i = 0; i < scripts.length; i++) {
                try {
                    const parsed = JSON.parse($(scripts[i]).html() || '');
                    const arr = Array.isArray(parsed) ? parsed : [parsed];
                    for (const e of arr) {
                        if (!e) continue;
                        const t = e['@type'] || e.type;
                        if (t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'))) {
                            // Return the first JobPosting we find — but keep it flexible
                            const out = {
                                title: e.title || e.name || null,
                                company: e.hiringOrganization?.name || null,
                                date_posted: e.datePosted || null,
                                description_html: e.description || null,
                                location: (e.jobLocation && e.jobLocation.address && (e.jobLocation.address.addressLocality || e.jobLocation.address.addressRegion)) || null,
                                salary: e.baseSalary?.value || e.baseSalary?.minValue || null,
                                job_type: e.employmentType || null,
                            };

                            if (firstOnly) return out;
                            found.push(out);
                        }
                    }
                } catch (e) { /* ignore parsing errors */ }
            }
            // If no JSON-LD found return either first or array
            if (found.length) return found;
            return null;
        }

        // --- Stealth helpers ---
        const USER_AGENTS = [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15',
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
        ];

        function getRandomUserAgent() {
            return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
        }

        function findJobLinks($, base) {
            const links = new Set();

            // Common patterns: anchors with /jobs/ in href, anchors inside listing cards, data-href attributes
            // Check anchors
            $('a[href]').each((_, a) => {
                const href = $(a).attr('href');
                if (!href) return;
                // Accept candidates containing /jobs/ or /job or 'listing' keywords
                if (/\/jobs\//i.test(href) || /\/job\//i.test(href) || /listing|ad\//i.test(href)) {
                    const abs = toAbs(href, base);
                    if (abs && !abs.includes('/search')) links.add(abs);
                }
            });

            // Check elements with data-href / data-url attributes (listing cards)
            $('[data-href], [data-url]').each((_, el) => {
                const href = $(el).attr('data-href') || $(el).attr('data-url');
                if (!href) return;
                const abs = toAbs(href, base);
                if (abs && !abs.includes('/search')) links.add(abs);
            });

            // Check <article> or card elements that contain link children
            $('article, .listing, .card').each((_, el) => {
                const a = $(el).find('a[href]').first();
                if (a && a.length) {
                    const href = a.attr('href');
                    const abs = toAbs(href, base);
                    if (abs && !abs.includes('/search')) links.add(abs);
                }
            });

            return [...links];
        }

        function findNextPage($, base, currentPage = 1) {
            // Look for pagination links
            const nextLink = $('a[rel="next"], a[aria-label*="next" i], a.next, button[aria-label*="next" i]').attr('href')
                || $('a').filter((_, el) => /page=\d+/i.test($(el).attr('href') || '') && /next|›|»|>/.test($(el).text())).first().attr('href');
            if (nextLink) return toAbs(nextLink, base);
            
            // Try to construct next page URL
            const urlObj = new URL(base);
            urlObj.searchParams.set('page', (currentPage + 1).toString());
            return urlObj.href;
        }

        // Try sitemap discovery for job URLs — returns array of URLs found in sitemap
        async function fetchSitemapUrls(rootDomain) {
            try {
                const candidates = ['/sitemap.xml', '/sitemap-index.xml', '/sitemap_jobs.xml', '/sitemap-pages.xml'];
                const found = new Set();
                for (const p of candidates) {
                    try {
                        const url = new URL(p, rootDomain).href;
                        const res = await gotScraping({ url, responseType: 'text', proxyUrl: proxyConf ? await proxyConf.newUrl() : undefined });
                        const xml = res.body || '';
                        const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/gi)].map(m => m[1]);
                        for (const l of locs) if (/\/jobs\//i.test(l)) found.add(l);
                    } catch (err) { /* skip failures */ }
                }
                return [...found];
            } catch (err) {
                log.debug(`Sitemap fetch failed: ${err.message}`);
                return [];
            }
        }

        const crawler = new PlaywrightCrawler({
            proxyConfiguration: proxyConf,
            maxRequestRetries: 3,
            failedRequestHandler: async ({ request, error }) => {
                log.warning(`Request ${request.url} failed too many times: ${error?.message || error}`);
                // Keep a small record to dataset for investigation
                try { await Dataset.pushData({ error: String(error?.message || error), url: request.url, userData: request.userData }); } catch (e) { /* ignore */ }
            },
            useSessionPool: true,
            maxConcurrency: 5,
            requestHandlerTimeoutSecs: 90,
            async requestHandler({ request, page, enqueueLinks, log: crawlerLog }) {
                // Small random delay to reduce fingerprinting and throttling
                await new Promise((r) => setTimeout(r, 100 + Math.floor(Math.random() * 800)));
                const label = request.userData?.label || 'LIST';
                const pageNo = request.userData?.pageNo || 1;

                const html = await page.content();
                const $ = cheerioLoad(html);

                if (label === 'LIST') {
                    let jobsData = [];

                    // Try API first if enabled
                    if (useApiFirst) {
                        const apiData = await fetchJobsFromAPI(request.url, pageNo);
                        // If we got an API body, try to normalize it into listings
                        if (apiData) {
                            // normalize various shapes
                            const normalized = normalizeListings(apiData);
                            if (normalized && normalized.length) {
                                jobsData = normalized;
                                crawlerLog.info(`API: Found ${jobsData.length} jobs on page ${pageNo}`);
                            } else {
                                // Try extracting embedded JSON from original page HTML as a last attempt
                                const embedded = parseEmbeddedJsonFromHtml($);
                                const eNorm = normalizeListings(embedded);
                                if (eNorm && eNorm.length) {
                                    jobsData = eNorm;
                                    crawlerLog.info(`EMBED: Found ${jobsData.length} listings embedded in page HTML on page ${pageNo}`);
                                }
                            }
                        }
                    }

                    // Fallback to HTML parsing if API didn't work
                    if (jobsData.length === 0) {
                        // Try JSON-LD listing embedded in page (many sites include lists)
                        const embeddedPosts = extractFromJsonLd($, false);
                        if (Array.isArray(embeddedPosts) && embeddedPosts.length) {
                            jobsData = embeddedPosts;
                            crawlerLog.info(`JSON-LD: Found ${jobsData.length} JobPosting entries on page ${pageNo}`);
                        }

                        // If still nothing, continue with anchor-based HTML parsing
                        const links = findJobLinks($, request.url);
                        crawlerLog.info(`HTML: Found ${links.length} job links on page ${pageNo}`);

                        if (collectDetails) {
                            const remaining = RESULTS_WANTED - saved;
                            const toEnqueue = links.slice(0, Math.max(0, remaining));
                            if (toEnqueue.length) await enqueueLinks({ urls: toEnqueue, userData: { label: 'DETAIL' } });
                        } else {
                            const remaining = RESULTS_WANTED - saved;
                            const toPush = links.slice(0, Math.max(0, remaining));
                            if (toPush.length) { 
                                await Dataset.pushData(toPush.map(u => ({ url: u }))); 
                                saved += toPush.length; 
                            }
                        }
                    } else {
                        // Process API data
                        const remaining = RESULTS_WANTED - saved;
                        const toProcess = jobsData.slice(0, Math.max(0, remaining));

                        for (const job of toProcess) {
                            if (saved >= RESULTS_WANTED) break;

                            const jobUrl = toAbs(`/jobs/${job.categorySlug || 'jobs'}/${job.id}`, `https://${emirate}.dubizzle.com`);
                            
                            if (collectDetails && jobUrl) {
                                await enqueueLinks({ urls: [jobUrl], userData: { label: 'DETAIL' } });
                            } else {
                                const item = {
                                    job_title: job.title || null,
                                    company: job.contactName || job.agentName || null,
                                    category: job.categoryName || category || null,
                                    location: job.location?.join(', ') || emirate || null,
                                    salary: job.price || null,
                                    job_type: null,
                                    date_posted: job.createdAt || null,
                                    url: jobUrl,
                                };
                                await Dataset.pushData(item);
                                saved++;
                            }
                        }
                    }

                    if (saved < RESULTS_WANTED && pageNo < MAX_PAGES) {
                        const next = findNextPage($, request.url, pageNo);
                        if (next) await enqueueLinks({ urls: [next], userData: { label: 'LIST', pageNo: pageNo + 1 } });
                    }
                    return;
                }

                if (label === 'DETAIL') {
                    if (saved >= RESULTS_WANTED) return;
                    try {
                        const json = extractFromJsonLd($);
                        const data = json || {};
                        
                        // Dubizzle-specific selectors
                        if (!data.title) data.title = $('h1, [class*="title"]').first().text().trim() || null;
                        if (!data.company) {
                            data.company = $('[class*="contact"], [class*="agent"], [class*="employer"]').first().text().trim() 
                                || $('span:contains("Company"), div:contains("Employer")').next().text().trim() || null;
                        }
                        if (!data.description_html) { 
                            const desc = $('[class*="description"], [class*="details"], section[class*="description"]').first(); 
                            data.description_html = desc && desc.length ? String(desc.html()).trim() : null; 
                        }
                        data.description_text = data.description_html ? cleanText(data.description_html) : null;
                        if (!data.location) data.location = $('[class*="location"], [class*="breadcrumb"]').first().text().trim() || emirate || null;
                        if (!data.salary) data.salary = $('[class*="salary"], [class*="price"]').first().text().trim() || null;
                        if (!data.job_type) data.job_type = $('[class*="job-type"], [class*="employment"]').first().text().trim() || null;

                        const item = {
                            job_title: data.title || null,
                            company: data.company || null,
                            category: category || null,
                            location: data.location || null,
                            salary: data.salary || null,
                            job_type: data.job_type || null,
                            date_posted: data.date_posted || null,
                            description_html: data.description_html || null,
                            description_text: data.description_text || null,
                            url: request.url,
                        };

                        await Dataset.pushData(item);
                        saved++;
                    } catch (err) { 
                        crawlerLog.error(`DETAIL ${request.url} failed: ${err.message}`); 
                    }
                }
            }
        });

        await crawler.run(initial.map(u => ({ url: u, userData: { label: 'LIST', pageNo: 1 } })));
        log.info(`Finished. Saved ${saved} items`);
    } finally {
        await Actor.exit();
    }
}

main().catch(err => { console.error(err); process.exit(1); });
