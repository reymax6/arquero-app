# Arquero's Mountain Resort — Restaurant & Pickleball App

A full-stack web app for Arquero's Mountain Resort: browse the restaurant menu and place
orders, and book pickleball courts by date and time slot. Orders and bookings are saved
to a real SQLite database, so nothing resets when the page is refreshed, and the same
time slot can't be double-booked by two people at once.

## What's inside

```
arquero-app/
  server/
    index.js      Express API server (also serves the app itself)
    db.js         SQLite connection + table schema
    seed.js       Loads the starting menu items and courts into the database
    backup.js     Safe database snapshots (npm run backup)
  public/
    index.html    The customer app — markup and styles
    app.js        The customer app's behaviour
    admin.html    The staff service board
    admin.js      The service board's behaviour
    safe-html.js  Shared escaping helpers used by both
    money.js      Currency formatting — the one place to change it
    404.html      A branded page for mistyped URLs
    manifest.webmanifest  Lets the app be added to a phone's home screen
    icons/        App icons, generated from icons/icon.svg
    images/       Drop real gallery photos in here (see below)
    fonts/        Fraunces + Inter, served from here rather than a CDN
  tests/          The full check suite (npm test)
  data/
    arquero.db    SQLite database file (created automatically)
  Dockerfile      For any host that takes a container
  render.yaml     One-click deploy to Render
  .env.example    Every setting, explained
  package.json
```

## Adding your own photos

The gallery ships with coloured tiles standing in for photography. To replace
one, drop a photo into `public/images/` with the matching filename:

| Tile | Filename |
|---|---|
| Sunrise Deck | `sunrise-deck.jpg` |
| Court 1 at Dusk | `court-dusk.jpg` |
| Wood-Fired Pizza | `wood-fired.jpg` |
| Ridge Trail View | `ridge-trail.jpg` |
| Doubles Match | `doubles-match.jpg` |
| Terrace Dining | `terrace-dining.jpg` |

Square images of around 900×900 look best. `.jpg`, `.png`, `.webp` and `.avif`
all work. There's nothing to configure — the server tells the app which photos
exist, so a tile you haven't replaced yet keeps its colour rather than showing
a broken image. Add them one at a time if you like.

## Running it locally

You'll need [Node.js](https://nodejs.org) 18 or newer installed.

```bash
cd arquero-app
npm install         # installs Express + better-sqlite3
npm run seed        # creates the database and loads the starting menu/courts (safe to re-run)
npm start           # starts the server
```

Then open **http://localhost:3000** in your browser. One server serves both the app and
its API.

## The staff service board

Open **http://localhost:3000/admin** and log in. This is the screen to keep open during
service — on the pass, at the front desk, or on a phone by the courts.

It shows one day at a time:

- **Kitchen** — every food order, oldest first, with the customer's name, tappable phone
  number, what they ordered and the total. Move an order along with **Start preparing →
  Mark ready → Mark collected**, or cancel it. Finished orders drop to the bottom so
  they're out of the way but still findable when someone comes back to ask.
- **Courts** — the day's bookings in time order. Mark someone **arrived**, flag a
  **no-show**, or **cancel** a booking, which releases that slot so another customer can
  book it.
- **Takings and counts** across the top, and arrows to look at any other day.
- **Print ticket** on any order produces a paper docket for the rail — order
  number and items set large, none of the interface on the page.

It refreshes every 20 seconds on its own, so two staff on two devices see the same board.
It stops polling when the tab isn't visible, and refreshes the moment you come back to it.

**Setting the password.** If you don't set one, the server generates a random password
each time it starts and prints it in the terminal. That's safe but inconvenient, so for
real use set your own:

```bash
ADMIN_PASSWORD='something-long-and-private' npm start
```

You can change the username with `ADMIN_USER`. Treat this password like the key to your
filing cabinet — anyone who has it can read every customer's contact details.

Also set `SESSION_SECRET` in production. Without it the server picks a random one at
startup, which means restarting the server signs staff out of their tablets mid-service.

```bash
ADMIN_PASSWORD='...' SESSION_SECRET='...' npm start
```

### Reading the data directly

The same information is available over the API if you'd rather script something:

```bash
curl -u admin:YOUR_PASSWORD http://localhost:3000/api/orders
curl -u admin:YOUR_PASSWORD http://localhost:3000/api/bookings
```

## How data works

- **Menu items** and **courts** live in the database and are managed from the staff
  board. Apostrophes and ampersands are handled safely — "Chef's Specials" works exactly
  like any other name.
- **Orders** are saved to the `orders` and `order_items` tables. Prices are always taken
  from the database, never from the customer's browser, so a customer can't edit what
  they're charged.
- **Bookings** are saved to the `bookings` table. The database itself enforces that a
  given court/date/time can only be booked once, so if two people tap the same slot at
  the same moment, the second gets a clear "that slot was just taken" message.
- The database is a single file at `data/arquero.db`. Back it up like any file, and don't
  delete it — it holds every order and reservation.

## Running your menu

Log into **/admin** and switch to the **Menu & courts** tab. You can add dishes, change
prices, write descriptions, pick a tile colour and icon, reorder items within a section,
and start new sections just by typing a new category name. Same for courts: add, rename,
and take one out of service when it's being resurfaced.

Nothing is ever deleted. **Remove** hides a dish from customers immediately while leaving
past orders intact, and **Restore** brings it back. Taking a court out of service hides
it from the booking screen but doesn't cancel bookings already made — if there are any,
the app tells you how many so you can ring those customers.

Every change is recorded, with the old and new values, in **Recent changes** at the
bottom of that screen.

The screen refuses `<` and `>` in any menu text. The app escapes everything it renders,
but a dish name doesn't stay in the browser — it goes onto printed kitchen tickets and,
sooner or later, into an SMS or an export. No real dish needs angle brackets, so refusing
them removes the whole problem wherever that text ends up next.

`server/seed.js` only fills an **empty** database now, so it will never overwrite what
you've set. Run `npm run seed -- --force` if you deliberately want the starting menu back.

## Prices and VAT

Prices are in **Philippine pesos** and **VAT-inclusive**: the number on the menu is the
number the customer pays. A ₱450 burger costs ₱450 at checkout, and the receipt breaks
out the ₱48.21 of VAT inside it for your records.

That distinction matters in the code — VAT is *extracted* (gross × 12/112), not added
(gross × 12%). Getting it backwards would overcharge every customer by 12%.

The starting prices are placeholders in a plausible mountain-resort range (₱185–₱620 for
food, ₱1,000 an hour for a court). Replace them from the **Menu & courts** screen.

| What | Where |
|---|---|
| Menu prices | The **Menu & courts** screen at /admin |
| The symbol and number format | `public/money.js` |
| VAT rate and court rate | `COURT_RATE` and `TAX_RATE` at the top of `server/index.js` |
| The starting menu | `server/seed.js` |

Historical orders keep whatever they were charged at the time, so changing a price never
rewrites what a past customer paid.

## The rules the server enforces

These are checked on the server, so they hold even if someone bypasses the app entirely:

| Rule | Setting |
|---|---|
| VAT | 12%, included in listed prices |
| Court rate | ₱1,000 per hour, incl. VAT |
| Dish name / court name | 2–60 / 2–40 characters, no `<` or `>` |
| Dish description | 200 characters |
| Dish price | ₱0 – ₱100,000 |
| Tile colour | A hex value like `#f0e6d2`, nothing else |
| How far ahead a court can be booked | 60 days |
| Bookings in the past | Rejected, including times that have already gone by today |
| Maximum quantity of one dish | 20 |
| Maximum different dishes per order | 40 |
| Name length | 2–80 characters |
| Phone number | 7+ digits, only `0-9 + ( ) - . space` |
| Requests per visitor | 60 orders/bookings per 10 minutes |
| Staff login attempts | 10 per 15 minutes |
| Staff session length | 12 hours |

All of these live at the top of `server/index.js` if you want to change them.

## Backing up

```bash
npm run backup                    # writes to ./backups
npm run backup -- /some/other/dir
```

This uses SQLite's online backup API rather than copying the file, which
matters: the database runs in WAL mode, so at any moment the real state is
split across two files. A plain `cp` during service can produce a backup
that's quietly missing the most recent orders. This is safe to run mid-shift.

The last 14 backups are kept and older ones removed, so it's safe to run daily
from cron:

```
0 3 * * *  cd /path/to/arquero-app && npm run backup
```

## Re-running the checks

One command runs everything:

```bash
npm install                 # devDependencies include Playwright
npx playwright install chromium
npm test
```

It starts its own server on a throwaway database for each check, so it never
touches your real data and you don't need the app running first. Expect about
two minutes.

```
  API attacks          auth, injection, tampering, validation          passed
  Stored XSS + flows   malicious menu content, apostrophes in names    passed
  Timezone             a midnight-in-Manila booking saves right        passed
  Accessibility        WCAG 2.1 AA across every screen and dialog      passed
  Keyboard             the whole app driven with no mouse              passed
  Focus handling       focus lands sensibly when sheets close          passed
  Staff board          login, a full shift, accessibility              passed
  Cart & ticket        cart survives a refresh, printable tickets      passed
  Menu management      running the menu, and what it refuses to accept  passed
```

Individual checks are available too (`npm run test:a11y`, `test:xss`,
`test:admin`, and so on) — these expect the app already running on port 3000.

If you push this to GitHub, `.github/workflows/checks.yml` runs the same suite
on every push, so none of this quietly rots.

## Taking this live (deployment)

Right now this only runs on your own computer. To make it a real website:

1. **Render.com (easiest — it's already configured)** — push this folder to GitHub,
   then in Render choose **New → Blueprint** and point it at the repo. `render.yaml`
   sets up the service, the health check, and a 1 GB persistent disk for the database.
   The only manual step is setting `ADMIN_PASSWORD` in the dashboard; Render generates
   `SESSION_SECRET` itself. Note the blueprint uses the paid Starter plan — the free
   plan has no persistent disk, so the database would reset on every deploy.
2. **A VPS (DigitalOcean, Linode, etc.)** — install Node, copy this folder over, run it
   behind `pm2`, and put it behind a domain with HTTPS (Caddy, or Nginx + Let's Encrypt).
   More setup, more control.
3. **Anywhere that takes a container** — there's a `Dockerfile`. Fly.io, Railway,
   Cloud Run and any VPS with Docker will run it. Mount a volume at `/data`.
4. **Switch to a hosted database** — if you outgrow SQLite, the queries in
   `server/index.js` are simple enough to port to Postgres (Supabase, Neon, Render).

Whichever you pick, `.env.example` lists every setting with an explanation, and
`/api/health` is there for the platform's health checks — it verifies the database
is readable, not just that the process is alive.

Whichever you choose, serve it over **HTTPS**. The admin password is sent with each
request, and without HTTPS it travels in the clear.

## Suggested next features

- Email or SMS confirmation when an order or booking is placed.
- Real payment collection at checkout (PayMongo for the Philippines, or Stripe).
- Per-person staff logins, so the board can show who marked an order collected.
