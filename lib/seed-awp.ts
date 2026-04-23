// Auto-seed AWP as every new user's first project.
//
// Why per-user? Because campaigns + matrices + personas + runs are all
// RLS-scoped to auth.uid(), so every account needs its own copy of the
// demo project. We seed through the service-role admin client to bypass
// RLS on the child tables (matrices/personas/runs have no end-user
// INSERT policy).

import { createAdminClient } from "./supabase-admin";

export const AWP_SEED_URL = "https://agentwork-protocol.vercel.app";

/**
 * Ensure the user has at least one project. If not, insert AWP as their
 * first one — fully populated with matrix, personas, and runs so all three
 * tabs render on the detail page.
 */
export async function ensureAwpSeeded(
  userId: string
): Promise<{ seeded: boolean; campaign_id?: string }> {
  const admin = createAdminClient();

  // Does this user already have any campaign?
  const { count, error: countErr } = await admin
    .from("campaigns")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);

  if (countErr) return { seeded: false };
  if ((count ?? 0) > 0) return { seeded: false };

  // 1) Campaign row.
  const { data: campaign, error: cErr } = await admin
    .from("campaigns")
    .insert({
      user_id: userId,
      url: AWP_SEED_URL,
      description:
        "AgentWork Protocol — AWP testing dogfood. Swarm tests whether agents can discover, perform, validate, and complete on-chain jobs across product configurations and failure scenarios.",
      status: "completed"
    })
    .select("id")
    .single();

  if (cErr || !campaign) return { seeded: false };

  const campaign_id = campaign.id;

  // 2) Matrix rows (configurations) × columns (scenarios).
  const rows = [
    {
      id: "cfg-easy-paying",
      label: "Easy jobs, paying rewards",
      config: { difficulty: "easy", reward: 0.1 }
    },
    {
      id: "cfg-hard-paying",
      label: "Hard jobs, paying rewards",
      config: { difficulty: "hard", reward: 0.5 }
    },
    {
      id: "cfg-easy-zero",
      label: "Easy jobs, zero reward",
      config: { difficulty: "easy", reward: 0 }
    },
    {
      id: "cfg-hard-zero",
      label: "Hard jobs, zero reward",
      config: { difficulty: "hard", reward: 0 }
    }
  ];

  const columns = [
    {
      id: "sce-discover",
      label: "Job discovery",
      scenario:
        "Agent discovers an open job via on-chain events and decides whether to volunteer.",
      success_criteria: ["Agent fetches JobCreated event", "Decision logged"]
    },
    {
      id: "sce-perform",
      label: "Perform work",
      scenario:
        "Agent performs the requested task and submits proof on-chain.",
      success_criteria: ["Submission tx lands", "Step proofs stored"]
    },
    {
      id: "sce-validate",
      label: "Validate peer work",
      scenario:
        "Validator agent reviews another agent's submission and casts a vote via ReviewGate.",
      success_criteria: ["Review vote posted", "Rating in 1..5"]
    },
    {
      id: "sce-complete",
      label: "Complete + claim",
      scenario:
        "Agent completes the job after review and claims the reward.",
      success_criteria: ["Job state = Completed", "Reward transferred"]
    },
    {
      id: "sce-deadline",
      label: "Deadline handling",
      scenario:
        "Agent gracefully handles missed deadlines without getting stuck.",
      success_criteria: ["No deadlock", "Graceful timeout"]
    }
  ];

  const { error: mErr } = await admin.from("matrices").insert({
    campaign_id,
    rows,
    columns
  });
  if (mErr) return { seeded: true, campaign_id }; // campaign exists, children best-effort

  // 3) Personas — one per configuration row.
  const personas = [
    {
      campaign_id,
      matrix_row_id: "cfg-easy-paying",
      name: "Opportunist Olga",
      archetype: "reward-hunter",
      goals: [
        "Volunteer on the first easy job seen",
        "Maximize reward per unit of time"
      ],
      biases: ["Skips validation work", "Picks low-hanging jobs only"],
      soul_md:
        "I'm here for the rewards. I scan JobCreated events, pick easy ones with the biggest reward, and move on. I don't like validating — it doesn't pay enough."
    },
    {
      campaign_id,
      matrix_row_id: "cfg-hard-paying",
      name: "Craftsman Chen",
      archetype: "quality-first",
      goals: [
        "Take on hard jobs to build reputation",
        "Ship polished submissions"
      ],
      biases: ["Over-researches before acting", "Underestimates timers"],
      soul_md:
        "Hard jobs teach me. The reward matters, but reputation compounds. I'll read the spec twice, draft in my head, then submit something I'm proud of."
    },
    {
      campaign_id,
      matrix_row_id: "cfg-easy-zero",
      name: "Skeptic Sam",
      archetype: "skeptical-lurker",
      goals: [
        "Observe before committing",
        "Only work if incentives make sense"
      ],
      biases: [
        "Assumes zero-reward jobs are traps",
        "Delays volunteering until gas settles"
      ],
      soul_md:
        "Why would I work for zero? I'll watch how other agents handle this. If nobody takes it, I'll pass. If someone takes it and gets scammed, I've learned something."
    },
    {
      campaign_id,
      matrix_row_id: "cfg-hard-zero",
      name: "Idealist Ines",
      archetype: "altruist",
      goals: [
        "Contribute to the protocol even without reward",
        "Exercise hard-job tooling"
      ],
      biases: [
        "Over-commits early in a session",
        "Keeps going past deadline out of pride"
      ],
      soul_md:
        "Money isn't the point. Hard jobs are good practice. I want to see the swarm succeed, even if I'm the one validating for free today."
    }
  ];

  const { data: personaRows, error: pErr } = await admin
    .from("personas")
    .insert(personas)
    .select("id, matrix_row_id");
  if (pErr || !personaRows) return { seeded: true, campaign_id };

  const personaByRow = new Map(personaRows.map((p) => [p.matrix_row_id, p.id]));

  // 4) Runs — one per (row × column) cell, mixing outcomes for a realistic
  //    demo that lights up Passed/Failed/Partial/Errors.
  const outcomeGrid: Record<string, Record<string, string>> = {
    "cfg-easy-paying": {
      "sce-discover": "pass",
      "sce-perform": "pass",
      "sce-validate": "partial",
      "sce-complete": "pass",
      "sce-deadline": "pass"
    },
    "cfg-hard-paying": {
      "sce-discover": "pass",
      "sce-perform": "partial",
      "sce-validate": "pass",
      "sce-complete": "fail",
      "sce-deadline": "pass"
    },
    "cfg-easy-zero": {
      "sce-discover": "pass",
      "sce-perform": "skipped",
      "sce-validate": "skipped",
      "sce-complete": "skipped",
      "sce-deadline": "pass"
    },
    "cfg-hard-zero": {
      "sce-discover": "pass",
      "sce-perform": "error",
      "sce-validate": "pass",
      "sce-complete": "fail",
      "sce-deadline": "partial"
    }
  };

  const quoteGrid: Record<string, Record<string, string>> = {
    "cfg-easy-paying": {
      "sce-validate":
        "Validator picked a reasonable rating but didn't include any written feedback — partial pass."
    },
    "cfg-hard-paying": {
      "sce-perform":
        "Agent submitted step proofs out of order; half the steps were accepted, half rejected.",
      "sce-complete":
        "Agent never called complete() — the job auto-expired at the deadline."
    },
    "cfg-hard-zero": {
      "sce-perform":
        "Agent threw mid-run: 'gas estimation failed — the chain reported out of gas'.",
      "sce-complete":
        "Zero-reward hard job never transitioned to Completed — agent walked away.",
      "sce-deadline":
        "Agent kept retrying past the deadline window, producing partial credit."
    }
  };

  const now = Date.now();
  const runs: any[] = [];
  let offset = 0;
  for (const row of rows) {
    for (const col of columns) {
      const outcome = outcomeGrid[row.id]?.[col.id] ?? "skipped";
      const quote = quoteGrid[row.id]?.[col.id] ?? null;
      const persona_id = personaByRow.get(row.id) ?? null;
      runs.push({
        campaign_id,
        matrix_row_id: row.id,
        matrix_column_id: col.id,
        persona_id,
        outcome,
        transcript: [
          {
            role: "system",
            text: `Scenario: ${col.scenario}`,
            ts: new Date(now - offset * 60000).toISOString()
          },
          {
            role: "persona",
            text: `[${
              personas.find((p) => p.matrix_row_id === row.id)?.name
            }] Attempting ${col.label.toLowerCase()} under config "${row.label}".`,
            ts: new Date(now - offset * 60000 + 5000).toISOString()
          },
          {
            role: "observer",
            text: `Outcome: ${outcome}. ${quote ?? ""}`.trim(),
            ts: new Date(now - offset * 60000 + 10000).toISOString()
          }
        ],
        quote,
        duration_ms: 12000 + ((offset * 1373) % 48000)
      });
      offset += 1;
    }
  }

  await admin.from("runs").insert(runs);

  return { seeded: true, campaign_id };
}
