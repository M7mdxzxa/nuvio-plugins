// TokyoInsider Scraper for Nuvio Local Scrapers
// React Native compatible version

console.log('[TokyoInsider] Initializing TokyoInsider scraper');

// Constants
const TMDB_API_KEY = "1c29a5198ee1854bd5eb45dbe8d17d92";
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const BASE_URL = 'https://www.tokyoinsider.com';
const TIMEOUT = 20000;

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Referer': BASE_URL + '/'
};

// Helper function to make HTTP requests
function makeRequest(url, options = {}) {
    return fetch(url, {
        timeout: TIMEOUT,
        headers: { ...HEADERS, ...options.headers },
        ...options
    }).then(function(response) {
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        return response;
    });
}

// Get TMDB details
function getTMDBDetails(tmdbId, mediaType) {
    const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
    const url = `${TMDB_BASE_URL}/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}`;

    return makeRequest(url).then(function(response) {
        return response.json();
    }).then(function(data) {
        const isTv = mediaType === 'tv';
        return {
            title: isTv ? data.name : data.title,
            originalTitle: isTv ? data.original_name : data.original_title,
            year: (isTv ? data.first_air_date : data.release_date)?.substring(0, 4) || '',
            mediaType: isTv ? 'tv' : 'movie'
        };
    }).catch(function(error) {
        console.log(`[TokyoInsider] TMDB lookup failed: ${error.message}`);
        return null;
    });
}

// Format title
function formatTitleForURL(title) {
    // Replace spaces with underscores
    // Keep special characters but encode them properly
    return title
        .trim()
        .replace(/ /g, '_')
        .replace(/'/g, '')  // Remove apostrophes
        .replace(/:/g, '')  // Remove colons
        .replace(/\?/g, '')  // Remove question marks
        .replace(/!/g, '');  // Remove exclamation marks
}

// Build TokyoInsider URL
function buildTokyoInsiderURL(title, mediaType, episodeNum) {
    const formattedTitle = formatTitleForURL(title);
    const firstLetter = title.charAt(0).toUpperCase();
    const typeDesignation = mediaType === 'tv' ? '_(TV)' : '_(Movie)';

    const baseAnimeUrl = `${BASE_URL}/anime/${firstLetter}/${formattedTitle}${typeDesignation}`;

    if (episodeNum) {
        return `${baseAnimeUrl}/episode/${episodeNum}`;
    }

    return baseAnimeUrl;
}

// Extract download link and file size from episode page
function extractDownloadInfo(episodePageUrl) {
    console.log(`[TokyoInsider] Fetching episode page: ${episodePageUrl}`);

    return makeRequest(episodePageUrl).then(function(response) {
        return response.text();
    }).then(function(html) {
        // Look for .mkv or .mp4 files in anchor tags
        const fileRegex = /<a[^>]+href=["']([^"']*\/download\/[^"']+)["'][^>]*>([^<]*?\.(?:mkv|mp4)[^<]*?)<\/a>/gi;

        let matches = [];
        let match;

        // Collect all .mkv and .mp4 links
        while ((match = fileRegex.exec(html)) !== null) {
            matches.push({
                url: match[1],
                filename: match[2].trim()
            });
        }

        if (matches.length === 0) {
            console.log('[TokyoInsider] No /download/ links found, trying broader search');
            const broadRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([^<]*?\.(?:mkv|mp4)[^<]*?)<\/a>/gi;

            while ((match = broadRegex.exec(html)) !== null) {
                const href = match[1];
                const filename = match[2].trim();

                if (filename.includes('.mkv') || filename.includes('.mp4')) {
                    matches.push({
                        url: href.startsWith('http') ? href : BASE_URL + href,
                        filename: filename
                    });
                }
            }
        }

        if (matches.length === 0) {
            console.log('[TokyoInsider] Could not find any .mkv or .mp4 files');
            
        }

        console.log(`[TokyoInsider] Found ${matches.length} file(s)`);

        // Process
        const results = matches.map(function(fileMatch) {
            const downloadUrl = fileMatch.url.startsWith('http') ? fileMatch.url : BASE_URL + fileMatch.url;
            const filename = fileMatch.filename;

            // Extract file size from the HTML (look near the filename)
            const filenameIndex = html.indexOf(filename);
            if (filenameIndex !== -1) {
                const surroundingText = html.substring(filenameIndex, filenameIndex + 500);
                const sizeMatch = surroundingText.match(/Size:\s*([0-9.]+\s*[KMGT]B)/i) || 
                                 surroundingText.match(/([0-9.]+\s*[KMGT]B)/i);
                const fileSize = sizeMatch ? sizeMatch[1] : null;

                // Extract quality from filename
                const qualityMatch = filename.match(/(\d{3,4}p)/i);
                const quality = qualityMatch ? qualityMatch[1] : 'Unknown';

                return {
                    url: downloadUrl,
                    filename: filename,
                    size: fileSize,
                    quality: quality
                };
            }

            // Fallback
            const qualityMatch = filename.match(/(\d{3,4}p)/i);
            return {
                url: downloadUrl,
                filename: filename,
                size: null,
                quality: qualityMatch ? qualityMatch[1] : 'Unknown'
            };
        });

        return results;
    });
}

// Main scraper function
async function invokeTokyoInsider(tmdbId, mediaType, seasonNum = null, episodeNum = null) {
    console.log(`[TokyoInsider] TMDB ID: ${tmdbId}, Type: ${mediaType}, Episode: ${episodeNum || 'N/A'}`);

    // For TV shows, episode number is required
    if (mediaType === 'tv' && !episodeNum) {
        console.log('[TokyoInsider] ERROR: Episode number is required for TV shows');
        return [];
    }

    try {
        // Step 1: Get TMDB details
        const mediaInfo = await getTMDBDetails(tmdbId, mediaType);
        if (!mediaInfo) {
            return [];
        }

        console.log(`[TokyoInsider] Title: "${mediaInfo.title}" (${mediaInfo.year})`);

        // Try with both English title and original title
        const titlesToTry = [mediaInfo.title];
        if (mediaInfo.originalTitle && mediaInfo.originalTitle !== mediaInfo.title) {
            titlesToTry.push(mediaInfo.originalTitle);
        }

        let downloadInfoArray = null;
        let usedTitle = null;

        // Try each title variation
        for (const title of titlesToTry) {
            try {
                console.log(`[TokyoInsider] Trying with title: "${title}"`);
                // Always include episode number for TV shows
                const episodeUrl = buildTokyoInsiderURL(
                    title, 
                    mediaInfo.mediaType, 
                    mediaInfo.mediaType === 'tv' ? episodeNum : null
                );
                console.log(`[TokyoInsider] Episode URL: ${episodeUrl}`);
                downloadInfoArray = await extractDownloadInfo(episodeUrl);
                usedTitle = title;
                break; // Success, stop trying
            } catch (error) {
                console.log(`[TokyoInsider] Failed with title "${title}": ${error.message}`);
                continue; // Try next title
            }
        }

        if (!downloadInfoArray || downloadInfoArray.length === 0) {
            console.log('[TokyoInsider] Could not find content with any title variation');
            return [];
        }

        // Step 3: Build stream objects for files
        const streams = downloadInfoArray.map(function(downloadInfo) {
            return {
                name: `TokyoInsider${downloadInfo.quality !== 'Unknown' ? ' - ' + downloadInfo.quality : ''}`,
                title: `${downloadInfo.filename}`,
                url: downloadInfo.url,
                quality: downloadInfo.quality,
                size: downloadInfo.size,
                headers: {
                    'User-Agent': HEADERS['User-Agent'],
                    'Referer': BASE_URL + '/'
                },
                provider: 'tokyoinsider'
            };
        });

        console.log(`[TokyoInsider] Successfully extracted ${streams.length} stream(s)`);
        return streams;

    } catch (error) {
        console.error(`[TokyoInsider] Error: ${error.message}`);
        return [];
    }
}

// Main function to get streams for TMDB content
function getStreams(tmdbId, mediaType = 'movie', seasonNum = null, episodeNum = 1) {
    console.log(`[TokyoInsider] Fetching streams for TMDB ID: ${tmdbId}, Type: ${mediaType}${seasonNum ? `, S${seasonNum}E${episodeNum}` : ''}`);

    return invokeTokyoInsider(tmdbId, mediaType, seasonNum, episodeNum).catch(function(error) {
        console.error(`[TokyoInsider] Error in getStreams: ${error.message}`);
        return [];
    });
}

// Export the main function
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { getStreams };
} else {
    global.getStreams = getStreams;
}
