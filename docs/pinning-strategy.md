# Tank-Mode IPFS Pinning Strategy

This document outlines a resilient pinning strategy for the 3Speak encoder. The goal is to eliminate the "finalizing" failures caused by single-node pinning and make the encoder bulletproof by introducing fallback pinning paths.

## Why a Single Supernode Fails

| Weak Point | Impact |
|------------|--------|
| Node overload or network hiccups | Pin attempts time out and jobs fail |
| Pin API returns success but content isnt actually pinned | Gateway is told the job succeeded, yet the video is missing |
| Node runs out of disk or crashes | Content is lost or garbage collected |
| No verification of persistence | Encoder happily reports success while the CID is unretrievable |

Relying on one supernode means *any* of these issues leads to a bad viewer experience. The content address (CID) is correct, but the data is gone.

## Core Strategy

1. **Upload Once**  Encode and add the HLS directory to the supernode as we do today.
2. **Bulletproof Pinning Attempt**  Retry pinning on the supernode up to five times with exponential backoff and verification.
3. **Fallback Pinning**  If the supernode still fails, instruct a secondary IPFS node to pin the same CID. The backup node fetches data from the supernode (or any peer) automaticallyno re-upload needed.
4. **Persistence Verification**  After pinning is confirmed, run a final check ensuring the CID is both pinned and retrievable before telling the gateway the job succeeded.

## Recommended Topology

```
 Encoder ───► Supernode (Primary IPFS)
     │             │  ▲
     │             │  ╰─ internal IPFS exchange (Bitswap)
     ╰────► Backup IPFS Nodes (2+ recommended)
```

* Upload remains pointed at the supernode.
* Pin retries stay local to the supernode.
* On failure, pins are sent to backup nodes via their IPFS HTTP APIs.
* Backup nodes fetch the content over IPFS and pin it locally.
* Once any node confirms the pin (supernode *or* backup), the encoder verifies persistence and completes the job.

## Step-by-Step Flows

### 1. Happy Path (Supernode succeeds)

```
1. Encoder uploads HLS directory to supernode
   → Receives CID `QmABC`
2. Attempt pin on supernode (Attempt 1)
   → Success
3. Verify pin via `pin ls`
   → Confirmed
4. Final persistence check (pin status + retrievability)
   → Pass
5. Upload result reported to gateway
   → Video immediately playable
```

### 2. Supernode initially overloaded, then recovers

```
1. Upload to supernode → CID `QmXYZ`
2. Pin attempt 1 → Timeout
3. Retry with exponential backoff (2s → 4s → 8s → 16s → 30s)
4. Attempt 3 succeeds
5. Verification succeeds
6. Final persistence check passes
7. Gateway notified of success
```

### 3. Supernode pin claims success but isnt real

```
1. Upload to supernode → CID `QmBAD`
2. Pin attempt returns "OK"
3. Verify via `pin ls` → CID missing
4. Retry pin on supernode → still missing
5. Fail over to backup node → pin succeeds and verifies
6. Final persistence check passes
7. Gateway notified
```

### 4. Supernode completely offline

```
1. Upload fails? → encoder stops and reports failure
   (If upload succeeds but node dies immediately...)
2. Pin attempt 1-5 all fail (connection refused)
3. Backup pin attempt fetches data via IPFS → success
4. Final persistence check passes
5. Gateway notified
```

### 5. Both supernode and backup fail

```
1. Upload succeeds → CID `QmNOPE`
2. Supernode pin 5 attempts → all fail
3. Backup pin 5 attempts → all fail
4. Encoder throws a CRITICAL error and reports failure to gateway
5. Job remains retryable once infrastructure is back online
```

## Implementation Checklist

- [x] **Tank Mode Pinning:** 5 retries + verification on each pin attempt
- [x] **Persistence Verification:** Final `verifyContentPersistence` gate before gateway reporting
- [ ] **Multi-node Pinning Fallback:** Try pinning on primary node first, then one or more backups
- [ ] **Async Pin Queue (Optional):** Queue pins so jobs dont block on slow nodes
- [ ] **Redundant Backups:** Pin to *at least* two nodes for high availability
- [ ] **Monitoring:** Alert when pin retries or verification failures spike

## Configuration Suggestions

Add fallback node URLs to configuration (e.g., `.env`):

```
IPFS_PRIMARY_API=https://supernode.3speak.tv:5001
IPFS_BACKUP_APIS=https://ipfs-backup-1:5001,https://ipfs-backup-2:5001
```

If theres only one backup available, pin to both nodes sequentially:

```
await pinToNode(primary, cid)
  .catch(() => pinToNode(backup, cid));
```

With multiple backups, treat the cluster as quorum-based:

```
Successful pin when ≥ 2 nodes confirm pin + verification
```

## Key Takeaways

- **Upload once, pin anywhere:** A CID can be pinned from any node without re-uploading.
- **Supernode + fallback = tank:** Even if the supernode fails, backups keep content alive.
- **Verification is critical:** Always confirm the pin and that the CID is retrievable before reporting success.
- **Scalability path:** Start with one backup, then scale to a cluster with async pin queues and multi-node verification.

Implement this strategy and the encoder will behave like a tank—videos wont get stuck in "finalizing" just because one node had a bad day.
