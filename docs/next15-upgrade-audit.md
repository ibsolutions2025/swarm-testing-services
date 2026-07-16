# Next.js 14 to 15 upgrade audit

Audit date: 2026-07-16

Scope: documentation only; no application code or dependency changes

Target: latest Next.js 15 release, `15.5.20`, with React `19.2.7`

## Executive summary

The upgrade is feasible but should not be treated as a dependency-only change. The highest-risk issue is the shared `lib/supabase-server.ts` helper: it calls `cookies()` synchronously, while Next.js 15 makes `cookies()` asynchronous. That helper is used by the dashboard guard, protected pages, sign-in/sign-up/sign-out handlers, the OAuth callback, and most onboarding APIs. A partial conversion would cause authentication or cookie-refresh regressions across the application.

Nine dynamic route/page files also read `params` synchronously and must move to `Promise<...>` params plus `await`. Thirteen `GET` Route Handlers need an explicit caching decision because Next.js 15 changes them from cached-by-default to uncached-by-default. The application does not use `next/image`, `@next/font`, `NextRequest.geo`, `NextRequest.ip`, or `runtime = "experimental-edge"`, so the corresponding removals do not require source changes.

There is a baseline discrepancy that must be resolved by the implementation task: the initiative says the application is pinned to `14.2.35`, but the checked-in root `package.json` and `eslint-config-next` are both `14.2.15`, and there is no lockfile. The upgrade branch must regenerate and commit a lockfile and must not assume the declared `14.2.35` floor is present.

Risk ranking:

1. **Critical:** Supabase cookie/session creation and refresh, including middleware and all consumers of `createServerClient()`.
2. **High:** dynamic onboarding, campaign, agent, and hire routes that synchronously access `params`.
3. **High:** React 19 dependency/type migration, especially third-party component compatibility and ref/test typing.
4. **Medium:** changed `fetch`, `GET` Route Handler, and client-router cache defaults.
5. **Low:** config, font, image, geolocation, and runtime removals; current code was inspected and does not use the removed forms.

## Baseline inventory

- App Router application under `app/`; no `pages/` router.
- Root manifest: Next `14.2.15`, React/React DOM `^18.3.1`, TypeScript `^5.6.2`, Node engine `>=18.17.0`.
- No root package lock is committed.
- `middleware.ts` refreshes Supabase auth cookies on nearly every non-static request.
- `lib/supabase-server.ts` synchronously calls `cookies()` and returns a synchronous client.
- 13 `GET` Route Handlers; none explicitly opts into static caching.
- No `next/image`, `next/font`, `@next/font`, Pages Router, `draftMode()`, `headers()`, `NextRequest.geo`/`ip`, or Edge runtime declaration.
- The separate `orchestrator/package.json` is a Node service, not a Next.js package, but its dependency is included below for completeness.

## Dependency matrix

“Forced” means Next.js 15/React 19 peer or type compatibility requires the major change. “Recommended” means it removes an avoidable unsupported-tooling risk while staying within the Next.js 15 peer ranges.

### Root `package.json`

| Package / runtime | Current declaration | Next-15 target | Forced major? | Reason |
|---|---:|---:|---|---|
| `next` | `14.2.15` | `15.5.20` (exact) | Yes | Requested supported-major migration; match `eslint-config-next`. |
| `react` | `^18.3.1` | `^19.2.7` | Yes | React 19 is the supported App Router baseline for the Next 15 migration; use the current patched React 19 line. |
| `react-dom` | `^18.3.1` | `^19.2.7` | Yes | Must exactly track the React major/minor peer. |
| `@types/react` | `^18.3.11` | `^19.2.17` | Yes | React 19 TypeScript definitions are required with React 19. |
| `@types/react-dom` | `^18.3.0` | `^19.2.3` | Yes | React DOM 19 definitions peer on `@types/react ^19.2.0`. |
| `eslint-config-next` | `14.2.15` | `15.5.20` (exact) | Yes | Keep the framework lint rules on the same release as Next. |
| `eslint` | `^8.57.1` | `^9.39.5` | No; recommended | Next 15.5 supports ESLint 7/8/9. ESLint 9 avoids carrying the EOL ESLint 8 line; do not jump to ESLint 10 in this migration. |
| `@supabase/ssr` | `^0.10.2` | keep `^0.10.2` | No | Its peer is `@supabase/supabase-js ^2.102.1`, already satisfied. Source adaptation for async cookies is still required. |
| `@supabase/supabase-js` | `^2.104.0` | keep `^2.104.0` | No | Satisfies `@supabase/ssr`; no React or Next peer. |
| `viem` | `^2.48.4` | keep `^2.48.4` | No | Its TypeScript peer (`>=5.0.4`) is already satisfied. |
| `@types/node` | `^20.16.10` | keep `^20.16.10` | No | Matches the recommended Node 20 runtime line. |
| `typescript` | `^5.6.2` | keep `^5.6.2` | No | Satisfies Next 15 and `viem`. |
| `autoprefixer` | `^10.4.20` | keep `^10.4.20` | No | No Next/React peer conflict. |
| `postcss` | `^8.4.47` | keep `^8.4.47` | No | Satisfies Autoprefixer. |
| `tailwindcss` | `^3.4.13` | keep `^3.4.13` | No | Tailwind 4 would be an unrelated major migration. |
| Node engine | `>=18.17.0` | `>=20.0.0` | Operationally yes | Next 15 requires at least Node 18.18; Node 18 is EOL, so use Node 20+ rather than widening to an obsolete floor. |

### `orchestrator/package.json`

| Package / runtime | Current declaration | Target | Forced major? | Reason |
|---|---:|---:|---|---|
| `@supabase/supabase-js` | `^2.45.4` | keep `^2.45.4` | No | The standalone orchestrator has no Next/React peer relationship. Upgrade separately if desired. |
| Node engine | `>=18.17.0` | `>=20.0.0` | Operationally yes | Keep deploy/runtime policy consistent and avoid EOL Node 18. |

Do not opportunistically update Supabase, viem, Tailwind, PostCSS, or TypeScript in the same implementation task. That would make a regression harder to attribute. After changing the six framework/React packages and ESLint, run `npm install` once and commit the generated `package-lock.json`.

## Breaking-change audit

### 1. Async request APIs — applicable, critical

Next.js 15 changes `cookies()`, `headers()`, `draftMode()`, route/page `params`, and page `searchParams` to asynchronous APIs. Temporary synchronous access exists in 15, but it emits warnings and becomes an error in the next major; it is not an acceptable migration endpoint.

#### Shared cookie helper

`lib/supabase-server.ts` currently does this synchronously:

```ts
export function createServerClient() {
  const cookieStore = cookies()
  // ...
}
```

The implementation task should make the factory asynchronous (`await cookies()`), then await `createServerClient()` at every call site. Review at least:

- `app/dashboard/layout.tsx`
- `app/dashboard/campaigns/page.tsx`
- `app/dashboard/campaigns/[id]/page.tsx`
- `app/hire/page.tsx`
- `app/hire/runs/[runId]/page.tsx`
- `app/hire/runs/[runId]/edit/page.tsx`
- `app/api/auth/signin/route.ts`
- `app/api/auth/signup/route.ts`
- `app/auth/signout/route.ts`
- `app/auth/callback/route.ts`
- campaign, test-campaign, and onboarding Route Handlers importing the helper

`middleware.ts` reads `req.cookies`, not `cookies()` from `next/headers`, so it does not need the async API conversion. It remains a critical smoke-test surface because it is responsible for copying refreshed cookies to the response.

#### Dynamic params

Change params types to promises and await them before use in these eight files:

- `app/api/agents/[name]/route.ts`
- `app/api/campaigns/[id]/route.ts`
- `app/api/onboarding/bundle/[runId]/route.ts`
- `app/api/onboarding/cutover-preview/[runId]/route.ts`
- `app/api/onboarding/data/[runId]/route.ts`
- `app/api/onboarding/result/[runId]/route.ts`
- `app/dashboard/campaigns/[id]/page.tsx`
- `app/hire/runs/[runId]/page.tsx`
- `app/hire/runs/[runId]/edit/page.tsx`

The list contains nine files: six Route Handlers and three pages.

`app/login/page.tsx` uses the client `useSearchParams()` hook. It is not the async server `searchParams` prop and does not require this codemod, but login remains a smoke-test target.

### 2. Caching semantics — applicable, high/medium

Next.js 15 no longer caches server `fetch` calls or `GET` Route Handlers by default, and page segments have a client-router stale time of zero by default.

#### `GET` Route Handlers

Review all 13 handlers:

- Auth-sensitive/dynamic: `app/auth/callback/route.ts`, `app/api/campaigns/route.ts`, `app/api/campaigns/[id]/route.ts`, `app/api/onboarding/edit/route.ts`, `app/api/onboarding/status/route.ts`, and all four `app/api/onboarding/*/[runId]/route.ts` handlers. These should remain uncached; make the intent explicit where useful with `export const dynamic = "force-dynamic"`.
- Data/result endpoints: the three `app/api/test-results/*/route.ts` handlers and `app/api/agents/[name]/route.ts`. Decide freshness per endpoint. Preserve 14-style caching only if data is public and staleness is explicitly acceptable, using `export const dynamic = "force-static"` or a documented revalidation policy.

Never cache a response that depends on a Supabase user session. Test that one user cannot receive another user’s campaign or onboarding response.

#### Server `fetch`

The upstream onboarding calls execute inside POST or authenticated/dynamic Route Handlers and should remain fresh. Do not add `force-cache` to them. Browser-side `fetch` calls are governed by browser/client behavior, not the changed server-fetch default.

#### Client router cache

Page segments are no longer reused during forward navigation by default. This can increase requests but improves freshness. Do not restore the old global `staleTimes.dynamic` behavior during the migration; first measure navigation/request impact. Back/forward restoration, shared layouts, and loading states retain their documented caching behavior.

### 3. React 19 — applicable, high

- Upgrade `react`, `react-dom`, and both type packages together.
- The modern JSX transform is already provided by Next/TypeScript.
- Repository search found no `useFormState`, legacy `ReactDOM.render`/`hydrate`, `findDOMNode`, string refs, `react-dom/test-utils`, function `propTypes`, or function `defaultProps` usage.
- Run the React 19 TypeScript codemod because callback-ref cleanup types and the `React.JSX` namespace can affect code or transitive declarations even when source search is clean.
- Re-run all client forms and Suspense/loading flows. React 19 changes render-error reporting and Suspense scheduling.
- Avoid a mixed React 18/19 install. The application is App Router-only, so React 19 should be used consistently.

### 4. Runtime and config changes — partially applicable

- Next 15 errors on `runtime = "experimental-edge"`; no such declaration exists.
- `experimental.bundlePagesExternals` became `bundlePagesRouterDependencies`; not used.
- `experimental.serverComponentsExternalPackages` became `serverExternalPackages`; not used.
- `swcMinify`, `experimental.missingSuspenseWithCSRBailout`, and deprecated `experimental.outputFileTracing` forms are not present.
- `next.config.js` contains `experimental.serverActions.allowedOrigins: ["*"]`. The upgrade task must run `next build` and confirm Next 15 accepts the current nesting. Independently of compatibility, a wildcard allowed-origin policy is security-sensitive; narrowing it is a separate product/security change and is not authorized by this migration audit.
- `next lint` still exists in Next 15, so the current script can survive this major. ESLint 9 configuration/output should nevertheless be verified before merge.

### 5. Middleware and request metadata — applicable for verification

Next 15 applies the `react-server` export condition to middleware. Current `middleware.ts` imports only `next/server` and `@supabase/ssr`, so no unsupported React client import was found. `NextRequest.geo` and `.ip` were removed, but the repository does not use them.

The middleware’s session refresh is central to auth correctness. Preserve the matcher and the two-step cookie copy (`req.cookies.set` and `res.cookies.set`) during the framework upgrade. Middleware must not become the sole authorization layer; the existing protected layouts and handlers already re-check `supabase.auth.getUser()` and should continue doing so.

### 6. Image and font changes — reviewed, not applicable

Next 15 removes the external `@next/font` package, removes the Squoosh image optimizer in favor of Sharp, changes image `Content-Disposition` defaults, and rejects image sources with leading/trailing spaces. This repository has no `@next/font`, `next/font`, `next/image`, or `images` configuration. No migration edit is expected. Verify static images and `_next/image` middleware exclusion still behave, but do not add an image dependency solely for this upgrade.

### 7. Other relevant Next 15 changes

- Automatic Vercel Speed Insights instrumentation was removed. No Speed Insights integration was found.
- `instrumentation.js` is stable and no longer needs `experimental.instrumentationHook`; neither is present.
- Server Action identifiers and dead-action elimination changed for security. The repository has no `'use server'` action files, but `allowedOrigins` config should still be build-validated.
- Self-hosted image optimization now brings Sharp automatically when using `next start`/standalone; no action required.

## Codemod and implementation plan

Run codemods only on a clean migration branch and inspect the diff after each command.

The task text names this historical convenience command:

```bash
npx @next/codemod@canary upgrade latest
```

**Do not run that command unpinned in July 2026:** `latest` now means Next 16, outside this initiative. Use the official upgrade CLI with the intended revision instead:

```bash
npx @next/codemod@canary upgrade 15.5.20
```

Expected touches: root `package.json`, the new lockfile, async request API call sites, and possibly React 19 migrations selected by the CLI. Review every dependency edit against the matrix above.

Then run the targeted official transforms explicitly (a dry run first is preferred):

```bash
npx @next/codemod@latest next-async-request-api . --dry --print
npx @next/codemod@latest next-async-request-api .
npx types-react-codemod@latest preset-19 .
```

Expected areas for `next-async-request-api`: `lib/supabase-server.ts`, its consumers, the six dynamic Route Handlers, and the three dynamic pages listed above. The codemod may insert `UnsafeUnwrapped*` types or `@next/codemod` comments when it cannot make a safe conversion. Treat both as unresolved work; do not merge with either marker:

```bash
rg -n 'UnsafeUnwrapped|@next/codemod' app lib
```

These official Next 15 transforms are not expected to change this repository, but may be run as no-op checks:

```bash
npx @next/codemod@latest app-dir-runtime-config-experimental-edge . --dry --print
npx @next/codemod@latest next-request-geo-ip . --dry --print
```

Do not run `middleware-to-proxy` or `next-lint-to-eslint-cli`; those are Next 16 migrations.

After codemods, manually make `createServerClient()` asynchronous and await every consumer if the transform does not complete that transitive change. Regenerate a single root lockfile and verify no duplicate React major exists:

```bash
npm ls next react react-dom @types/react @types/react-dom
npm ls @supabase/ssr @supabase/supabase-js
```

## Regression-risk map and smoke-test direction

### Critical: authentication and session cookies

1. Sign in with valid credentials; response sets Supabase session cookies and redirects correctly.
2. Refresh `/dashboard`; the session persists through middleware cookie refresh.
3. Visit `/dashboard`, `/hire`, and a dynamic run/campaign URL while signed out; each redirects to `/login?next=...` without leaking content.
4. Complete the auth callback with a valid code and verify the `next` destination. Reject/handle a missing or invalid code.
5. Sign out; cookies clear and protected routes are inaccessible on the next request.
6. Exercise sign-up and the existing-user conversion path without logging secrets.
7. Confirm every auth-sensitive API returns `401` without a session and user-scoped data with a session.

### High: dynamic route params

Exercise a valid and missing identifier for campaign, agent, onboarding data/result/bundle/cutover-preview, hire run, and hire edit routes. A missed `await params` can compile with temporary compatibility but fail or warn at runtime, so CI should fail on async-API warnings and `UnsafeUnwrapped` markers.

### High: onboarding mutation chain

Run the credential-free/mocked onboarding sequence: create, poll status, retrieve data, edit, preview, greenlight, retrieve result, and bundle. Verify upstream requests remain uncached and authorization headers are never rendered or logged.

### Medium: caching and navigation

- Call public result endpoints twice and verify the intended freshness.
- Navigate dashboard/campaign pages forward, back, and forward; confirm no stale user data and acceptable request volume.
- Verify no authenticated response is emitted with shared-cache headers.

### Required quality gates

```bash
npm run lint
npx tsc --noEmit
npm run build
```

Run the route/auth smoke suite after the production build. Inspect `next build` route output for unexpected static rendering of authenticated routes. The migration can move to review only when lint, typecheck, build, async-marker search, dependency-tree checks, and smoke tests all pass.

## Rollback boundary

Keep all upgrade edits on the migration branch. Do not merge dependency-only changes before the async cookie/params work and smoke tests are green. If a regression cannot be resolved, revert the migration commits as a unit; do not attempt to run Next 15 with React 18 or with temporary synchronous request API casts.

## Sources

- [Next.js 15 upgrade guide](https://nextjs.org/docs/app/guides/upgrading/version-15)
- [Next.js 15 release notes](https://nextjs.org/blog/next-15)
- [Official Next.js codemods](https://nextjs.org/docs/app/guides/upgrading/codemods)
- [React 19 upgrade guide](https://react.dev/blog/2024/04/25/react-19-upgrade-guide)
- Package target/peer ranges checked with the npm registry on the audit date.
