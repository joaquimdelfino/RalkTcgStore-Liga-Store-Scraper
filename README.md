# Liga Scraper

Web app for finding which stores sell a LigaPokemon product: paste the product link, get the list of stores that sell it with each store's phone number, and export everything as CSV or TXT.

## What the site does

- **Product lookup**: paste a LigaPokemon product link (e.g. `https://www.ligapokemon.com.br/?view=prod/view&pcode=135107`) and get every store currently selling it.
- **Phone for each store**: the number is taken from the store's WhatsApp link and normalized, so it always comes out in the correct format.
- **Real-time progress**: the search runs live and shows how many stores have been processed. A search with ~90 stores takes about 2 minutes.
- **Easy export**: download the list as CSV or TXT, or copy it straight to the clipboard.
- **CSV ready for Excel**: semicolon-separated with UTF-8 BOM, it opens directly in Excel without breaking accents.
- **TXT ready to paste**: one store per line, in the format `Name - Phone`.
- **Stays out of the way**: Chrome runs in the background, without stealing focus, and its window is minimized automatically.
- **Gentle on the site**: requests are made one at a time with a pause between them, and failed stores are retried automatically (up to 3 times).
- **Own browser profile**: the app uses its own Chrome profile (never your personal one) and keeps the session saved, so the next searches are faster.

## How to use

1. Start the app and open <http://localhost:3777>.
2. Paste the product link into the field.
3. Click "Search" and follow the progress on screen.
4. When it finishes, download the CSV or TXT, or copy the list.

## How it works

- **No pagination to deal with**: all the offers already come in the product page, so one page load returns the full list of stores.
- **Phones come from a separate request**: the store's contact data is fetched one store at a time, from inside the page, reusing the browser session.
- **Real Chrome required**: the site is protected by a Cloudflare challenge that only lets a normal, visible (headed) Chrome through. The app starts the system Chrome as a regular process and connects to it, then minimizes the window.
- **First search can be slower**: with a new profile, the challenge may take a while to clear. After that, the session is saved and everything is immediate.

## Technology

- Node.js 20+ with TypeScript, run directly with tsx (no build step)
- Express 5
- Playwright (`playwright-core`), connected to the system Chrome through CDP
- Live progress with Server-Sent Events
- Plain HTML, CSS and JS front end

## Development

```sh
npm i
npm run dev
```

`npm run dev` restarts the server on every file change; for normal use, `npm start`. Google Chrome must be installed on the computer, since the app uses the system browser to run the searches. The port can be changed with the `PORT` environment variable (default: 3777), and a Chrome in a non-standard location can be set with `CHROME_PATH`.

Project structure:

- `src/chrome.ts`: starts and reuses the Chrome process (CDP)
- `src/scraper.ts`: extracts stores and phones from a product page
- `src/server.ts`: Express server; the search is streamed to the front end via SSE
- `public/index.html`: the whole interface (HTML + CSS + JS)

## Checks

```sh
npm run typecheck
npm run smoke
```

## Good to know

- **Do not lower the delay between requests**: it is set to 1 second in `src/scraper.ts` and it is what keeps Cloudflare quiet. Faster or parallel requests make the site start returning challenge pages instead of data.
- **Some stores have no phone**: a few stores only register an e-mail on the site, so no number can be found for them.
- **Use with common sense**: the site's `robots.txt` asks for a long delay between requests, so this tool is meant for one-off lookups, not for continuously scanning the catalog.

## If it stops working

The tool relies on internal details of the site, so it may break if the site changes. Most likely causes:

1. **Empty store list**: the page objects that hold the stores were renamed. Check in the browser console what replaced them.
2. **Phones all empty**: the store data endpoint changed. Inspect the site's store request in the browser to find the new address.
3. **Stuck waiting for release**: Cloudflare got stricter. Delete the `.chrome-profile/` folder and try again.
