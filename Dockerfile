# Unified Stay OS — the App runtime (Public API + operator portal + lifecycle).
# The kernel is zero-runtime-dependency; this image only adds tsx (to run the .ts
# entrypoint) and the optional `pg` driver (used only for cold-start reads when
# DATABASE_URL is set). Writes go through the persist-world Edge Function.
FROM node:22-slim

WORKDIR /app

# Install deps first for layer caching. tsx is a devDependency — there is no
# compile step, the entrypoint runs directly under it — so devDependencies MUST
# be installed. NODE_ENV=production makes `npm ci` silently strip devDependencies
# regardless of --include=optional (that flag only affects optionalDependencies),
# so NODE_ENV is set only AFTER install, for the running process's own behavior.
COPY package.json package-lock.json ./
RUN npm ci --include=optional

# App source.
COPY tsconfig.json ./
COPY src ./src

# Runs src/api/main.ts under tsx (see the "start" script). main.ts reads its
# configuration from the environment (JWT_SECRET, SUPABASE_*, DATABASE_URL, …).
ENV NODE_ENV=production
EXPOSE 8080
ENV PORT=8080
CMD ["npm", "start"]
