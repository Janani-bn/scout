# Multi-stage build for the Next.js web workspace.
# Build with the repo root as context:
#   docker build -f apps/web/Dockerfile -t scout-web .
FROM node:20-alpine AS build
WORKDIR /app
COPY . .
RUN npm ci
RUN npm run build --workspace=apps/web

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
WORKDIR /app/apps/web
EXPOSE 3000
CMD ["npm", "run", "start"]
