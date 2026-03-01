const ALLOWED_ORIGINS = [
  "https://filmarks.com/",
  "https://www.rottentomatoes.com/",
];

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!sender.tab || !sender.url?.startsWith("https://video.unext.jp/")) {
    return;
  }

  if (message.type === "FETCH_ALL_SCORES") {
    (async () => {
      try {
        const result = await fetchAllScores(message.title, message.year);
        sendResponse(result);
      } catch (e) {
        console.error("[Ratings] Unhandled error:", e);
        sendResponse({ filmarks: { error: e.message } });
      }
    })();
    return true;
  }
  if (message.type === "OPEN_TAB") {
    const url = message.url;
    if (url && ALLOWED_ORIGINS.some((origin) => url.startsWith(origin))) {
      chrome.tabs.create({ url });
    }
  }
});

// --- Orchestrator ---

async function fetchAllScores(japaneseTitle, unextYear) {
  console.log("[Ratings] Fetching all scores for:", japaneseTitle, "U-NEXT year:", unextYear);

  // Step 1: Filmarks search
  const filmarks = await fetchFilmarksScore(japaneseTitle);

  // Step 2: Get English title from Filmarks detail page
  let englishTitle = null;
  let year = unextYear || null; // U-NEXT year is primary
  if (filmarks.url && !filmarks.error) {
    const detail = await fetchFilmarksDetail(filmarks.url);
    englishTitle = detail.originalTitle;
    if (!year) year = detail.year; // Filmarks year as fallback
    console.log("[Ratings] English title:", englishTitle, "Year:", year);
  }

  // Step 3: Rotten Tomatoes (if we have an English title)
  let rt = null;
  if (englishTitle) {
    rt = await fetchRTScore(englishTitle, year);
    console.log("[Ratings] RT result:", rt);
  }

  return { filmarks, rt, englishTitle };
}

// --- Filmarks ---

async function fetchFilmarksScore(title) {
  try {
    const searchUrl =
      "https://filmarks.com/search/movies?q=" + encodeURIComponent(title);
    const res = await fetch(searchUrl);
    if (!res.ok) return { error: "search_failed", status: res.status };

    const html = await res.text();
    return parseSearchResults(html, title, searchUrl);
  } catch (e) {
    return { error: e.message };
  }
}

function parseSearchResults(html, queryTitle, searchUrl) {
  const results = [];

  // Match each card: the onClickDetailLink and class="p-content-cassette" are on the same tag
  // e.g. <div @click="onClickDetailLink($event, '/movies/30973')" class="p-content-cassette">
  const cardRegex = /onClickDetailLink\(\$event,\s*(?:'|&#39;)(\/movies\/\d+)(?:'|&#39;)\)"\s*class="p-content-cassette">([\s\S]*?)(?=onClickDetailLink\(\$event|$)/g;
  let cardMatch;
  while ((cardMatch = cardRegex.exec(html)) !== null) {
    const moviePath = cardMatch[1];
    const card = cardMatch[2];

    const titleMatch = card.match(
      /p-content-cassette__title"[^>]*>([^<]+)<\/h3>/
    );
    const movieTitle = titleMatch
      ? decodeHTMLEntities(titleMatch[1].trim())
      : null;

    const scoreMatch = card.match(/c-rating__score"[^>]*>(\d\.\d)<\/div>/);
    const score = scoreMatch ? scoreMatch[1] : null;

    const thumbMatch = card.match(
      /<img\s[^>]*src="(https:\/\/d2ueuvlup6lbue\.cloudfront\.net\/[^"]+)"[^>]*>/
    );
    const thumbnail = thumbMatch ? thumbMatch[1] : null;

    if (movieTitle && score) {
      results.push({
        title: movieTitle,
        score,
        url: "https://filmarks.com" + moviePath,
        thumbnail,
        searchUrl,
      });
    }
  }

  if (results.length === 0) {
    return { error: "no_results", searchUrl };
  }

  // Match priority: exact > query-contains-movie > movie-contains-query > first result
  const normalizedQuery = normalize(queryTitle);
  const scored = results.map((r) => {
    const normalizedMovie = normalize(r.title);
    let priority = 0;
    if (normalizedMovie === normalizedQuery) priority = 3;
    else if (normalizedQuery.includes(normalizedMovie)) priority = 2;
    else if (normalizedMovie.includes(normalizedQuery)) priority = 1;
    return { ...r, priority };
  });
  scored.sort((a, b) => b.priority - a.priority);
  return scored[0];
}

async function fetchFilmarksDetail(filmarksMovieUrl) {
  try {
    const res = await fetch(filmarksMovieUrl);
    if (!res.ok) return { originalTitle: null, year: null };
    const html = await res.text();

    // English title: <p class="p-content-detail__original">ENGLISH TITLE</p>
    const titleMatch = html.match(
      /class="p-content-detail__original"[^>]*>([^<]+)<\/p>/
    );
    const originalTitle = titleMatch
      ? decodeHTMLEntities(titleMatch[1].trim())
      : null;

    // Year: "2000年製作の映画" in <h1> or nearby
    const yearMatch = html.match(/(\d{4})年製作の映画/);
    const year = yearMatch ? parseInt(yearMatch[1], 10) : null;

    return { originalTitle, year };
  } catch (e) {
    console.error("[Ratings] Failed to fetch Filmarks detail:", e);
    return { originalTitle: null, year: null };
  }
}

// --- Rotten Tomatoes ---

async function fetchRTScore(englishTitle, expectedYear) {
  try {
    const slug = englishTitle
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .replace(/\s+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "");

    // Try multiple URL patterns: base slug, slug_year
    const candidates = ["https://www.rottentomatoes.com/m/" + slug];
    if (expectedYear) {
      candidates.push(
        "https://www.rottentomatoes.com/m/" + slug + "_" + expectedYear
      );
    }

    // Strategy 1: Try guessed URLs, collect valid results
    const validResults = [];
    for (const guessedUrl of candidates) {
      console.log("[Ratings] Trying RT URL:", guessedUrl);
      const res = await fetch(guessedUrl);
      if (res.ok) {
        const html = await res.text();
        const result = parseRTPage(html, guessedUrl);
        if (!result.error) {
          validResults.push(result);
        }
      }
    }

    if (validResults.length > 0) {
      const best = pickClosestYear(validResults, expectedYear);
      if (best) return best;
      // All results had wrong years, fall through to search
    }

    // Strategy 2: Search RT
    console.log("[Ratings] Guessed URLs failed, searching RT...");
    const moviePath = await searchRT(englishTitle);
    if (!moviePath) return { error: "not_found" };

    const movieUrl = "https://www.rottentomatoes.com" + moviePath;
    const res = await fetch(movieUrl);
    if (!res.ok) return { error: "fetch_failed", status: res.status };

    const html = await res.text();
    const result = parseRTPage(html, movieUrl);
    if (!result.error && isYearMatch(result.year, expectedYear)) {
      return result;
    }

    return result.error ? result : { error: "year_mismatch" };
  } catch (e) {
    return { error: e.message };
  }
}

function isYearMatch(rtYear, expectedYear) {
  if (!expectedYear || !rtYear) return true; // missing year info, accept
  return Math.abs(rtYear - expectedYear) <= 1;
}

function pickClosestYear(results, expectedYear) {
  if (!expectedYear) return results[0];

  // Filter out results with clearly wrong years (allow ±3 for JP/US release gap)
  const compatible = results.filter(
    (r) => !r.year || Math.abs(r.year - expectedYear) <= 3
  );
  if (compatible.length === 0) return null;

  // Sort by year proximity (year data preferred, closest first)
  compatible.sort((a, b) => {
    if (!a.year && !b.year) return 0;
    if (!a.year) return 1;
    if (!b.year) return -1;
    return Math.abs(a.year - expectedYear) - Math.abs(b.year - expectedYear);
  });
  return compatible[0];
}

function parseRTPage(html, movieUrl) {
  // RT embeds JSON with score data: "criticsScore":{"score":"89",...}
  const criticsMatch = html.match(
    /"criticsScore"\s*:\s*\{[^}]*?"score"\s*:\s*"(\d+)"[^}]*?\}/
  );
  const audienceMatch = html.match(
    /"audienceScore"\s*:\s*\{[^}]*?"score"\s*:\s*"(\d+)"[^}]*?\}/
  );

  if (!criticsMatch && !audienceMatch) {
    return { error: "no_scores" };
  }

  // Extract year from RT page (e.g. "releaseYear":"2000" or "Released Jan 20, 2000")
  const yearMatch =
    html.match(/"releaseYear"\s*:\s*"(\d{4})"/) ||
    html.match(/"year"\s*:\s*(\d{4})/) ||
    html.match(/Released\s+\w+\s+\d{1,2},\s+(\d{4})/);
  const pageYear = yearMatch ? parseInt(yearMatch[1], 10) : null;

  return {
    criticsScore: criticsMatch ? criticsMatch[1] : null,
    audienceScore: audienceMatch ? audienceMatch[1] : null,
    url: movieUrl,
    year: pageYear,
  };
}

async function searchRT(englishTitle) {
  try {
    const searchUrl =
      "https://www.rottentomatoes.com/search?search=" +
      encodeURIComponent(englishTitle);
    const res = await fetch(searchUrl);
    if (!res.ok) return null;
    const html = await res.text();

    // Look for search-page-media-row elements with movie links
    const rowRegex =
      /<search-page-media-row[^>]*>(.*?)<\/search-page-media-row>/gs;
    let match;
    while ((match = rowRegex.exec(html)) !== null) {
      const row = match[1];
      const urlMatch = row.match(/href="(\/m\/[^"]+)"/);
      if (urlMatch) return urlMatch[1];
    }

    // No results found in search page (likely client-rendered)
    return null;
  } catch (e) {
    console.error("[Ratings] RT search failed:", e);
    return null;
  }
}

// --- Utilities ---

function decodeHTMLEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));
}

function normalize(str) {
  return str
    .toLowerCase()
    .replace(/[\s\u3000]+/g, "")
    .replace(/[！-～]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
    )
    .replace(/[（(）)【】\[\]「」『』]/g, "")
    .replace(/[-−‐ー]/g, "");
}
