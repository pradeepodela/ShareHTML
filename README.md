# ShareHTML

Paste or drop HTML, get a shareable link you control. Turn a page off, replace its
HTML, keep multiple **versions** on one link, or delete it — all from a simple admin UI.
Runs on [Zoho Catalyst](https://catalyst.zoho.com/) AppSail with pages stored in a
Stratus bucket.

## Features

- **Paste or drop** `.html` files and get a public link: `/.../p/<id>`
- **Owner-only manager** behind an admin passcode (`ADMIN_KEY`)
- **Disable / enable** a page without losing its HTML
- **Replace** a page's HTML in place — the link stays the same
- **Versioning** — keep several versions on one page:
  - Toggle **Allow versioning** per page to show a floating switcher on the public link
  - Viewers switch versions in the URL: `/.../p/<id>?v=<vid>`
  - Set any version as **live**, add / edit / delete versions, copy per-version links
- Shared pages are served with a `Content-Security-Policy: sandbox` so they can't
  reach the manager's origin or storage

## Architecture

- **Express** server (`app.js`) serving a static manager UI (`public/`) + a REST API
- **Stratus** object storage: each page is one JSON object `pages/<id>.json`, with a
  lightweight `index.json` for fast listing
- Deployed as a Catalyst **AppSail** service (`catalyst.json`)

## Local / deploy setup

1. `npm install`
2. Copy the config template and set your own values:
   ```bash
   cp app-config.example.json app-config.json
   ```
   - `BUCKET_NAME` — a globally-unique Stratus bucket name
   - `ADMIN_KEY` — the admin passcode for the manager UI
3. Create the Stratus bucket (name must match `BUCKET_NAME`) in the Catalyst console.
4. Deploy:
   ```bash
   catalyst deploy appsail --name htmls
   ```

> `app-config.json` is gitignored because it holds the admin passcode. Keep it local.

## API

| Method | Path | Purpose |
|--------|------|---------|
| `GET`  | `/p/:id` | Public page (serves live version; `?v=<vid>` for a specific one) |
| `GET`  | `/api/status` | Bucket readiness + whether a passcode is required |
| `GET`  | `/api/pages` | List pages (metadata) |
| `GET`  | `/api/pages/:id` | Full page incl. every version's HTML |
| `POST` | `/api/pages` | Create a page |
| `PUT`  | `/api/pages/:id` | Update title / disabled / versioning / live; replace live HTML |
| `POST` | `/api/pages/:id/versions` | Add a version |
| `PUT`  | `/api/pages/:id/versions/:vid` | Edit a version |
| `DELETE` | `/api/pages/:id/versions/:vid` | Delete a version |
| `DELETE` | `/api/pages/:id` | Delete a page |

All `/api/*` management routes require the `x-admin-key` header matching `ADMIN_KEY`.
