FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV NODE_ENV=production PORT=8787 CALENDAR_FILE=/tmp/calendar.json
USER node
EXPOSE 8787
CMD ["node", "src/http.js"]
