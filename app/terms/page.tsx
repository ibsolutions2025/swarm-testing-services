import type { Metadata } from "next";
import Link from "next/link";
import { PublicFooter, PublicHeader } from "../_components/public-site";

export const metadata: Metadata = { title: "Terms | Swarm Testing Services", description: "Private-beta terms for Swarm Testing Services." };

export default function TermsPage() {
  return (
    <main className="min-h-screen">
      <PublicHeader />
      <article className="container-narrow max-w-4xl py-16 lg:py-20">
        <p className="text-sm uppercase tracking-widest text-accent">Legal</p>
        <h1 className="mt-4 text-4xl font-semibold tracking-tight">Private Beta Terms</h1>
        <p className="mt-3 text-sm text-[var(--muted)]">Effective July 11, 2026</p>
        <div className="mt-10 rounded-lg border border-amber-400/30 bg-amber-400/10 p-5 text-sm leading-6 text-amber-100">Swarm Testing Services is in private beta. Features may be incomplete, change without notice, or be unavailable. These terms are a practical beta operating agreement and may be supplemented by a written order or evaluation agreement.</div>
        <div className="mt-12 space-y-12">
          <LegalSection title="1. Agreement and eligibility"><p>By creating an account, submitting a campaign, or using STS, you agree to these terms. You must be able to enter into this agreement for yourself or the organization you represent. If a separate signed agreement conflicts with these terms, the signed agreement controls.</p></LegalSection>
          <LegalSection title="2. Authorized use"><p>You may submit only systems that you own or have explicit authority to test. You are responsible for the accuracy of your authorization, scope, exclusions, credentials, and stop conditions. You must use synthetic test accounts and non-production data unless we approve a different arrangement in writing.</p><p>You may not use STS to disrupt a service; evade access controls; test third-party targets without permission; conduct credential attacks, social engineering, malware delivery, denial-of-service activity, or unlawful surveillance; or violate another party&apos;s rights.</p></LegalSection>
          <LegalSection title="3. Beta service"><p>The beta may generate product-context summaries, workflows, personas, test scenarios, rubrics, and other planning output. Automated browser execution, continuous monitoring, and verified verdicts may be limited or unavailable. We may add, remove, pause, or change beta functionality to improve safety and reliability.</p></LegalSection>
          <LegalSection title="4. Accounts and security"><p>Keep account credentials confidential and promptly report suspected compromise. Do not share secrets in product documentation, URLs, free-text scope fields, or support messages. We may suspend an account or campaign when needed to protect a target, user, third party, or the service.</p></LegalSection>
          <LegalSection title="5. Customer content and permissions"><p>You retain ownership of the URLs, documentation, instructions, test data, and other materials you provide. You grant STS the limited permission needed to access, process, reproduce, and analyze those materials to operate, secure, troubleshoot, and improve your authorized campaign. You represent that you have the rights needed to provide them.</p></LegalSection>
          <LegalSection title="6. Output and review"><p>Subject to third-party rights and applicable law, you may use output generated for your campaign. Output can be incomplete, inaccurate, or inferred. You are responsible for reviewing it before acting on it. STS output is not a security certification, accessibility certification, legal opinion, regulatory approval, or guarantee that a product is defect-free.</p></LegalSection>
          <LegalSection title="7. Confidentiality and data handling"><p>We will use reasonable care with non-public customer content and will not intentionally disclose it except to operate the service, comply with law, respond to emergencies, or use service providers acting on our behalf. Beta-specific data handling, retention, or deletion commitments must be documented in a separate written agreement.</p></LegalSection>
          <LegalSection title="8. Fees"><p>Any fees, usage limits, credits, or evaluation period will be stated in the applicable order, pricing page, or written beta invitation. We will not charge a payment method without disclosed terms and authorization.</p></LegalSection>
          <LegalSection title="9. Disclaimers"><p>To the maximum extent permitted by law, the beta is provided &quot;as is&quot; and &quot;as available.&quot; We disclaim implied warranties of merchantability, fitness for a particular purpose, non-infringement, and uninterrupted or error-free operation. Some jurisdictions do not allow certain disclaimers, so parts of this section may not apply.</p></LegalSection>
          <LegalSection title="10. Limitation of liability"><p>To the maximum extent permitted by law, STS will not be liable for indirect, incidental, special, consequential, exemplary, or punitive damages, or for lost profits, revenue, data, goodwill, or business interruption. Any aggregate liability arising from the beta will not exceed the amount you paid for the beta in the three months before the event giving rise to the claim. This limitation does not apply where prohibited by law.</p></LegalSection>
          <LegalSection title="11. Suspension and termination"><p>You may stop using the beta at any time. We may suspend or terminate access for safety risks, misuse, legal requirements, prolonged inactivity, or material breach. Sections that by their nature should survive termination will survive, including ownership, disclaimers, and liability limits.</p></LegalSection>
          <LegalSection title="12. Changes and contact"><p>We may update these terms as the product matures. Material changes will be identified by a new effective date and, when practical, notice through the service or beta channel. Questions can be sent to <Link href="mailto:hello@swarm-testing.dev" className="text-accent hover:underline">hello@swarm-testing.dev</Link>.</p></LegalSection>
        </div>
      </article>
      <PublicFooter />
    </main>
  );
}

function LegalSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section><h2 className="text-xl font-medium">{title}</h2><div className="mt-3 space-y-4 text-sm leading-7 text-[var(--muted)]">{children}</div></section>;
}
