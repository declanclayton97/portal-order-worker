# Playwright's official image ships Chromium + all system deps preinstalled — the
# painless way to run a headless browser on Render (no apt juggling). This tag MUST
# match the exact `playwright` version in package.json or the browser binary won't be
# found (they ship together).
FROM mcr.microsoft.com/playwright:v1.62.1-jammy

WORKDIR /app

# Install deps first (better layer caching)
COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
# Render provides PORT; default for local runs
ENV PORT=3000
EXPOSE 3000

CMD ["node", "index.js"]
