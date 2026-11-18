# Microsoft's official Playwright image already has Chromium and all the
# system libraries it needs, which is the fiddly part on Railway.
FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
