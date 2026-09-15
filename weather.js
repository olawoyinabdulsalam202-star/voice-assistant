// ════════════════════════════════════════
//  weather.js  —  KAIROS WEATHER MODULE
//  v1  —  No API key required
//  Uses: Open-Meteo (weather) +
//        Nominatim (geocoding)
// ════════════════════════════════════════

// ── WMO WEATHER CODE → DESCRIPTION ──
const WMO_CODES = {
  0:  'clear skies',
  1:  'mainly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'foggy', 48: 'icy fog',
  51: 'light drizzle', 53: 'moderate drizzle', 55: 'heavy drizzle',
  61: 'light rain', 63: 'moderate rain', 65: 'heavy rain',
  71: 'light snow', 73: 'moderate snow', 75: 'heavy snow',
  77: 'snow grains',
  80: 'light showers', 81: 'moderate showers', 82: 'violent showers',
  85: 'light snow showers', 86: 'heavy snow showers',
  95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'severe thunderstorm',
};

// ── WEATHER TRIGGER PHRASES ──
const WEATHER_PATTERNS = [
  /what(?:'s| is) the weather(?: like)?(?: in | for | at )?(.+)?/i,
  /how(?:'s| is) the weather(?: in | for | at )?(.+)?/i,
  /weather(?: in| for| at| today| now| forecast)?(?: in| for| at)?\s*(.+)?/i,
  /(?:is it|will it) (?:rain|snow|hot|cold|sunny|cloudy)(?: in| today| tomorrow)?(.+)?/i,
  /(?:temperature|temp)(?: in| at| for)?\s*(.+)?/i,
  /(?:what should i wear|do i need an umbrella)(?: in| today)?(.+)?/i,
  /(?:current conditions?|forecast)(?: in| for| at)?\s*(.+)?/i,
];

// ── CITY EXTRACTION ──
// Pulls the location name from a weather query
function extractLocation(text) {
  const lower = text.toLowerCase();

  // Try each pattern and extract capture group
  for (const pattern of WEATHER_PATTERNS) {
    const match = text.match(pattern);
    if (match && match[1]) {
      let loc = match[1]
        .replace(/[?.!,]/g, '')
        .replace(/\b(today|now|tomorrow|this week|forecast|please|right now|currently)\b/gi, '')
        .trim();
      if (loc.length > 1) return loc;
    }
  }

  // Fallback: strip common words and return what's left after "in/at/for"
  const prep = lower.match(/(?:in|at|for)\s+([a-z\s,]+?)(?:\s*[?.!]|$)/);
  if (prep && prep[1]) return prep[1].trim();

  return null; // caller will use geolocation instead
}

// ── IS WEATHER REQUEST? ──
window.isWeatherRequest = function(text) {
  return WEATHER_PATTERNS.some(p => p.test(text));
};

// ── GEOCODE CITY → LAT/LON ──
async function geocodeCity(cityName) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(cityName)}&format=json&limit=1`;
  const res = await fetch(url, {
    headers: { 'Accept-Language': 'en', 'User-Agent': 'KairosVoiceAssistant/1.0' }
  });
  const data = await res.json();
  if (!data || data.length === 0) return null;
  return {
    lat: parseFloat(data[0].lat),
    lon: parseFloat(data[0].lon),
    name: data[0].display_name.split(',').slice(0, 2).join(',').trim(),
  };
}

// ── GET DEVICE LOCATION ──
function getDeviceLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Geolocation unavailable'));
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, name: 'your location' }),
      err => reject(err),
      { timeout: 6000 }
    );
  });
}

// ── REVERSE GEOCODE → CITY NAME ──
async function reverseGeocode(lat, lon) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`;
    const res = await fetch(url, {
      headers: { 'Accept-Language': 'en', 'User-Agent': 'KairosVoiceAssistant/1.0' }
    });
    const data = await res.json();
    const city = data.address?.city || data.address?.town || data.address?.village || data.address?.county || 'your area';
    return city;
  } catch (e) {
    return 'your location';
  }
}

// ── FETCH WEATHER FROM OPEN-METEO ──
async function fetchWeatherData(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,apparent_temperature,relative_humidity_2m,windspeed_10m,weathercode,is_day` +
    `&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
    `&timezone=auto&forecast_days=3`;

  const res = await fetch(url);
  if (!res.ok) throw new Error('Weather fetch failed');
  return res.json();
}

// ── FORMAT WEATHER REPLY ──
function formatWeatherReply(data, locationName) {
  const c = data.current;
  const d = data.daily;

  const temp     = Math.round(c.temperature_2m);
  const feels    = Math.round(c.apparent_temperature);
  const humidity = c.relative_humidity_2m;
  const wind     = Math.round(c.windspeed_10m);
  const code     = c.weathercode;
  const isDay    = c.is_day;

  const condition = WMO_CODES[code] || 'unknown conditions';

  // Tomorrow forecast
  const tomorrowCode = d.weathercode?.[1];
  const tomorrowHigh = d.temperature_2m_max?.[1] != null ? Math.round(d.temperature_2m_max[1]) : null;
  const tomorrowLow  = d.temperature_2m_min?.[1] != null ? Math.round(d.temperature_2m_min[1]) : null;
  const tomorrowRain = d.precipitation_probability_max?.[1];
  const tomorrowCond = tomorrowCode != null ? (WMO_CODES[tomorrowCode] || 'variable conditions') : null;

  // Clothing / advisory hint
  let advisory = '';
  if (temp <= 10)       advisory = ' You may want a coat.';
  else if (temp <= 18)  advisory = ' A light jacket would be wise.';
  if (code >= 61 && code <= 67)  advisory += ' Bring an umbrella.';
  if (code >= 95)                advisory += ' Stay indoors if possible.';
  if (wind > 40)                 advisory += ' Strong winds are expected.';

  let reply = `Currently in ${locationName}, it's ${temp}°C with ${condition}. ` +
              `Feels like ${feels}°C, humidity at ${humidity}%, wind ${wind} km/h.${advisory}`;

  if (tomorrowCond && tomorrowHigh !== null) {
    reply += ` Tomorrow: ${tomorrowCond}, high of ${tomorrowHigh}°C and low of ${tomorrowLow}°C`;
    if (tomorrowRain != null) reply += `, ${tomorrowRain}% chance of rain`;
    reply += '.';
  }

  return reply;
}

// ════════════════════════════════════════
//  MAIN EXPORT — getWeatherReply(query)
//  Call this from processCommand() in
//  script.js when isWeatherRequest() is true
// ════════════════════════════════════════
window.getWeatherReply = async function(query) {
  try {
    const cityName = extractLocation(query);
    let coords;

    if (cityName) {
      // Named city — geocode it
      coords = await geocodeCity(cityName);
      if (!coords) return `I couldn't find weather data for "${cityName}". Please check the city name and try again.`;
    } else {
      // No city mentioned — use device GPS
      try {
        const geo = await getDeviceLocation();
        const name = await reverseGeocode(geo.lat, geo.lon);
        coords = { lat: geo.lat, lon: geo.lon, name };
      } catch (e) {
        return "I need either a city name or location permission to fetch the weather. Try saying: 'weather in Lagos'.";
      }
    }

    const data = await fetchWeatherData(coords.lat, coords.lon);
    return formatWeatherReply(data, coords.name);

  } catch (err) {
    console.error('weather.js error:', err);
    return "I'm having trouble fetching weather data right now. Please check your connection and try again.";
  }
};