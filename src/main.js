// Dubizzle Jobs scraper - JSON API + HTML fallback implementation
import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';
import { gotScraping } from 'got-scraping';

// Single-entrypoint main
await Actor.init();

async function main() {
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

        // Try to fetch jobs from Dubizzle API first
        async function fetchJobsFromAPI(searchUrl, page = 1) {
            try {
                const apiUrl = new URL(searchUrl);
                apiUrl.searchParams.set('page', page.toString());
                
                const response = await gotScraping({
                    url: apiUrl.href,
                    responseType: 'json',
                    headers: {
                        'Accept': 'application/json',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    },
                    proxyUrl: proxyConf ? await proxyConf.newUrl() : undefined,
                });

                return response.body;
            } catch (err) {
                log.warning(`API fetch failed: ${err.message}`);
                return null;
            }
        }

        function extractFromJsonLd($) {
            const scripts = $('script[type="application/ld+json"]');
            for (let i = 0; i < scripts.length; i++) {
                try {
                    const parsed = JSON.parse($(scripts[i]).html() || '');
                    const arr = Array.isArray(parsed) ? parsed : [parsed];
                    for (const e of arr) {
                        if (!e) continue;
                        const t = e['@type'] || e.type;
                        if (t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'))) {
                            return {
                                title: e.title || e.name || null,
                                company: e.hiringOrganization?.name || null,
                                date_posted: e.datePosted || null,
                                description_html: e.description || null,
                                location: (e.jobLocation && e.jobLocation.address && (e.jobLocation.address.addressLocality || e.jobLocation.address.addressRegion)) || null,
                                salary: e.baseSalary?.value || e.baseSalary?.minValue || null,
                                job_type: e.employmentType || null,
                            };
                        }
                    }
                } catch (e) { /* ignore parsing errors */ }
            }
            return null;
        }

        function findJobLinks($, base) {
            const links = new Set();
            $('a[href]').each((_, a) => {
                const href = $(a).attr('href');
                if (!href) return;
                // Dubizzle job URLs typically contain /jobs/ and end with numbers
                if (/\/jobs\/.*\/\d+/i.test(href) || href.includes('job')) {
                    const abs = toAbs(href, base);
                    if (abs && !abs.includes('/search') && abs.includes('/jobs/')) {
                        links.add(abs);
                    }
                }
            });
            return [...links];
        }

        function findNextPage($, base, currentPage = 1) {
            // Look for pagination links
            const nextLink = $('a[aria-label*="next" i], a.next, button[aria-label*="next" i]').attr('href');
            if (nextLink) return toAbs(nextLink, base);
            
            // Try to construct next page URL
            const urlObj = new URL(base);
            urlObj.searchParams.set('page', (currentPage + 1).toString());
            return urlObj.href;
        }

        const crawler = new CheerioCrawler({
            proxyConfiguration: proxyConf,
            maxRequestRetries: 3,
            useSessionPool: true,
            maxConcurrency: 5,
            requestHandlerTimeoutSecs: 90,
            async requestHandler({ request, $, enqueueLinks, log: crawlerLog }) {
                const label = request.userData?.label || 'LIST';
                const pageNo = request.userData?.pageNo || 1;

                if (label === 'LIST') {
                    let jobsData = [];

                    // Try API first if enabled
                    if (useApiFirst) {
                        const apiData = await fetchJobsFromAPI(request.url, pageNo);
                        if (apiData && apiData.props?.pageProps?.searchResult?.listings) {
                            jobsData = apiData.props.pageProps.searchResult.listings;
                            crawlerLog.info(`API: Found ${jobsData.length} jobs on page ${pageNo}`);
                        }
                    }

                    // Fallback to HTML parsing if API didn't work
                    if (jobsData.length === 0) {
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
