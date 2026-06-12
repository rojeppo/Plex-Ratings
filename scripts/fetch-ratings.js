const fs = require('fs');

const PLEX_URL   = process.env.PLEX_URL;
const PLEX_TOKEN = process.env.PLEX_TOKEN;
const TMDB_API_KEY = process.env.TMDB_API_KEY;

if (!PLEX_URL || !PLEX_TOKEN) {
  console.error('Missing PLEX_URL or PLEX_TOKEN environment variables.');
  process.exit(1);
}

// ── Config ───────────────────────────────────────────────────────────────────
const config = {
  ownerName:          process.env.OWNER_NAME           || 'My',
  showsTabLabel:      process.env.SHOWS_TAB_LABEL      || 'TV Shows',
  showsSectionLabel:  process.env.SHOWS_SECTION_LABEL  || 'TV Shows',
  moviesTabLabel:     process.env.MOVIES_TAB_LABEL     || 'Movies',
  moviesSectionLabel: process.env.MOVIES_SECTION_LABEL || 'Cinema',
  defaultTheme:       process.env.DEFAULT_THEME        || 'system',
};
fs.writeFileSync('config.json', JSON.stringify(config, null, 2));
console.log('config.json written:', config);

// ── Plex helpers ─────────────────────────────────────────────────────────────
async function plexGet(p) {
  const sep = p.includes('?') ? '&' : '?';
  const url = `${PLEX_URL}${p}${sep}X-Plex-Token=${PLEX_TOKEN}&X-Plex-Container-Start=0&X-Plex-Container-Size=5000`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Plex returned HTTP ${res.status} for ${p}`);
  return res.json();
}

async function downloadPoster(thumb, ratingKey) {
  if (!thumb) return null;
  const sep = thumb.includes('?') ? '&' : '?';
  const innerUrl = encodeURIComponent(`${PLEX_URL}${thumb}?X-Plex-Token=${PLEX_TOKEN}`);
  const url = `${PLEX_URL}/photo/:/transcode?url=${innerUrl}&width=600&height=900&minSize=1&upscale=1&X-Plex-Token=${PLEX_TOKEN}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buffer = await res.arrayBuffer();
    fs.mkdirSync('posters', { recursive: true });
    const filename = `posters/${ratingKey}.jpg`;
    fs.writeFileSync(filename, Buffer.from(buffer));
    return filename;
  } catch (e) {
    console.warn(`Failed to download poster for ${ratingKey}:`, e.message);
    return null;
  }
}

// Extract IMDb ID from either the new Guid array or legacy guid string
function extractImdbId(item) {
  if (Array.isArray(item.Guid)) {
    const g = item.Guid.find(g => g.id?.startsWith('imdb://'));
    if (g) return g.id.replace('imdb://', '');
  }
  if (item.guid) {
    const m = item.guid.match(/imdb:\/\/(tt\d+)/);
    if (m) return m[1];
  }
  return null;
}

// Extract TMDB ID from Plex's Guid array
function extractTmdbId(item) {
  if (Array.isArray(item.Guid)) {
    const g = item.Guid.find(g => g.id?.startsWith('tmdb://'));
    if (g) return g.id.replace('tmdb://', '');
  }
  return null;
}

// Normalize a provider name to a canonical key for deduplication.
// Strips all known suffixes, ad tiers, channel variants, and normalises + → plus.
function normalizeProviderName(name) {
  return name
    .toLowerCase()
    .replace(/\+/g, 'plus')                    // "Paramount+" → "paramountplus"
    .replace(/\s*\([^)]*\)/g, '')              // remove anything in parentheses
    .replace(/\bstandard\b/gi, '')             // "Netflix Standard with Ads"
    .replace(/\b(?:free\s+with\s+ads|with\s+ads)\b/gi, '')
    .replace(/\bno\s+ads\b/gi, '')
    .replace(/\bad[-\s]?free\b/gi, '')
    .replace(/\bbasic\b/gi, '')
    .replace(/\bessentials?\b/gi, '')
    .replace(/\bpremium\b/gi, '')
    .replace(/\bamazon\s+channel\b/gi, '')
    .replace(/\bamazon\b/gi, '')
    .replace(/\bapple\s+tv\s+channel\b/gi, '')
    .replace(/\bapple\s+tv\b/gi, '')
    .replace(/\broku\s+premium\s+channel\b/gi, '')
    .replace(/\broku\b/gi, '')
    .replace(/\bfubo\s+channel\b/gi, '')
    .replace(/\bchannel\b/gi, '')
    .replace(/\s+/g, '')                        // collapse all remaining whitespace
    .trim();
}

async function getWatchProviders(tmdbId, imdbId, type, title) {
  if (!TMDB_API_KEY) {
    console.log(`[${title}] ⚠️ TMDB_API_KEY is missing from environment!`);
    return null;
  }
  if (!tmdbId && !imdbId) return null;

  try {
    const tmdbType = type === 'movie' ? 'movie' : 'tv';
    let finalTmdbId = tmdbId;

    // Fall back to looking up by IMDb ID if we have no TMDB ID
    if (!finalTmdbId && imdbId) {
      const findRes = await fetch(`https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`);
      if (findRes.ok) {
        const findData = await findRes.json();
        const results = tmdbType === 'movie' ? findData.movie_results : findData.tv_results;
        if (results?.length > 0) finalTmdbId = results[0].id;
      }
    }

    if (!finalTmdbId) return null;

    const provRes = await fetch(`https://api.themoviedb.org/3/${tmdbType}/${finalTmdbId}/watch/providers?api_key=${TMDB_API_KEY}`);
    if (!provRes.ok) return null;

    const provData = await provRes.json();
    const usData   = provData.results?.US;
    if (!usData) return null;

    // Combine flatrate, free, and ad-supported streams
        const streams = [
      ...(usData.flatrate || []),
      ...(usData.free     || []),
      ...(usData.ads      || []),
    ];

    // Group by normalized key, keeping the shortest original name per group.
    // Shortest wins because "Netflix" (7) beats "Netflix Standard with Ads" (26),
    // "Plex" (4) beats "Plex Channel" (12), etc.
    const seen = new Map();
    for (const s of streams) {
      const key = normalizeProviderName(s.provider_name);
      if (!seen.has(key)) {
        seen.set(key, { name: s.provider_name, logo: s.logo_path });
      } else if (s.provider_name.length < seen.get(key).name.length) {
        seen.set(key, { name: s.provider_name, logo: s.logo_path });
      }
    }

    const uniqueProviders = Array.from(seen.values()).map(p => ({
      name: p.name,
      logo: `https://image.tmdb.org/t/p/original${p.logo}`,
    }));

    return uniqueProviders.length > 0
      ? { link: usData.link, providers: uniqueProviders }
      : null;

  } catch (e) {
    console.log(`[${title}] ⚠️ Failed to fetch TMDB providers: ${e.message}`);
    return null;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Connecting to Plex...');
  const libData  = await plexGet('/library/sections');
  const sections = libData.MediaContainer?.Directory || [];
  console.log(`Found ${sections.length} library sections.`);

  const shows  = [];
  const movies = [];

  for (const sec of sections) {
    if (sec.type !== 'show' && sec.type !== 'movie') continue;

    console.log(`Scanning section: ${sec.title} (${sec.type})`);

    // Fetch with Guid data included
    const data  = await plexGet(`/library/sections/${sec.key}/all?includeGuids=1`);
    const items = data.MediaContainer?.Metadata || [];
    const rated = items.filter(i => i.userRating != null && i.userRating !== '');
    console.log(`  ${rated.length} rated items found.`);

    for (const item of rated) {
      // Fetch detailed metadata for this specific item to bypass Plex's 2-genre summary limit
      let detailedItem = item;
      try {
        const detailData = await plexGet(`/library/metadata/${item.ratingKey}`);
        if (detailData.MediaContainer && detailData.MediaContainer.Metadata) {
          detailedItem = detailData.MediaContainer.Metadata[0];
        }
      } catch (e) {
        console.warn(`Could not fetch details for ${item.ratingKey}, using basic data.`);
      }

      const poster = await downloadPoster(detailedItem.thumb || item.thumb, item.ratingKey);
      
      // Grab all genres and cap at 5
      const allGenres = (detailedItem.Genre || []).map(g => g.tag);
      const imdbId = extractImdbId(detailedItem) || extractImdbId(item);

      // Grab TMDB ID and fetch Where to Watch data
      const tmdbId = extractTmdbId(detailedItem) || extractTmdbId(item);
      const watchData = await getWatchProviders(tmdbId, imdbId, item.type, detailedItem.title || item.title);

      const entry  = {
        ratingKey:  item.ratingKey,
        title:      detailedItem.title              || 'Untitled',
        year:       detailedItem.year               || null,
        summary:    detailedItem.summary            || '',
        userRating: parseFloat(item.userRating),
        studio:     detailedItem.studio             || null,
        contentRating: detailedItem.contentRating   || null,
        duration:   detailedItem.duration           || null,
        genres:     allGenres.slice(0, 5),
        imdbId:     extractImdbId(detailedItem),
        type:       item.type,
        poster,
        whereToWatch: watchData
      };
      if (sec.type === 'show')  shows.push(entry);
      else                      movies.push(entry);
    }
  }

  const output = { shows, movies, updatedAt: new Date().toISOString() };
  fs.writeFileSync('data.json', JSON.stringify(output, null, 2));
  console.log(`Done. ${shows.length} shows, ${movies.length} movies written.`);
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
