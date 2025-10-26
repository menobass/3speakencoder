# IPFS Infrastructure Recovery Plan for Eddie

## Current Crisis Status
- **Pinning Supernode**: ✅ RECOVERED (already fixed)
- **Gateway Nodes**: ❌ FAILING (502 errors)
- **Other IPFS Nodes**: ❓ UNKNOWN STATUS

## Recovery Strategy

### Phase 1: Assessment (15 minutes)
```bash
# 1. Get list of all IPFS infrastructure nodes
# You'll need to provide the server list:
GATEWAY_SERVERS="server1.3speak.tv server2.3speak.tv ..."
PINNING_SERVERS="160TB-SuperNode ..."
STORAGE_SERVERS="storage1.3speak.tv ..."

# 2. Run assessment on each node
for server in $GATEWAY_SERVERS; do
    echo "Assessing $server..."
    ssh root@$server 'bash -s' < ipfs-node-assessment.sh
done
```

### Phase 2: Prioritized Recovery (30-60 minutes)

**Priority 1: Gateway Nodes** (fixes 502 errors immediately)
```bash
# Fix gateway nodes first - these serve user requests
for server in $GATEWAY_SERVERS; do
    echo "Recovering gateway node: $server"
    scp ipfs-node-recovery.sh root@$server:/tmp/
    ssh root@$server '/tmp/ipfs-node-recovery.sh gateway force'
done
```

**Priority 2: Critical Pinning Nodes** 
```bash
# Fix remaining pinning nodes
for server in $PINNING_SERVERS; do
    echo "Recovering pinning node: $server"
    scp ipfs-node-recovery.sh root@$server:/tmp/
    ssh root@$server '/tmp/ipfs-node-recovery.sh pinning force'
done
```

**Priority 3: Storage/Backup Nodes**
```bash
# Fix storage nodes last
for server in $STORAGE_SERVERS; do
    echo "Recovering storage node: $server"
    scp ipfs-node-recovery.sh root@$server:/tmp/
    ssh root@$server '/tmp/ipfs-node-recovery.sh storage force'
done
```

### Phase 3: Verification (15 minutes)
```bash
# Test gateway functionality
./check-gateway-health.sh

# Test pinning functionality from encoder
echo "test-post-recovery-$(date +%s)" | ipfs add | xargs ipfs pin add

# Test end-to-end: upload → pin → gateway retrieval
```

## What Each Script Does

### `ipfs-node-assessment.sh`
- ✅ Identifies resource usage issues (high CPU/memory)
- ✅ Finds zombie storage processes (du, bindfs)
- ✅ Tests IPFS daemon responsiveness
- ✅ Tests pinning functionality
- ✅ Checks filesystem mount health
- ✅ Provides clear status: HEALTHY/UNHEALTHY

### `ipfs-node-recovery.sh`
- 🔪 Kills zombie processes blocking operations
- 🧹 Cleans corrupted filesystem mounts
- 🔄 Restarts IPFS service properly
- 🔍 Verifies functionality restored
- 📊 Progressive recovery (gentle → aggressive)

### `check-gateway-health.sh`
- 🌐 Tests gateway from user perspective
- 📊 Monitors CDN vs backend health
- ⚡ Continuous monitoring capability

## Expected Timeline

| Phase | Duration | Action |
|-------|----------|--------|
| Assessment | 15 min | Run assessment on all nodes |
| Gateway Recovery | 20 min | Fix gateway nodes (502 errors gone) |
| Pinning Recovery | 20 min | Fix remaining pinning nodes |
| Storage Recovery | 20 min | Fix storage/backup nodes |
| Verification | 15 min | Test end-to-end functionality |
| **TOTAL** | **90 min** | **Full infrastructure recovery** |

## Communication Plan

### During Recovery
- [ ] Notify users about maintenance (Discord/Twitter)
- [ ] Update status page if available
- [ ] Coordinate with encoder operators

### Post Recovery
- [ ] Confirm all services operational
- [ ] Document lessons learned
- [ ] Plan prevention measures

## Prevention Measures (Post-Recovery)

1. **Automated Health Monitoring**
   - Deploy health checks on all nodes
   - Alert on high resource usage
   - Auto-kill zombie processes

2. **Load Balancer Health Checks**
   - Configure proper IPFS backend health checks
   - Automatic failover to healthy nodes

3. **Resource Limits**
   - Set CPU/memory limits for IPFS processes
   - Prevent resource exhaustion death spirals

4. **Regular Maintenance**
   - Weekly restart of IPFS services
   - Monthly filesystem health checks

## Emergency Contacts

- **Encoder Issues**: Contact encoder team
- **Infrastructure Issues**: Eddie/3Speak team
- **CDN Issues**: BunnyCDN support

## Files to Deploy

1. `ipfs-node-assessment.sh` - Health assessment
2. `ipfs-node-recovery.sh` - Recovery procedures  
3. `check-gateway-health.sh` - Gateway monitoring

All scripts are ready to deploy and run on infrastructure nodes.