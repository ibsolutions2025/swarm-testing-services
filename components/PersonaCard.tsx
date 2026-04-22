import type { Persona } from "@/lib/types";

export function PersonaCard({ persona }: { persona: Persona }) {
  return (
    <div className="rounded-md border border-[var(--border)] p-6">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-lg font-medium">{persona.name}</h3>
          <p className="text-sm text-[var(--muted)]">{persona.archetype}</p>
        </div>
      </div>
      {persona.goals?.length > 0 && (
        <div className="mt-4">
          <p className="text-xs uppercase tracking-widest text-accent">Goals</p>
          <ul className="mt-2 list-disc pl-5 text-sm text-[var(--muted)]">
            {persona.goals.map((g, i) => (
              <li key={i}>{g}</li>
            ))}
          </ul>
        </div>
      )}
      {persona.biases?.length > 0 && (
        <div className="mt-4">
          <p className="text-xs uppercase tracking-widest text-accent">Biases</p>
          <ul className="mt-2 list-disc pl-5 text-sm text-[var(--muted)]">
            {persona.biases.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
