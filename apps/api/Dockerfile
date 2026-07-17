FROM node:22-alpine AS base

# Install openssl for Prisma
RUN apk add --no-cache openssl

WORKDIR /app

# Copy root monorepo files
COPY package.json package-lock.json turbo.json ./
COPY packages/typescript-config/package.json ./packages/typescript-config/package.json
COPY packages/typescript-config/base.json ./packages/typescript-config/base.json

# Copy api package.json
COPY apps/api/package.json ./apps/api/package.json

# Install dependencies
RUN npm ci

# Copy prisma schema first and generate Prisma Client to leverage caching
COPY apps/api/prisma ./apps/api/prisma
RUN npm run prisma:generate --workspace=api

# Copy the rest of the workspace files
COPY apps/api ./apps/api
COPY packages ./packages

# Build the NestJS API
RUN npm run build --workspace=api

# Production stage
FROM node:22-alpine AS production
WORKDIR /app

# Prisma needs openssl at runtime
RUN apk add --no-cache openssl

# Copy the entire build context to preserve all workspace node_modules and symlinks
COPY --from=base /app ./

# Set working directory to the API workspace for proper resolution of local files/env
WORKDIR /app/apps/api

EXPOSE 8001
CMD ["node", "dist/src/main.js"]
