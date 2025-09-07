# Lightweight Node + Docker CLI for invoking docker compose through docker.sock
FROM node:20-alpine

# Install docker cli + compose plugin
RUN apk add --no-cache docker-cli docker-cli-compose bash git curl jq

WORKDIR /opt/provisioner
COPY package.json package-lock.json* ./
RUN npm install --production || npm install --production --legacy-peer-deps

COPY server.js ./

ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
