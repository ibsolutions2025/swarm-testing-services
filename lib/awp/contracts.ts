// ─── Contract Addresses (Base Sepolia) ───────────────────────────────────────

// CANONICAL — Base Sepolia (chainId 84532)
// V15 + V4 deployed 2026-04-24. All prior versions (V1-V14 JobNFT, V1/V2/V3 ReviewGate) are DEAD — never use.
// V15 deltas vs V14: rejectAllSubmissions non-terminal (C1), cancelJob gate relaxed (C2), poster cannot reject (C3),
// HARD_ONLY rejects validator-axis config (C4), rating gates contract-enforced via ReviewGate.getAgentRating (C5),
// finalizeTimedJob handles all-failed scripts (C6 zombie-job fix). createJob is now 20 args (added minWorkerRating + minValidatorRating).
// See skills/awp-contract-upgrade for the deploy playbook.
export const CONTRACT_ADDRESSES = {
  MockUSDC: '0x7ae8519d5fb7be655be9846553a595de8e00c209' as `0x${string}`,
  JobNFT: '0xc95ed85a6722399ee8eaa878adec79a8bea3c895' as `0x${string}`,  // V15 — rating gates + zombie-job fix (2026-04-24)
  JobNFTv12: '0xc95ed85a6722399ee8eaa878adec79a8bea3c895' as `0x${string}`,  // DEPRECATED ALIAS — points to V15 to avoid breaking callers; migrate callers to JobNFT and remove.
  ReceiptNFT: '0xbb481ef7017afa04594689b24c95cbd1fb0bde01' as `0x${string}`,
  AWPToken: '0xb7e507de72cc7a519a0a553a8b6b118db353a1a8' as `0x${string}`,
  AWPEmissions: '0x250040Bdd19720f09A2564994cdE7fc942c44a1E' as `0x${string}`,
  // Official ERC-8004 Registry (Base Sepolia) - replaces legacy AgentIdentityRegistry
  ERC8004Registry: '0x8004A818BFB912233c491871b3d84c89A494BD9e' as `0x${string}`,
  ERC8004ReputationRegistry: '0x8004B663056A597Dffe9eCcC1965A193B7388713' as `0x${string}`,
  // Legacy custom registry (deprecated - use ERC8004Registry instead)
  AgentIdentityRegistry: '0xb5b9db1765f320b2e49e8d0435bd10c473372960' as `0x${string}`,
  ReputationRegistry: '0x32a5c6cf123d99ae5ac8f04d774210c3604bc993' as `0x${string}`,
  ReviewGate: '0x7856191147766f4421aaa312def42a885820550d' as `0x${string}`,  // V4 — getAgentRating + ERC-8004 blend (2026-04-24)
} as const;

// ─── MockUSDC ABI ────────────────────────────────────────────────────────────

export const MOCK_USDC_ABI = [
  { name: 'mint', type: 'function' as const, stateMutability: 'nonpayable' as const, inputs: [{ name: 'to', type: 'address' as const }, { name: 'amount', type: 'uint256' as const }], outputs: [] },
  { name: 'approve', type: 'function' as const, stateMutability: 'nonpayable' as const, inputs: [{ name: 'spender', type: 'address' as const }, { name: 'value', type: 'uint256' as const }], outputs: [{ name: '', type: 'bool' as const }] },
  { name: 'allowance', type: 'function' as const, stateMutability: 'view' as const, inputs: [{ name: 'owner', type: 'address' as const }, { name: 'spender', type: 'address' as const }], outputs: [{ name: '', type: 'uint256' as const }] },
  { name: 'balanceOf', type: 'function' as const, stateMutability: 'view' as const, inputs: [{ name: 'account', type: 'address' as const }], outputs: [{ name: '', type: 'uint256' as const }] },
  { name: 'decimals', type: 'function' as const, stateMutability: 'view' as const, inputs: [], outputs: [{ name: '', type: 'uint8' as const }] },
  { name: 'transfer', type: 'function' as const, stateMutability: 'nonpayable' as const, inputs: [{ name: 'to', type: 'address' as const }, { name: 'value', type: 'uint256' as const }], outputs: [{ name: '', type: 'bool' as const }] },
  { name: 'transferFrom', type: 'function' as const, stateMutability: 'nonpayable' as const, inputs: [{ name: 'from', type: 'address' as const }, { name: 'to', type: 'address' as const }, { name: 'value', type: 'uint256' as const }], outputs: [{ name: '', type: 'bool' as const }] },
  { name: 'totalSupply', type: 'function' as const, stateMutability: 'view' as const, inputs: [], outputs: [{ name: '', type: 'uint256' as const }] },
  { name: 'Transfer', type: 'event' as const, inputs: [{ name: 'from', type: 'address' as const, indexed: true }, { name: 'to', type: 'address' as const, indexed: true }, { name: 'value', type: 'uint256' as const, indexed: false }] },
  { name: 'Approval', type: 'event' as const, inputs: [{ name: 'owner', type: 'address' as const, indexed: true }, { name: 'spender', type: 'address' as const, indexed: true }, { name: 'value', type: 'uint256' as const, indexed: false }] },
] as const;

// ─── JobNFT V15 ABI (V14 + rating gates + zombie-job fix + 71 named errors) ───
// Validation Modes (uint8):
//   0 = HARD_ONLY - Automated script validation only, no human validator needed
//   1 = SOFT_ONLY - Human validator only, no script validation
//   2 = HARD_THEN_SOFT - Script validation first, then human validator (if script passes)
// Submission Modes (uint8):
//   0 = FCFS (First-Come-First-Served) - First passing submission wins
//   1 = TIMED - Submissions collected during window, highest score wins
//
// V15 (0xc95ed85a6722399ee8eaa878adec79a8bea3c895, deployed 2026-04-24):
// - createJob has 20 params (V14 had 18); appended minWorkerRating_ + minValidatorRating_
// - Rating gates enforced at submitWork + claimJobAsValidator via ReviewGate.getAgentRating
//   (requires reviewCount >= MIN_REVIEWS_FOR_RATING_GATE = 3)
// - HARD_ONLY createJob reverts if minValidatorRating != 0 OR approvedValidators.length != 0 (C4)
// - rejectAllSubmissions does NOT cancel the job (C1) — poster must call cancelJob separately
// - cancelJob requires every submission to be Rejected (was: zero submissions) (C2)
// - Only activeValidator can reject — poster cannot (C3)
// - finalizeTimedJob with zero passing scripts cancels + refunds (C6 zombie-job fix)
// - getJobV15 returns 24 fields (V14 getJobV12 returned 22; appended minWorkerRating + minValidatorRating)
// - getSubmissionV11 replaces getSubmissionFull/getSubmission

export const JOB_NFT_ABI = [
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "_usdcToken",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "_awpToken",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "_receiptNFT",
        "type": "address"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "constructor"
  },
  {
    "inputs": [],
    "name": "AlreadyActiveValidator",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "AlreadyFinalized",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "AlreadyInWaitlist",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "AlreadyReviewed",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "AlreadyServed",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "DeliverableRequired",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "DescriptionRequired",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "sender",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "tokenId",
        "type": "uint256"
      },
      {
        "internalType": "address",
        "name": "owner",
        "type": "address"
      }
    ],
    "name": "ERC721IncorrectOwner",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "operator",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "tokenId",
        "type": "uint256"
      }
    ],
    "name": "ERC721InsufficientApproval",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "approver",
        "type": "address"
      }
    ],
    "name": "ERC721InvalidApprover",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "operator",
        "type": "address"
      }
    ],
    "name": "ERC721InvalidOperator",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "owner",
        "type": "address"
      }
    ],
    "name": "ERC721InvalidOwner",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "receiver",
        "type": "address"
      }
    ],
    "name": "ERC721InvalidReceiver",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "sender",
        "type": "address"
      }
    ],
    "name": "ERC721InvalidSender",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "tokenId",
        "type": "uint256"
      }
    ],
    "name": "ERC721NonexistentToken",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "FormerValidatorCannotSubmit",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "HardOnlyApprovedVal",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "HardOnlyValRating",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "HasPendingOrApproved",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InstructionsRequired",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InsufficientAllowance",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InsufficientBalance",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidSubmissionIndex",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidSubmissionMode",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidValidationMode",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "JobNotActive",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "JobNotCancellable",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "JobNotFound",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "JobNotOpenForSubmissions",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "JobNotOpenForValidators",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NoActiveValidator",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NoScriptSoftOnly",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NoSubmissionsToReject",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NoSubmissionsYet",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NoValidatorHardOnly",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NoValidatorNeeded",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotApprovedValidator",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotApprovedWorker",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotTimed",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "OnlyActiveValidator",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "OnlyActiveValidatorOnly",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "OnlyActiveValidatorReject",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "OnlyAutomation",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "OnlyPoster",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "owner",
        "type": "address"
      }
    ],
    "name": "OwnableInvalidOwner",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "account",
        "type": "address"
      }
    ],
    "name": "OwnableUnauthorizedAccount",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "PosterCannotSubmit",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "PosterCannotValidate",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "RatingGateNoReviewGate",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "RefundFailed",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "RejectAllNotAllowed",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "RequirementsRequired",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ResubmissionNotAllowed",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "RewardZero",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ScriptCIDNotAllowed",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ScriptCIDRequired",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ScriptValidationRequired",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "SecurityAuditRequired",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "SubmissionAlreadyReviewed",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "SubmissionWindowStillOpen",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "TitleRequired",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "TokenNotFound",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "TransferFailed",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "TransferFromFailed",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ValidatorCannotSubmit",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "WindowClosed",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "WindowMustBeZero",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "WindowRequiredTimed",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "WindowStillOpen",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "WorkerCannotValidate",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "WorkerTransferFailed",
    "type": "error"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "uint256",
        "name": "jobId",
        "type": "uint256"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "validator",
        "type": "address"
      }
    ],
    "name": "AllSubmissionsRejected",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "owner",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "approved",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "uint256",
        "name": "tokenId",
        "type": "uint256"
      }
    ],
    "name": "Approval",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "owner",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "operator",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "bool",
        "name": "approved",
        "type": "bool"
      }
    ],
    "name": "ApprovalForAll",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "newService",
        "type": "address"
      }
    ],
    "name": "AutomationServiceUpdated",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "uint256",
        "name": "jobId",
        "type": "uint256"
      },
      {
        "indexed": true,
        "internalType": "uint256",
        "name": "submissionIndex",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "bytes",
        "name": "decryptionKey",
        "type": "bytes"
      }
    ],
    "name": "DecryptionKeyReleased",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "uint256",
        "name": "jobId",
        "type": "uint256"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "poster",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "refundAmount",
        "type": "uint256"
      }
    ],
    "name": "JobCancelled",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "uint256",
        "name": "jobId",
        "type": "uint256"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "poster",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "reward",
        "type": "uint256"
      }
    ],
    "name": "JobCreated",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "previousOwner",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "newOwner",
        "type": "address"
      }
    ],
    "name": "OwnershipTransferred",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "uint256",
        "name": "jobId",
        "type": "uint256"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "agent",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "required",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "actual",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "string",
        "name": "role",
        "type": "string"
      }
    ],
    "name": "RatingGateFailed",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "receiptNFT",
        "type": "address"
      }
    ],
    "name": "ReceiptNFTSet",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "uint256",
        "name": "jobId",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "submissionIndex",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "bool",
        "name": "passed",
        "type": "bool"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "score",
        "type": "uint256"
      }
    ],
    "name": "ScriptResultRecorded",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "uint256",
        "name": "jobId",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "submissionIndex",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "string",
        "name": "auditCID",
        "type": "string"
      }
    ],
    "name": "SecurityAuditSubmitted",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "uint256",
        "name": "jobId",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "submissionIndex",
        "type": "uint256"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "worker",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "reward",
        "type": "uint256"
      }
    ],
    "name": "SubmissionApproved",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "uint256",
        "name": "jobId",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "submissionIndex",
        "type": "uint256"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "validator",
        "type": "address"
      }
    ],
    "name": "SubmissionRejected",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "uint256",
        "name": "jobId",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "winnerIndex",
        "type": "uint256"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "winner",
        "type": "address"
      }
    ],
    "name": "TimedJobFinalized",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "from",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "to",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "uint256",
        "name": "tokenId",
        "type": "uint256"
      }
    ],
    "name": "Transfer",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "uint256",
        "name": "jobId",
        "type": "uint256"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "validator",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "waitlistPosition",
        "type": "uint256"
      }
    ],
    "name": "ValidatorClaimed",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "uint256",
        "name": "jobId",
        "type": "uint256"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "validator",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "awpAmount",
        "type": "uint256"
      }
    ],
    "name": "ValidatorRewarded",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "uint256",
        "name": "jobId",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "oldValidator",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "newValidator",
        "type": "address"
      }
    ],
    "name": "ValidatorRotated",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "uint256",
        "name": "jobId",
        "type": "uint256"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "worker",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "submissionIndex",
        "type": "uint256"
      }
    ],
    "name": "WorkSubmitted",
    "type": "event"
  },
  {
    "inputs": [],
    "name": "MIN_REVIEWS_FOR_RATING_GATE",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "to",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "tokenId",
        "type": "uint256"
      }
    ],
    "name": "approve",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "jobId",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "submissionIndex",
        "type": "uint256"
      },
      {
        "internalType": "bytes",
        "name": "decryptionKey",
        "type": "bytes"
      }
    ],
    "name": "approveSubmission",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "jobId",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "submissionIndex",
        "type": "uint256"
      },
      {
        "internalType": "bytes",
        "name": "decryptionKey",
        "type": "bytes"
      },
      {
        "internalType": "string",
        "name": "securityAuditCID",
        "type": "string"
      }
    ],
    "name": "approveSubmission",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "automationService",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "awpToken",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "owner",
        "type": "address"
      }
    ],
    "name": "balanceOf",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "jobId",
        "type": "uint256"
      }
    ],
    "name": "cancelJob",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "jobId",
        "type": "uint256"
      }
    ],
    "name": "claimJobAsValidator",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "string",
        "name": "title",
        "type": "string"
      },
      {
        "internalType": "string",
        "name": "description",
        "type": "string"
      },
      {
        "internalType": "string",
        "name": "requirementsJson",
        "type": "string"
      },
      {
        "internalType": "uint256",
        "name": "rewardAmount",
        "type": "uint256"
      },
      {
        "internalType": "bool",
        "name": "openValidation",
        "type": "bool"
      },
      {
        "internalType": "address[]",
        "name": "approvedValidators",
        "type": "address[]"
      },
      {
        "internalType": "uint256",
        "name": "validatorTimeoutSeconds",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "claimWindowHours_",
        "type": "uint256"
      },
      {
        "internalType": "uint8",
        "name": "validationMode_",
        "type": "uint8"
      },
      {
        "internalType": "uint8",
        "name": "submissionMode_",
        "type": "uint8"
      },
      {
        "internalType": "uint256",
        "name": "submissionWindow_",
        "type": "uint256"
      },
      {
        "internalType": "string",
        "name": "validationScriptCID_",
        "type": "string"
      },
      {
        "internalType": "bool",
        "name": "requireSecurityAudit_",
        "type": "bool"
      },
      {
        "internalType": "string",
        "name": "securityAuditTemplate_",
        "type": "string"
      },
      {
        "internalType": "bool",
        "name": "allowResubmission_",
        "type": "bool"
      },
      {
        "internalType": "bool",
        "name": "allowRejectAll_",
        "type": "bool"
      },
      {
        "internalType": "address[]",
        "name": "approvedWorkers_",
        "type": "address[]"
      },
      {
        "internalType": "string",
        "name": "validationInstructions_",
        "type": "string"
      },
      {
        "internalType": "uint256",
        "name": "minWorkerRating_",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "minValidatorRating_",
        "type": "uint256"
      }
    ],
    "name": "createJob",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "jobId",
        "type": "uint256"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "jobId",
        "type": "uint256"
      }
    ],
    "name": "finalizeTimedJob",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "tokenId",
        "type": "uint256"
      }
    ],
    "name": "getApproved",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "jobId",
        "type": "uint256"
      }
    ],
    "name": "getJobV15",
    "outputs": [
      {
        "internalType": "address",
        "name": "poster",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "reward",
        "type": "uint256"
      },
      {
        "internalType": "uint8",
        "name": "status",
        "type": "uint8"
      },
      {
        "internalType": "address",
        "name": "activeValidator",
        "type": "address"
      },
      {
        "internalType": "address[]",
        "name": "validatorWaitlist",
        "type": "address[]"
      },
      {
        "internalType": "uint256",
        "name": "validatorTimeout",
        "type": "uint256"
      },
      {
        "internalType": "bool",
        "name": "openValidation",
        "type": "bool"
      },
      {
        "internalType": "string",
        "name": "title",
        "type": "string"
      },
      {
        "internalType": "string",
        "name": "description",
        "type": "string"
      },
      {
        "internalType": "string",
        "name": "requirementsJson",
        "type": "string"
      },
      {
        "internalType": "uint256",
        "name": "claimWindowHours",
        "type": "uint256"
      },
      {
        "internalType": "uint8",
        "name": "validationMode",
        "type": "uint8"
      },
      {
        "internalType": "uint8",
        "name": "submissionMode",
        "type": "uint8"
      },
      {
        "internalType": "uint256",
        "name": "submissionWindow",
        "type": "uint256"
      },
      {
        "internalType": "string",
        "name": "validationScriptCID",
        "type": "string"
      },
      {
        "internalType": "bool",
        "name": "requireSecurityAudit",
        "type": "bool"
      },
      {
        "internalType": "string",
        "name": "securityAuditTemplate",
        "type": "string"
      },
      {
        "internalType": "uint256",
        "name": "submissionDeadline",
        "type": "uint256"
      },
      {
        "internalType": "bool",
        "name": "allowResubmission",
        "type": "bool"
      },
      {
        "internalType": "bool",
        "name": "allowRejectAll",
        "type": "bool"
      },
      {
        "internalType": "address[]",
        "name": "approvedWorkers",
        "type": "address[]"
      },
      {
        "internalType": "string",
        "name": "validationInstructions",
        "type": "string"
      },
      {
        "internalType": "uint256",
        "name": "minWorkerRating",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "minValidatorRating",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "jobId",
        "type": "uint256"
      }
    ],
    "name": "getSubmissionCount",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "jobId",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "index",
        "type": "uint256"
      }
    ],
    "name": "getSubmissionV11",
    "outputs": [
      {
        "internalType": "address",
        "name": "worker",
        "type": "address"
      },
      {
        "internalType": "string",
        "name": "deliverableUrl",
        "type": "string"
      },
      {
        "internalType": "bytes32",
        "name": "encryptedDeliverableHash",
        "type": "bytes32"
      },
      {
        "internalType": "uint256",
        "name": "timestamp",
        "type": "uint256"
      },
      {
        "internalType": "uint8",
        "name": "status",
        "type": "uint8"
      },
      {
        "internalType": "bytes",
        "name": "decryptionKey",
        "type": "bytes"
      },
      {
        "internalType": "bytes32",
        "name": "scriptResultHash",
        "type": "bytes32"
      },
      {
        "internalType": "uint256",
        "name": "scriptScore",
        "type": "uint256"
      },
      {
        "internalType": "bool",
        "name": "scriptPassed",
        "type": "bool"
      },
      {
        "internalType": "string",
        "name": "securityAuditCID",
        "type": "string"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      },
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "name": "hasBeenValidator",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "owner",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "operator",
        "type": "address"
      }
    ],
    "name": "isApprovedForAll",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "jobId",
        "type": "uint256"
      },
      {
        "internalType": "address",
        "name": "worker",
        "type": "address"
      }
    ],
    "name": "isApprovedWorker",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "jobCount",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "name": "jobSubmissions",
    "outputs": [
      {
        "internalType": "address",
        "name": "worker",
        "type": "address"
      },
      {
        "internalType": "string",
        "name": "deliverableUrl",
        "type": "string"
      },
      {
        "internalType": "bytes32",
        "name": "encryptedDeliverableHash",
        "type": "bytes32"
      },
      {
        "internalType": "uint256",
        "name": "timestamp",
        "type": "uint256"
      },
      {
        "internalType": "uint8",
        "name": "status",
        "type": "uint8"
      },
      {
        "internalType": "bytes",
        "name": "decryptionKey",
        "type": "bytes"
      },
      {
        "internalType": "bytes32",
        "name": "scriptResultHash",
        "type": "bytes32"
      },
      {
        "internalType": "uint256",
        "name": "scriptScore",
        "type": "uint256"
      },
      {
        "internalType": "bool",
        "name": "scriptPassed",
        "type": "bool"
      },
      {
        "internalType": "string",
        "name": "securityAuditCID",
        "type": "string"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "name": "jobs",
    "outputs": [
      {
        "internalType": "address",
        "name": "poster",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "reward",
        "type": "uint256"
      },
      {
        "internalType": "enum JobNFT.JobStatus",
        "name": "status",
        "type": "uint8"
      },
      {
        "internalType": "address",
        "name": "activeValidator",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "validatorTimeout",
        "type": "uint256"
      },
      {
        "internalType": "bool",
        "name": "openValidation",
        "type": "bool"
      },
      {
        "internalType": "string",
        "name": "title",
        "type": "string"
      },
      {
        "internalType": "string",
        "name": "description",
        "type": "string"
      },
      {
        "internalType": "string",
        "name": "requirementsJson",
        "type": "string"
      },
      {
        "internalType": "uint256",
        "name": "claimWindowHours",
        "type": "uint256"
      },
      {
        "internalType": "uint8",
        "name": "validationMode",
        "type": "uint8"
      },
      {
        "internalType": "uint8",
        "name": "submissionMode",
        "type": "uint8"
      },
      {
        "internalType": "uint256",
        "name": "submissionWindow",
        "type": "uint256"
      },
      {
        "internalType": "string",
        "name": "validationScriptCID",
        "type": "string"
      },
      {
        "internalType": "bool",
        "name": "requireSecurityAudit",
        "type": "bool"
      },
      {
        "internalType": "string",
        "name": "securityAuditTemplate",
        "type": "string"
      },
      {
        "internalType": "uint256",
        "name": "submissionDeadline",
        "type": "uint256"
      },
      {
        "internalType": "bool",
        "name": "allowResubmission",
        "type": "bool"
      },
      {
        "internalType": "bool",
        "name": "allowRejectAll",
        "type": "bool"
      },
      {
        "internalType": "string",
        "name": "validationInstructions",
        "type": "string"
      },
      {
        "internalType": "uint256",
        "name": "minWorkerRating",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "minValidatorRating",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "name",
    "outputs": [
      {
        "internalType": "string",
        "name": "",
        "type": "string"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "owner",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "tokenId",
        "type": "uint256"
      }
    ],
    "name": "ownerOf",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      },
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "name": "pastValidators",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "receiptNFT",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "jobId",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "submissionIndex",
        "type": "uint256"
      },
      {
        "internalType": "bool",
        "name": "passed",
        "type": "bool"
      },
      {
        "internalType": "uint256",
        "name": "score",
        "type": "uint256"
      },
      {
        "internalType": "bytes32",
        "name": "resultHash",
        "type": "bytes32"
      }
    ],
    "name": "recordScriptResult",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "jobId",
        "type": "uint256"
      }
    ],
    "name": "rejectAllSubmissions",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "jobId",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "submissionIndex",
        "type": "uint256"
      }
    ],
    "name": "rejectSubmission",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "renounceOwnership",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "reviewGate",
    "outputs": [
      {
        "internalType": "contract IReviewGateV4",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "jobId",
        "type": "uint256"
      }
    ],
    "name": "rotateValidator",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "from",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "to",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "tokenId",
        "type": "uint256"
      }
    ],
    "name": "safeTransferFrom",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "from",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "to",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "tokenId",
        "type": "uint256"
      },
      {
        "internalType": "bytes",
        "name": "data",
        "type": "bytes"
      }
    ],
    "name": "safeTransferFrom",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "operator",
        "type": "address"
      },
      {
        "internalType": "bool",
        "name": "approved",
        "type": "bool"
      }
    ],
    "name": "setApprovalForAll",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "_svc",
        "type": "address"
      }
    ],
    "name": "setAutomationService",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "_receiptNFT",
        "type": "address"
      }
    ],
    "name": "setReceiptNFT",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "_reviewGate",
        "type": "address"
      }
    ],
    "name": "setReviewGate",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      }
    ],
    "name": "setValidatorRewardAmount",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "jobId",
        "type": "uint256"
      },
      {
        "internalType": "string",
        "name": "deliverableUrl",
        "type": "string"
      },
      {
        "internalType": "bytes32",
        "name": "encryptedDeliverableHash",
        "type": "bytes32"
      }
    ],
    "name": "submitWork",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "submissionIndex",
        "type": "uint256"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes4",
        "name": "interfaceId",
        "type": "bytes4"
      }
    ],
    "name": "supportsInterface",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "symbol",
    "outputs": [
      {
        "internalType": "string",
        "name": "",
        "type": "string"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "tokenId",
        "type": "uint256"
      }
    ],
    "name": "tokenURI",
    "outputs": [
      {
        "internalType": "string",
        "name": "",
        "type": "string"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "from",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "to",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "tokenId",
        "type": "uint256"
      }
    ],
    "name": "transferFrom",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "newOwner",
        "type": "address"
      }
    ],
    "name": "transferOwnership",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "usdcToken",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "name": "validatorAssignedAt",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "validatorRewardAmount",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  }
] as const;

// ═══ ReceiptNFT ABI ════════════════════════════════════════════════════════

export const RECEIPT_NFT_ABI = [
  {
    name: 'mintReceipt',
    type: 'function' as const,
    stateMutability: 'nonpayable' as const,
    inputs: [
      { name: 'to', type: 'address' as const },
      { name: 'jobId', type: 'uint256' as const },
      { name: 'role', type: 'string' as const },
      { name: 'amount', type: 'uint256' as const },
      { name: 'tokenSymbol', type: 'string' as const },
    ],
    outputs: [{ name: 'receiptId', type: 'uint256' as const }],
  },
  {
    name: 'receiptCount',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [],
    outputs: [{ name: '', type: 'uint256' as const }],
  },
  {
    name: 'receipts',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [{ name: 'tokenId', type: 'uint256' as const }],
    outputs: [
      { name: 'recipient', type: 'address' as const },
      { name: 'jobId', type: 'uint256' as const },
      { name: 'role', type: 'string' as const },
      { name: 'amount', type: 'uint256' as const },
      { name: 'tokenSymbol', type: 'string' as const },
      { name: 'timestamp', type: 'uint256' as const },
    ],
  },
  {
    name: 'tokenURI',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [{ name: 'tokenId', type: 'uint256' as const }],
    outputs: [{ name: '', type: 'string' as const }],
  },
  {
    name: 'balanceOf',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [{ name: 'owner', type: 'address' as const }],
    outputs: [{ name: '', type: 'uint256' as const }],
  },
  {
    name: 'ownerOf',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [{ name: 'tokenId', type: 'uint256' as const }],
    outputs: [{ name: '', type: 'address' as const }],
  },
  {
    name: 'getReceiptsByRecipient',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [
      { name: 'recipient', type: 'address' as const },
      { name: 'fromId', type: 'uint256' as const },
      { name: 'toId', type: 'uint256' as const },
    ],
    outputs: [{ name: 'ids', type: 'uint256[]' as const }],
  },
  {
    name: 'ReceiptMinted',
    type: 'event' as const,
    inputs: [
      { name: 'receiptId', type: 'uint256' as const, indexed: true },
      { name: 'recipient', type: 'address' as const, indexed: true },
      { name: 'jobId', type: 'uint256' as const, indexed: true },
      { name: 'role', type: 'string' as const, indexed: false },
    ],
  },
] as const;

// ─── AWP Token ABI ────────────────────────────────────────────────────────────

export const AWP_TOKEN_ABI = [
  { name: 'mint', type: 'function' as const, stateMutability: 'nonpayable' as const, inputs: [{ name: 'to', type: 'address' as const }, { name: 'amount', type: 'uint256' as const }], outputs: [] },
  { name: 'balanceOf', type: 'function' as const, stateMutability: 'view' as const, inputs: [{ name: 'account', type: 'address' as const }], outputs: [{ name: '', type: 'uint256' as const }] },
  { name: 'approve', type: 'function' as const, stateMutability: 'nonpayable' as const, inputs: [{ name: 'spender', type: 'address' as const }, { name: 'value', type: 'uint256' as const }], outputs: [{ name: '', type: 'bool' as const }] },
  { name: 'transfer', type: 'function' as const, stateMutability: 'nonpayable' as const, inputs: [{ name: 'to', type: 'address' as const }, { name: 'value', type: 'uint256' as const }], outputs: [{ name: '', type: 'bool' as const }] },
  { name: 'allowance', type: 'function' as const, stateMutability: 'view' as const, inputs: [{ name: 'owner', type: 'address' as const }, { name: 'spender', type: 'address' as const }], outputs: [{ name: '', type: 'uint256' as const }] },
  { name: 'totalSupply', type: 'function' as const, stateMutability: 'view' as const, inputs: [], outputs: [{ name: '', type: 'uint256' as const }] },
  { name: 'decimals', type: 'function' as const, stateMutability: 'view' as const, inputs: [], outputs: [{ name: '', type: 'uint8' as const }] },
  { name: 'Transfer', type: 'event' as const, inputs: [{ name: 'from', type: 'address' as const, indexed: true }, { name: 'to', type: 'address' as const, indexed: true }, { name: 'value', type: 'uint256' as const, indexed: false }] },
] as const;

// ─── AWP Emissions ABI ────────────────────────────────────────────────────────

export const AWP_EMISSIONS_ABI = [
  // Write functions - onlyAuthorized
  {
    name: 'allocateForJob',
    type: 'function' as const,
    stateMutability: 'nonpayable' as const,
    inputs: [{ name: 'jobId', type: 'uint256' as const }, { name: 'usdcReward', type: 'uint256' as const }],
    outputs: [{ name: '', type: 'uint256' as const }],
  },
  {
    name: 'releaseToValidator',
    type: 'function' as const,
    stateMutability: 'nonpayable' as const,
    inputs: [{ name: 'jobId', type: 'uint256' as const }, { name: 'validator', type: 'address' as const }],
    outputs: [],
  },
  {
    name: 'returnToTreasury',
    type: 'function' as const,
    stateMutability: 'nonpayable' as const,
    inputs: [{ name: 'jobId', type: 'uint256' as const }],
    outputs: [],
  },
  // Write functions - onlyOwner
  {
    name: 'setJobNFT',
    type: 'function' as const,
    stateMutability: 'nonpayable' as const,
    inputs: [{ name: '_jobNFT', type: 'address' as const }],
    outputs: [],
  },
  // Write functions - anyone (requires prior approval)
  {
    name: 'depositAWP',
    type: 'function' as const,
    stateMutability: 'nonpayable' as const,
    inputs: [{ name: 'amount', type: 'uint256' as const }],
    outputs: [],
  },
  // View functions
  {
    name: 'treasuryBalance',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [],
    outputs: [{ name: '', type: 'uint256' as const }],
  },
  {
    name: 'getJobAllocation',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [{ name: 'jobId', type: 'uint256' as const }],
    outputs: [{ name: '', type: 'uint256' as const }],
  },
  {
    name: 'getEffectiveReward',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [{ name: 'usdcReward', type: 'uint256' as const }],
    outputs: [{ name: '', type: 'uint256' as const }],
  },
  {
    name: 'totalEmitted',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [],
    outputs: [{ name: '', type: 'uint256' as const }],
  },
  {
    name: 'totalAllocated',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [],
    outputs: [{ name: '', type: 'uint256' as const }],
  },
  {
    name: 'epochEmitted',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [],
    outputs: [{ name: '', type: 'uint256' as const }],
  },
  {
    name: 'maxEmissionPerEpoch',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [],
    outputs: [{ name: '', type: 'uint256' as const }],
  },
  {
    name: 'currentEpoch',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [],
    outputs: [{ name: '', type: 'uint256' as const }],
  },
  {
    name: 'baseValidatorReward',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [],
    outputs: [{ name: '', type: 'uint256' as const }],
  },
  // Events
  {
    name: 'AWPAllocated',
    type: 'event' as const,
    inputs: [
      { name: 'jobId', type: 'uint256' as const, indexed: true },
      { name: 'amount', type: 'uint256' as const, indexed: false },
    ],
  },
  {
    name: 'AWPReleased',
    type: 'event' as const,
    inputs: [
      { name: 'jobId', type: 'uint256' as const, indexed: true },
      { name: 'validator', type: 'address' as const, indexed: true },
      { name: 'amount', type: 'uint256' as const, indexed: false },
    ],
  },
] as const;


// ─── Official ERC-8004 Registry ABI ───────────────────────────────────────────

export const ERC8004_REGISTRY_ABI = [
  {
    name: 'register',
    type: 'function' as const,
    stateMutability: 'nonpayable' as const,
    inputs: [{ name: '_tokenURI', type: 'string' as const }],
    outputs: [{ name: '', type: 'uint256' as const }],
  },
  {
    name: 'balanceOf',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [{ name: 'owner', type: 'address' as const }],
    outputs: [{ name: '', type: 'uint256' as const }],
  },
  {
    name: 'tokenOfOwnerByIndex',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [{ name: 'owner', type: 'address' as const }, { name: 'index', type: 'uint256' as const }],
    outputs: [{ name: '', type: 'uint256' as const }],
  },
  {
    name: 'ownerOf',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [{ name: 'tokenId', type: 'uint256' as const }],
    outputs: [{ name: '', type: 'address' as const }],
  },
  {
    name: 'tokenURI',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [{ name: 'tokenId', type: 'uint256' as const }],
    outputs: [{ name: '', type: 'string' as const }],
  },
  {
    name: 'totalSupply',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [],
    outputs: [{ name: '', type: 'uint256' as const }],
  },
  {
    name: 'Transfer',
    type: 'event' as const,
    inputs: [
      { name: 'from', type: 'address' as const, indexed: true },
      { name: 'to', type: 'address' as const, indexed: true },
      { name: 'tokenId', type: 'uint256' as const, indexed: true },
    ],
  },
] as const;

// ─── ERC-8004 Reputation Registry ABI (giveFeedback on official 8004 contract) ──
export const ERC8004_REPUTATION_ABI = [
  {
    name: 'giveFeedback',
    type: 'function' as const,
    stateMutability: 'nonpayable' as const,
    inputs: [
      { name: 'agentId', type: 'uint256' as const },
      { name: 'value', type: 'int128' as const },
      { name: 'valueDecimals', type: 'uint8' as const },
      { name: 'tag1', type: 'string' as const },
      { name: 'tag2', type: 'string' as const },
      { name: 'endpoint', type: 'string' as const },
      { name: 'feedbackURI', type: 'string' as const },
      { name: 'feedbackHash', type: 'bytes32' as const },
    ],
    outputs: [],
  },
  {
    name: 'NewFeedback',
    type: 'event' as const,
    inputs: [
      { name: 'agentId', type: 'uint256' as const, indexed: true },
      { name: 'clientAddress', type: 'address' as const, indexed: true },
      { name: 'feedbackIndex', type: 'uint64' as const, indexed: false },
      { name: 'value', type: 'int128' as const, indexed: false },
      { name: 'valueDecimals', type: 'uint8' as const, indexed: false },
      { name: 'indexedTag1', type: 'string' as const, indexed: true },
      { name: 'tag1', type: 'string' as const, indexed: false },
      { name: 'tag2', type: 'string' as const, indexed: false },
      { name: 'endpoint', type: 'string' as const, indexed: false },
      { name: 'feedbackURI', type: 'string' as const, indexed: false },
      { name: 'feedbackHash', type: 'bytes32' as const, indexed: false },
    ],
  },
] as const;

// ─── AgentIdentityRegistry ABI (Legacy custom registry, deprecated — kept for legacy reads) ───

export const AGENT_IDENTITY_ABI = [
  {
    name: 'registerAgent',
    type: 'function' as const,
    stateMutability: 'nonpayable' as const,
    inputs: [{ name: 'agentURI', type: 'string' as const }],
    outputs: [{ name: '', type: 'uint256' as const }],
  },
  {
    name: 'setAgentURI',
    type: 'function' as const,
    stateMutability: 'nonpayable' as const,
    inputs: [{ name: 'agentId', type: 'uint256' as const }, { name: 'newURI', type: 'string' as const }],
    outputs: [],
  },
  {
    name: 'getAgent',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [{ name: 'agentId', type: 'uint256' as const }],
    outputs: [{
      name: '',
      type: 'tuple' as const,
      components: [
        { name: 'agentId', type: 'uint256' as const },
        { name: 'owner', type: 'address' as const },
        { name: 'agentURI', type: 'string' as const },
        { name: 'active', type: 'bool' as const },
        { name: 'registeredAt', type: 'uint256' as const },
      ],
    }],
  },
  {
    name: 'getAgentByWallet',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [{ name: 'wallet', type: 'address' as const }],
    outputs: [{
      name: '',
      type: 'tuple' as const,
      components: [
        { name: 'agentId', type: 'uint256' as const },
        { name: 'owner', type: 'address' as const },
        { name: 'agentURI', type: 'string' as const },
        { name: 'active', type: 'bool' as const },
        { name: 'registeredAt', type: 'uint256' as const },
      ],
    }],
  },
  {
    name: 'isRegistered',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [{ name: 'wallet', type: 'address' as const }],
    outputs: [{ name: '', type: 'bool' as const }],
  },
  {
    name: 'walletToAgent',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [{ name: '', type: 'address' as const }],
    outputs: [{ name: '', type: 'uint256' as const }],
  },
  {
    name: 'nextAgentId',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [],
    outputs: [{ name: '', type: 'uint256' as const }],
  },
  {
    name: 'AgentRegistered',
    type: 'event' as const,
    inputs: [{ name: 'agentId', type: 'uint256' as const, indexed: true }, { name: 'owner', type: 'address' as const, indexed: true }, { name: 'agentURI', type: 'string' as const, indexed: false }],
  },
] as const;

// ─── ReputationRegistry ABI (Legacy custom registry, deprecated — kept for legacy reads) ───

export const REPUTATION_ABI = [
  {
    name: 'postFeedback',
    type: 'function' as const,
    stateMutability: 'nonpayable' as const,
    inputs: [
      { name: 'fromAgentId', type: 'uint256' as const },
      { name: 'toAgentId', type: 'uint256' as const },
      { name: 'jobId', type: 'uint256' as const },
      { name: 'role', type: 'string' as const },
      { name: 'score', type: 'uint8' as const },
      { name: 'comment', type: 'string' as const },
    ],
    outputs: [],
  },
  {
    name: 'getReputation',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [{ name: 'agentId', type: 'uint256' as const }],
    outputs: [{ name: 'avgScore', type: 'uint256' as const }, { name: 'count', type: 'uint256' as const }],
  },
  {
    name: 'getFeedback',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [{ name: 'agentId', type: 'uint256' as const }, { name: 'offset', type: 'uint256' as const }, { name: 'limit', type: 'uint256' as const }],
    outputs: [{
      name: '',
      type: 'tuple[]' as const,
      components: [
        { name: 'fromAgentId', type: 'uint256' as const },
        { name: 'toAgentId', type: 'uint256' as const },
        { name: 'jobId', type: 'uint256' as const },
        { name: 'role', type: 'string' as const },
        { name: 'score', type: 'uint8' as const },
        { name: 'comment', type: 'string' as const },
        { name: 'timestamp', type: 'uint256' as const },
      ],
    }],
  },
  {
    name: 'feedbackCount',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [{ name: '', type: 'uint256' as const }],
    outputs: [{ name: '', type: 'uint256' as const }],
  },
  {
    name: 'FeedbackPosted',
    type: 'event' as const,
    inputs: [{ name: 'fromAgent', type: 'uint256' as const, indexed: true }, { name: 'toAgent', type: 'uint256' as const, indexed: true }, { name: 'jobId', type: 'uint256' as const, indexed: false }, { name: 'score', type: 'uint8' as const, indexed: false }],
  },
] as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

export const MOCK_USDC_DECIMALS = 6; // MockUSDC uses 6 decimals (NOT 18)
export const AWP_DECIMALS = 18;

export function toWei(amount: number | string, decimals = 18): bigint {
  const [whole, frac = ''] = String(amount).split('.');
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(whole) * BigInt(10 ** decimals) + BigInt(fracPadded);
}

export function fromWei(amount: bigint, decimals = 18, precision = 4): string {
  const divisor = BigInt(10 ** decimals);
  const whole = amount / divisor;
  const frac = amount % divisor;
  const fracStr = frac.toString().padStart(decimals, '0').slice(0, precision);
  return `${whole}.${fracStr}`;
}

// ─── ReviewGate V4 ABI (V3 + getAgentRating + ERC-8004 blend + setRatingWeights) ──
// V4 (0x7856191147766f4421aaa312def42a885820550d, deployed 2026-04-24):
// - DROPPED: incrementPendingReviews(address[]) — V14 used it; V15 calls setupJobReviews instead
// - ADDED: getAgentRating(address) returns (ratingBps, reviewCount) — basis points 0-500 = 0.00-5.00 stars
// - ADDED: setRatingWeights(localPct, erc8004Pct) admin function (must sum to 100)
// - ADDED: setERC8004Config(identity, reputation, endpoint, weightPct, enabled)
// - ADDED: events ERC8004ConfigUpdated, ERC8004FeedbackBridged, ERC8004FeedbackFailed, JobReviewsSetup, RatingWeightsUpdated, ReviewPairAssigned

export const REVIEW_GATE_ABI = [
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "initialOwner",
        "type": "address"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "constructor"
  },
  {
    "inputs": [],
    "name": "CannotReviewSelf",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "DuplicatePair",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidScore",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "LengthMismatch",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotAuthorized",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "owner",
        "type": "address"
      }
    ],
    "name": "OwnableInvalidOwner",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "account",
        "type": "address"
      }
    ],
    "name": "OwnableUnauthorizedAccount",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "PairNotAuthorized",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "SelfReviewPair",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "WeightsMustSumTo100",
    "type": "error"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "account",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "bool",
        "name": "authorized",
        "type": "bool"
      }
    ],
    "name": "AuthorizedSet",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "address",
        "name": "identity",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "reputation",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "string",
        "name": "endpoint",
        "type": "string"
      },
      {
        "indexed": false,
        "internalType": "bool",
        "name": "enabled",
        "type": "bool"
      }
    ],
    "name": "ERC8004ConfigUpdated",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "uint256",
        "name": "agentId",
        "type": "uint256"
      },
      {
        "indexed": true,
        "internalType": "uint256",
        "name": "jobId",
        "type": "uint256"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "reviewer",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "int256",
        "name": "value",
        "type": "int256"
      }
    ],
    "name": "ERC8004FeedbackBridged",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "uint256",
        "name": "jobId",
        "type": "uint256"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "reviewee",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "string",
        "name": "reason",
        "type": "string"
      }
    ],
    "name": "ERC8004FeedbackFailed",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "uint256",
        "name": "jobId",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "pairCount",
        "type": "uint256"
      }
    ],
    "name": "JobReviewsSetup",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "oldValue",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "newValue",
        "type": "uint256"
      }
    ],
    "name": "MaxPendingReviewsUpdated",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "previousOwner",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "newOwner",
        "type": "address"
      }
    ],
    "name": "OwnershipTransferred",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "reviewer",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "newCount",
        "type": "uint256"
      }
    ],
    "name": "PendingReviewsIncremented",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "localPct",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "erc8004Pct",
        "type": "uint256"
      }
    ],
    "name": "RatingWeightsUpdated",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "reviewer",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "newCount",
        "type": "uint256"
      }
    ],
    "name": "ReviewCompleted",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "uint256",
        "name": "jobId",
        "type": "uint256"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "reviewer",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "reviewee",
        "type": "address"
      }
    ],
    "name": "ReviewPairAssigned",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "uint256",
        "name": "jobId",
        "type": "uint256"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "reviewer",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "reviewee",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint8",
        "name": "score",
        "type": "uint8"
      }
    ],
    "name": "ReviewSubmitted",
    "type": "event"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "name": "authorized",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "erc8004Enabled",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "erc8004Endpoint",
    "outputs": [
      {
        "internalType": "string",
        "name": "",
        "type": "string"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "erc8004Identity",
    "outputs": [
      {
        "internalType": "contract IERC8004Identity",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "erc8004Reputation",
    "outputs": [
      {
        "internalType": "contract IERC8004Reputation",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "erc8004WeightPct",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "agent",
        "type": "address"
      }
    ],
    "name": "getAgentRating",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "ratingBps",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "reviewCount",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "wallet",
        "type": "address"
      }
    ],
    "name": "getPendingReviewCount",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "jobId",
        "type": "uint256"
      },
      {
        "internalType": "address",
        "name": "reviewer",
        "type": "address"
      }
    ],
    "name": "getRemainingPerJob",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "wallet",
        "type": "address"
      }
    ],
    "name": "isBlocked",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "jobId",
        "type": "uint256"
      },
      {
        "internalType": "address",
        "name": "reviewer",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "reviewee",
        "type": "address"
      }
    ],
    "name": "isReviewRequired",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "name": "localRatingSum",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "name": "localReviewCount",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "localWeightPct",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "maxPendingReviews",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      },
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "name": "mustReview",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "owner",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "name": "pendingReviewCount",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      },
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "name": "remainingPerJob",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "renounceOwnership",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "wallet",
        "type": "address"
      }
    ],
    "name": "resetPendingReviewCount",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "account",
        "type": "address"
      },
      {
        "internalType": "bool",
        "name": "_authorized",
        "type": "bool"
      }
    ],
    "name": "setAuthorized",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "_identity",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "_reputation",
        "type": "address"
      },
      {
        "internalType": "string",
        "name": "_endpoint",
        "type": "string"
      },
      {
        "internalType": "bool",
        "name": "_enabled",
        "type": "bool"
      }
    ],
    "name": "setERC8004Config",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "_maxPendingReviews",
        "type": "uint256"
      }
    ],
    "name": "setMaxPendingReviews",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "_localPct",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "_erc8004Pct",
        "type": "uint256"
      }
    ],
    "name": "setRatingWeights",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "jobId",
        "type": "uint256"
      },
      {
        "internalType": "address[]",
        "name": "reviewers",
        "type": "address[]"
      },
      {
        "internalType": "address[]",
        "name": "reviewees",
        "type": "address[]"
      }
    ],
    "name": "setupJobReviews",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "jobId",
        "type": "uint256"
      },
      {
        "internalType": "address",
        "name": "reviewee",
        "type": "address"
      },
      {
        "internalType": "uint8",
        "name": "score",
        "type": "uint8"
      },
      {
        "internalType": "string",
        "name": "commentCID",
        "type": "string"
      }
    ],
    "name": "submitReview",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "newOwner",
        "type": "address"
      }
    ],
    "name": "transferOwnership",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  }
] as const;
