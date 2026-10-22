FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATABASE_PATH=/var/data/accord.sqlite
COPY package.json ./
COPY src ./src
COPY public ./public
RUN mkdir -p /var/data
EXPOSE 3000
CMD ["node", "src/entrypoint.mjs"]
