# Alex Martínez – Artist Portfolio (Full-stack SPA)

This is the full-stack artist portfolio site for **Alex Martínez**, built as a Single Page Application (SPA) with an Express.js backend.

## 🚀 Features
- **SPA Frontend**: Home, About, Portfolio, Login
- **Authentication**: Login with `Martin3z` / `May2nd1989`
- **Portfolio Management**: Upload, edit captions, delete works
- **About Portrait**: Upload & persist artist portrait
- **Subscribers**: Visitors can subscribe with name/email
- **Email Notifications**: Subscribers notified automatically on new uploads (via Nodemailer + SMTP)

## 🛠 Tech Stack
- Node.js + Express.js
- Replit DB (storage)
- Nodemailer (email)
- PicoCSS (styling)

## ⚙️ Setup
1. Ensure files are present:
   - `package.json`
   - `replit.nix`
   - `.replit`
   - `index.html`
   - `server.js`

2. Press **Run** in Replit. It will execute `node server.js`.

3. Install dependencies (handled automatically by Replit):
   ```bash
   npm install