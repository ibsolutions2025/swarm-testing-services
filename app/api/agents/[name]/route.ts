import { NextRequest, NextResponse } from "next/server";
import { getAgent } from "@/lib/agents-fs";
import { auditPersona } from "@/lib/insider-audit";

export const dynamic = "force-dynamic";

/**
 * GET /api/agents/awp-test-<1..7>
 * Returns the on-disk doc bundle plus the insider-info audit report.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: { name: string } }
) {
  const agent = await getAgent(params.name);
  if (!agent) {
    return NextResponse.json(
      { error: `agent '${params.name}' not found` },
      { status: 404 }
    );
  }
  const audit = auditPersona({
    soul_md: agent.soul_md,
    user_md: agent.user_md
  });
  return NextResponse.json({ ...agent, audit });
}
