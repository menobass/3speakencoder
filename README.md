# 3Speak Modern Video Encoder 🎬

## 🚀 **SUPER EASY Setup - Help Encode Videos!**

Want to help 3Speak with video encoding? **Get running in 2 minutes!**

### **One-Command Installation:**

**Linux/Mac:**
```bash
# Download and run interactively to allow configuration choices
wget https://raw.githubusercontent.com/menobass/3speakencoder/main/install.sh
chmod +x install.sh
./install.sh
```

**Windows:**
- **PowerShell (Recommended):** `iwr -useb https://raw.githubusercontent.com/menobass/3speakencoder/main/install.ps1 | iex`
- **Command Prompt:** Download and run `install.bat` directly
- **Manual:** Follow the manual installation guide below

*Both installers automatically handle Node.js, FFmpeg, and IPFS installation + daemon management!*

**Docker (All Platforms):**
```bash
docker run -d --name 3speak-encoder \
  -e HIVE_USERNAME=your-hive-username \
  -p 3001:3001 ghcr.io/menobass/3speakencoder:latest
```

**That's it!** Open **http://localhost:3001** and start helping encode videos! 🎉

### 🎮 **What You'll See**
Beautiful dashboard with:
- ✅ System status
- 🎬 Active encoding jobs  
- 📊 Your contribution stats
- 🔧 Health monitoring

---

## 🌍 **Help Decentralize Video!**

**Why run an encoder?**
- 🚀 **Support Web3 creators** - Help process videos for decentralized platforms
- 🏗️ **Build the future** - Contribute to decentralized video infrastructure  
- 💡 **Learn encoding** - Understand video processing and IPFS
- 🎁 **Potential rewards** - Future token incentives for network participants
- 🤝 **Join the community** - Connect with other Web3 builders

**Perfect for:**
- Content creators wanting to support the network
- Developers learning about video processing
- Anyone with spare CPU/bandwidth to share
- Community members supporting decentralization

**Requirements:**
- Decent internet connection (for downloading/uploading videos)
- Some CPU power (encoding uses processing power)
- Storage space (temporary, cleaned up automatically)

**Just run it and forget it!** The encoder automatically:
✅ Finds encoding jobs
✅ Processes videos efficiently  
✅ Uploads to IPFS
✅ Reports completion
✅ Cleans up temporary files

---

A modern, reliable replacement for the 3Speak video encoder with **dual-mode operation** supporting both 3Speak gateway jobs and direct API requests for miniservice integration.

## ✨ Key Features

- 🚀 **Dual-Mode Architecture**: Handles both 3Speak gateway jobs and direct API requests
- �️ **Super Encoder Mode**: Can self-host videos with database tracking and automatic sync
- �🎬 **Multi-Quality Encoding**: Automatic 1080p, 720p, 480p HLS output
- 🔧 **Smart Codec Detection**: Hardware acceleration with automatic fallback
- 📡 **Full API Compatibility**: Works with existing 3Speak gateway
- 🔐 **DID Authentication**: Secure identity-based authentication for gateway
- 🔑 **API Key Security**: Configurable API key authentication for direct requests
- 🛡️ **TANK MODE Uploads**: Maximum reliability with Upload→Pin→Announce workflow
- 🏗️ **IPFS Cluster Support**: Optional cluster pinning to reduce main daemon load
- 🏠 **Local Fallback Pinning**: 3Speak nodes can pin locally when supernode is overloaded
- 📊 **Pin Database**: SQLite tracking of local pins with automatic sync service
- 🚀 **Smart Retry System**: Cache results, skip wasteful re-processing on retries
- 🔍 **Clean Error Logging**: No more buffer dumps, user-friendly error messages
- 💪 **Production Ready**: 5-attempt retry logic with intelligent error handling
- 📂 **Direct IPFS Integration**: Uploads directly to 3Speak's IPFS infrastructure
- ⚡ **Easy Setup**: Simple configuration and deployment

## 📦 Installation Options

### 🎯 **Recommended: Use Easy Installers Above!**

For the **simplest experience**, use the one-command installers shown above. They handle everything automatically and let you choose your preferred mode:

**🎯 Available Modes:**
- **Gateway Mode** - Help 3Speak community (processes community videos)
- **Direct API Mode** - Private encoder for your apps (API requests only)
- **Dual Mode** - Both community jobs and private API (best of both worlds)

### 🔧 **Manual Installation** (for developers)

**Prerequisites:**
- Node.js 18+ ([nodejs.org](https://nodejs.org/))
- FFmpeg ([ffmpeg.org](https://ffmpeg.org/))
- IPFS ([ipfs.tech](https://ipfs.tech/)) - *Auto-installed by easy installer*
- Git

```bash
git clone https://github.com/menobass/3speakencoder.git
cd 3speakencoder
npm install
echo "HIVE_USERNAME=your-hive-username" > .env

# Start IPFS daemon (in another terminal or background)
ipfs daemon &

# Start the encoder
npm start
```

**Windows Manual Installation:**
```cmd
git clone https://github.com/menobass/3speakencoder.git
cd 3speakencoder
npm install
echo HIVE_USERNAME=your-hive-username > .env

REM Start IPFS daemon in background
start /b ipfs daemon

REM Start the encoder
npm start
```

**PowerShell Manual Installation:**
```powershell
git clone https://github.com/menobass/3speakencoder.git
cd 3speakencoder
npm install
"HIVE_USERNAME=your-hive-username" | Out-File -FilePath ".env" -Encoding UTF8

# Start IPFS daemon in background
Start-Process -FilePath "ipfs" -ArgumentList "daemon" -WindowStyle Hidden

# Start the encoder
npm start  
```

## 🌐 Web Dashboard

The dashboard provides real-time monitoring of:
- System status and health
- Active encoding jobs
- Processing statistics
- Error logs and debugging
- Resource usage monitoring

Access at **http://localhost:3001** after starting the encoder.

## ⚙️ Configuration

### Basic Configuration (Just Need This!)

Create a `.env` file with your Hive username:
```bash
HIVE_USERNAME=your-hive-username

# ⚠️ CRITICAL: Add this for persistent encoder identity
# Without this, your encoder gets a new identity on every restart!
ENCODER_PRIVATE_KEY=auto-generated-see-logs-on-first-run
```

**🚨 IMPORTANT:** The `ENCODER_PRIVATE_KEY` is **required** for:
- ✅ **Persistent identity** - Same encoder ID across restarts
- ✅ **Dashboard tracking** - Proper job attribution in monitoring systems
- ✅ **Gateway authentication** - Secure communication with 3Speak

**🎯 Good news:** The **easy installers automatically generate this key** for you! If installing manually, generate one with:
```bash
node -e "console.log('ENCODER_PRIVATE_KEY=' + require('crypto').randomBytes(32).toString('base64'))"
```

### Advanced Configuration Options

```bash
# Basic settings
HIVE_USERNAME=your-hive-username
LOG_LEVEL=info

# Dual-mode operation
ENABLE_GATEWAY_MODE=true
ENABLE_API_MODE=true

# Custom ports
DASHBOARD_PORT=3001
API_PORT=3002

# Gateway settings
GATEWAY_URL=https://encoder-gateway.infra.3speak.tv
DID_PRIVATE_KEY=your-did-private-key
GATEWAY_POLL_INTERVAL=5000

# IPFS settings
IPFS_GATEWAY=https://ipfs.3speak.tv
IPFS_TIMEOUT=60000

# IPFS Cluster Support (optional - reduces main daemon load)
USE_CLUSTER_FOR_PINS=false
IPFS_CLUSTER_ENDPOINT=http://65.21.201.94:9094

# Processing settings
WORK_DIR=./work
MAX_CONCURRENT_JOBS=2
ENABLE_HARDWARE_ACCEL=true

# TANK MODE for maximum reliability
TANK_MODE=true
```

### IPFS Cluster Pinning (Optional)

⚠️ **Note**: Currently only works for encoders running on the supernode itself due to localhost-only API access.

To reduce load on the main IPFS daemon, the encoder can use IPFS Cluster for pinning operations:

```bash
# Enable cluster pinning (reduces main daemon load)
USE_CLUSTER_FOR_PINS=false  # Disabled by default due to access limitation

# Cluster endpoint (requires localhost access or SSH tunnel)
IPFS_CLUSTER_ENDPOINT=http://65.21.201.94:9094
```

**Benefits (when accessible):**
- 🚀 Reduces load on main IPFS daemon (port 5002)
- 📂 Uploads still use main daemon for optimal performance  
- 📌 Pins route to cluster API to distribute load
- 🔧 Automatic health checking and fallback

See `docs/cluster-pinning.md` for detailed technical information and access solutions.

### Local Fallback Pinning (3Speak Operated Nodes)

⚠️ **For 3Speak infrastructure nodes only** - disabled by default to protect community encoders' storage.

When the supernode IPFS is overloaded, 3Speak-operated encoding nodes can pin content locally and continue processing:

```bash
# Enable local fallback (3Speak nodes only)
ENABLE_LOCAL_FALLBACK=true

# Number of remote attempts before trying local (default: 3)
LOCAL_FALLBACK_THRESHOLD=3
```

**How it works:**
- 🎯 Try to pin to supernode first (normal operation)
- 🏠 If supernode fails after X attempts, pin locally instead
- ✅ Job continues and reports success to gateway
- 📝 Local pins logged to `logs/local-pins.jsonl` for future sync
- 🔄 Sync service (separate) can migrate local pins to supernode later

**Benefits:**
- 🚀 Keeps encoding pipeline running during supernode overload
- 📦 Content stays available immediately (from local node)
- 🔄 Eventually consistent (sync service handles migration)
- 🛡️ No job failures due to temporary supernode issues

See `docs/local-fallback-pinning.md` for detailed technical information.

### Super Encoder Mode (3Speak Infrastructure)

🏗️ **Complete video hosting solution** - for 3Speak-operated nodes that both encode AND host content.

```bash
# Enable super encoder capabilities
ENABLE_LOCAL_FALLBACK=true
LOCAL_FALLBACK_THRESHOLD=2

# Automatic cleanup after sync (recommended)
REMOVE_LOCAL_AFTER_SYNC=true
```

**Super Encoder Features:**
- 🎯 **Smart Fallback**: Pin locally when supernode is busy, keep pipeline running
- 📊 **SQLite Database**: Track all local pins with metadata and sync status
- 🔄 **Background Sync**: Automatic migration of local pins to supernode
- 🧹 **Auto Cleanup**: Remove local pins after successful sync (configurable)
- 📈 **Stats & Monitoring**: Database stats and sync service metrics
- 🛡️ **Resilient Pipeline**: Never lose jobs due to temporary supernode issues

**Database Location**: `data/local-pins.db` - tracks all locally pinned content
**Log Files**: `logs/local-pins.jsonl` - fallback if database unavailable

See `docs/local-fallback-pinning.md` for detailed technical information.

### Configuration Examples

#### Example 1: Gateway Mode (Community Helper)
Perfect for community members who want to help encode videos:

```bash
HIVE_USERNAME=your-hive-username
REMOTE_GATEWAY_ENABLED=true
DIRECT_API_ENABLED=false

# ⚠️ CRITICAL: Required for persistent identity
ENCODER_PRIVATE_KEY=your-generated-key-from-first-run
```

#### Example 2: Direct API Mode (Private Encoder)
For developers who want a private encoder for their applications:

```bash
HIVE_USERNAME=direct-api-encoder  # Optional for direct-only mode
REMOTE_GATEWAY_ENABLED=false
DIRECT_API_ENABLED=true
DIRECT_API_PORT=3002
DIRECT_API_KEY=your-secure-generated-api-key
```

#### Example 3: Dual Mode (Maximum Flexibility)
Perfect setup for developers who want both community contribution and private API:

```bash
HIVE_USERNAME=your-hive-username
REMOTE_GATEWAY_ENABLED=true
DIRECT_API_ENABLED=true
DIRECT_API_PORT=3002
DIRECT_API_KEY=your-secure-generated-api-key
MAX_CONCURRENT_JOBS=4

# ⚠️ CRITICAL: Required for persistent identity
ENCODER_PRIVATE_KEY=your-generated-key-from-first-run
```

## 🚀 Usage

### Gateway Mode (3Speak Jobs)
The encoder automatically:
1. Connects to 3Speak gateway
2. Polls for available encoding jobs
3. Downloads source videos
4. Processes to multiple qualities (1080p, 720p, 480p)
5. Uploads HLS segments to IPFS
6. Reports completion to gateway

### API Mode (Direct Requests)
Send encoding requests directly:

```bash
curl -X POST http://localhost:3002/api/encode \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "videoUrl": "https://example.com/video.mp4",
    "title": "My Video",
    "description": "Video description"
  }'
```

## 🔧 Development

### Building
```bash
npm run build
```

### Running in Development Mode
```bash
npm run dev
```

### Testing FFmpeg
```bash
# Test FFmpeg installation
ffmpeg -version

# Test basic encoding (optional)
ffmpeg -i input.mp4 -c:v libx264 -preset medium -crf 23 output.mp4
```

## 🚨 Troubleshooting

### Common Issues

#### 1. Dashboard Shows "Offline"
- Check if the encoder process is running
- Verify network connectivity
- Look for errors in the console output
- The encoder may still be working despite showing "offline" due to gateway hiccups

#### 2. Gateway 500 Errors
- These are usually temporary server issues
- The smart retry system handles these automatically
- Jobs often complete successfully despite these errors
- Check dashboard for actual job completion status

#### 3. FFmpeg Not Found
```bash
# Ubuntu/Debian
sudo apt install ffmpeg

# CentOS/RHEL
sudo yum install ffmpeg

# macOS
brew install ffmpeg

# Windows (automatic via installers, or manual)
choco install ffmpeg
# Or download from https://ffmpeg.org/download.html
```

#### 4. IPFS Connection Issues
**The install script handles IPFS automatically, but if you have issues:**

```bash
# Check if IPFS is installed
ipfs version

# Check if IPFS daemon is running
curl -s http://127.0.0.1:5001/api/v0/id

# Start IPFS daemon manually if needed
ipfs daemon
```

**Windows-specific IPFS commands:**
```powershell
# PowerShell: Check IPFS daemon
Invoke-RestMethod -Uri "http://127.0.0.1:5001/api/v0/id" -Method Post

# Command Prompt: Start IPFS daemon
start /b ipfs daemon

# Install IPFS on Windows
choco install ipfs
# Or download from: https://dist.ipfs.tech/kubo/
```

**Install IPFS manually (if needed):**
```bash
# Linux/Mac with install script (recommended - allows interactive setup)
wget https://raw.githubusercontent.com/menobass/3speakencoder/main/install.sh && chmod +x install.sh && ./install.sh

# Or install manually:
# Linux: Download from https://dist.ipfs.tech/kubo/
# Mac: brew install ipfs
# Windows: choco install ipfs OR download from https://dist.ipfs.tech/kubo/
# Then: ipfs init && ipfs daemon
```

**Windows Installers Features:**
- ✅ **Automatic dependency installation** (Node.js, FFmpeg, IPFS)
- ✅ **IPFS daemon management** (init + auto-start)
- ✅ **Desktop shortcuts** and Start Menu entries
- ✅ **Multiple modes** (Gateway, Direct API, Dual)
- ✅ **API key generation** for direct modes
- ✅ **Colored output** and progress indicators
- ✅ **Error handling** with helpful guidance

#### 5. IPFS Upload Failures
- Check network connectivity
- Verify IPFS gateway is accessible
- Large files may take time to upload
- TANK MODE provides maximum upload reliability

#### 6. Missing ENCODER_PRIVATE_KEY
**Problem:** Encoder identity changes on every restart, breaking dashboard tracking

**Solution:**
```bash
# Generate a new persistent key
node -e "console.log('ENCODER_PRIVATE_KEY=' + require('crypto').randomBytes(32).toString('base64'))"

# Copy the output to your .env file
echo "ENCODER_PRIVATE_KEY=YourGeneratedKeyHere" >> .env
```

**Signs you're missing this:**
- Dashboard shows "new encoder" after every restart
- Job attribution doesn't persist across sessions
- Gateway authentication issues

#### 7. Smart Retry System
The encoder includes intelligent retry logic:
- **5 retry attempts** with exponential backoff
- **Result caching** - skips wasteful re-processing on retries
- **Fast recovery** for temporary server errors (2 minutes)
- **Clean error logging** - no more massive buffer dumps

### Getting Help

1. Check the logs in the dashboard
2. Verify FFmpeg is installed and working
3. Ensure network connectivity to 3Speak services
4. Join our Discord community for support
5. Create GitHub issues for bugs

## 📚 API Documentation

### Health Check
```bash
GET /api/health
```

### Encode Video
```bash
POST /api/encode
Content-Type: application/json
Authorization: Bearer your-api-key

{
  "videoUrl": "https://example.com/video.mp4",
  "title": "Video Title",
  "description": "Video Description",
  "tags": ["tag1", "tag2"]
}
```

### Job Status
```bash
GET /api/jobs/:jobId
Authorization: Bearer your-api-key
```

## 🤝 Contributing

We welcome contributions! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## 📄 License

MIT License - see LICENSE file for details.

## 🆘 Support

- **GitHub Issues**: Report bugs and request features
- **Discord**: Join our community for real-time support
- **Documentation**: Check our comprehensive guides
- **Email**: Contact the 3Speak team

---

**Ready to help decentralize video? Get started with the one-command installers above! 🚀**