FROM node:18-slim

RUN apt-get update && apt-get install -y \
  fonts-liberation \
  fonts-dejavu-core \
  fontconfig \
  && fc-cache -fv \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

EXPOSE 3000
CMD ["node", "index.js"]
