FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    ca-certificates \
    python3 \
    python3-requests \
    fonts-liberation \
    fonts-noto-color-emoji \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    wget \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# macro_adapter.py (SPY/QQQ) is launched BY stream_engine.js itself
# (startMacroAdapter(), --live mode) as a piped child process, not from
# this CMD directly. Tried a shell "python3 -u macro_adapter.py & exec
# node ..." background-job form here first - a real deploy of that
# produced a healthy stream but ZERO [MACRO_ADAPTER] log lines ever, even
# with unbuffered stdout, for a reason never confirmed (no container
# shell access to inspect it directly). Having Node spawn and relay the
# child's output itself removes that ambiguity - it's the exact same
# stdout every other log line in this file already reaches reliably.
# python3/python3-requests above are still required here since Node only
# spawns the `python3` binary; it doesn't provide it.
CMD ["node", "stream_engine.js", "--live"]
