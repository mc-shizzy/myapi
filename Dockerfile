FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY proxy-server.js ./
COPY lib ./lib

ENV NODE_ENV=production

CMD ["node", "proxy-server.js"]
