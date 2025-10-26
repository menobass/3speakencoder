# 🚀 Smart Cache System - Eliminate Wasteful Re-processing

## 📋 Overview

The current encoder re-downloads and re-encodes videos on every retry, wasting significant bandwidth, CPU, and time. This document outlines a **Smart Cache System** to eliminate this waste and make retries lightning-fast.

## 🎯 Problem Statement

### Current Wasteful Flow:
```
Job Attempt 1:
1. Download 2GB video ✅ (5 minutes)
2. Encode to 1080p, 720p, 480p ✅ (20 minutes) 
3. Upload to IPFS ❌ (fails at 90%)

Job Attempt 2:
1. Download 2GB video AGAIN 🗑️ (5 minutes - WASTE!)
2. Encode AGAIN 🗑️ (20 minutes - WASTE!)
3. Upload to IPFS ✅ (works this time)

Total: 50 minutes | Wasted: 25 minutes (50%!)
```

### Smart Cache Flow:
```
Job Attempt 1:
1. Download 2GB video ✅ → CACHE locally (5 min)
2. Encode to profiles ✅ → CACHE encoded files (20 min)
3. Upload to IPFS ❌ (fails)

Job Attempt 2:
1. Check cache - source exists ✅ (0 min)
2. Check cache - encoded files exist ✅ (0 min)  
3. Upload to IPFS ✅ (2 min)

Total: 27 minutes | Saved: 23 minutes (85% efficiency!)
```

## 🏗️ Architecture Design

### Three-Layer Caching Strategy:

#### **Layer 1: Source Video Cache**
- **Purpose**: Avoid re-downloading same source videos
- **Key**: MD5 hash of source URL
- **Location**: `./cache/sources/{hash}.{ext}`
- **Benefit**: Save bandwidth and download time

#### **Layer 2: Encoded Profiles Cache**
- **Purpose**: Avoid re-encoding when source + profile settings are identical
- **Key**: Source hash + profile configuration hash
- **Location**: `./cache/profiles/{sourceHash}_{profileHash}/`
- **Benefit**: Save massive CPU time (encoding is most expensive operation)

#### **Layer 3: Upload State Cache**
- **Purpose**: Track partial uploads and job state
- **Key**: Job ID
- **Location**: `./cache/uploads/{jobId}.json`
- **Benefit**: Resume from exact failure point

### Cache Structure:
```
cache/
├── sources/
│   ├── a1b2c3d4.mp4                    # Source video files
│   ├── e5f6g7h8.mp4
│   └── metadata.json                   # Cache metadata
├── profiles/
│   ├── a1b2c3d4_profile123/           # Encoded outputs
│   │   ├── 1080p/
│   │   ├── 720p/
│   │   ├── 480p/
│   │   └── master.m3u8
│   └── a1b2c3d4_profile456/
└── uploads/
    ├── job-uuid-1.json                # Upload state tracking
    └── job-uuid-2.json
```

## 🛠️ Implementation Plan

### **Phase 1: Source Video Cache (2-4 hours)**

#### Priority: HIGH - Biggest bandwidth savings

#### Implementation Points:
1. **VideoProcessor.ts** - Modify `downloadVideo()` method
2. Add cache check before download
3. Copy to cache after successful download
4. Validate cached files before use

#### Code Integration:
```typescript
// In VideoProcessor.ts
private async downloadVideoWithCache(uri: string): Promise<string> {
  const sourceHash = this.generateSourceHash(uri)
  const cachedPath = path.join(this.cacheDir, 'sources', `${sourceHash}.mp4`)
  
  // Check if cached version exists and is valid
  if (await this.isValidCachedFile(cachedPath)) {
    logger.info(`📁 Using cached source video: ${sourceHash}`)
    this.updateCacheAccess(cachedPath) // For LRU
    return cachedPath
  }
  
  // Download as normal
  const downloadedPath = await this.downloadVideo(uri)
  
  // Copy to cache asynchronously (don't block job)
  this.saveToCacheAsync(downloadedPath, cachedPath)
  
  return downloadedPath
}

private generateSourceHash(uri: string): string {
  // Include URL and any relevant metadata
  return crypto.createHash('md5')
    .update(uri)
    .update(JSON.stringify(this.config.download))
    .digest('hex')
}
```

### **Phase 2: Encoded Profiles Cache (4-6 hours)**

#### Priority: HIGH - Massive CPU savings

#### Implementation Points:
1. **VideoProcessor.ts** - Modify `processVideo()` method
2. Generate profile configuration hash
3. Check cache before encoding each profile
4. Save encoded results to cache
5. Load cached results when available

#### Code Integration:
```typescript
// In VideoProcessor.ts  
private async encodeProfileWithCache(
  sourcePath: string, 
  profile: EncodingProfile, 
  onProgress?: (progress: any) => void
): Promise<EncodedOutput> {
  const sourceHash = await this.getFileHash(sourcePath)
  const profileHash = this.generateProfileHash(profile)
  const cacheKey = `${sourceHash}_${profileHash}`
  const cachedDir = path.join(this.cacheDir, 'profiles', cacheKey)
  
  // Check if cached version exists
  if (await this.isValidCachedProfile(cachedDir)) {
    logger.info(`🎬 Using cached profile: ${profile.name}`)
    this.updateCacheAccess(cachedDir)
    return this.loadCachedProfile(cachedDir)
  }
  
  // Encode as normal
  const result = await this.encodeProfile(sourcePath, profile, onProgress)
  
  // Save to cache asynchronously
  this.saveCachedProfileAsync(result, cachedDir)
  
  return result
}

private generateProfileHash(profile: EncodingProfile): string {
  // Hash all encoding parameters that affect output
  return crypto.createHash('md5')
    .update(JSON.stringify({
      resolution: profile.resolution,
      bitrate: profile.bitrate,
      codec: profile.codec,
      preset: profile.preset,
      // Include all parameters that affect encoding
    }))
    .digest('hex')
}
```

### **Phase 3: Upload State Tracking (6-8 hours)**

#### Priority: MEDIUM - Complex but valuable for large uploads

#### Implementation Points:
1. **IPFSService.ts** - Modify upload methods
2. Track upload progress and state
3. Resume from last successful point
4. Handle partial upload recovery

#### Code Integration:
```typescript
// New UploadStateManager class
interface UploadState {
  jobId: string
  sourceHash: string
  profileHashes: string[]
  uploadProgress: {
    [profileHash: string]: {
      completed: boolean
      ipfsHash?: string
      uploadedFiles: string[]
      totalFiles: number
    }
  }
  finalHash?: string
  attempts: number
  lastAttempt: string
  errors: string[]
}

class UploadStateManager {
  private stateFile(jobId: string): string {
    return path.join(this.cacheDir, 'uploads', `${jobId}.json`)
  }
  
  async saveUploadState(state: UploadState): Promise<void> {
    await fs.writeFile(this.stateFile(state.jobId), JSON.stringify(state, null, 2))
  }
  
  async loadUploadState(jobId: string): Promise<UploadState | null> {
    try {
      const data = await fs.readFile(this.stateFile(jobId), 'utf8')
      return JSON.parse(data)
    } catch {
      return null
    }
  }
  
  async resumeUpload(jobId: string): Promise<boolean> {
    const state = await this.loadUploadState(jobId)
    if (!state) return false
    
    // Resume logic here
    return true
  }
}
```

## 📊 Cache Management

### **Cache Configuration:**
```typescript
interface CacheConfig {
  enabled: boolean
  maxSize: string           // '50GB'
  maxAge: string           // '24h'
  cleanupInterval: string  // '1h'
  evictionPolicy: 'LRU' | 'FIFO' | 'SIZE'
  locations: {
    sources: string
    profiles: string  
    uploads: string
  }
}
```

### **Automatic Cleanup:**
```typescript
class CacheManager {
  async cleanup(): Promise<void> {
    const totalSize = await this.getCacheSize()
    if (totalSize > this.config.maxSize) {
      await this.evictOldEntries(totalSize - this.targetSize)
    }
    
    await this.removeExpiredEntries()
    await this.removeCorruptedEntries()
  }
  
  private async evictOldEntries(bytesToFree: number): Promise<void> {
    const entries = await this.getCacheEntries()
    entries.sort((a, b) => a.lastAccess - b.lastAccess) // LRU
    
    let freed = 0
    for (const entry of entries) {
      if (freed >= bytesToFree) break
      freed += await this.removeEntry(entry)
    }
  }
}
```

### **Cache Validation:**
```typescript
async isValidCachedFile(filePath: string): Promise<boolean> {
  if (!fs.existsSync(filePath)) return false
  
  const stats = await fs.stat(filePath)
  
  // Check file size (must be > 1KB)
  if (stats.size < 1024) return false
  
  // Check age
  const age = Date.now() - stats.mtime.getTime()
  if (age > this.config.maxAge) return false
  
  // Quick corruption check
  return await this.quickIntegrityCheck(filePath)
}
```

## 🔧 Configuration Integration

### **Add to .env:**
```bash
# Smart Cache Configuration
CACHE_ENABLED=true
CACHE_MAX_SIZE=50GB
CACHE_MAX_AGE=24h
CACHE_CLEANUP_INTERVAL=1h
CACHE_EVICTION_POLICY=LRU

# Cache Locations (optional)
CACHE_SOURCES_DIR=./cache/sources
CACHE_PROFILES_DIR=./cache/profiles  
CACHE_UPLOADS_DIR=./cache/uploads
```

### **Add to ConfigLoader.ts:**
```typescript
interface EncoderConfig {
  // ... existing config
  cache?: {
    enabled: boolean
    maxSize: number      // bytes
    maxAge: number       // milliseconds
    cleanupInterval: number
    evictionPolicy: 'LRU' | 'FIFO' | 'SIZE'
    locations: {
      sources: string
      profiles: string
      uploads: string
    }
  }
}
```

## 🧪 Testing Strategy

### **Unit Tests:**
1. Cache key generation
2. File validation logic
3. Cleanup algorithms
4. Corruption handling

### **Integration Tests:**
1. Full download → cache → reuse flow
2. Encoding → cache → reuse flow
3. Cache cleanup under disk pressure
4. Concurrent access handling

### **Performance Tests:**
1. Measure retry speed improvement
2. Memory usage with large cache
3. Disk I/O impact
4. Cache hit/miss ratios

## 📈 Expected Performance Gains

### **Bandwidth Savings:**
- **Source Cache**: 100% bandwidth saving on retries
- **Large Videos**: 10GB+ videos never re-downloaded
- **Network Costs**: Significant savings for metered connections

### **CPU Savings:**
- **Profile Cache**: 90%+ CPU savings on retries
- **Encoding Time**: 20+ minute jobs retry in seconds
- **Server Load**: Reduced encoding load on busy nodes

### **Time Savings:**
- **Failed Jobs**: Retry in 30 seconds vs 25 minutes
- **User Experience**: Near-instant retry completion
- **Throughput**: 10x+ improvement in retry scenarios

### **Real-World Impact:**
```
Current State:
- Job fails → 25 minutes to retry
- High bandwidth usage
- CPU constantly encoding

With Smart Cache:
- Job fails → 30 seconds to retry  
- Minimal bandwidth usage
- CPU mostly idle during retries
```

## 🚀 Migration Path

### **Phase 1 Rollout:**
1. Deploy source cache only
2. Monitor cache performance
3. Gather hit/miss metrics
4. Fine-tune cache size

### **Phase 2 Rollout:**
1. Add profile cache
2. Monitor disk usage
3. Optimize cleanup algorithms
4. Performance benchmarking

### **Phase 3 Rollout:**
1. Add upload state tracking
2. Complex retry scenarios
3. Full integration testing
4. Documentation updates

## 🎯 Success Metrics

### **Performance KPIs:**
- **Cache Hit Rate**: Target >70% for sources, >50% for profiles
- **Retry Speed**: Target 10x improvement (25 min → 2.5 min)
- **Bandwidth Reduction**: Target 50% reduction in download traffic
- **CPU Utilization**: Target 60% reduction during retry peaks

### **Operational KPIs:**
- **Disk Usage**: Stay under configured limits
- **Memory Usage**: No increase in base memory usage
- **Error Rate**: No increase in job failure rates
- **User Satisfaction**: Faster completion times

## 🔮 Future Enhancements

### **Shared Cache Network:**
- Multiple encoders sharing cache over network
- Distributed cache for encoder pools
- Cache synchronization across nodes

### **Predictive Caching:**
- Pre-download popular videos
- ML-based cache optimization
- Proactive encoding of trending content

### **Advanced Features:**
- Compression for cached files
- Deduplication across similar videos
- Smart cache warming strategies

---

## 💡 Implementation Notes

### **File Locations to Modify:**
1. `src/services/VideoProcessor.ts` - Main integration point
2. `src/services/IPFSService.ts` - Upload state tracking
3. `src/config/ConfigLoader.ts` - Configuration
4. `src/services/CacheManager.ts` - New cache management service

### **New Dependencies:**
```json
{
  "proper-lockfile": "^4.1.2",  // File locking
  "du": "^1.0.0",               // Disk usage calculation
  "glob": "^8.0.3"              // File pattern matching
}
```

### **Backward Compatibility:**
- Cache is completely optional
- Existing jobs continue working unchanged
- No breaking API changes
- Graceful degradation when cache disabled

### **Risk Mitigation:**
- Extensive file validation prevents corrupted cache usage
- LRU eviction prevents disk space exhaustion  
- Async cache operations don't slow down jobs
- Cache corruption automatically triggers re-download/re-encode

---

**This Smart Cache System will transform the encoder from good to EXCEPTIONAL, eliminating waste and making retries lightning-fast!** ⚡🛡️