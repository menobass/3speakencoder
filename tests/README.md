# 🧪 3Speak Encoder Test Suite

This directory contains all test files and test assets for the 3Speak video encoder.

## 📋 Test Categories

### 🔌 MongoDB & Database Tests
- `test-mongodb-connection.js` - Tests MongoDB connectivity and basic operations
- `test-mongo-force.ts` - Tests MongoDB force processing capabilities
- `test-mongo-verifier.ts` - Tests MongoVerifier service functionality

### 🚀 Force Processing Tests
- `test-force-processing.js` - Tests force processing feature (ES module version)
- `test-mongo-force.ts` - TypeScript force processing test with full workflow

### 🌐 IPFS & Cluster Tests
- `test-cluster-config.js` - Tests IPFS cluster configuration
- `test-cluster-pins.js` - Tests IPFS cluster pinning functionality
- `test-lazy-pin-fallback.js` - Tests lazy pinning fallback mechanisms
- `test-local-fallback.js` - Tests local IPFS fallback functionality

### 🔧 Service Integration Tests
- `test-services.ts` - Comprehensive service integration tests
- `test-direct-api-mode.js` - Tests direct API mode functionality

## 🎥 Test Video Assets

### Hardware Acceleration Test Files
- `test_qsv.mp4` - Intel Quick Sync Video (QSV) hardware acceleration test
- `test_vaapi.mp4` - Video Acceleration API (VAAPI) test file
- `test_x264.mp4` - Software x264 encoding test file

## 🚀 Running Tests

### MongoDB Tests
```bash
# Test MongoDB connectivity
node tests/test-mongodb-connection.js

# Test force processing (TypeScript)
npx ts-node tests/test-mongo-force.ts
```

### IPFS Tests
```bash
# Test IPFS cluster
node tests/test-cluster-pins.js

# Test local fallback
node tests/test-local-fallback.js
```

### Service Tests
```bash
# Run service integration tests
npx ts-node tests/test-services.ts
```

## 🔧 Test Configuration

All tests use the same `.env` configuration as the main application. Make sure to:

1. Configure MongoDB credentials (if testing MongoDB features)
2. Set up IPFS endpoints for cluster tests
3. Ensure FFmpeg is installed for video processing tests

## 📝 Adding New Tests

When adding new test files:
1. Use descriptive filenames with `test-` prefix
2. Include proper error handling and cleanup
3. Add documentation to this README
4. Follow existing test patterns for consistency

## 🎯 Test Coverage

- ✅ MongoDB connectivity and operations
- ✅ Force processing workflow
- ✅ IPFS cluster integration
- ✅ Hardware acceleration support
- ✅ Service initialization and configuration
- ✅ Error handling and fallback mechanisms