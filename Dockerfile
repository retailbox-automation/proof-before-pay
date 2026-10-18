# Hosted judge demo: `npm run public` (see scripts/public.ts). Build context = this directory.
FROM public.ecr.aws/docker/library/node:26.10.0-slim
WORKDIR /app
COPY package.json package-lock.json ./
# devDependencies are needed for the build step (esbuild); pruned right after it.
RUN npm ci --include=dev --no-audit --no-fund
COPY . .
RUN node build.ts && npm prune --omit=dev --no-audit --no-fund && rm -rf data/verify logs .pids
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "scripts/public.ts"]
