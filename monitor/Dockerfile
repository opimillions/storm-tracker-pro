# StormCheck Pro monitor (Billy Bob). Node + headless Chromium for the customer workflow test.
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npx playwright install --with-deps chromium && rm -rf /var/lib/apt/lists/*
COPY src ./src
ENV NODE_ENV=production DATA_DIR=/data
CMD ["node", "src/index.js"]
