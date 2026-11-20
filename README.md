# Spider-Man Across New York

An interactive map of every Spider-Man film from 2002 to 2026. Each stop marks where a film's main fight takes place, and Spider-Man leaves a trail of webs from one stop to the next. At each stop, a clip of the fight pops up next to the pin.

**Live site:** https://lukekav48-jpg.github.io/spider-man-timeline/

## Files

- `index.html`: the page, with the map, the About section, and sources.
- `stops.json`: the map data: one entry per film, with its location, text, and fight clip. Edit this file to change the stops.
- `app.js`: the map, the web trail animation, and the clip pop-up, built with [Leaflet](https://leafletjs.com/).
- `styles.css`: the page design.

The earlier TimelineJS version of this project is saved in the git history.

Published with GitHub Pages from the `main` branch. To preview it locally, run `python3 -m http.server` in this folder and open http://localhost:8000.
