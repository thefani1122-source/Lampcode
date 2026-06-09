FROM node:20-slim

RUN apt-get update && apt-get install -y git curl ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /home/user/app

# Pre-install common dependencies for fast boot
COPY package.json ./
RUN npm install

COPY vite.config.ts ./
COPY . .

EXPOSE 5173

CMD ["npx", "vite", "--host", "0.0.0.0", "--port", "5173"]
