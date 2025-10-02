# 🚀 Easy Install Guide - Help Encode Videos!

Want to help 3Speak with video encoding? **This guide gets you running in 5 minutes!**

## 🎯 One-Click Options (Coming Soon)

### Option 1: Windows Installer (Planned)
- Download `3SpeakEncoder-Setup.exe`
- Double-click to install
- Enter your Hive username
- Click "Start Encoding"

### Option 2: Docker Container (Available Now)
```bash
# One command to start encoding!
docker run -d --name 3speak-encoder \
  -e HIVE_USERNAME=your-hive-username \
  -p 3001:3001 \
  ghcr.io/menobass/3speakencoder:latest
```

### Option 3: Electron App (Planned)
- Cross-platform desktop app
- GUI configuration
- No command line needed

## 📦 Current Easy Installation

### For Windows Users:
1. **Install Node.js**: Download from [nodejs.org](https://nodejs.org) (choose LTS)
2. **Install FFmpeg & IPFS**: 
   ```bash
   # Using chocolatey (run as admin)
   choco install ffmpeg
   
   # Install IPFS
   # Download IPFS from https://dist.ipfs.tech/kubo/
   # Or use the automated installer (recommended)
   ```
3. **Get the encoder**:
   ```bash
   git clone https://github.com/3speak/video-encoder
   cd video-encoder
   npm install
   ```
4. **Configure** (just your Hive username):
   ```bash
   echo HIVE_USERNAME=your-hive-username > .env
   ```
5. **Start encoding**:
   ```bash
   npm start
   ```

### For Mac Users:
1. **Install dependencies**:
   ```bash
   # Install homebrew if you don't have it
   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
   
   # Install everything at once  
   brew install node ffmpeg git ipfs
   ```
2. **Get and start encoder**:
   ```bash
   git clone https://github.com/menobass/3speakencoder
   cd 3speakencoder
   npm install
   echo "HIVE_USERNAME=your-hive-username" > .env
   npm start
   ```

### For Linux Users:
**🎯 Recommended: Use the one-command installer:**
```bash
curl -sSL https://raw.githubusercontent.com/menobass/3speakencoder/main/install.sh | bash
```

**Or manual installation:**
```bash
# Ubuntu/Debian
sudo apt update && sudo apt install -y nodejs npm ffmpeg git
# Note: IPFS will be auto-installed by our installer, or install manually from ipfs.tech
git clone https://github.com/menobass/3speakencoder
cd 3speakencoder
npm install
echo "HIVE_USERNAME=your-hive-username" > .env
# Start IPFS daemon: ipfs daemon &
npm start
```

## 🎮 What You'll See

Once running, open **http://localhost:3001** in your browser for a beautiful dashboard showing:
- ✅ System status (including IPFS connection)
- 🎬 Active encoding jobs  
- 📊 Your contribution stats
- 🔧 Health monitoring

**💡 Note:** The install script automatically handles IPFS installation and daemon management!

## 💡 Why Help?

- **Decentralize video infrastructure**
- **Support Web3 content creators**
- **Earn potential future rewards**
- **Learn about video encoding**
- **Contribute to open source**

## 🆘 Need Help?

- **Discord**: Join our community
- **GitHub Issues**: Report problems
- **Documentation**: Full guides available
- **Video Tutorial**: Coming soon!

---
**Ready to make Web3 video better? Let's encode! 🚀**