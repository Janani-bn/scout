# Multi-stage build for the API workspace.
# Build with the repo root as context:
#   docker build -f apps/api/Dockerfile -t scout-api .
FROM node:20-alpine AS build
WORKDIR /app
# Copy the whole monorepo so npm workspaces + shared packages resolve.
COPY . .
RUN npm ci
# Generate the Prisma client and compile TypeScript (build script is `tsc`).
RUN npx prisma generate --schema=apps/api/prisma/schema.prisma
RUN npm run build --workspace=apps/api

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
WORKDIR /app/apps/api
EXPOSE 4000
CMD ["node", "dist/server.js"]
