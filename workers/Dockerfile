FROM node:20-bullseye-slim

# 1. Install Python 3 and build tools
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    git \
    && rm -rf /var/lib/apt/lists/*

# Create symlink for python command (some systems need this)
RUN ln -sf /usr/bin/python3 /usr/bin/python

# 2. Set working directory
WORKDIR /app

# 3. Install Python dependencies first (for better caching)
COPY python/requirements.txt ./python/
RUN pip3 install --no-cache-dir -r python/requirements.txt

# 4. Copy package files and install Node.js dependencies
COPY package.json ./
COPY package-lock.json* ./
RUN npm install --production=false

# 5. Copy source code
COPY . .

# 6. Build TypeScript
RUN npm run build

# 7. Verify the build
RUN ls -la dist/ && ls -la python/

# 8. Set environment for Python
ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/app/python

# 9. Start command
CMD ["npm", "start"]
