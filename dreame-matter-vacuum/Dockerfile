ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:3.21
# ---- build stage: compile the TypeScript app -------------------------------
FROM node:22-alpine AS build
WORKDIR /build
COPY app/package.json app/package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY app/tsconfig.json ./
COPY app/src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime stage: Home Assistant base image + Node.js --------------------
FROM ${BUILD_FROM}
RUN apk add --no-cache nodejs
WORKDIR /app
COPY --from=build /build/dist ./dist
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/package.json ./package.json
COPY run.sh /run.sh
RUN chmod a+x /run.sh
ENV NODE_ENV=production
CMD ["/run.sh"]
