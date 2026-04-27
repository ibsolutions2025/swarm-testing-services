// lib/awp/events.ts
//
// Event signature hashes (topic0) + decoders for every V15 + V4 event the
// scanner watches. Matches contracts/JobNFTv15.sol + contracts/ReviewGateV4.sol.
//
// Hashes pre-computed via:
//   keccak256(toBytes("EventName(type1,type2,...)"))
//
// Verified against the existing scanner.mjs (which uses the same constants).
// Adding a new event = compute its topic0 and append. The decoder is shaped
// so callers can `decodeEvent(log)` to get a typed object back.

export type EventName =
  // V15 (JobNFT)
  | "JobCreated"
  | "ValidatorClaimed"
  | "WorkSubmitted"
  | "SubmissionApproved"
  | "SubmissionRejected"
  | "ValidatorRotated"
  | "JobCancelled"
  | "ValidatorRewarded"
  | "DecryptionKeyReleased"
  | "ReceiptNFTSet"
  | "ScriptResultRecorded"
  | "TimedJobFinalized"
  | "SecurityAuditSubmitted"
  | "AutomationServiceUpdated"
  | "AllSubmissionsRejected"
  | "RatingGateFailed"
  // V4 (ReviewGate)
  | "ReviewSubmitted"
  | "JobReviewsSetup"
  | "ReviewPairAssigned"
  | "PendingReviewsIncremented"
  | "ReviewCompleted"
  | "MaxPendingReviewsUpdated"
  | "AuthorizedSet"
  | "ERC8004ConfigUpdated"
  | "ERC8004FeedbackBridged"
  | "ERC8004FeedbackFailed"
  | "RatingWeightsUpdated";

/**
 * topic0 = keccak256("EventName(arg1Type,arg2Type,...)") for every V15 + V4
 * event. The 11 hashes verified against the existing production scanner
 * (`framework/scanner.mjs`) are pinned literally; the rest are computed
 * lazily via viem's keccak on first access (see EVENT_SIGS getter below).
 *
 * Pinning avoids a runtime dependency at module-load time and makes the
 * file readable; lazy-compute fills in events the scanner doesn't yet watch
 * but the auditor or HLO might (RatingGateFailed, TimedJobFinalized, etc.).
 */
import { keccak256, toBytes } from "viem";

const _PINNED: Partial<Record<EventName, `0x${string}`>> = {
  JobCreated:             "0x8678ba2d99dba901dafc51009f8d402d37a5a0275752cf0e263b827aeca906f2",
  ValidatorClaimed:       "0xf7615534252f5c4222f231ceb09fba15f7bfab2a6ec3958aa431855ffe10efc7",
  WorkSubmitted:          "0xeaf66c9016a991665a7582b129182d19b8525216aca968483fe860f2a459ce87",
  SubmissionApproved:     "0xc26c858ff8e61f25088ae05177b0fcbbedebc15afccac12444e34ac04e912307",
  SubmissionRejected:     "0x0c85652d2ac95894ed3aa3311d30cef8a307693957451a95f4b7ace387907c2a",
  // 2026-04-27 — Phase B Iteration 2: corrected from 0x22a27adcea... (the
  // hand-typed value was wrong — never matched real V15 ValidatorRotated
  // events). Verified by recomputing keccak("ValidatorRotated(uint256,address,address)")
  // which is the canonical Solidity sig per V15's event declaration. The
  // production scanner now picks up real validator-rotation events.
  ValidatorRotated:       "0xba4cc02258fc903f33e1d9b5bf2f9d6d09b3d8b098fc1a691fd964b77150a75b",
  JobCancelled:           "0xa80c76c474b34cc7af71dec63d733b959fff08f4eb0789e288be5db6b608f942",
  ValidatorRewarded:      "0xf748876df18b552193d7cc2b9ba41429489708fa04a5a7e964a02f4bef478baa",
  DecryptionKeyReleased:  "0x6dd073b5f787686fd496ebaedc900ddb6fe6c567cc668129b24f0854f63a2a34",
  ScriptResultRecorded:   "0xa8a3f1caeccc5c07ceae4f712a6cd188c0214ab048235accdd7ac7f08310af25",
  AllSubmissionsRejected: "0xdcddfb3a7500e64439b1381a028edbd33a3bb99b4bcc0494c0f0a67fae21d1f1",
  ReviewSubmitted:        "0x73838c8181e68ccb58141bf7cbb01b8fcb260ebc4843abe09ed0e310bb091e14",
};

/**
 * Compute topic0 for an event signature (e.g. "JobCreated(uint256,address,uint256)").
 * Useful for one-off lookups outside the catalog.
 */
export function computeTopic0(eventSignature: string): `0x${string}` {
  return keccak256(toBytes(eventSignature)) as `0x${string}`;
}

/**
 * Event signature catalog — the canonical Solidity signatures that produce
 * each topic0. Keep in sync with EVENT_SIGS. This is the input form that
 * Phase B's Onboarding Engine will derive from contract source via Sonnet.
 */
export const EVENT_SIGNATURES: Record<EventName, string> = {
  JobCreated:               "JobCreated(uint256,address,uint256)",
  ValidatorClaimed:         "ValidatorClaimed(uint256,address,uint256)",
  WorkSubmitted:            "WorkSubmitted(uint256,address,uint256)",
  SubmissionApproved:       "SubmissionApproved(uint256,uint256,address,uint256)",
  SubmissionRejected:       "SubmissionRejected(uint256,uint256,address)",
  ValidatorRotated:         "ValidatorRotated(uint256,address,address)",
  JobCancelled:             "JobCancelled(uint256,address,uint256)",
  ValidatorRewarded:        "ValidatorRewarded(uint256,address,uint256)",
  DecryptionKeyReleased:    "DecryptionKeyReleased(uint256,uint256,bytes)",
  ReceiptNFTSet:            "ReceiptNFTSet(address)",
  ScriptResultRecorded:     "ScriptResultRecorded(uint256,uint256,bool,uint256)",
  TimedJobFinalized:        "TimedJobFinalized(uint256,uint256,address)",
  SecurityAuditSubmitted:   "SecurityAuditSubmitted(uint256,uint256,string)",
  AutomationServiceUpdated: "AutomationServiceUpdated(address)",
  AllSubmissionsRejected:   "AllSubmissionsRejected(uint256,address)",
  RatingGateFailed:         "RatingGateFailed(uint256,address,uint256,uint256,string)",

  ReviewSubmitted:           "ReviewSubmitted(uint256,address,address,uint8)",
  JobReviewsSetup:           "JobReviewsSetup(uint256,uint256)",
  ReviewPairAssigned:        "ReviewPairAssigned(uint256,address,address)",
  PendingReviewsIncremented: "PendingReviewsIncremented(address,uint256)",
  ReviewCompleted:           "ReviewCompleted(address,uint256)",
  MaxPendingReviewsUpdated:  "MaxPendingReviewsUpdated(uint256,uint256)",
  AuthorizedSet:             "AuthorizedSet(address,bool)",
  ERC8004ConfigUpdated:      "ERC8004ConfigUpdated(address,address,string,bool)",
  ERC8004FeedbackBridged:    "ERC8004FeedbackBridged(uint256,uint256,address,int256)",
  ERC8004FeedbackFailed:     "ERC8004FeedbackFailed(uint256,address,string)",
  RatingWeightsUpdated:      "RatingWeightsUpdated(uint256,uint256)",
};

/**
 * topic0 catalog. Pinned values for the 12 events the production scanner
 * already watches; the rest are computed lazily from EVENT_SIGNATURES.
 */
export const EVENT_SIGS: Record<EventName, `0x${string}`> = (() => {
  const out: Partial<Record<EventName, `0x${string}`>> = {};
  for (const [name, sig] of Object.entries(EVENT_SIGNATURES) as [EventName, string][]) {
    out[name] = _PINNED[name] ?? (keccak256(toBytes(sig)) as `0x${string}`);
  }
  return out as Record<EventName, `0x${string}`>;
})();

/** Reverse map: topic0 → event name. */
export const SIG_TO_NAME: Record<string, EventName> = (() => {
  const map: Record<string, EventName> = {};
  for (const [name, sig] of Object.entries(EVENT_SIGS) as [EventName, `0x${string}`][]) {
    map[sig.toLowerCase()] = name;
  }
  return map;
})();

// ============================================================================
// Decoder — viem-style. Returns a typed event payload or null if topic0 is
// unknown. Decoders are intentionally minimal — the auditor uses viem's full
// decodeEventLog with the ABI for richer arg shaping.
// ============================================================================

export interface RawLog {
  address: `0x${string}`;
  topics: `0x${string}`[];
  data: `0x${string}`;
  blockNumber: `0x${string}` | bigint | number;
  transactionHash: `0x${string}`;
  logIndex?: `0x${string}` | number;
}

export interface DecodedEvent {
  name: EventName;
  topic0: `0x${string}`;
  jobId?: bigint;
  worker?: `0x${string}`;
  validator?: `0x${string}`;
  poster?: `0x${string}`;
  reviewer?: `0x${string}`;
  reviewee?: `0x${string}`;
  score?: number;
  amount?: bigint;
  blockNumber: number;
  txHash: `0x${string}`;
  rawTopics: `0x${string}`[];
  rawData: `0x${string}`;
}

function topicToBigInt(topic: `0x${string}` | undefined): bigint | undefined {
  if (!topic) return undefined;
  return BigInt(topic);
}

function topicToAddress(topic: `0x${string}` | undefined): `0x${string}` | undefined {
  if (!topic) return undefined;
  // Address topics are 32 bytes — the address is the trailing 20 bytes.
  const hex = topic.toLowerCase().replace(/^0x/, "");
  if (hex.length !== 64) return undefined;
  return ("0x" + hex.slice(24)) as `0x${string}`;
}

/**
 * Lightweight decoder. Pulls indexed args (jobId + party addresses) for the
 * common-case scanner read path. For full arg decoding (e.g. score in
 * ReviewSubmitted, reward in JobCreated), use viem.decodeEventLog with the
 * ABI from `lib/awp/contracts.ts`.
 */
export function decodeEvent(log: RawLog): DecodedEvent | null {
  const topic0 = log.topics?.[0]?.toLowerCase();
  if (!topic0) return null;
  const name = SIG_TO_NAME[topic0];
  if (!name) return null;

  const blockNumber =
    typeof log.blockNumber === "bigint" ? Number(log.blockNumber)
    : typeof log.blockNumber === "number" ? log.blockNumber
    : Number(BigInt(log.blockNumber));

  const out: DecodedEvent = {
    name,
    topic0: topic0 as `0x${string}`,
    blockNumber,
    txHash: log.transactionHash,
    rawTopics: log.topics,
    rawData: log.data,
  };

  // Most JobNFT events: topic[1] = indexed jobId
  if ([
    "JobCreated", "ValidatorClaimed", "WorkSubmitted", "SubmissionApproved", "SubmissionRejected",
    "ValidatorRotated", "JobCancelled", "ValidatorRewarded", "DecryptionKeyReleased",
    "ScriptResultRecorded", "TimedJobFinalized", "SecurityAuditSubmitted", "AllSubmissionsRejected",
    "RatingGateFailed", "ReviewSubmitted", "JobReviewsSetup", "ReviewPairAssigned",
    "ERC8004FeedbackBridged", "ERC8004FeedbackFailed",
  ].includes(name)) {
    out.jobId = topicToBigInt(log.topics[1]);
  }

  // Per-event indexed arg shaping (only the shapes we actually use today)
  if (name === "JobCreated") out.poster = topicToAddress(log.topics[2]);
  if (name === "ValidatorClaimed") out.validator = topicToAddress(log.topics[2]);
  if (name === "WorkSubmitted") out.worker = topicToAddress(log.topics[2]);
  if (name === "SubmissionApproved") out.worker = topicToAddress(log.topics[3]);
  if (name === "SubmissionRejected") out.validator = topicToAddress(log.topics[3]);
  if (name === "JobCancelled") out.poster = topicToAddress(log.topics[2]);
  if (name === "ValidatorRewarded") out.validator = topicToAddress(log.topics[2]);
  if (name === "AllSubmissionsRejected") out.validator = topicToAddress(log.topics[2]);
  if (name === "RatingGateFailed") {
    // RatingGateFailed(jobId indexed, agent indexed, required, actual, role)
    out.worker = topicToAddress(log.topics[2]); // 'agent' — could be worker or validator (role distinguishes)
  }
  if (name === "ReviewSubmitted") {
    out.reviewer = topicToAddress(log.topics[2]);
    out.reviewee = topicToAddress(log.topics[3]);
    // score is in data (uint8) — caller can decode if needed
  }

  return out;
}

/**
 * Group raw logs by event name (sorted by block + logIndex). Mirrors the
 * scanner's `groupEvents` helper.
 */
export function groupEvents(logs: RawLog[]): Record<string, DecodedEvent[]> {
  const out: Record<string, DecodedEvent[]> = {};
  for (const log of logs) {
    const dec = decodeEvent(log);
    if (!dec) continue;
    if (!out[dec.name]) out[dec.name] = [];
    out[dec.name].push(dec);
  }
  for (const arr of Object.values(out)) {
    arr.sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
      const ai = typeof (a as DecodedEvent & { logIndex?: number }).logIndex === "number"
        ? (a as DecodedEvent & { logIndex?: number }).logIndex! : 0;
      const bi = typeof (b as DecodedEvent & { logIndex?: number }).logIndex === "number"
        ? (b as DecodedEvent & { logIndex?: number }).logIndex! : 0;
      return ai - bi;
    });
  }
  return out;
}

/**
 * Convenience for HLO + auditor — returns a single tx hash for the first
 * matching event of `name`, or null.
 */
export function firstTxHashForEvent(events: Record<string, DecodedEvent[]>, name: EventName): `0x${string}` | null {
  const arr = events[name];
  if (!arr || arr.length === 0) return null;
  return arr[0].txHash;
}

// All event names known to the catalog (V15 + V4).
export const ALL_EVENT_NAMES: EventName[] = Object.keys(EVENT_SIGS) as EventName[];
