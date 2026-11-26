# Second-Hand Expert (Gemini) — v1

An application that uses Gemini to analyze listing information and photos for second-hand products/vehicles, producing a defect/fraud-risk analysis, comparable market research, and evidence questions to ask the seller.

**Architecture:** Node.js/Express backend (Gemini proxy) + static frontend. The API key is kept only on the server and is never sent to the browser. The key can be read from a `.env` file, or entered through the **Gemini API Key** card in the UI and stored persistently.

> ⚠️ **Security note:** Earlier versions of `.env.example` contained a **real Gemini API key**. If that file was ever shared or committed, consider the key compromised. Revoke and regenerate it at [aistudio.google.com/apikey](https://aistudio.google.com/apikey), and store the new key only in `.env`. `.env.example` now contains placeholders only.

---

## Quick Start

```bash
npm install
cp .env.example .env      # Windows: copy .env.example .env
npm start                 # http://localhost:3000
```

You can provide the API key in two ways:

1. **UI (recommended):** Open the app, paste your key into the **🔑 Gemini API Key** card, and click **Save**. The key is stored persistently in `data/api-key.json`; no server restart is needed.
2. **`.env`:** Set the `GEMINI_API_KEY` value in `.env`.

A key saved via the UI takes priority over the `.env` value. If the saved key is deleted, the `.env` key (if present) is used automatically. In Docker, the `data` directory is persisted via a named volume.

Development (restarts on file changes):

```bash
npm run dev
```

Verification:

```bash
npm test      # 76 tests (unit + API integration, mocked Gemini)
npm run lint
npm run check # lint + test
```

Docker:

```bash
docker compose up -d --build
```

`docker-compose.yml` keeps `read_only: true`; the `eksper-data` volume is mounted at `/app/data` for the key store, so the key survives container recreation.

---

## Project Structure

```
ikinci-el-eksper/
├── backend/
│   ├── server.js              # HTTP server, graceful shutdown, signals
│   ├── app.js                 # createApp(): middleware chain (testable)
│   ├── config.js              # .env schema validation (zod) — fail-fast
│   ├── routes/                # analyze / settings / system routes
│   ├── controllers/
│   ├── services/               # apiKeyStore, geminiService, jobManager,
│   │                            # listingFetcher, promptBuilder
│   ├── middleware/             # rate limiting, error handling, request-id
│   └── utils/                  # validation, reportSchema, redact, logger
├── frontend/
│   ├── index.html
│   ├── css/style.css
│   ├── js/app.js
│   ├── manifest.webmanifest    # PWA
│   └── sw.js                   # shell-only cache (API responses never cached)
├── test/                       # node:test (no extra dependencies)
├── data/                       # created at runtime: api-key.json (excluded from git/Docker/zip)
├── Dockerfile / docker-compose.yml
└── .github/workflows/ci.yml
```

---

## API

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/analyze` | Starts an analysis. `x-client-id` required. |
| `POST` | `/api/listing/preview` | Scrapes a listing URL; returns title, description, price, and photos. |
| `GET` | `/api/analyze/:jobId` | Status/result (polling fallback). Requires `token`. |
| `GET` | `/api/analyze/:jobId/stream` | SSE stream. Requires `?token=`. |
| `POST` | `/api/analyze/:jobId/followup` | Asks a follow-up question on a completed report. Requires `x-job-token`. |
| `GET/PUT/DELETE` | `/api/settings/api-key` | Manage the persisted API key. |
| `POST` | `/api/settings/api-key/test` | Tests a (possibly unsaved) key. |
| `GET` | `/api/health` / `/api/ready` | Health/readiness checks. |

---

## ⚠️ Disclaimer

This project was created for **educational purposes only**, to demonstrate concepts such as building a Gemini-backed proxy API, secure key handling, SSRF-hardened server-side fetching, prompt engineering, and defensive backend design. It is **not** intended as a certified or professional second-hand goods evaluation tool, and its analyses should not be the sole basis for financial decisions. Use it at your own risk, and always verify important purchases independently.
