FROM node:24-bookworm-slim AS build

ENV NODE_OPTIONS=--dns-result-order=ipv4first
WORKDIR /app

COPY package.json pnpm-lock.yaml .npmrc ./
COPY scripts ./scripts

RUN corepack enable
RUN corepack pnpm install --frozen-lockfile

COPY . .

RUN corepack pnpm build


FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PORT=3001
WORKDIR /app

COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

EXPOSE 3001

CMD ["node", "dist/index.js"]
