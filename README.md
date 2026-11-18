# AU Astro Lookup Dashboard

Private dashboard for AI Astro Talk that shows:

1. **Astrologer × Platform** — chats and calls per astrologer per platform (from Yukti)
2. **Average Call Duration** — web / app / overall (from Yukti)
3. **Entry-Point Funnel** — per entry point, logged-in and non-logged-in cohorts (from Pinot CDP)

Data is pulled daily by a GitHub Actions workflow. The dashboard is a static HTML page served from GitHub Pages, gated by a client-side password.

---

## One-time setup

### 1. Create the GitHub repo

```bash
cd /path/to/this/folder
git init
git add .
git commit -m "init: au astro lookup dashboard"
gh repo create 770navyasharma/au-astro-lookup --private --source=. --push
```

(Or create via the GitHub UI and push manually.)

### 2. Set GitHub Secrets

Settings → Secrets and variables → Actions → New repository secret. Add:

| Name | Value |
|---|---|
| `PINOT_URL` | `http://46.62.191.123:9000/sql` |
| `PINOT_USER` | `analyst` |
| `PINOT_PASSWORD` | *(your Pinot password)* |
| `YUKTI_BASE_URL` | `https://yukti-ui.amarujala.com` |
| `YUKTI_USERNAME` | *(your Yukti login)* |
| `YUKTI_PASSWORD` | *(your Yukti password)* |

### 3. Enable GitHub Pages

Settings → Pages → Source: `Deploy from a branch` → Branch: `main`, Folder: `/docs` → Save.

Your dashboard lives at `https://770navyasharma.github.io/au-astro-lookup/`.

### 4. Set the dashboard password

Open `docs/gen-pw-hash.html` in your browser, type your password, copy the generated SHA-256 hash, and paste it into `docs/app.js` at the top:

```js
const PW_HASH = "paste-your-hash-here";
```

Commit and push.

### 5. Verify Yukti scraper (needed once)

The Yukti login endpoint, conversations endpoint, and field names are **marked `TODO verify` in `scripts/pull_yukti.py`**. These need confirming from one live probe:

1. Open `https://yukti-ui.amarujala.com/dashboard/conversations` in Chrome and log in.
2. Open DevTools → Console, paste the contents of `yukti_probe.js` from the main project, press Enter.
3. Apply a 1-day date filter, scroll the list, click Export (cancel the download).
4. Run `yuktiProbe()` in the console. It downloads a JSON of all API calls.
5. Open that JSON and update the four constants in `scripts/pull_yukti.py`:
   - `LOGIN_PATH` — the POST login endpoint (something like `/api/auth/login`)
   - `CONVERSATIONS_PATH` — the GET endpoint for the conversations list
   - `PLATFORM_FIELD`, `ASTROLOGER_FIELD`, `DURATION_FIELD`, `TYPE_FIELD` — the exact field names in one conversation object

Push the updated file. Yukti data will start appearing from the next daily run.

Until this is done, the Pinot side (Module 3 funnel) works fully; Modules 1 and 2 will show "No Yukti data loaded."

### 6. Backfill historical data

Go to Actions → Daily Snapshot → Run workflow. Enter a backfill range like `2026-10-01` → `2026-11-18`. This runs one snapshot per day in the range (~45 queries per day).

For a more compact local backfill:

```bash
export PINOT_PASSWORD='...'
export YUKTI_USERNAME='...'
export YUKTI_PASSWORD='...'
python scripts/daily_snapshot.py --range 2026-11-01 2026-11-17
```

Then `git add data/ && git commit -m "data: backfill" && git push`.

### 7. Verify the daily schedule

The workflow runs at **02:00 IST** every day (20:30 UTC previous day). Check Actions tab a few mornings to confirm commits are landing.

---

## Project layout

```
.
├── .github/workflows/
│   └── daily-snapshot.yml           # runs daily, commits data/
├── scripts/
│   ├── pinot_client.py              # Pinot REST wrapper w/ auth + retry
│   ├── pinot_queries.py             # all 14 queries as templates
│   ├── pull_yukti.py                # Yukti scraper (TODO markers)
│   └── daily_snapshot.py            # entrypoint — runs everything, writes JSON
├── data/
│   ├── index.json                   # list of available dates
│   └── YYYY-MM-DD.json              # one per day
├── docs/                             # GitHub Pages root
│   ├── index.html
│   ├── style.css
│   ├── app.js
│   └── gen-pw-hash.html             # local-only password hash tool
├── requirements.txt
└── README.md
```

---

## How the aggregation works

Each `data/YYYY-MM-DD.json` holds results for one IST day. The dashboard loads daily JSONs for the selected range and sums metric values across days.

**Caveat**: Pinot's `DISTINCTCOUNTHLL` is a per-day unique count. Summing across days double-counts users who returned on multiple days. This is fine for trend / funnel-shape analysis; for truly unique user counts over long ranges, add a dedicated multi-day query in a future phase.

---

## Updating queries

All 14 queries live in `scripts/pinot_queries.py` as templates. To add a new entry point (e.g. a web entry):

1. Add a new entry to the `ENTRY_POINTS` dict with its entry event + downstream filter.
2. The `q_identification`, `q_cohort_li`, `q_cohort_nli` helpers pick it up automatically.
3. Register a new checkbox in `docs/index.html` and an entry in `ENTRY_POINTS` in `app.js`.
4. Push.

---

## Troubleshooting

**Workflow fails with "PINOT_PASSWORD env var is not set"**
Secrets are set at the repo level but missing in the workflow env. Open `.github/workflows/daily-snapshot.yml` and confirm all `secrets.X` references match the secret names.

**Dashboard says "Could not load data/index.json"**
Either Pages isn't serving yet, or no snapshot has run. Verify `/data/` exists in the branch Pages is deploying from.

**Dashboard login fails**
Open DevTools, re-check `PW_HASH` matches what `gen-pw-hash.html` produced for your password. Hash must be 64 hex chars.

**Yukti rows empty but Pinot works**
Yukti scraper's `TODO verify` constants need updating (see step 5 above).

**Pinot query timeout**
Edit `pinot_client.py` and raise `timeout_ms`, or narrow the date in the query. Multi-stage engine (used by cohort queries) is heavier than single-stage.

---

## Contact

Owned by Navya. Pinot cluster is shared — don't run heavy ad-hoc queries without checking `references/pinot-best-practices.md` in the main project.
