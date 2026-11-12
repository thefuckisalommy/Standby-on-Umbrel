# Standby — single-container Node 24 app
FROM node:24-alpine

WORKDIR /app

COPY package.json ./
# Zero runtime dependencies — no `npm install` step needed.
COPY server.js ./
COPY lib ./lib
COPY public ./public
# The check-in receiver shares this image (same build, no second
# image): docker-compose runs it as a second service with a different
# command — `node checkin-receiver/server.js` — on LAN port 3101.
COPY checkin-receiver ./checkin-receiver

RUN mkdir -p /data

ENV PORT=3100
ENV DATA_DIR=/data

EXPOSE 3100

CMD ["node", "server.js"]
