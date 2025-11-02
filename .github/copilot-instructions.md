

## 3Speak Modern Video Encoder Project

This is a modern, production-ready replacement for the 3Speak video encoder with advanced resilience features.

### Core Capabilities:
- **Dual-Mode Operation**: Gateway jobs + Direct API for miniservice integration
- **Multi-Quality Encoding**: HLS output (1080p, 720p, 480p) with hardware acceleration
- **MongoDB Resilience**: Direct database fallback when gateway APIs fail (3Speak infrastructure)
- **Rescue Mode**: Auto-claims abandoned jobs during gateway outages (60s intervals, 5min threshold)
- **Complete Autonomy**: Can process videos entirely offline during gateway failures
- **Smart Retry System**: Cached results, 5 retries with exponential backoff
- **DID Authentication**: Secure identity-based gateway communication
- **Production Hardened**: Handles race conditions, gateway failures, network issues

### Advanced Features Implemented:
- [x] ✅ MongoDB Direct Verification (bypasses unreliable gateway APIs)
- [x] ✅ Defensive Takeover System (claims jobs directly when gateway fails)
- [x] ✅ Force Processing (emergency job processing via MongoDB - dashboard controlled)
- [x] ✅ Pre-Processing Status Checks (ensures accurate job state before encoding)
- [x] ✅ Race Condition Handling (graceful skip when other encoders claim jobs)
- [x] ✅ Rescue Mode (auto-claims jobs abandoned 5+ minutes, 2 jobs/cycle max)
- [x] ✅ Dashboard Integration (rescue stats, available jobs, MongoDB status)
- [x] ✅ Complete Independence (processes jobs without gateway during outages)

### Resilience Architecture:
**Layer 1**: Gateway APIs (normal operation)
**Layer 2**: MongoDB verification (when gateway returns errors)
**Layer 3**: Defensive takeover (when gateway APIs completely fail)
**Layer 4**: Direct completion (update MongoDB directly, skip gateway reporting)
**Layer 5**: Rescue Mode (auto-claim abandoned jobs during prolonged outages)

### Current Status:
- ✅ Production deployment ready
- ✅ Battle-tested with gateway failures
- ✅ Complete MongoDB fallback system operational
- ✅ Rescue Mode active for infrastructure nodes
- ✅ Mobile dashboard management via force processing
- ✅ Zero manual intervention during outages

### API Compatibility:
- Gateway: https://encoder-gateway.infra.3speak.tv
- MongoDB: Direct database access (optional, 3Speak infrastructure only)
- Authentication: DID + JWS signatures
- Node registration, job polling, progress reporting
- Same configuration format as legacy encoder