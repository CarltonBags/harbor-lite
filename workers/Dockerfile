FROM node:20-bullseye-slim

# Install git (needed for some npm packages)
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package.json ./
COPY package-lock.json* ./
RUN npm install --production=false

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Verify the build
RUN ls -la dist/

# Start command
CMD ["npm", "start"]
