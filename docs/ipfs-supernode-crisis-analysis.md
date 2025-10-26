# IPFS Supernode Crisis Analysis & Recovery Procedures

**Date:** October 26, 2025  
**Issue:** 3Speak IPFS Supernode Complete Failure  
**Duration:** ~11 hours of downtime  
**Impact:** All encoder jobs failed due to pinning timeouts

## Crisis Timeline

### Initial Symptoms (Morning)
- Encoder jobs failing with "download stream was aborted" 
- IPFS pinning operations timing out
- Gateway returning 500 errors intermittently

### Root Cause Discovery (Afternoon)
- IPFS daemon process consuming 239% CPU + 7.7GB RAM for 11+ hours
- Long-running storage operations: `du -sh /pool0/ipfs/.ipfs` (5+ hours)
- Zombie `bindfs` processes holding filesystem locks
- Pinning operations completely non-responsive

### Recovery Process
1. **Process Analysis**: Identified runaway IPFS daemon and zombie processes
2. **Service Restart**: `systemctl restart ipfs` 
3. **Zombie Cleanup**: Killed long-running `du` and `bindfs` processes
4. **Mount Corruption**: Discovered corrupted filesystem mounts after bindfs kill
5. **Mount Recovery**: Clean unmount + IPFS restart to rebuild mounts
6. **Verification**: Confirmed pinning functionality restored

## Technical Analysis

### Why The Crash Happened
```
Filesystem Corruption → Resource Exhaustion → Death Spiral
     ↓                        ↓                    ↓
bindfs mount issues → IPFS retry loops → 239% CPU usage
     ↓                        ↓                    ↓
Write permission errors → Memory consumption → Process lockup
     ↓                        ↓                    ↓
Storage operations hang → Zombie processes → Complete failure
```

### Crash Pattern Identified
1. **Initial Trigger**: Filesystem corruption (bindfs mount issues)
2. **Cascade Effect**: IPFS daemon enters retry loops trying to write
3. **Resource Exhaustion**: CPU/memory consumption spirals out of control
4. **Lock Cascade**: Storage operations create filesystem locks
5. **Total Failure**: Pinning operations completely blocked

### Evidence From Logs
```bash
# Resource consumption at crash
ipfs-daemon: 239% CPU, 7.7GB RAM, 11+ hour runtime
du -sh: Running for 5+ hours, blocking filesystem
bindfs: Multiple zombie processes holding locks

# Error pattern during recovery
Oct 26 18:52:03 Error: /pool0/ipfs/.ipfs-view is not writeable by the current user
Oct 26 18:52:08 Error: /pool0/ipfs/.ipfs-view is not writeable by the current user
# ... repeating every 5 seconds
```

## Recovery Commands Reference

### Diagnosis Commands
```bash
# Check IPFS daemon resource usage
ps aux | grep ipfs

# Check for zombie storage processes  
ps aux | grep -E "(du|bindfs)" | grep -v grep

# Test basic IPFS functionality
ipfs id
echo "test" | ipfs add --pin=false

# Test pinning (the critical operation)
ipfs pin add <hash>

# Check filesystem mounts
mount | grep ipfs

# Monitor IPFS logs
journalctl -u ipfs --since="1 hour ago" -f
```

### Recovery Procedures
```bash
# Step 1: Kill zombie processes
kill -9 <du_pid>
kill -9 <problematic_bindfs_pid>

# Step 2: Clean corrupted mounts
systemctl stop ipfs
umount /pool0/ipfs/.ipfs-view
umount /pool0/ipfs/.ipfs-mapped

# Step 3: Restart service
systemctl start ipfs

# Step 4: Verify functionality
ipfs id
echo "test recovery" | ipfs add --pin=false
ipfs pin add <test_hash>
```

## Prevention Strategies

### For Supernode Operators
1. **Resource Monitoring**: Alert on CPU > 200% or Memory > 4GB for IPFS daemon
2. **Process Monitoring**: Kill `du` operations running > 1 hour on IPFS directories  
3. **Mount Health**: Monitor bindfs mount accessibility every 5 minutes
4. **Pinning Health**: Test pin operations every 10 minutes, restart if failing
5. **Automatic Recovery**: Implement service restart on sustained high resource usage

### For Encoder Operators
1. **Fallback Strategy**: Our two-tier download system already handles this
2. **Timeout Handling**: Our enhanced error handling catches pinning failures
3. **Local IPFS**: Use local IPFS daemon as Tier 2 fallback (implemented)
4. **Health Checks**: Monitor supernode health via test pin operations

## Impact Assessment

### What Failed
- All video processing jobs requiring IPFS pinning
- Content persistence verification  
- Upload completion workflows
- Dashboard progress reporting stuck at upload phase

### What Worked
- Local IPFS daemon operations (Tier 2 fallback)
- File download from 3Speak gateway (Tier 1)
- Video processing and encoding
- Dashboard monitoring and error reporting

### Lessons Learned
1. **Infrastructure Dependency**: Encoder reliability depends on external IPFS supernode
2. **Fallback Importance**: Our local IPFS fallback prevented total encoder failure
3. **Monitoring Gaps**: Need supernode health visibility for early warning
4. **Recovery Knowledge**: Document recovery procedures for future incidents

## Recommendations

### Immediate Actions
- [x] Document recovery procedures (this document)
- [x] Verify encoder two-tier fallback working
- [x] Test local IPFS daemon reliability

### Short Term (Next Week)
- [ ] Implement supernode health monitoring in encoder
- [ ] Add timeout alerts for pinning operations
- [ ] Create encoder-side health dashboard

### Long Term (Next Month)  
- [ ] Evaluate alternative IPFS pinning services
- [ ] Consider super-encoder architecture for infrastructure users
- [ ] Implement encoder clustering for high availability

## Supernode Auto-Healing Architecture

*Note: This would be implemented by supernode operators, not encoder users*

### Health Monitoring System
- **Resource Monitoring**: CPU, memory, disk usage alerts
- **Process Monitoring**: Detect and kill zombie storage operations
- **Mount Health**: Verify filesystem accessibility 
- **Pinning Tests**: Regular pin/unpin operations to verify functionality
- **Auto-Recovery**: Automated service restart on failure detection

### Implementation Considerations
- Monitor every 5 minutes for early detection
- Progressive healing: gentle restart → mount cleanup → full recovery
- Alerting integration (Slack, Discord, email)
- Log rotation and historical analysis
- Graceful degradation during maintenance

## Contact Information

**For Encoder Issues**: Contact encoder development team  
**For Supernode Issues**: Contact Eddie/3Speak infrastructure team  
**For Emergency Recovery**: Use procedures documented above

---

*This document serves as both incident report and operational playbook for future IPFS supernode issues affecting the 3Speak video encoder ecosystem.*