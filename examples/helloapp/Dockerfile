FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --production
COPY server.js ./
ENV APP_PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
