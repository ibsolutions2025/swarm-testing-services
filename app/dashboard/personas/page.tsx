import fs from "node:fs/promises";
import path from "node:path";
import { DashboardNav } from "@/components/DashboardNav";
import { PersonaCard } from "@/components/PersonaCard";
import type { Persona } from "@/lib/types";

export const dynamic = "force-dynamic";

async function loadLibrary(): Promise<Persona[]> {
  const dir = path.join(process.cwd(), "personas", "library");
  try {
    const files = await fs.readdir(dir);
    const out: Persona[] = [];
    for (const f of files.filter((x) => x.endsWith(".json"))) {
      try {
        const raw = await fs.readFile(path.join(dir, f), "utf8");
        const data = JSON.parse(raw);
        out.push({
          id: f.replace(/\.json$/, ""),
          campaign_id: "library",
          matrix_row_id: "library",
          name: data.name ?? f,
          archetype: data.archetype ?? "",
          goals: data.goals ?? [],
          biases: data.biases ?? [],
          soul_md: data.soul_md ?? "",
          created_at: new Date().toISOString()
        });
      } catch {
        // skip malformed file
      }
    }
    return out;
  } catch {
    return [];
  }
}

export default async function PersonasPage() {
  const personas = await loadLibrary();

  return (
    <main className="min-h-screen">
      <DashboardNav />

      <section className="container-narrow py-16">
        <h1 className="text-3xl font-semibold tracking-tight">Persona library</h1>
        <p className="mt-2 text-[var(--muted)]">
          These are the starter personas the matrix designer draws from. Each
          campaign generates its own campaign-specific personas on top of this
          library.
        </p>

        {personas.length === 0 ? (
          <div className="mt-12 rounded-md border border-[var(--border)] p-8 text-center text-[var(--muted)]">
            No personas in the library yet. Drop JSON files into{" "}
            <code>personas/library/</code> to seed the matrix designer.
          </div>
        ) : (
          <div className="mt-10 grid gap-4 md:grid-cols-2">
            {personas.map((p) => (
              <PersonaCard key={p.id} persona={p} />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
