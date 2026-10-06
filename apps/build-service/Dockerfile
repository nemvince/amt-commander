FROM oven/bun

WORKDIR /app

# The workspace manifest and lockfile first, so a dependency install is cached
# until the lockfile changes. `apps/` and `packages/` carry the workspace
# package.json files bun install needs to link them.
COPY package.json bun.lock ./
COPY apps/ apps/
COPY packages/ packages/
RUN bun install

EXPOSE 8787
CMD ["bun", "apps/build-service/server.ts"]
