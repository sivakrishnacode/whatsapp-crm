FROM node:22-alpine AS base

WORKDIR /app

# Set DOCKERIZED environment variable so Next.js build and runtime know they are inside Docker
ENV DOCKERIZED=true

# Copy root monorepo files
COPY package.json package-lock.json turbo.json ./
COPY packages/typescript-config/package.json ./packages/typescript-config/package.json
COPY packages/typescript-config/base.json ./packages/typescript-config/base.json

# Copy web package.json
COPY apps/web/package.json ./apps/web/package.json

# Install dependencies
RUN npm ci

# Copy the environment file if it exists (using wildcard to prevent failure if absent)
COPY apps/web/.env.local* ./apps/web/

# Copy the rest of the workspace files
COPY apps/web ./apps/web
COPY packages ./packages

# Build the Next.js Web App
RUN npm run build --workspace=web

# Production stage
FROM node:22-alpine AS production
WORKDIR /app

# Preserve DOCKERIZED environment variable in production stage
ENV DOCKERIZED=true

# Copy the entire build context to preserve all workspace node_modules and symlinks
COPY --from=base /app ./

EXPOSE 3000
CMD ["npm", "run", "start", "--workspace=web"]
