FROM node:20-alpine

# Install essential development tools
RUN apk add --no-cache \
    bash \
    bash-completion \
    git \
    curl \
    wget \
    nano \
    vim \
    python3 \
    py3-pip \
    build-base \
    ca-certificates

# Create non-root user for security
RUN addgroup -g 1001 developer && \
    adduser -D -u 1001 -G developer developer

# Create workspace directory with proper permissions
RUN mkdir -p /workspace && \
    chown -R developer:developer /workspace

# Install global npm packages
RUN npm install -g \
    typescript \
    ts-node \
    nodemon \
    eslint \
    prettier

# Set working directory
WORKDIR /workspace

# Switch to non-root user
USER developer

# Set bash as default shell
ENV SHELL=/bin/bash

# Default command: bash
CMD ["/bin/bash"]
