---
name: Admin auth credentials
description: Why the documented admin password may not work and how to verify login credentials for this project.
---

The admin login on this project is not a hardcoded plaintext password. `server.js` reads the username from `ADMIN_USER` (default `Martin3z`) and verifies the password with `bcrypt.compare()` against a hash stored in the `ADMIN_PASS_HASH` secret.

**Why:** An earlier version of `replit.md` documented a specific hardcoded username/password pair. That pair no longer authenticates — the app was migrated to env-based bcrypt auth at some point without updating the docs. Trying the old documented credentials during e2e testing produces a genuine "Invalid credentials" 401, not a bug in new code.

**How to apply:** Before writing an e2e test or debugging a "login fails" report, check whether `ADMIN_PASS_HASH`/`ADMIN_USER` env vars are set and confirm actual credentials with the user rather than trusting docs or memory. If you can't obtain valid credentials, verify admin-only features by other means (e.g., seeding data files directly, or testing the public/unauthenticated view) rather than blocking on UI login.

For automated e2e testing or curl-based verification of admin-only flows (uploads, adding Development videos, deletes, etc.), don't rely on the documented login form credentials. Instead, sign a valid JWT locally using the same `JWT_SECRET` the server uses (e.g. `jwt.sign({ username: '<admin-username>', role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '24h' })` via a one-off `node -e` script with `dotenv` loaded), then either call protected API routes directly with `Authorization: Bearer <token>`, or in a Playwright test set `localStorage.setItem('adminToken', token)` and `localStorage.setItem('ownerMode', 'true')` before reloading the page to simulate a logged-in admin session. Do not spend time guessing password variations, and never write real or attempted credential values into memory files — this approach reliably unblocks testing without touching the real credential.
