FROM node:24.22.3-alpine3.24 AS build
# Upstream has no app releases (its GitHub releases are dataset drops), so pin a
# commit and bump it deliberately.
ARG ZIWEI_COMMIT=495b79ecb3524b20b2edc026067d7d0b0f407319
WORKDIR /app
RUN wget -qO- https://codeload.github.com/Renhuai123/ziwei-doushu/tar.gz/${ZIWEI_COMMIT} | tar xz --strip-components=1
# The repo leaves the AI routes out; ours forward to any OpenAI-compatible API.
COPY api/ app/api/
# The home page opens with the upstream site's dated letter to its own users
# (a May promo for their hosted platform); a self-hosted copy has no use for it.
RUN printf 'export default function AnnouncementModal() { return null; }\n' > components/AnnouncementModal.tsx
# Standalone output: a self-contained server.js, no full node_modules at runtime.
RUN printf "module.exports = { transpilePackages: ['lunar-javascript'], output: 'standalone' };\n" > next.config.js
RUN npm ci --no-audit --no-fund
# NEXT_PUBLIC_* is inlined at build; a placeholder is swapped for the real
# domain when the container starts (railway-entrypoint.sh).
RUN NEXT_PUBLIC_SITE_URL=https://ziwei-site-url.invalid NEXT_TELEMETRY_DISABLED=1 npm run build

FROM node:24.22.3-alpine3.24
WORKDIR /app
# sed -i in the entrypoint writes temp files next to server.js.
RUN chown node:node /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static .next/static
COPY --chmod=0755 railway-entrypoint.sh /railway-entrypoint.sh
USER node
EXPOSE 3000
CMD ["/railway-entrypoint.sh"]
