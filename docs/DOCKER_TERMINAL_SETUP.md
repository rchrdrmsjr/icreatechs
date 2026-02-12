# Docker Workspace Terminal Setup Guide

This guide explains how to set up and run the Docker-based workspace terminal system.

## Prerequisites

1. **Docker Desktop** (Windows/Mac) or **Docker Engine** (Linux)
   - Windows: Download from https://www.docker.com/products/docker-desktop/
   - Mac: Download from https://www.docker.com/products/docker-desktop/
   - Linux: `sudo apt-get install docker.io` (Ubuntu/Debian)

2. **Node.js 20+** (already installed)

## Setup Steps

### 1. Install Dependencies

Already done if you ran:
```bash
npm install
```

### 2. Build the Workspace Docker Image

From the project root:

```bash
docker build -t icreatechs/workspace:latest -f docker/workspace.Dockerfile .
```

This creates the base Linux image that will run user workspaces.

### 3. Configure Environment Variables

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Update the following in `.env`:

```env
# Docker Configuration
WORKSPACE_IMAGE=icreatechs/workspace:latest
DOCKER_SOCKET=/var/run/docker.sock  # Windows: //./pipe/docker_engine
```

### 4. Start the Socket Server

The socket server now uses Docker containers instead of local shells.

Run:

```bash
npm run socket:dev
```

Or if you need to update package.json, add:

```json
{
  "scripts": {
    "socket:dev": "tsx watch server/socket-server-docker.ts"
  }
}
```

### 5. Start the Next.js Development Server

In a separate terminal:

```bash
npm run dev
```

### 6. Test the Terminal

1. Open your app in browser: http://localhost:3000
2. Navigate to a page with the `PreviewTerminal` component
3. The terminal should:
   - Connect via Socket.IO
   - Spawn a Docker container
   - Open a bash shell inside the container
   - Accept commands like `ls`, `pwd`, `npm install`, etc.

## How It Works

### Container Lifecycle

1. **First Connection**: Creates a persistent Docker container with a volume
   - Container name: `workspace-{userId}-{projectId}`
   - Volume name: `workspace-vol-{userId}-{projectId}`
   
2. **Subsequent Connections**: Restarts the same container
   - Files persist in the Docker volume
   - State is preserved

3. **Idle Cleanup**: Containers stop after 30 minutes of inactivity
   - Volumes are never deleted
   - Container can be restarted at any time

### Architecture

```
Browser (xterm.js)
    ↓ WebSocket
Socket Server (socket-server-docker.ts)
    ↓ Docker SDK
Docker Container (workspace-{user}-{project})
    ↓ PTY (node-pty via Docker exec)
bash shell
```

### Resource Limits (Per Container)

- **CPU**: 1 core
- **RAM**: 1GB
- **Disk**: 2GB (volume limit)
- **Processes**: 100 max (prevents fork bombs)

## Troubleshooting

### "Cannot connect to Docker daemon"

**Windows**:
- Make sure Docker Desktop is running
- Check that Docker is using Windows containers (not WSL2 Linux)

**Mac/Linux**:
- Start Docker: `sudo systemctl start docker`
- Check: `docker ps`

### "Permission denied" on Docker socket

**Linux**:
```bash
sudo usermod -aG docker $USER
# Log out and back in
```

### Container won't start

Check Docker logs:
```bash
docker logs workspace-{userId}-{projectId}
```

List all containers:
```bash
docker ps -a
```

### Clean up containers and volumes

Remove all workspace containers:
```bash
docker ps -a | grep workspace- | awk '{print $1}' | xargs docker rm -f
```

Remove all workspace volumes:
```bash
docker volume ls | grep workspace-vol- | awk '{print $2}' | xargs docker volume rm
```

## Development Workflow

### Testing Locally

1. Build the workspace image
2. Start socket server
3. Start Next.js dev server
4. Open terminal in browser
5. Run commands: `ls`, `pwd`, `echo "hello"`, etc.

### Debugging

Enable verbose logging in `container-manager.ts` and `pty-handler.ts`.

Watch container activity:
```bash
docker ps
docker logs -f workspace-{userId}-{projectId}
```

### Production Deployment

1. Deploy socket server to a cloud VM with Docker installed
2. Ensure Docker socket is accessible
3. Set up persistent volumes
4. Configure cleanup cron jobs for idle containers
5. Monitor resource usage

## Next Steps

- [ ] Add file synchronization (volume → S3/Supabase)
- [ ] Add snapshot/restore functionality
- [ ] Implement warm container pool
- [ ] Add resource monitoring dashboard
- [ ] Set up automated cleanup
