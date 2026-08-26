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

# macro_adapter.py (SPY/QQQ, own isolated process/state/output file - see
# its own header comment) is launched as a background co-process, then
# `exec` replaces this shell with the node process so node becomes PID 1
# and still receives Railway's SIGTERM directly for a clean shutdown, same
# as before this change. macro_adapter.py has its own internal try/except
# retry loop (see main()) and needs no env vars/secrets, so nothing here
# needs to supervise/restart it - if the container itself stops, the whole
# process tree (including this background process) is torn down with it.
#
# `-u` (unbuffered stdout): a real deploy of this CMD without `-u`
# produced a running stream with zero [MACRO_ADAPTER] log lines ever
# appearing, despite the build installing python3/python3-requests
# successfully. Python fully buffers stdout by default when it isn't a
# TTY (exactly the case for a Docker container's log pipe) - the leading
# theory is macro_adapter.py's print() output was sitting unflushed
# rather than the process failing outright, but that couldn't be
# directly confirmed without container shell access. `-u` forces
# unbuffered stdout/stderr regardless, which is the correct fix either
# way and costs nothing.
CMD ["sh", "-c", "python3 -u macro_adapter.py & exec node stream_engine.js --live"]
