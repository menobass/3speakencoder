# IPFS Cluster Pinning Feature

## Current Limitation

⚠️ **IMPORTANT**: The IPFS Cluster API is currently only accessible from localhost on the supernode (65.21.201.94). This means:

- **External Encoders**: Cannot use cluster pinning (feature disabled by default)
- **Supernode-Local Encoders**: Could use cluster pinning if running on the supernode itself

### Why This Limitation Exists

The cluster API binds to `localhost:9094` for security reasons. External access would require:
1. Changing cluster configuration to bind to `0.0.0.0:9094` 
2. Adding authentication/authorization to the cluster API
3. Firewall rules to control access

## Potential Solutions

### Option 1: SSH Tunneling (Immediate)
External encoders could create SSH tunnels:
```bash
# Create tunnel from encoder host
ssh -L 9094:localhost:9094 root@65.21.201.94 -N &

# Encoder would then use localhost:9094 as cluster endpoint
USE_CLUSTER_FOR_PINS=true
IPFS_CLUSTER_ENDPOINT=http://localhost:9094
```

### Option 2: API Proxy (Development Required)  
Create a simple HTTP proxy on the supernode that:
- Accepts external requests on a public port
- Forwards to localhost cluster API
- Adds basic authentication/rate limiting

### Option 3: Cluster Configuration Change (Infrastructure)
Modify cluster config to listen on external interface:
- Change API binding from localhost to 0.0.0.0
- Add authentication mechanisms
- Configure firewall rules

## Current Recommendation

**Keep cluster pinning disabled by default** (`USE_CLUSTER_FOR_PINS=false`) until external access is properly configured. The feature works correctly but only benefits encoders running directly on the supernode.

## Problem Solved

The 3Speak supernode's main IPFS daemon was receiving heavy traffic from encoder users:
- Multiple external IPs making frequent pin/ls requests
- Streaming responses of 317,506+ pins causing timeouts
- "context canceled" errors due to load
- Main daemon becoming unresponsive

## Solution

The encoder can now use the IPFS Cluster service for pinning operations:
- **Uploads**: Still use main daemon (port 5002) for optimal performance
- **Pins**: Route to cluster API (port 9094) to distribute load
- **Unpins**: Also route to cluster when cluster mode is enabled

## Configuration

### Environment Variables

Add to your `.env` file:

```bash
# Enable cluster pinning to reduce main daemon load
USE_CLUSTER_FOR_PINS=true

# Cluster endpoint (default: http://65.21.201.94:9094)
IPFS_CLUSTER_ENDPOINT=http://65.21.201.94:9094
```

### Default Behavior

By default, cluster pinning is **disabled** to maintain compatibility:
- `USE_CLUSTER_FOR_PINS=false` (default)
- All operations use main daemon as before

## Technical Implementation

### Modified Files

1. **ConfigLoader.ts**:
   - Added `cluster_endpoint` and `use_cluster_for_pins` options
   - Environment variable support for cluster configuration

2. **IPFSService.ts**:
   - New `pinHashWithCluster()` method for cluster pin operations
   - New `unpinHashWithCluster()` method for cluster unpin operations
   - Cluster health checking in `checkClusterHealth()`
   - Automatic fallback to main daemon if cluster is disabled

### API Differences

**Main Daemon Pin API**:
```bash
POST http://65.21.201.94:5002/api/v0/pin/add?arg=QmHash
```

**Cluster Pin API**:
```bash
POST http://65.21.201.94:9094/pins/QmHash
```

## Benefits

1. **Reduced Main Daemon Load**: Pin operations no longer hit the main daemon
2. **Better Performance**: Main daemon can focus on uploads and file serving  
3. **Improved Reliability**: Less chance of timeouts during pin operations
4. **Distributed Pinning**: Cluster can manage pins across multiple nodes
5. **Backward Compatibility**: Existing encoders continue working without changes

## Operation Flow

### Tank Mode with Cluster Pinning

1. **Encode Video**: FFmpeg creates video files
2. **Upload Directory**: Main daemon (port 5002) handles file uploads
3. **Pin Directory**: Cluster API (port 9094) handles pinning
4. **Report Success**: Job completion reported to gateway

### Verification Commands

Test cluster functionality:
```bash
# Test cluster identity
ssh root@65.21.201.94 "curl -s localhost:9094/id"

# Test pin operation  
ssh root@65.21.201.94 "curl -s -X POST localhost:9094/pins/QmHash"

# List cluster pins
ssh root@65.21.201.94 "curl -s localhost:9094/pins"
```

## Health Monitoring

The encoder automatically checks cluster health when cluster pinning is enabled:

```typescript
// Cluster health check output
🏥 Checking IPFS Cluster health...
✅ IPFS Cluster is healthy (160TB-SuperNode)
📊 Cluster version: 1.1.4, peers: 1
```

## Rollout Strategy

### Phase 1: Testing (Current)
- Feature implemented but disabled by default
- Manual testing with `USE_CLUSTER_FOR_PINS=true`
- Monitor cluster API performance

### Phase 2: Gradual Enablement 
- Enable for specific encoder nodes experiencing issues
- Monitor main daemon load reduction
- Verify pin operations work correctly

### Phase 3: Default Enablement
- Change default to `USE_CLUSTER_FOR_PINS=true`
- All new encoder deployments use cluster by default
- Existing encoders can opt-in by updating configuration

## Monitoring

Key metrics to monitor:
- Main daemon request rate (should decrease)
- Cluster API response times
- Pin operation success rates
- Overall encoding job success rates

## Troubleshooting

### Cluster Connection Issues
```bash
# Check cluster service status
ssh root@65.21.201.94 "systemctl status ipfs-cluster"

# Check cluster ports
ssh root@65.21.201.94 "lsof -p $(pgrep ipfs-cluster) | grep LISTEN"

# Test cluster API
ssh root@65.21.201.94 "curl -s localhost:9094/id"
```

### Fallback Behavior
If cluster pinning fails, the encoder will:
1. Log the cluster error
2. Throw an exception (job will retry)
3. Admin can disable cluster pinning to restore functionality

## Future Enhancements

1. **Automatic Failover**: Fall back to main daemon if cluster is down
2. **Pin Status Verification**: Check pin completion in cluster
3. **Cluster Load Balancing**: Support multiple cluster endpoints
4. **Pin Cleanup**: Automated cleanup of old pins in cluster

## Security Considerations

- Cluster API currently only accessible from localhost on supernode
- No authentication required for cluster operations
- Consider adding API authentication for production use