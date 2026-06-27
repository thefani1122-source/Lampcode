FROM node:20-slim

RUN apt-get update && apt-get install -y git curl ca-certificates python3 python3-pip python3-venv && rm -rf /var/lib/apt/lists/*

# Python agent dependencies
RUN pip3 install --break-system-packages \
    crewai \
    langgraph \
    langchain-anthropic \
    apscheduler \
    exa-py \
    fastapi \
    uvicorn \
    supabase

WORKDIR /home/user/app

# Pre-install common dependencies for fast boot
COPY package.json ./
RUN npm install

COPY vite.config.ts ./
COPY . .

EXPOSE 5173
