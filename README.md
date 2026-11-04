# Tides

A small, client-only tide PWA for phones. No backend, no API keys.

- **Tide curve + high/low times** for today and the next 7 days, with a "now" marker and drag-to-read heights
- **Worldwide**: official **NOAA** station predictions when you're within 30 km of a US station; everywhere else the **Open-Meteo marine model** (`sea_level_height_msl`). If you're inland it searches up to 45 km for the nearest sea cell
- **GPS** location, place search, saved favourites (☆)
- **Sun & moon**: night shading on the chart, sunrise/sunset, moon phase (hemisphere-correct) and spring/neap hint
- **Wind & swell**: wind speed/gust/direction and swell height/period/direction, with a 3-hourly strip
- Units: m/ft, kn/km/h/mph. Works offline with the last loaded data

Not for navigation. Model heights are relative to mean sea level and are approximate in harbours/estuaries; NOAA heights are above MLLW.

## Run locally
```
python3 -m http.server 8000
```
Open http://localhost:8000 (geolocation needs https or localhost).

## Host on GitHub Pages
```
git init && git add . && git commit -m "Tides v0.1"
git branch -M main
git remote add origin https://github.com/DGenergy/Tides.git
git push -u origin main
```
Then in the repo: **Settings → Pages → Deploy from branch → main / root**. App URL: `https://dgenergy.github.io/Tides/`.
On the phone open it in Chrome → ⋮ → **Add to Home screen**.

## Data sources
- NOAA CO-OPS: `api.tidesandcurrents.noaa.gov` (station list cached 30 days)
- Open-Meteo: marine, forecast and geocoding APIs
- BigDataCloud client reverse-geocode (names your GPS spot)
