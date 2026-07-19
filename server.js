/**
 * Nuvio Plugins - Express API
 *
 * Endpoints:
 *   GET /providers                                          → list all available providers
 *   GET /streams/:tmdbId                                    → streams from ALL providers (movie)
 *   GET /streams/:tmdbId/:season/:episode                   → streams from ALL providers (TV)
 *   GET /streams/:tmdbId?providers=airflix,videasy           → streams from specific providers (movie)
 *   GET /streams/:tmdbId/:season/:episode?providers=...     → streams from specific providers (TV)
 *   GET /streams/:tmdbId?provider=airflix                   → alias: single provider (movie)
 *   GET /streams/:tmdbId/:season/:episode?provider=...      → alias: single provider (TV)
 */

const express = require("express");
const path    = require("path");
const fs      = require("fs");

const manifest = require("./manifest.json");
const app      = express();
const PORT     = process.env.PORT || 3000;

// ─── Static provider registry (Vercel-compatible) ────────────────────────────
// Dynamic require(filePath) won't work on Vercel because files referenced via
// fs at runtime are not bundled. We list every provider explicitly so the
// build tool can trace and include them.
const PROVIDER_MODULES = {
  "nuvio-4khdhub":      require("./providers/4khdhub.js"),
  "nuvio-airflix":      require("./providers/airflix.js"),
  "nuvio-animepahe":    require("./providers/animepahe.js"),
  "nuvio-anineko":      require("./providers/anineko.js"),
  "nuvio-bollyflix":    require("./providers/bollyflix.js"),
  "nuvio-dahmermovies": require("./providers/dahmermovies.js"),
  "nuvio-embed69":      require("./providers/embed69.js"),
  "nuvio-faselhd":      require("./providers/faselhd.js"),
  "nuvio-filmmodu":     require("./providers/filmmodu.js"),
  "nuvio-hdhub4u":      require("./providers/hdhub4u.js"),
  "nuvio-movieblast":   require("./providers/movieblast.js"),
  "nuvio-movix":        require("./providers/movix.js"),
  "nuvio-showbox":      require("./providers/showbox.js"),
  "nuvio-tokyoinsider": require("./providers/tokyoinsider.js"),
  "nuvio-uhdmovies":    require("./providers/uhdmovies.js"),
  "nuvio-videasy":      require("./providers/videasy.js"),
  "nuvio-vidfast":      require("./providers/vidfast.js"),
  "nuvio-vidlink":      require("./providers/vidlink.js"),
};

// ─── Load all providers from manifest ────────────────────────────────────────

const providerMap = {}; // id → { meta, getStreams }

for (const scraper of manifest.scrapers) {
  if (!scraper.enabled) continue;

  const mod = PROVIDER_MODULES[scraper.id];

  if (!mod) {
    console.warn(`[API] No static module registered for provider: ${scraper.id}`);
    continue;
  }

  if (typeof mod.getStreams !== "function") {
    console.warn(`[API] Provider "${scraper.id}" has no getStreams(), skipping`);
    continue;
  }

  providerMap[scraper.id] = { meta: scraper, getStreams: mod.getStreams };
  console.log(`[API] Loaded provider: ${scraper.id} (${scraper.name})`);
}

const allProviderIds = Object.keys(providerMap);
console.log(`[API] ${allProviderIds.length} provider(s) ready`);

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(express.json());

// Friendly CORS headers (handy when calling from a web UI)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});

// ─── Helper ───────────────────────────────────────────────────────────────────

/**
 * Resolve which providers to use from query params.
 * Supports ?providers=id1,id2,id3  or  ?provider=id1
 * Falls back to all loaded providers.
 */
function resolveProviders(query) {
  const raw = query.providers || query.provider || "";
  if (!raw) return allProviderIds;

  const requested = raw.split(",").map(s => s.trim()).filter(Boolean);
  const valid     = [];
  const unknown   = [];

  for (const id of requested) {
    if (providerMap[id]) valid.push(id);
    else unknown.push(id);
  }

  if (unknown.length) {
    console.warn(`[API] Unknown provider id(s): ${unknown.join(", ")}`);
  }

  return valid;
}

/**
 * Normalize the subtitles field on a stream object.
 * Different providers use different shapes:
 *   - Airflix / AniNeko  → { url, lang }
 *   - FilmModu           → { url, language, label }
 *   - HDHub4u / VidLink  → { url, language }
 * We always output: { url: string, language: string }
 */
function normalizeSubtitles(raw) {
  if (!raw || !Array.isArray(raw) || raw.length === 0) return [];
  return raw
    .filter(s => s && s.url)
    .map(s => ({
      url:      s.url,
      language: s.language || s.lang || s.label || "Unknown",
    }));
}

/**
 * Fetch subtitles from sub.vdrk.site (v1 and v2) for a given media.
 * Response shape: [{ label: "English", file: "https://..." }]
 * We try both versions in parallel and merge+deduplicate results.
 *
 * TV:    /v{n}/tv/{tmdbId}/{season}/{episode}
 * Movie: /v{n}/movie/{tmdbId}
 */
async function fetchVdrkSubtitles(tmdbId, mediaType, season, episode) {
  const VDRK_BASE = "https://sub.vdrk.site";
  const versions  = ["v1", "v2"];

  const path = mediaType === "tv"
    ? `/tv/${tmdbId}/${season}/${episode}`
    : `/movie/${tmdbId}`;

  const urls = versions.map(v => `${VDRK_BASE}/${v}${path}`);

  const results = await Promise.allSettled(
    urls.map(url =>
      fetch(url, { headers: { "Accept": "application/json" } })
        .then(r => r.ok ? r.json() : [])
        .catch(() => [])
    )
  );

  const seen = new Set();
  const subtitles = [];

  for (const result of results) {
    const list = result.status === "fulfilled" ? (result.value || []) : [];
    for (const item of list) {
      if (!item || !item.file) continue;
      const url      = item.file;
      const language = item.label || "Unknown";
      if (!seen.has(url)) {
        seen.add(url);
        subtitles.push({ url, language });
      }
    }
  }

  console.log(`[API] VDRK subtitles fetched: ${subtitles.length} for ${mediaType} ${tmdbId}`);
  return subtitles;
}

/**
 * Fetch streams from a single provider and attach provider metadata.
 * Subtitles are normalized per stream but will be hoisted to a shared
 * top-level array by the route handler (individual stream subtitles removed).
 */
async function fetchFromProvider(id, tmdbId, mediaType, season, episode) {
  const { meta, getStreams } = providerMap[id];
  try {
    const streams = await getStreams(tmdbId, mediaType, season, episode);
    return (streams || []).map(s => ({
      ...s,
      subtitles:     normalizeSubtitles(s.subtitles),
      _provider:     id,
      _providerName: meta.name,
    }));
  } catch (err) {
    console.error(`[API] Error in provider "${id}": ${err.message}`);
    return [];
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /
app.get("/", (req, res) => {
  res.json({
    name:    "Nuvio Plugins API",
    version: manifest.version,
    endpoints: [
      "GET /providers",
      "GET /streams/:tmdbId[?providers=id1,id2&type=movie]",
      "GET /streams/:tmdbId/:season/:episode[?providers=id1,id2]",
    ]
  });
});

// GET /providers – list all loaded providers and their metadata
app.get("/providers", (req, res) => {
  const list = allProviderIds.map(id => {
    const { meta } = providerMap[id];
    return {
      id:               meta.id,
      name:             meta.name,
      description:      meta.description,
      version:          meta.version,
      author:           meta.author,
      supportedTypes:   meta.supportedTypes,
      formats:          meta.formats,
      contentLanguage:  meta.contentLanguage,
      logo:             meta.logo,
    };
  });
  res.json({ providers: list });
});

// GET /streams/:tmdbId  (movie or TV with ?type=tv&season=1&episode=1)
// GET /streams/:tmdbId/:season/:episode
app.get("/streams/:tmdbId/:season?/:episode?", async (req, res) => {
  const { tmdbId }  = req.params;
  const season      = req.params.season  ? parseInt(req.params.season,  10) : null;
  const episode     = req.params.episode ? parseInt(req.params.episode, 10) : null;

  // Determine media type
  //  → infer from route: if season+episode present it's tv, else use ?type query param
  let mediaType = req.query.type || (season && episode ? "tv" : "movie");
  if (!["movie", "tv"].includes(mediaType)) mediaType = "movie";

  const providerIds = resolveProviders(req.query);

  if (providerIds.length === 0) {
    return res.status(400).json({
      error: "No valid providers found. Check the `providers` query parameter or /providers endpoint.",
      availableProviders: allProviderIds,
    });
  }

  console.log(
    `[API] /streams/${tmdbId}` +
    (season ? `/${season}/${episode}` : "") +
    ` type=${mediaType} providers=[${providerIds.join(",")}]`
  );

  // Fetch all providers + VDRK subtitles in parallel
  const [providerResults, vdrkSubtitles] = await Promise.all([
    Promise.allSettled(
      providerIds.map(id => fetchFromProvider(id, tmdbId, mediaType, season, episode))
    ),
    fetchVdrkSubtitles(tmdbId, mediaType, season, episode),
  ]);

  const streams       = [];
  const providerStats = {};

  // Collect all subtitles from every provider stream into one deduplicated array
  const subtitleSeenUrls = new Set();
  const allSubtitles     = [];

  // First seed with VDRK subtitles
  for (const sub of vdrkSubtitles) {
    if (!subtitleSeenUrls.has(sub.url)) {
      subtitleSeenUrls.add(sub.url);
      allSubtitles.push(sub);
    }
  }

  for (let i = 0; i < providerIds.length; i++) {
    const id     = providerIds[i];
    const result = providerResults[i];

    if (result.status === "fulfilled") {
      const provStreams = result.value || [];

      // Hoist subtitles from each stream into the shared array (dedup by URL)
      for (const s of provStreams) {
        for (const sub of (s.subtitles || [])) {
          if (!subtitleSeenUrls.has(sub.url)) {
            subtitleSeenUrls.add(sub.url);
            allSubtitles.push(sub);
          }
        }
      }

      // Strip per-stream subtitles — they now live at the top level
      const cleanStreams = provStreams.map(({ subtitles, ...rest }) => rest);
      streams.push(...cleanStreams);
      providerStats[id] = { count: provStreams.length, error: null };
    } else {
      providerStats[id] = { count: 0, error: result.reason?.message || "Unknown error" };
    }
  }

  res.json({
    tmdbId,
    mediaType,
    season:    season  || null,
    episode:   episode || null,
    total:     streams.length,
    providers: providerStats,
    subtitles: allSubtitles,
    streams,
  });
});

// ─── 404 fallback ─────────────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🚀  Nuvio Plugins API running at http://localhost:${PORT}`);
  console.log(`📋  Providers loaded: ${allProviderIds.join(", ")}\n`);
});
