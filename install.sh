#!/bin/bash

# 3Speak Encoder - Easy Linux Setup Script
# Run with: curl -sSL https://raw.githubusercontent.com/menobass/3speakencoder/main/install.sh | bash

set -e

echo "🚀 3Speak Video Encoder - Easy Setup"
echo "====================================="sh

# 3Speak Encoder - Easy Linux Setup Script
# Run with: curl -sSL https://raw.githubusercontent.com/menobass/3speakencoder/main/install.sh | bash

set -e

echo "🚀 3Speak Video Encoder - Easy Setup"
echo "====================================="

# Check if running as root
if [[ $EUID -eq 0 ]]; then
   echo "❌ Don't run this script as root! Run as your normal user."
   exit 1
fi

# Detect OS
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    OS="linux"
elif [[ "$OSTYPE" == "darwin"* ]]; then
    OS="mac"
else
    echo "❌ Unsupported OS: $OSTYPE"
    echo "Please use Windows installer or manual installation"
    exit 1
fi

echo "✅ Detected OS: $OS"

# Check for required tools
check_command() {
    if ! command -v $1 &> /dev/null; then
        echo "❌ $1 is not installed"
        return 1
    else
        echo "✅ $1 is available"
        return 0
    fi
}

# Install dependencies based on OS
install_deps() {
    if [[ "$OS" == "linux" ]]; then
        if command -v apt &> /dev/null; then
            echo "📦 Installing dependencies with apt..."
            sudo apt update
            sudo apt install -y nodejs npm ffmpeg git curl
        elif command -v yum &> /dev/null; then
            echo "📦 Installing dependencies with yum..."
            sudo yum install -y nodejs npm ffmpeg git curl
        elif command -v pacman &> /dev/null; then
            echo "📦 Installing dependencies with pacman..."
            sudo pacman -S nodejs npm ffmpeg git curl
        else
            echo "❌ Unsupported Linux distribution. Please install manually:"
            echo "   - Node.js 18+"
            echo "   - npm"
            echo "   - ffmpeg" 
            echo "   - git"
            exit 1
        fi
    elif [[ "$OS" == "mac" ]]; then
        if ! command -v brew &> /dev/null; then
            echo "📦 Installing Homebrew..."
            /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
        fi
        echo "📦 Installing dependencies with brew..."
        brew install node ffmpeg git
    fi
}

# Check if dependencies are installed
echo ""
echo "🔍 Checking dependencies..."

NEED_INSTALL=false

if ! check_command node; then NEED_INSTALL=true; fi
if ! check_command npm; then NEED_INSTALL=true; fi
if ! check_command ffmpeg; then NEED_INSTALL=true; fi
if ! check_command git; then NEED_INSTALL=true; fi

if [[ "$NEED_INSTALL" == "true" ]]; then
    echo ""
    echo "📦 Installing missing dependencies..."
    install_deps
    echo "✅ Dependencies installed!"
fi

# Check Node.js version
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [[ $NODE_VERSION -lt 18 ]]; then
    echo "❌ Node.js version $NODE_VERSION is too old. Need 18+."
    echo "Please update Node.js from https://nodejs.org"
    exit 1
fi

echo "✅ Node.js version: $(node -v)"

# Choose encoder mode
echo ""
echo "🎯 Choose your encoder mode:"
echo "  1) Gateway Mode - Help 3Speak community (connects to 3Speak gateway)"
echo "  2) Direct API Mode - Private encoder for your apps (direct requests only)"
echo "  3) Dual Mode - Both gateway jobs and direct API (recommended for developers)"
echo ""
read -p "Enter your choice (1, 2, or 3): " MODE_CHOICE

case $MODE_CHOICE in
    1)
        ENCODER_MODE="gateway"
        echo "✅ Gateway Mode selected - you'll help encode videos for 3Speak community"
        ;;
    2)
        ENCODER_MODE="direct"
        echo "✅ Direct API Mode selected - private encoder for your applications"
        ;;
    3)
        ENCODER_MODE="dual"
        echo "✅ Dual Mode selected - maximum flexibility for developers"
        ;;
    *)
        echo "❌ Invalid choice. Defaulting to Gateway Mode."
        ENCODER_MODE="gateway"
        ;;
esac

# Get Hive username (required for gateway modes, optional for direct-only)
echo ""
if [[ "$ENCODER_MODE" == "direct" ]]; then
    echo "👤 Hive username (optional for direct-API-only mode):"
    read -p "Hive username (or press Enter to skip): " HIVE_USERNAME
    if [[ -z "$HIVE_USERNAME" ]]; then
        HIVE_USERNAME="direct-api-encoder"
        echo "ℹ️ Using default username: $HIVE_USERNAME"
    fi
else
    echo "👤 What's your Hive username? (required for gateway mode)"
    read -p "Hive username: " HIVE_USERNAME
    if [[ -z "$HIVE_USERNAME" ]]; then
        echo "❌ Hive username is required for gateway mode"
        exit 1
    fi
fi

# Clone and setup encoder
echo ""
echo "📥 Downloading 3Speak Encoder..."

INSTALL_DIR="$HOME/3speak-encoder"

if [[ -d "$INSTALL_DIR" ]]; then
    echo "📁 Directory exists, updating..."
    cd "$INSTALL_DIR"
    git pull
else
    git clone https://github.com/menobass/3speakencoder.git "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi

echo "📦 Installing npm packages..."
npm install

# Generate API key for direct modes
if [[ "$ENCODER_MODE" == "direct" ]] || [[ "$ENCODER_MODE" == "dual" ]]; then
    echo ""
    echo "🔑 Generating secure API key for direct requests..."
    # Generate a secure random API key
    API_KEY=$(openssl rand -hex 32 2>/dev/null || xxd -l 32 -p /dev/urandom | tr -d '\n' || head -c 64 /dev/urandom | base64 | tr -d '\n' | head -c 64)
    echo "✅ Generated secure API key: ${API_KEY:0:16}..."
    echo "⚠️  Keep this key secret - you'll need it to make API requests!"
fi

# Create .env file based on mode
echo "⚙️  Creating configuration..."

if [[ "$ENCODER_MODE" == "gateway" ]]; then
    # Gateway-only mode
    cat > .env << EOF
# 3Speak Encoder Configuration - Gateway Mode
HIVE_USERNAME=$HIVE_USERNAME

# Gateway mode settings
REMOTE_GATEWAY_ENABLED=true

# Direct API disabled for gateway-only mode
DIRECT_API_ENABLED=false

# Logging
LOG_LEVEL=info

# Optional: Custom work directory
# WORK_DIR=/path/to/encoding/workspace
EOF

elif [[ "$ENCODER_MODE" == "direct" ]]; then
    # Direct API-only mode
    cat > .env << EOF
# 3Speak Encoder Configuration - Direct API Mode
HIVE_USERNAME=$HIVE_USERNAME

# Disable gateway mode (direct API only)
REMOTE_GATEWAY_ENABLED=false

# Direct API settings
DIRECT_API_ENABLED=true
DIRECT_API_PORT=3002
DIRECT_API_KEY=$API_KEY

# Logging
LOG_LEVEL=info

# Optional: Custom work directory
# WORK_DIR=/path/to/encoding/workspace
EOF

else
    # Dual mode
    cat > .env << EOF
# 3Speak Encoder Configuration - Dual Mode
HIVE_USERNAME=$HIVE_USERNAME

# Gateway mode enabled
REMOTE_GATEWAY_ENABLED=true

# Direct API enabled
DIRECT_API_ENABLED=true
DIRECT_API_PORT=3002
DIRECT_API_KEY=$API_KEY

# Logging
LOG_LEVEL=info

# Optional: Custom work directory
# WORK_DIR=/path/to/encoding/workspace
EOF

fi

# Create desktop shortcut (Linux with GUI)
if [[ "$OS" == "linux" ]] && [[ -n "$DISPLAY" ]]; then
    DESKTOP_FILE="$HOME/Desktop/3Speak-Encoder.desktop"
    cat > "$DESKTOP_FILE" << EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=3Speak Encoder
Comment=Help encode videos for 3Speak
Icon=video-x-generic
Exec=gnome-terminal -- bash -c "cd '$INSTALL_DIR' && npm start; exec bash"
Path=$INSTALL_DIR
Terminal=false
Categories=AudioVideo;
EOF
    chmod +x "$DESKTOP_FILE"
    echo "🖥️  Desktop shortcut created!"
fi

# Success message
echo ""
echo "🎉 3Speak Encoder installed successfully!"
echo ""
echo "📍 Installation directory: $INSTALL_DIR"
echo "👤 Configured for user: $HIVE_USERNAME"
echo "🎯 Mode: $(echo $ENCODER_MODE | tr '[:lower:]' '[:upper:]')"
echo ""

# Mode-specific instructions
if [[ "$ENCODER_MODE" == "gateway" ]]; then
    echo "🌐 Gateway Mode - Community Encoding:"
    echo "   • Dashboard: http://localhost:3001"
    echo "   • Will automatically fetch and process 3Speak community videos"
    echo "   • Helps decentralize video processing for Web3"
    
elif [[ "$ENCODER_MODE" == "direct" ]]; then
    echo "🔌 Direct API Mode - Private Encoding:"
    echo "   • Dashboard: http://localhost:3001"
    echo "   • API Endpoint: http://localhost:3002"
    echo "   • Your API Key: $API_KEY"
    echo "   • Use this key to make direct encoding requests to your private encoder"
    echo ""
    echo "📝 Example API Request:"
    echo "   curl -X POST http://localhost:3002/api/encode \\"
    echo "        -H \"Authorization: Bearer $API_KEY\" \\"
    echo "        -H \"Content-Type: application/json\" \\"
    echo "        -d '{\"videoUrl\":\"https://example.com/video.mp4\", \"title\":\"My Video\"}'"
    
else
    echo "🚀 Dual Mode - Maximum Flexibility:"
    echo "   • Dashboard: http://localhost:3001"
    echo "   • API Endpoint: http://localhost:3002"
    echo "   • Your API Key: $API_KEY"
    echo "   • Processes both 3Speak community jobs AND your direct requests"
    echo "   • Perfect for developers who want to help the community and use private API"
fi

echo ""
echo "🚀 To start encoding:"
echo "   cd $INSTALL_DIR"
echo "   npm start"
echo ""
echo "💡 The encoder will automatically:"
if [[ "$ENCODER_MODE" != "direct" ]]; then
    echo "   ✅ Connect to 3Speak gateway (if enabled)"
    echo "   ✅ Fetch available community encoding jobs"
fi
if [[ "$ENCODER_MODE" != "gateway" ]]; then
    echo "   ✅ Start direct API server for your applications"
fi
echo "   ✅ Process videos and upload to IPFS"
echo "   ✅ Provide real-time dashboard monitoring"
echo ""
echo "❓ Need help? Check the README.md or join our Discord!"
echo ""

# Offer to start immediately
read -p "🚀 Start the encoder now? (y/n): " START_NOW

if [[ "$START_NOW" =~ ^[Yy]$ ]]; then
    echo ""
    echo "🎬 Starting 3Speak Encoder..."
    echo "📱 Opening dashboard at http://localhost:3001"
    
    if command -v xdg-open &> /dev/null; then
        sleep 3 && xdg-open http://localhost:3001 &
    elif command -v open &> /dev/null; then
        sleep 3 && open http://localhost:3001 &
    fi
    
    npm start
else
    echo ""
    echo "✨ Setup complete! Start encoding when ready with:"
    echo "   cd $INSTALL_DIR && npm start"
fi