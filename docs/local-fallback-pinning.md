# Local Fallback Pinning Feature

## Overview

The local fallback pinning feature allows 3Speak-operated encoder nodes to continue processing jobs even when the supernode IPFS daemon is overloaded or unreachable. Instead of failing jobs, the encoder will pin content locally and report success, ensuring the encoding pipeline continues running.

## Problem Solved

When the supernode IPFS daemon (port 5002) becomes overloaded:
- Pin operations timeout or fail
- Encoding jobs get stuck or fail
- Video processing pipeline comes to a halt
- Users experience delays in video availability

## Solution

**Local Fallback Strategy:**
1. **First Choice**: Try to pin to supernode (normal operation)
2. **Fallback**: If supernode fails after N attempts, pin locally instead
3. **Continue**: Job completes successfully and reports to gateway
4. **Log**: Local pins are recorded for future migration
5. **Sync**: Separate service can later migrate local pins to supernode

## Configuration

### Environment Variables

```bash
# Enable local fallback (disabled by default)
ENABLE_LOCAL_FALLBACK=false

# Number of remote attempts before trying local fallback (default: 3)
LOCAL_FALLBACK_THRESHOLD=3
```

### Safety by Design

- **Disabled by Default**: Protects community encoders from filling their storage
- **3Speak Nodes Only**: Intended for infrastructure nodes with managed storage
- **Configurable Threshold**: Control when fallback triggers

## Technical Implementation

### Modified Files

1. **ConfigLoader.ts**:
   - Added `enable_local_fallback` and `local_fallback_threshold` options
   - Environment variable support

2. **IPFSService.ts**:
   - Enhanced `pinAndAnnounce()` method with fallback logic
   - New `verifyLocalPinStatus()` method for local pin verification
   - New `logLocalPin()` method for tracking local pins
   - Separate DHT announcement for local vs remote pins

### Operation Flow

#### Normal Operation (Fallback Disabled)
```
1. Upload to Supernode ✅
2. Pin to Supernode ✅ 
3. Verify Pin ✅
4. Announce to DHT ✅
5. Report Success ✅
```

#### Fallback Operation (Supernode Overloaded)
```
1. Upload to Supernode ✅
2. Pin to Supernode ❌ (3 attempts)
3. Pin Locally ✅ (fallback)
4. Verify Local Pin ✅
5. Announce to Local DHT ✅
6. Log Local Pin 📝
7. Report Success ✅
```

### Logging Format

Local pins are logged to `logs/local-pins.jsonl`:

```json
{"hash":"QmXXX...","timestamp":"2025-10-27T14:30:00.000Z","type":"local_fallback_pin","node_id":"12D3KooW..."}
{"hash":"QmYYY...","timestamp":"2025-10-27T14:35:00.000Z","type":"local_fallback_pin","node_id":"12D3KooW..."}
```

## Pin Verification

### Remote Pin Verification
- HTTP call to supernode: `/api/v0/pin/ls?arg={hash}`
- Confirms content is pinned on supernode
- Standard verification process

### Local Pin Verification
- Uses local IPFS client: `ipfs.pin.ls({paths: [hash]})`
- Confirms content is pinned locally
- Prevents false success reports

## DHT Announcement

### Remote DHT (Normal Operation)
- Announces via supernode DHT network
- Broader network visibility
- Standard content discovery

### Local DHT (Fallback Operation)  
- Announces via local node DHT
- Limited to local node's DHT connections
- Still provides some discoverability

## Benefits

1. **Resilience**: Encoding continues during supernode issues
2. **No Job Failures**: Content gets pinned somewhere reliable
3. **Immediate Availability**: Content accessible from local node
4. **Future Migration**: Logged for eventual supernode sync
5. **Configurable**: Can tune fallback behavior per deployment

## Monitoring and Alerting

### Log Messages to Monitor

**Normal Remote Pin:**
```
✅ Remote pin verified successfully: QmXXX...
```

**Fallback Triggered:**
```
🏠 Remote pin failed, attempting local fallback for QmXXX...
✅ Local fallback pin succeeded for QmXXX...
🏠 FALLBACK USED: Content QmXXX... pinned locally due to remote failures
```

**Critical Failures:**
```
❌ Both remote and local pin failed for QmXXX...
```

### Metrics to Track

- Fallback activation rate (should be low)
- Local pin count accumulation
- Supernode recovery correlation
- Job success rate improvement

## Sync Service Integration

### Future Sync Service Requirements

The local pins logged to `logs/local-pins.jsonl` should be processed by a separate sync service that:

1. **Reads Log Files**: Parse local pin entries
2. **Checks Supernode**: Verify if content already exists on supernode
3. **Migrates Content**: Upload from local to supernode if missing
4. **Cleanup**: Remove local pins after successful migration
5. **Retention**: Maintain local pins for X days/weeks as configured

### Sync Service API Expectations

```bash
# Check if hash exists on supernode
GET http://65.21.201.94:5002/api/v0/pin/ls?arg={hash}

# Pin content to supernode (if accessible from local node)
POST http://65.21.201.94:5002/api/v0/pin/add?arg={hash}

# Remove local pin after successful migration
ipfs pin rm {hash}
```

## Deployment Strategy

### Phase 1: Infrastructure Nodes Only
- Enable on 3Speak-operated encoder nodes
- Monitor fallback activation rates
- Verify local pin logging works correctly

### Phase 2: Sync Service Development
- Develop separate service to migrate local pins
- Test migration logic with accumulated local pins
- Implement retention and cleanup policies

### Phase 3: Production Monitoring
- Set up alerting for high fallback rates
- Monitor storage usage on encoder nodes
- Track sync service effectiveness

## Security Considerations

- **Storage Management**: Local nodes need adequate storage for fallback pins
- **Network Security**: Local DHT announcements have limited reach
- **Data Integrity**: Local pins must be verified before reporting success
- **Cleanup**: Sync service must eventually migrate or clean up local pins

## Troubleshooting

### High Fallback Rate
- **Cause**: Supernode IPFS daemon overloaded or unreachable
- **Solution**: Investigate supernode health, consider scaling

### Local Storage Full
- **Cause**: Too many local pins without cleanup
- **Solution**: Implement/run sync service, increase storage, adjust retention

### Jobs Still Failing
- **Cause**: Both remote and local pins failing
- **Solution**: Check local IPFS daemon health, network connectivity

### Sync Service Issues
- **Cause**: Cannot migrate local pins to supernode
- **Solution**: Check supernode accessibility, authentication, network

## Future Enhancements

1. **Intelligent Fallback**: Use supernode health metrics to predict when to use fallback
2. **Peer-to-Peer Sync**: Direct encoder-to-supernode content migration
3. **Storage Quotas**: Limit local pin storage with LRU eviction
4. **Real-time Sync**: Continuous background migration instead of batch processing
5. **Multi-Supernode**: Support multiple supernode targets for redundancy